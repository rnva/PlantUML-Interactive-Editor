# Sequence Diagram Features

How every sequence diagram feature works end to end: the gesture the user makes, the
PlantUML syntax it produces, and the backend logic that maps a clicked SVG shape back
to a line of puml.

Backend code lives in `src/plantuml_gui/sequence/`, frontend code in
`src/plantuml_gui/static/sequence-*.js`, and the menus/modals in
`src/plantuml_gui/templates/partials/sequence_menus.html`.

---

## 1. The Common Round Trip

Every sequence interaction follows the same loop:

1. **Render** — The frontend sends the editor's puml to `/render`, gets SVG back, and
   injects it into `#colb`.
2. **Position fetch** — One call to `/getSequencePositions` returns the position table
   for *every* element type (participants, messages, notes, groups, boxes). One
   round-trip per render instead of one per type (`sequence/positions.py`).
3. **Handler binding** — `setHandlersForSequenceDiagram()` walks the SVG elements once
   and attaches context menus, hover handlers, and hover-highlight registrations
   (`setupParticipantHandlers`, `setupMessageHandlers`, `setupNoteHandlers`,
   `setupGroupHandlers`, `setupBoxHandlers`).
4. **Gesture** — The user right-clicks a shape or the background, picks a menu item,
   and possibly performs a two-point gesture (click … move … click) with a live ghost
   preview.
5. **Request** — The frontend POSTs `{plantuml, svg, svgelement, …}` to a route. The
   `svgelement` is the clicked element's `outerHTML`.
6. **Backend edit** — The route's module parses the SVG, resolves the clicked element to
   a **1-based ordinal**, maps that ordinal to a **puml line index**, edits the line
   list, and returns the joined text.
7. **Re-render** — `setPuml()` writes the returned puml back into the editor, which
   triggers a fresh render, and the loop starts over.

The backend never holds state. Everything it needs is in the request body.

### Two ways an element is identified

| Strategy | Used by | How |
| --- | --- | --- |
| **Ordinal matching** | notes, groups, boxes, participants, messages | Count matching shapes in SVG document order; the Nth shape is the Nth matching puml construct. |
| **Spatial matching** | message insertion, note attachment, activation bars, box/group ranges | Compare SVG coordinates (`cx`, `cy`) against participant lifelines and message rows. |

SVG document order matches puml source order for every construct here, which is what
makes ordinal matching valid.

---

## 2. SVG Signatures

PlantUML gives no ids or classes, so every element type is recognized by shape and
style. These signatures are the foundation of the whole module — several of them
collide, and the tie-breakers matter.

| Element | Tag | Signature |
| --- | --- | --- |
| Participant header | `rect` | `style="stroke:#181818;stroke-width:0.5;"` **and** has `rx`/`ry` (rounded corners) |
| Participant box | `rect` | Same style, **no** `rx`/`ry`, solid `fill`, **and geometrically encloses a participant header** |
| `rnote` | `rect` | Same style, no `rx`/`ry`, encloses **no** participant header |
| `note` | two `path`s | Body path with 6 points (`d.count("L") + 1 == 6`), immediately followed by the small fold-corner path |
| `hnote` | `polygon` | Exactly 7 points (hexagon) |
| Activation bar | `rect` | `stroke-width:1.0` |
| Group box | `rect` | `fill="none"`, immediately preceded by its `#EEEEEE` keyword tab `path` |
| Message arrow | `polygon` + `line` | `stroke-width:1.0` |
| Message text | `text` | `font-size="13"`, not bold, not anchored to a note shape |
| Participant name text | `text` | `font-size="14"` |
| Group keyword/label | `text` | bold, `font-size` 13 or 11 |
| Lifeline | `line` | `stroke-dasharray:5.0,5.0` |

Three collisions worth calling out:

- **Box vs. rnote** — byte-identical attributes. Told apart *only* by
  `rect_encloses()`: a box wraps at least one participant header, an rnote never does
  (`sequence/box.py::is_box_rect`).
- **Group box vs. PlantUML's invisible layout rect** — PlantUML emits an extra
  `fill="none"` rect for layout. Only a rect *immediately following* an `#EEEEEE` tab
  path counts as a real group (`_count_group_boxes` on the backend,
  `setupGroupHandlers` on the frontend — the same rule, applied twice, and they must
  not drift).
- **Note detection is never by fill color**, only by shape and stroke, so it keeps
  working now that note colors are user-editable.

---

## 3. Participants

**Module:** `sequence/participant.py` · **Frontend:** `sequence-operations.js`

### Recognizing a participant

`Participant` (in `sequence/classes.py`) carries `name`, `cx`, `cy`, `x_origin`,
`width`, and `index` (its puml line). PlantUML draws **two** header rects per
participant (top and bottom), so `Diagram._parse_participants` deduplicates by center-x
— the same rule `index_of_clicked_participant` uses when counting to the clicked rect.

### Line assignment

`_assign_participant_indexes` matches declarations to participants **by name, not by
position**:

```python
PARTICIPANT_DECLARATION_RE = r'^participant\s+(?:"(?P<quoted>[^"]*)"|(?P<bare>[^\s#]+))'
```

This handles `participant Alice` and `participant "Long name" as A`, ignoring trailing
`as`/`order`/`#color` modifiers — only the *displayed* name matters, because that is
what the SVG gives back.

Why by name: a participant can be introduced **implicitly** by a message
(`Alice -> Bob: hi`) and have no declaration line at all. Zipping declarations against
diagram-ordered participants would shift every later participant onto the wrong line.
Participants with no declaration keep `index = -1`, which is honest — there is no line
to point at. Each declaration is claimed at most once, so repeated display names map to
distinct lines.

### Operations

| Action | Gesture | Result |
| --- | --- | --- |
| **Rename** | Double-click the header, or right-click → *Rename* | `/getParticipantName` fills the modal; `/editParticipantName` applies it |
| **Add left/right** | Right-click → *Add Participant* ⬅/➡ | Inserts `participant participantN` at the neighbor's line index |
| **Delete** | Right-click → *Delete Participant* | Cascade delete |
| **Box** | Right-click → *Box ▢* | See [§8](#8-participant-boxes) |

**Add** picks the next free `N` by scanning existing `participant participantN` names
(`_next_participant_number`), then inserts at `participant.index` (left) or
`participant.index + 1` (right).

**Rename** HTML-escapes the new name and does a whole-document
`puml.replace(old, new)` — deliberately, so every message and note referencing the
participant is renamed too. The cost is that the old name is replaced everywhere it
appears, including inside message text.

**Delete is a cascade.** It removes:
- the participant's declaration line,
- every message whose `from_participant` or `to_participant` is this participant,
- every note whose *header* (the part before `" : "`) mentions the name — and for a
  block note, the **entire region** including body and `end note`, not just the opening
  line, since an orphaned body breaks the diagram.

### Positions

`get_participant_positions` pairs each participant with its lifeline's vertical bounds,
found by scanning `line` elements for `stroke-dasharray:5.0,5.0` and matching x within
±1 (stroke width shifts `cx` by a fraction). The result —
`{name, cx, yTop, yBottom, index}` — is the frontend's `participantLifelines`, and it
drives nearly every other gesture: finding the lifeline under the cursor, snapping a
message endpoint, anchoring a note, and resolving a box range.

---

## 4. Messages

**Module:** `sequence/message.py` · **Frontend:** `sequence-message.js`

### Recognizing a message

Message detection has to agree in two places — SVG parsing and puml parsing — or
messages and their source lines fall out of alignment. Both use `ARROW_RE` from
`sequence/classes.py`:

```python
ARROW_RE = re.compile(
    r"<{1,2}[-\\/]*(?:\[#[^\]]*\])?[-\\/]*(?:>{1,2}|[xo])?"   # starts with '<'
    r"|[-\\/]+(?:\[#[^\]]*\])?[-\\/]*(?:>{1,2}|[xo])"          # ends with a head
)
```

`is_message_line()` only inspects the part **before the first colon** and requires the
matched arrow to contain a real dash. That rejects two look-alikes: a group label like
`alt <size:12>…` (a bare `<` before a colon) and notes whose arrow appears only after
the colon. Requiring a head keeps the `-` in `Web-Server` from being read as an arrow.

On the SVG side, `Diagram._parse_messages` walks elements in document order and matches
tag patterns:

| Pattern | Message kind |
| --- | --- |
| `polygon, polygon, line, text` | bidirectional (`<->`, `<-->`) |
| `line, line, line, polygon, text` | self-message |
| `polygon, line, text` | normal (`->`, `-->`, `<-`) |

Endpoints are resolved by `_participant_at(x)`: the participant whose header spans `x`,
else the **nearest by cx**. The fallback keeps parsing robust when an activation bar
shifts where an arrow meets the lifeline — without it a slightly-off endpoint would
raise and turn the request into a 500.

`_assign_message_indexes` then zips SVG-ordered messages against `is_message_line`
matches in source order.

### Adding a message

A two-click gesture (`setupLifelineInteraction` in `sequence-message.js`):

1. Right-click on or near a lifeline → *Add Message* (solid `->` or dashed `-->`).
   The right-click position is stored as `firstClickCoordinates` / `messageOrigin`.
2. Move the mouse — a **ghost arrow** previews to whichever lifeline is nearest.
3. Click to confirm the destination; a modal collects the label.
4. `/addMessage` receives both coordinate pairs plus `arrowtype`.

The backend snaps each x to the closest participant (`_find_closest_participant`) and
picks the insertion line with `find_insertion_index()` (see [§9](#9-shared-behavior)),
producing `Sender -> Receiver: text`.

### Editing, coloring, deleting

Right-click a message arrow or its text → *Edit Message* / *Delete Message*.

`index_of_clicked_message` re-walks the same tag patterns as the parser and checks the
clicked element against each group's members. Multi-line messages (`A -> B: a\nb`)
render extra `text` siblings after the group; `_is_continuation_text` attributes them to
the same message, so clicking *any* line of the label resolves correctly. A click that
resolves to nothing returns `-1`, and every caller checks it — otherwise
`messages[-1 - 1]` would silently edit an unrelated message.

Arrow color is stored as a `[#color]` token inside the arrow itself.
`_apply_arrow_color` strips any existing token and re-inserts the new one right after
the arrow's first dash, PlantUML's canonical placement:

```
->     →  -[#red]>
-->    →  -[#red]->
<->    →  <-[#red]->
```

Color semantics follow `resolve_color()`: `None` leaves it unchanged, `""`/`"none"`
clears it, anything else replaces it. Named colors and hex both work.

### Positions

`get_message_positions` returns `{cy, index, text}` per message. This table is what the
activation and group gestures snap to.

---

## 5. Activation Bars

**Module:** `sequence/activation.py` · **Frontend:** `sequence-activation.js`

An activation bar is always created as a **balanced pair** — one gesture inserts both
`activate` and its closing line, so a participant can never be deactivated without first
being activated.

### The gesture

1. Right-click a lifeline → *Activate*. The start snaps to the **nearest message** by y
   (`findNearestMessage`); bail out early if there are no messages to anchor to.
2. Move the mouse — a ghost bar previews down to the nearest message **at or below**
   the start.
3. Click to confirm the end, then choose **Deactivate** or **Destroy ✕** from a small
   menu.
4. `/addActivation` receives `participant`, `startMessageIndex`, `endMessageIndex`,
   `endType`.

<kbd>Esc</kbd> cancels at any point in the flow.

### The edit

```python
lines.insert(end_index + 1,   f"{keyword} {participant_name}")   # deactivate | destroy
lines.insert(start_index + 1, f"activate {participant_name}")
```

Both lines anchor **below** their nearest message, so the bar covers the messages
*following* the start message up to and including the end message. The closing line is
inserted first because it sits at the greater-or-equal index — inserting it second would
invalidate `start_index`. (The same "insert the later line first" trick appears in
groups and boxes.)

### Deleting

Right-clicking an activation bar (`stroke-width:1.0`) reveals *Delete activation bar*.
There are no ids to match on, so `delete_activation` reconstructs geometry:

- `_activation_pairs` pairs each `activate X` with its closing line using a **stack**,
  so nested bars pair correctly, and records the nesting `level`.
- For each pair, the expected top is the `cy` of the message just above the `activate`
  line, and the expected center is `participant.cx + level * (width / 2)` — mirroring
  how PlantUML offsets nested bars to the right.
- The pair with the smallest combined distance to the clicked rect wins, and **only its
  two lines** are removed.

---

## 6. Notes

**Module:** `sequence/note.py` + `sequence/util.py` · **Frontend:** `sequence-operations.js`

### Three types, one grammar

`note` (folded corner), `hnote` (hexagon), and `rnote` (plain rectangle) support the
same placement grammar identically. `NOTE_KEYWORDS` is the single list, and
`_normalize_note_type` falls back to `"note"` for anything unrecognized — the value
comes straight from client JS, so it is untrusted.

### Placements

| Menu item | Produces |
| --- | --- |
| Over this participant | `note over A : text` |
| ⬅ Left | `note left of A : text` |
| Right ➡ | `note right of A : text` |
| Spanning participants | `note over A, B : text` |

### The gesture

Right-click a lifeline → *Add Note* → pick a **type** → pick a **placement** → fill the
modal. Spanning placement adds a second-participant dropdown populated from
`participantLifelines` (excluding the origin).

### Message-attached notes

If placement is `left` or `right` and the click lands within `MESSAGE_NOTE_TOLERANCE`
(10 SVG units) of a message **and** the x falls inside that message's horizontal span,
`add_note` switches to the message-attached form and inserts it right after the message:

```
Alice -> Bob: hello
note right : attached to the message above
```

Self-messages are skipped as candidates — they have no horizontal span to test against.
Otherwise the note is placed by y with `find_insertion_index()`.

### Regions: single-line vs. block

A note is either one line (`note over A : text`) or a block:

```
note over A
  first line
  second line
end note
```

`note_regions()` returns the `(start, end)` line range of every note in source order —
`end == start` for single-line notes. It **skips block bodies while scanning**, so a
body line that happens to begin with `note ` is never miscounted as its own note. That
is what keeps the puml note count aligned with the one-shape-per-note count from
`iter_note_shapes()` — the two must agree for ordinal matching to work.

`is_note_end_line` accepts `end note`, `endnote`, `end hnote`, `end rnote`, case
insensitively; PlantUML lets `end note` close any type.

### Editing

*Edit Note* fetches text, type, and color in a single lookup
(`get_note_text_and_type`) and shows them in the modal. On submit, `edit_note` can
change all three at once:

- **Text** — single-line notes get `\n`-escaped inline text; block notes have their
  **body lines replaced** while the opening line and `end note` are preserved.
- **Type** — `_swap_note_keyword` swaps just the leading keyword, preserving indentation
  and the placement clause exactly.
- **Color** — a `#token` at the end of the placement clause
  (`note over A #LightBlue : text`). `_NOTE_COLOR_RE` requires a leading space so a `#`
  inside a participant name (`note over C#`) is never read as a color.

### Deleting

Removes the whole region — for a block note that means the opening line, every body
line, and `end note`.

### Hover

Note **text** has `pointer-events: none` so clicks fall through to the shape. A `note`
renders as *two* paths (body + fold corner); both are registered under the same ordinal
so they highlight and recolor as one visual unit.

---

## 7. Groups

**Module:** `sequence/group.py` · **Frontend:** `sequence-group.js`

Supported keywords: **`group`**, **`alt`**, **`opt`**, **`loop`** (`VALID_GROUP_TYPES`).
A group wraps a range of messages in `<keyword> <label> … end`.

### The gesture

Right-click a lifeline → *Add Group ▢* → pick a keyword → the start snaps to the
nearest message → move (ghost box previews the range) → click to confirm the end → a
modal collects the label.

`/addGroup` normalizes the range so bottom-to-top selection works, then:

```python
lines.insert(end + 1, "end")
lines.insert(start, f"{group_type} {label}")
```

An invalid `groupType` returns **400** with `{"error": …}`.

### Clicking a group

Only the **keyword tab** and its **header text** open the group menu — not the box
interior, which would hijack lifeline right-clicks for everything inside the group.
Whichever of the two is clicked, `openGroupContextMenu` records the **box rect** as the
clicked element, because that is what the backend matches on (by x/y).

### Rename and delete

- **Rename** keeps the keyword and replaces the label; an empty label leaves a bare
  keyword.
- **Delete unwraps** — it removes only the header and its matching `end`. Contents
  (messages, notes, nested groups) stay in place. `_find_group_end_index` tracks nesting
  depth so a nested group's `end` is never mistaken for this one's.

---

## 8. Participant Boxes

**Module:** `sequence/box.py` · **Frontend:** `sequence-box.js`

A box groups contiguous participants behind a bordered rectangle:

```
box "Backend" #LightBlue
participant API
participant DB
end box
```

### The gesture

Right-click a **participant header** → *Box ▢* → move horizontally (ghost box previews
the participant range) → click the far participant. No modal: the box is created bare,
and title/color are added afterwards via *Edit Box*.

### Nesting, crossing, and teoz

`_needs_teoz_or_raise` classifies the requested range against existing boxes:

- **Disjoint** → plain insert.
- **Nested** (one range fully contains the other) → `!pragma teoz true` is inserted once
  after `@startuml`, since PlantUML's default engine can't render nested boxes.
- **Crossing** (partial overlap) → `ValueError` → **400**, because PlantUML cannot
  render it at all.

A participant with `index == -1` (introduced implicitly by a message, never declared)
raises with a message telling the user to declare it first. Without that check,
`lines.insert(-1, …)` would put `end box` above `@startuml` and turn the box inside out.

### Editing

*Edit Box* / *Delete Box* appear in the **background** context menu when the right-click
falls inside a box's bounds (`findEnclosingBox`). The box rect gets no handler of its
own — it covers the lifeline area, so one would hijack every lifeline right-click
inside the box.

`_parse_box_header` reads back the title and color: the title is the quoted string
(HTML-unescaped), and the color is searched for **only outside** the quoted title, so a
`#` inside a name (`box "C#"`) isn't mistaken for a color. `edit_box` rewrites the
header through the same `_box_header` builder used by `add_box`, so escaping and color
formatting can't diverge between create and edit.

**Delete unwraps**, like groups: header and matching `end box` go, contents and the teoz
pragma stay (remaining nested boxes still need it).

---

## 9. Shared Behavior

### Insertion by y-coordinate

`find_insertion_index()` (`sequence/util.py`) decides where a new message or note goes.
It builds a list of `(cy, line_index)` for **every message and note**, sorts by `cy`,
and returns the line index of the first element below the click. If nothing is below,
it inserts before `@enduml`. Considering both types is what makes insertion between a
message and a nearby note land correctly.

### Colors

`resolve_color()` centralizes the semantics shared by messages, notes, and boxes:

| Incoming value | Effect |
| --- | --- |
| `None` (field absent) | leave existing color unchanged |
| `""` or `"none"` | clear the color |
| anything else | replace it |

The palette (`color_select` macro) offers 11 named colors plus *None*. A color that
isn't in the palette — a hex value, or a name not listed — is preserved by
`setColorSelect` as a temporary custom option, so editing round-trips it instead of
silently resetting to *None* and clearing it on save.

### Multi-line text

`escape_multiline_text` converts real newlines to a literal `\n` so the text stays on
one PlantUML line; `unescape_multiline_text` reverses it for display in the modal. Block
notes are the exception — their body genuinely spans lines.

### Editor ↔ diagram hover highlighting

Both directions run through the shared core in `static/hover-highlight.js`:

- **Diagram → editor** — hovering a shape calls `setEditorMarkers(lineIndex)` (or
  `getmarker([header, end])` for a group's whole range).
- **Editor → diagram** — moving the cursor over an editor row looks up
  `sequenceRowMap` and highlights every shape registered on that row.

`registerSequenceRow(row, el, kind)` builds that map during the handler walk and drops
any `-1` line. The map is rebuilt from scratch on every render, since the old SVG nodes
are gone.

See `docs/hover_highlighting.md` for the full mechanism.

---

## 10. Route Reference

All routes are on `sequence_bp` (`sequence/routes.py`) and return JSON.

| Route | Input | Returns |
| --- | --- | --- |
| `/getSequencePositions` | `plantuml`, `svg` | `{participants, messages, notes, groups, boxes}` |
| `/addParticipant` | + `svgelement`, `direction` | `{plantuml}` |
| `/getParticipantName` | + `svgelement` | `{name}` |
| `/editParticipantName` | + `svgelement`, `name` | `{plantuml}` |
| `/deleteParticipant` | + `svgelement` | `{plantuml}` |
| `/addMessage` | + `message`, `firstcoordinates`, `secondcoordinates`, `arrowtype` | `{plantuml}` |
| `/getMessageText` | + `svgelement` | `{text, color}` |
| `/editMessageText` | + `svgelement`, `text`, `color?` | `{plantuml}` |
| `/deleteMessage` | + `svgelement` | `{plantuml}` |
| `/addActivation` | `participant`, `startMessageIndex`, `endMessageIndex`, `endType` | `{plantuml}` |
| `/deleteActivation` | + `svgelement` | `{plantuml}` |
| `/addNote` | + `participant`, `placement`, `text`, `yPosition`, `xPosition?`, `secondParticipant?`, `noteType?` | `{plantuml}` |
| `/getSeqNoteText` | + `svgelement` | `{text, noteType, color}` |
| `/editSeqNote` | + `svgelement`, `text`, `noteType?`, `color?` | `{plantuml}` |
| `/deleteSeqNote` | + `svgelement` | `{plantuml}` |
| `/addGroup` | `groupType`, `label`, `startMessageIndex`, `endMessageIndex` | `{plantuml}` or **400** `{error}` |
| `/getSeqGroupLabel` | + `svgelement` | `{type, label}` |
| `/renameSeqGroup` | + `svgelement`, `label` | `{plantuml}` |
| `/deleteSeqGroup` | + `svgelement` | `{plantuml}` |
| `/addBox` | `startParticipantIndex`, `endParticipantIndex`, `title?`, `color?` | `{plantuml}` or **400** `{error}` |
| `/getSeqBoxLabel` | + `svgelement` | `{title, color}` |
| `/editSeqBox` | + `svgelement`, `title`, `color` | `{plantuml}` |
| `/deleteSeqBox` | + `svgelement` | `{plantuml}` |

See `docs/routes.md` for the full per-field descriptions.

---

## 11. Adding a New Sequence Feature

The path of least surprise, following the existing modules:

1. **Find the SVG signature** — render a sample, inspect the output, and pick a
   tag + style/geometry test that can't collide with an existing signature. If it does
   collide (as box/rnote does), find a geometric tie-breaker.
2. **Write `index_of_clicked_X`** — count matching shapes in document order, match the
   clicked one by its identity attributes (`points` for polygons, `d` for paths, x/y for
   rects).
3. **Write `_find_X_line_index`** — count the matching puml construct to the same
   ordinal. If the construct can span lines, write a `regions`/`spans` helper that skips
   bodies, and track nesting depth with a stack for anything that nests.
4. **Add the operations** — get / add / edit / delete, all as pure line-list edits.
   When inserting a pair, insert the later line first.
5. **Add positions** — a `get_X_positions` returning line indexes, wired into
   `get_sequence_positions`.
6. **Wire the frontend** — a `setupXHandlers` walk for context menus and hover, plus
   the menu/modal markup in `sequence_menus.html`.

Two rules worth repeating: any counting rule implemented on both sides (like the group
tab pairing) must stay identical in both places, and any ordinal lookup that can fail
must return `-1` and be checked — a negative index is a *valid* Python index and will
quietly corrupt the diagram.
