# Hover Highlighting

The editor and the diagram are kept visually linked in both directions:

- **Diagram → editor** — hovering a shape highlights the puml line(s) that produced it.
- **Editor → diagram** — hovering (or clicking) an editor line highlights the shape(s)
  that line produced.

Both directions work off the *same* per-render mapping between editor rows and SVG
elements, built once per render and consulted on every hover. No request is made while
hovering.

Shared core: `static/hover-highlight.js`. Editor-side markers: `static/script.js`.
Per-diagram registration: `static/activity.js` and `static/sequence-operations.js`.
Backend row tables: `activity/positions.py` and `sequence/positions.py`.

---

## 1. The Central Problem

PlantUML's SVG output carries no ids, no classes, and no back-references to the source.
A `<rect>` in the output does not say "I am line 7." So the link has to be reconstructed,
and it is reconstructed **once per render** rather than per hover.

The reconstruction rests on one invariant:

> **SVG document order matches puml source order, per element type.**

The backend counts the Nth element of a type in the SVG and finds the Nth matching
construct in the puml. The frontend walks the SVG in the same document order and
collects hover targets in the same per-type arrays. Zipping the two by ordinal yields
"this DOM node ↔ these editor rows."

This is the same invariant the click-handling code relies on (see
`docs/element_pattern.md`), so highlighting and editing cannot disagree about which
element is which.

---

## 2. Data Flow Per Render

```
render → SVG injected into #colb
      → POST /getActivityPositions or /getSequencePositions   (one round trip)
      → walk the SVG, register hover targets in document order
      → zip targets against the returned row table
      → rowMap:       row  → [{el, style}, …]      (editor → diagram)
      → elementRows:  el   → [rows]                (diagram → editor)
```

Everything is rebuilt from scratch on each render, because `element.innerHTML = svg`
discards the old DOM nodes and any references to them become stale.

### The positions fetch

`fetchDiagramData(endpoint)` in `hover-highlight.js` POSTs
`{plantuml, svg}` and returns the parsed JSON, **or `null`** if there is no rendered
diagram or the request throws:

```js
} catch (error) {
    return null;   // highlighting is non-critical
}
```

A failure silently disables highlighting for that render instead of surfacing an error.
Callers default their tables to empty.

### Render-generation guard

Both `setHandlersForActivityDiagram` and `setHandlersForSequenceDiagram` compare
`renderId !== renderGeneration` before publishing results. The sequence path checks
**twice** — once after the SVG fetch and once after the positions fetch — because each
is a separate async hop and a newer render can land in between. Without the second
check, a stale render's positions could overwrite the current diagram's tables.

---

## 3. The Shared Core (`hover-highlight.js`)

The module holds **no globals of its own**. Every function is pure over the state passed
in — a `rowMap` Map and an `active` array — so each diagram type owns its own state.
Composition over inheritance: the map machinery lives here, the styles and the
registration walk live in each diagram's module.

### Highlight styles

A "highlight style" is an object `{apply(el) → token, restore(el, token)}`. `apply` puts
the element into its highlighted state and returns whatever `restore` needs to undo it —
or `null` to *decline*.

**`attributeHighlight(attr, value)`** — toggles a single attribute (`fill`,
`font-weight`):

```js
apply(el) {
    const old = el.getAttribute(attr);
    if (old === value) return null;   // decline
    el.setAttribute(attr, value);
    return {old: old};
}
```

The decline is the important part. If the element already shows the highlighted value —
a diagram-side hover is already active, or the element was registered twice for one row
— applying again would capture the *highlighted* value as the "original" and restore it
later, leaving the highlight stuck permanently. Restoring `old === null` removes the
attribute rather than setting the string `"null"`.

**`stylePropertyHighlight(properties)`** — sets `el.style.x` properties, but restores by
putting back the **literal `style` attribute string**:

```js
apply(el)  { const old = el.getAttribute('style'); /* mutate el.style */ return {old}; }
restore(el, token) { el.setAttribute('style', token.old); }
```

Why not just clear the individual properties: mutating `el.style` makes the browser
re-serialize the whole attribute, which can drop the exact substrings the element
classifiers match on — `"stroke-width:1.0"` may come back as `"stroke-width: 1"`. Since
messages, activation bars, notes, and group boxes are all identified by those literal
substrings, a re-serialized style attribute would silently break element detection after
the first hover. Restoring the original string verbatim avoids that entirely.

### Map functions

| Function | Purpose |
| --- | --- |
| `registerHoverRow(rowMap, row, el, style)` | Register `el` under `row`. **Negative rows are ignored** — a `-1` from the backend means "no line resolved." |
| `highlightHoverRow(rowMap, row, active)` | Apply every registered style for `row`, pushing undo entries onto `active`. Declined styles are skipped, so `active` only ever holds real restore tokens. |
| `clearHoverHighlight(active)` | Restore everything in `active`; returns a fresh empty array for the caller to reassign. |
| `findActiveHighlight(active, el)` | Return the active entry for `el`, or `null`. Lets a diagram-side handler detect an editor-owned highlight and read the true pre-highlight value via `entry.token.old`. |
| `registerElementRows(elementRows, el, row)` | The **inverse** map, built in the same pass: which rows an element owns. |
| `markEditorForElement(elementRows, el)` | Mark the editor line(s) for a hovered element — a cached lookup, not a fetch. |

---

## 4. Editor → Diagram

### Dispatch

`initEditorHoverHighlighting(editor)` is called once from `initeditor()` and wires two
listeners:

```js
editor.on('mousemove', function(e) {
    if (currentDiagramType !== 'sequence' && currentDiagramType !== 'activity') return;
    const row = e.getDocumentPosition().row;
    if (row === lastEditorHoverRow) return;   // same row: nothing to redo
    lastEditorHoverRow = row;
    resetEditorHighlight();
    highlightEditorRow(row);
});
editor.container.addEventListener('mouseleave', function() {
    lastEditorHoverRow = -1;    // so re-entering on the same row re-highlights
    resetEditorHighlight();
});
```

`lastEditorHoverRow` throttles the common case: `mousemove` fires constantly, but the
row usually hasn't changed. Resetting it to `-1` on leave matters — otherwise moving the
mouse out and back onto the same line would be treated as "no change" and the highlight
would never come back.

`resetEditorHighlight()` / `highlightEditorRow(row)` branch on `currentDiagramType` and
call the per-diagram pair (`highlightSequenceForRow` / `highlightActivityForRow`). All
three entry paths — mousemove, mouseleave, and cursor change — funnel through this one
dispatch.

### The cursor path

Clicking in the editor fires `changeCursor`, which runs `cursorChangeListener`:

```js
resetEditorHighlight();
highlightEditorRow(editor.getCursorPosition().row);
```

So the highlight follows the caret as well as the pointer.

### Sequence registration

`sequence-operations.js` defines the per-type treatment:

```js
const SEQ_HIGHLIGHTS = {
    participant: attributeHighlight('fill', '#d8d8d8'),
    note:        attributeHighlight('fill', '#d8d8d8'),
    message:     stylePropertyHighlight({fontWeight: 'bold', strokeWidth: '2.0'}),
    group:       stylePropertyHighlight({strokeWidth: '2.0'}),
    box:         stylePropertyHighlight({strokeWidth: '2.0'})
};

function registerSequenceRow(row, el, kind) {
    registerHoverRow(sequenceRowMap, row, el, SEQ_HIGHLIGHTS[kind]);
}
```

Registration happens inside the `setup*Handlers` walk, alongside context-menu binding —
one pass over the SVG does both:

| Element | Registered on |
| --- | --- |
| Participant header rect | its lifeline's `index` (matched to the rect's center-x within ±1) |
| Message element (arrow polygon, line, text) | the **nearest message's** `index`, by `cy` |
| Note shape | the note's `index`; a folded `note` registers **both** its body and fold-corner paths under the same row so they highlight as one unit |
| Group box **and** its keyword tab | **both** `headerIndex` and `endIndex` |
| Box rect | **both** `headerIndex` and `endIndex` |

Registering groups and boxes under two rows is what makes hovering either the opening or
the closing line light up the same block. `registerHoverRow` drops the `-1` case, so an
unclosed group is registered on its header only.

Since every element of a message is registered under one row, hovering that row bolds
and thickens the arrow, its head, and its label together.

`highlightSequenceForRow` bails out while an add-mode gesture is in progress
(`isSequenceAddMode()`), so a ghost arrow/box preview is never polluted by highlights.

### Activity registration

`activity.js` collects targets during `setHandlersForSvg` into
`activityHoverTargets`, one array per type, **in SVG document order**:

```js
{activities, polys, whiles, notes, groups, ellipses, connectors, merges, arrows, forks, title}
```

`buildActivityRowMap(positions)` then zips each array against the matching row list from
`/getActivityPositions`:

```js
const add = (rowsPerElement, targets, style) => {
    for (let i = 0; i < targets.length && i < rowsPerElement.length; i++) {
        for (const row of rowsPerElement[i]) register(row, targets[i], style);
    }
};
```

The `i < targets.length && i < rowsPerElement.length` bound makes a count mismatch
degrade gracefully — the shorter list wins and the extras are simply not highlightable,
instead of throwing.

Note the shape: each element gets a **list** of rows, because a construct can span
several lines. An if/else registers its `if`, `else`, and `endif` rows; a group
registers its start and end; a multi-line activity registers its whole text range.

Treatments vary by type so the highlight reads correctly against each element's normal
fill:

| Style | Applied to |
| --- | --- |
| `FILL_HIGHLIGHT` (`fill` → `#d8d8d8`) | activities, polys, whiles, notes, merges, forks |
| `BOLD_HIGHLIGHT` (`font-weight` → `bold`) | group labels, arrow labels |
| `ELLIPSE_HIGHLIGHT` (`fill` → `#818181`) | start/stop/end markers (already dark) |
| `CONNECTOR_HIGHLIGHT` (`fill` → `#c2c2c2`) | connectors |
| `TITLE_HIGHLIGHT` (`fill` → `#e5e5e5`) | title |

**Arrows and forks are special cases.** An arrow's target is the *array* of its label
text elements, so `register` normalizes to an array and registers each element
separately — the row map holds one element per entry. Forks are registered from
`{el, row}` pairs produced by `labelForks` rather than from the backend table, because
fork rows are derived on the frontend during the walk.

---

## 5. Diagram → Editor

The editor side of the highlight is an **Ace marker**: a full-line background band drawn
behind the text, styled by `.hover` in `css/legacy.css` (`background-color: #56596a`).

### The marker API (`script.js`)

```js
function getmarker(bounds) {                 // one contiguous range
    clearMarkers();
    editor.session.addMarker(new Range(bounds[0], 0, bounds[1], 200), "hover", "fullLine");
}

function setEditorMarkers(bounds) {          // a single row, or a list of rows
    clearMarkers();
    if (typeof bounds === 'number') {
        editor.session.addMarker(new Range(bounds, 0, bounds, 200), "hover", "fullLine");
    } else {
        for (let bound of bounds) {
            editor.session.addMarker(new Range(bound, 0, bound, 200), "hover", "fullLine");
        }
    }
}

function clearMarkers() { /* remove every marker whose clazz === "hover" */ }
```

The distinction matters: `getmarker([start, end])` shades the **whole span** between two
lines (used for groups and boxes, where the block interior should be included), while
`setEditorMarkers([a, b, c])` shades **only the listed lines** (used for an if/else,
where the `if`, `else`, and `endif` lines light up but the branch bodies do not).

`clearMarkers` filters on `clazz === "hover"`, so Ace's own active-line and selection
markers are left alone.

### Wiring

**Activity** — each element's `mouseover` calls
`markEditorForElement(activityElementRows, svgelement)`, which reads the inverse map
built during registration and calls `setEditorMarkers(rows)`. No fetch, no ordinal
re-derivation.

**Sequence** — handlers call the marker functions directly from their cached position
tables:

| Hovered element | Editor effect |
| --- | --- |
| Participant header | `setEditorMarkers(lifeline.index)` |
| Message element | `setEditorMarkers(nearest.index)` |
| Note shape | `setEditorMarkers(note.index)` |
| Group tab / header text | `getmarker([headerIndex, endIndex])` — the whole block |
| Box rect | `getmarker([headerIndex, endIndex])` — the whole block |

`mouseout` calls `clearMarkers()` in every case.

### The message hover highlights the whole message

A sequence message is several SVG elements. Hovering any one of them highlights all of
them, by reusing the row map rather than re-deriving the grouping:

```js
const nearest = findNearestMessage(messageElementCy(svgelement));
const entries = sequenceRowMap.get(nearest.index) || [];
for (const entry of entries) {
    if (findActiveHighlight(sequenceHighlighted, entry.el)) continue;   // editor-owned
    if (findActiveHighlight(sequenceDiagramHover, entry.el)) continue;  // already ours
    const token = entry.style.apply(entry.el);
    if (token === null) continue;
    sequenceDiagramHover.push({el: entry.el, style: entry.style, token: token});
}
setEditorMarkers(nearest.index);
```

`messageElementCy` normalizes each tag to a comparable y: `y1` for a line, `y` for text,
and the mean of the point ys for a polygon.

---

## 6. Two Highlight Owners, One Element

This is the subtlest part of the design. The same shape can be highlighted from the
editor side *and* hovered from the diagram side at the same time, and each has to undo
only its own work.

The sequence module therefore keeps **two separate active lists**:

```js
let sequenceHighlighted  = [];  // applied from the editor side
let sequenceDiagramHover = [];  // applied by a diagram-side message hover
```

The rules that keep them from corrupting each other:

1. **Diagram hover skips editor-owned elements.** If `findActiveHighlight(sequenceHighlighted, el)`
   returns an entry, the hover leaves it alone. The editor side already holds the true
   original and will restore it correctly.
2. **Diagram hover-out restores only its own list.** `sequenceDiagramHover = clearHoverHighlight(sequenceDiagramHover)`
   never touches an editor-owned highlight.
3. **Element-level hover reads through the token.** Participant and note handlers do:
   ```js
   const highlighted = findActiveHighlight(sequenceHighlighted, svgelement);
   rectcolor = highlighted ? highlighted.token.old : svgelement.getAttribute('fill');
   ```
   Without this, hovering an already-editor-highlighted shape would capture `#d8d8d8` as
   the "original" and restore *that* on mouseout, leaving the shape stuck grey.
4. **Mouseout defers when the editor owns the element.**
   `if (findActiveHighlight(sequenceHighlighted, svgelement)) return;` — the editor side
   restores it when the editor hover ends.
5. **`apply` declining (`null`) is the last line of defense** for the case where an
   element is registered twice on the same row.

There is one more guard on the note handlers. `mouseover` bails out early during an
add-mode gesture, which means `notecolor` was never captured — so `mouseout` mirrors the
guard:

```js
if (isSequenceAddMode()) return;
```

Restoring the empty string would blank the paint attribute and render the note **black**.

---

## 7. The Change Highlight

A related but separate use of the same marker machinery: after an edit settles, the
lines that changed are marked.

```js
const debouncedRenderPlantUml = debounce(async () => {
    await renderPlantUml();
    let changedIndices = findChangedLines();
    setEditorMarkers(changedIndices);
}, 200);
```

`findChangedLines()` diffs the current history entry against the previous one with
`Diff.diffLines` and collects the row indexes of added lines. This is why an element
created by a context-menu action appears with its new puml line already highlighted.

Because it uses the same `"hover"` marker class, the next hover (or cursor move) clears
it — `clearMarkers()` runs at the top of both `setEditorMarkers` and `getmarker`, and on
every `changeCursor`.

---

## 8. Backend Row Tables

Both endpoints are called once per render and return, per element type, the puml rows
each element owns.

### `/getActivityPositions` → `activity/positions.py`

Returns a list-of-row-lists per type, in SVG document order:

```json
{"activities": [[3], [5,6]], "polys": [[8, 11, 14]], "whiles": [[…]], "notes": […],
 "groups": […], "ellipses": […], "connectors": […], "merges": […], "arrows": […],
 "title": [1, 2, 3]}
```

The module deliberately **reuses the existing line-finders** rather than duplicating
their logic — `find_text_bounds`, `get_if_line`, `get_while_line`, `find_note_bounds`,
`find_group_bounds`, `find_arrow_bounds`, `find_merge_index`, `find_title_bounds`. Where
a finder can't be reused directly it is mirrored exactly, with the deviation documented:

- `_nth_ellipse_row` mirrors `get_index_ellipse`'s counting (including its skip of lines
  preceded by a `note` keyword) but returns the **matched** row rather than the
  insertion point below it. Its note guard uses `index > 0` to avoid the `lines[-1]`
  wrap that would otherwise skip row 0 whenever the diagram's last line starts with
  `note`.
- `_count_notes`, `_count_groups`, `_count_merges` count elements the way the
  corresponding click handlers do, but without a click target to match against.

`_expand(start, end)` turns a bounds pair into the inclusive row list, returning empty
for invalid bounds. Negative rows are filtered out everywhere (an `if` with no `else`
yields `-1` for the else row), and `registerHoverRow` drops any that slip through.

### `/getSequencePositions` → `sequence/positions.py`

Aggregates the five per-type tables into one response:

```json
{"participants": [{"name": …, "cx": …, "yTop": …, "yBottom": …, "index": …}],
 "messages":     [{"cy": …, "index": …, "text": …}],
 "notes":        [{"cy": …, "index": …}],
 "groups":       [{"headerIndex": …, "endIndex": …}],
 "boxes":        [{"headerIndex": …, "endIndex": …}]}
```

Unlike the activity table, the sub-tables keep their own geometry-carrying shapes —
participants carry lifeline bounds, messages and notes carry SVG y-coordinates —
because sequence elements are matched **spatially**, not purely by ordinal. The same
tables therefore serve double duty: highlighting *and* gesture snapping (the activation
and group gestures snap to the nearest message and send its line index).

This endpoint is a pure transport aggregation. Each sub-table is exactly what its own
`get_*_positions` already returned.

---

## 9. Invariants and Gotchas

**Ordinal agreement is load-bearing.** Any rule that counts elements must be implemented
identically on both sides. The clearest example is group counting: PlantUML emits an
invisible `fill="none"` layout rect alongside each real group box, and both
`_count_group_boxes` (backend) and `setupGroupHandlers` (frontend) skip it by the same
rule — only a rect *immediately following* an `#EEEEEE` tab path counts. If either side
changed, `groupPositions[ordinal]` would address the wrong group and highlighting would
silently point at the wrong lines.

**`-1` means "no line."** A participant introduced implicitly by a message has no
declaration, so its index is `-1`. `registerHoverRow` drops negative rows rather than
letting Python-style negative indexing address the end of the file.

**All state is discarded per render.** `sequenceHighlighted`, `sequenceDiagramHover`,
`sequenceRowMap`, `activityHighlighted`, `activityRowMap`, and `activityHoverTargets`
are all reset when the new SVG is injected. Holding a reference to a node from a
previous render would restore a style onto a node no longer in the document.

**Highlighting is best-effort.** A failed positions fetch returns `null`, tables default
to empty, and the diagram simply isn't highlightable for that render. Nothing else
breaks — this is deliberate, since highlighting is an affordance rather than a function.

**Style restoration is verbatim.** Never "clean up" `stylePropertyHighlight` by clearing
individual properties in `restore`; the literal attribute string is what the element
classifiers match on.

---

## 10. Adding Highlighting to a New Element Type

1. **Backend** — add a `get_X_positions(puml, svg)` that returns the rows each element
   owns, in SVG document order, reusing the existing line-finder for that element. Wire
   it into `get_activity_positions` / `get_sequence_positions`.
2. **Pick a treatment** — `attributeHighlight('fill', …)` for filled shapes,
   `stylePropertyHighlight({…})` for anything whose `style` attribute is matched on by a
   classifier. Add it to `SEQ_HIGHLIGHTS` (sequence) or as a `*_HIGHLIGHT` constant
   (activity).
3. **Register during the walk** — call `registerSequenceRow(row, el, kind)` or push into
   the matching `activityHoverTargets` array, in document order, in the same pass that
   binds context menus. Register multi-line constructs on **every** row they own.
4. **Add the reverse direction** — in `mouseover`, call `setEditorMarkers(index)` for a
   point element or `getmarker([start, end])` for a block, and `clearMarkers()` in
   `mouseout`.
5. **Respect the two owners** — if the element also has an element-level hover recolor,
   read through `findActiveHighlight(sequenceHighlighted, el)` before capturing the
   original, and return early on mouseout when the editor owns it.
