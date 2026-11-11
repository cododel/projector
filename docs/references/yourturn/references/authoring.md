# Authoring a page

Every yourturn artifact is one page with the same shape. Use it to help the
user understand something you made or found (a change set, an architecture, a
bug, a plan), to collect input, or both. It replaces a wall of chat text with a
page that is easy to read and can be read aloud.

A code or PR review has rules of its own, see `review.md`.

## The format

```json
{
  "title": "What changed in auth",
  "spec": {
    "root": "page",
    "state": { "merge": "" },
    "elements": {
      "page": {
        "type": "Page",
        "props": { "overview": "I moved **token checking** out of the HTTP layer. Tests are now much simpler." },
        "children": ["why", "moved", "decide"]
      },
      "why": { "type": "Section", "props": { "heading": "Why I changed it" }, "children": ["t1"] },
      "t1": {
        "type": "Text",
        "props": { "text": "Auth was tied to the request object. You could not test it alone. Every test had to fake a full **HTTP request**." }
      },
      "moved": { "type": "Section", "props": { "heading": "One function checks tokens" }, "children": ["t2", "d1"] },
      "t2": { "type": "Text", "props": { "text": "There is now one function called **verifyToken**. The middleware just calls it." } },
      "d1": {
        "type": "Diff",
        "props": { "path": "src/auth.ts", "note": "The middleware shrinks to one call.", "source": { "mode": "dirty-tree" } }
      },
      "decide": { "type": "Section", "props": { "heading": "One thing to decide" }, "children": ["t3", "t4", "q1"] },
      "t3": { "type": "Text", "props": { "text": "The new check needs a field that older tokens lack. So it rejects them, and everyone logged in now gets logged out once." } },
      "t4": { "type": "Text", "props": { "text": "A **migration** can add that field to old tokens first. It takes about a day. I would wait, because a surprise logout looks like a bug to users." } },
      "q1": {
        "type": "RadioGroup",
        "props": { "label": "When should it ship?", "options": [{ "label": "Now, everyone logs in again once", "value": "now" }, { "label": "After the migration, a day later (my pick)", "value": "later" }], "value": { "$bindState": "/merge" } }
      }
    }
  }
}
```

The `spec` uses json-render's **flat** format: a `root` element id, an
`elements` map keyed by id (each `{ type, props, children?: string[] }`) and an
optional `state` object with seed values.

Rules, checked by `create.mjs`:

- The root element is a `Page` with `{ overview, width }`. `overview` is the
  big picture in 1 to 3 sentences. Leave it out only on a page with nothing
  to explain, like a raw diff. `width` is `"base"` or
  `"wide"`, default `"base"`. On a wide page the `Code` and `Diff` cards take
  the width of the window and the text keeps its reading width. Use it when
  the code is the point, like a raw diff review.
- Its children are `Section` elements with `{ heading }`. Nothing else goes
  directly under the `Page`.
- A section's children are blocks. A block is any other component below, or
  one of the project's own components, see `components.md`.
- Every element lives in `elements` keyed by a unique id. Containers reference
  children by id in `children` (an array of strings).
- A prop marked optional below can be left out or set to `null`. An unknown
  prop or a wrong type is an error that names the element.

Put an input where its question comes up, right after the text that explains
it. Bind its value to a JSON Pointer path with `{ "$bindState": "/path" }` and
seed it in `spec.state` under the same path, see "Inputs". The result is
the full state model, so plan your paths (e.g. `/form/email`).

## What the page adds itself

Do not add any of these to a spec.

- The submit button, after the last section.
- An "Anything to add?" text area, so the user can always reply. Its text
  comes back as `result.comment`.
- Comments on lines of any `Code` or `Diff` card: hover the gutter, click the
  plus, write a note. They come back as `result.comments`.
- The section outline on wide screens, made from the section headings. Under
  a section it lists the files of a `Diff` that shows a whole change, with a
  dot on each file the user commented on.
- A fixed bottom player: prev sentence, play/pause, next sentence. The spoken
  sentence is highlighted and scrolled into view. The user can click any
  sentence to start reading from it. The player uses the browser's
  `speechSynthesis`. When it reaches an input it says "Your turn", marks the
  input and stops. The user answers and presses play to go on. Inputs in a
  row are one stop.
- A small feedback toolbar in the bottom-right corner. The user can drop image
  files onto the page, select an element and capture it as a screenshot, or
  comment on selected text. Those come back in `feedback.attachments`. Its
  list also shows the comments on lines, which stay in `result.comments`.

```ts
type Result = {
  // ...your bound state paths
  comment?: string;
  comments?: {
    card: number; // 1-based order of the card in the page
    path: string;
    side: "old" | "new" | null; // null for code cards
    startLine: number;
    endLine: number;
    snippet: string | null; // the commented lines
    body: string;
  }[];
};
```

Do not bind your own fields to `/comment` or `/comments`.

Use `**word**` inside any text to highlight a keyword. Read-aloud ignores the
marks. Keep a mark inside one sentence.

## Writing rules

Follow the shared writing rules in `SKILL.md`. On top of those:

- 3 to 6 sections. A guided review may need more, one per idea.
- Sentences must make sense read aloud: no tables, code blocks, file paths
  lists or symbols like `->`. Name things in words. Put code in a `Code` or
  `Diff` card instead.
- If the explanation is about a code change and a few lines make it clearer,
  add a `Diff` or `Code` block right after the `Text` block that introduces
  it. For a real change prefer `Diff` with `source` (see `DiffSource` below,
  `path` is repo-relative). yourturn reads the real file
  from git and the reader can expand the hidden lines around each change. The
  card shows every change in that file. To talk about one change, add
  `contains` with a short snippet from a changed line (added or removed), for
  example `"Math.max(amount"`. Other changes stay in the file as plain code.
  No match is an error. Do not read whole diffs just to fill `contains`: use
  text you already know, or list the changes cheaply with
  `node scripts/changes.mjs [dirty-tree|staged|unstaged] [-- paths...]` (or
  `range <base> <head>`), which prints one line per change like
  `L20-21  +2 -2  <first changed line>`. Copy a piece of that line. Paste `content` only for a hunk that is not in git, and use `Code` for
  a snippet worth seeing whole. Never paste whole files. Skip cards when words are enough. The player says
  "Code block" and waits 1 to 6 seconds (longer for longer code) so the user
  can look. The code itself is not read aloud, so the `note` must say the
  point on its own. When the card holds several things or the point is easy
  to miss, name one keyword from the code in the `note` or the text before it
  (an identifier or a short phrase, like **Math.max**), so the reader can spot
  the matching line at once. Skip it when the card is short and obvious.
- To explain a change set, go from broad to specific: first the contract or
  intent (new type, interface, config, public API), then the key design
  decisions in the order they affect each other, then the call site that ties
  it together. Name the concept in headings ("One function checks tokens"), not
  the code action ("Added verifyToken"). Say why, not what: the constraint,
  the tradeoff, what would break without it. Pick the 4 to 7 most important
  changes and skip the rest.
- A page that only collects input can be shorter: one or two sections, with a
  line of `Text` before the fields that says what they are for.

Dense, from a real page:

> **Settled:** the listener gets no signal, and drawing keeps `next`, your
> way. Every slot is a middleware chain like the actions, so round 9's "parts
> or null, the core joins" is withdrawn. **The cost you accept:** a draw that
> forgets `...next(input)` empties the slot.

The same, plain. It names one thing, says it in words and follows on:

> Drawing now works like actions. Each extension gets what the ones before
> it drew and passes on its own version, as you asked. So the idea from last
> round, where the core glued the parts together, is gone. There is one
> catch. An extension that forgets to pass on what it got wipes out its spot
> on the screen, for example the whole footer.

## Text, code and images

`Text`, `Heading`, the `note` of a card, the `title` and `caption` of a
diagram and the steps of a `StepNav` are read aloud. The player announces a
card, a diagram and an input, see above. A diagram is announced as "Diagram"
after its caption, with a pause of 1 to 6 seconds (longer for more boxes).
Its boxes, arrows and steps are not read, so the caption must say the point
on its own. Everything else is skipped.

| Component | Props | Notes |
|-----------|-------|-------|
| `Text` | `text`: string, `muted`: boolean (optional) | One paragraph. `muted` makes it small helper copy. |
| `Heading` | `text`: string | Sub-heading inside a section. The section's own `heading` is usually enough. |
| `Code` | see below | Card with a short piece of code. |
| `Diff` | see below | Card with the changes of one file, or of the whole change. |
| `Image` | `src`: string, `alt`: string, `caption`: string (optional) | An image from the artifact's `assets/` folder, see "Assets". |
| `Divider` | none | Horizontal rule. |

```ts
type CardComment = {
  author?: string; // label, e.g. "Agent Reviewer"
  side?: "old" | "new"; // diff cards only, default "new"
  startLine: number; // new-file line (old-file line when side is "old")
  endLine?: number;
  body: string; // plain words, 1-2 sentences
};

type Code = {
  path: string; // shown in the card header
  content: string; // plain code
  note?: string | null; // one plain sentence on why it matters, read aloud
  comments?: CardComment[]; // your review notes, see `review.md`
};

type Diff = {
  path?: string; // repo-relative when using source. Without it: the whole change, see `review.md`
  note?: string | null;
  source?: DiffSource; // the real change from git
  oldPath?: string; // previous name, only for a renamed file
  contains?: string | string[]; // show only the changes with this text
  content?: string; // or a pasted unified diff (one file, with ---/+++ and @@)
  comments?: (CardComment & { path?: string })[]; // `path` only on the whole change
};

type DiffSource =
  | { mode: "unstaged" | "staged" | "dirty-tree"; paths?: string[] }
  | { mode: "merge-base-range"; base: string; head: string; paths?: string[] };
```

A `Diff` takes either `source` or `content`, never both. `contains`, `oldPath`
and `content` need a `path`. `paths` in a source is for the whole change.

| Source mode | What it shows |
|---|---|
| `"unstaged"` | Unstaged changes (`git diff`) and untracked files |
| `"staged"` | Staged changes (`git diff --cached`) |
| `"dirty-tree"` | Everything against HEAD (`git diff HEAD`) and untracked files |
| `"merge-base-range"` | What `head` added since it left `base` (`git diff base...head`) |

`create.mjs` snapshots a `Diff` with `source` when it writes the artifact, so
the page shows the change as it was at that moment.

## Assets

An artifact is a folder, so it can carry files. `create.mjs` prints the
artifact `path`. Copy images into `<path>/assets/` before you run `open.mjs`
and refer to them by relative path:

```json
{ "type": "Image", "props": { "src": "assets/before.png", "alt": "The old login screen", "caption": "Before the change." } }
```

`src` must be relative and stay inside `assets/`. Absolute paths, `..` and
URLs are rejected.

## Inputs

All inputs take `label` and an optional `help` string. Bind the value prop with
`$bindState`.

| Component | Value prop | Other props |
|-----------|-----------|-------------|
| `TextField` | `value` (string) | `type`: `"text" \| "email" \| "number" \| "url"`, `placeholder`, `required` |
| `Textarea` | `value` (string) | `placeholder`, `rows` (number), `required` |
| `Select` | `value` (string) | `options`, `placeholder`, `required` |
| `RadioGroup` | `value` (string) | `options` |
| `Checkbox` | `checked` (boolean) | none |

`options` is an array of either bare strings (`["A", "B"]`) or
`{ "label": "...", "value": "..." }` objects.

Never pre-pick a choice. A picked option comes back looking like the user's
decision, even when they only had questions.

- Seed a `RadioGroup` or `Select` with `""`, so nothing is picked.
- Mark the option you recommend in its label and keep its value plain, like
  `{ "label": "After the migration (my pick)", "value": "later" }`.
- Use a `Checkbox` only when unticked is a real answer, like a setting, and
  seed it with `false`. A decision like "fix this or not" is a `RadioGroup`.
- `required` only adds a star. The page still sends an empty answer.

There is no password field. Answers are saved to disk and a page may be
deployed, so never ask for a secret on a page.

A page that only collects input:

```json
{
  "title": "Tell us about you",
  "spec": {
    "root": "page",
    "state": { "form": { "name": "", "role": "", "notes": "", "remote": false } },
    "elements": {
      "page":   { "type": "Page", "props": { "overview": "A few questions so I can set up **your profile**." }, "children": ["who"] },
      "who":    { "type": "Section", "props": { "heading": "Who you are" }, "children": ["name", "role", "remote", "notes"] },
      "name":   { "type": "TextField", "props": { "label": "Name", "value": { "$bindState": "/form/name" }, "required": true } },
      "role":   { "type": "Select", "props": { "label": "Role", "value": { "$bindState": "/form/role" }, "options": ["Engineering", "Design", "Product"] } },
      "remote": { "type": "Checkbox", "props": { "label": "Works remotely", "checked": { "$bindState": "/form/remote" } } },
      "notes":  { "type": "Textarea", "props": { "label": "Notes", "value": { "$bindState": "/form/notes" }, "rows": 3 } }
    }
  }
}
```

Submitting yields:

```json
{
  "type": "form",
  "version": 1,
  "result": {
    "form": { "name": "...", "role": "...", "remote": true, "notes": "..." }
  },
  "feedback": { "attachments": [] },
  "errors": []
}
```

## Layout, slides and diagrams

| Component | Props | Notes |
|-----------|-------|-------|
| `Stack` | `gap`: `"sm" \| "md" \| "lg"` (optional) | Vertical container. |
| `Columns` | `gap`: `"sm" \| "md" \| "lg"` (optional) | Responsive two-column layout. Use for paired fields or content that benefits from side-by-side layout on wide screens. |
| `Card` | `title`: string (optional), `tone` (optional) | Bordered container with optional title. Use it only for grouped subcontent that needs a visible frame. |
| `Slideshow` | `slides`: `{ title, body? }[]` | Paginated slides with prev/next nav. Display-only. |
| `DiagramFlow` | `title`?, `caption`?, `shape`? (`"flow"` or `"stack"`), `direction`? (`"down"` or `"right"`), `nodes`: `{ id, label, detail?, icon?, tone?, group?, items? }[]`, `groups`?: `{ id, label, tone? }[]`, `edges`?: `{ from, to, label?, step?, kind? }[]` | Boxes and arrows, laid out for you. Use only when the picture says something the words can't. Node ids must be unique. |
| `StepNavHorizontal` | `steps`: `{ title, detail?, status? }[]` | Display-only step rail for short flows. Its steps are read aloud. Prefer this when progress context helps but a sidebar would waste space. |
| `StepNavVertical` | `steps`: `{ title, detail?, status? }[]` | Display-only side rail for longer walkthroughs or dense wide layouts. Its steps are read aloud. Use only when the side space is worth it. |

Use `Slideshow` when you need to walk the user through something before they
answer: architecture decisions, a summary of changes, a step-by-step
explanation, a before/after review.

```json
{
  "slides": {
    "type": "Slideshow",
    "props": {
      "slides": [
        { "title": "Why we refactored", "body": "The old approach coupled auth tightly to the HTTP layer, making unit tests painful." },
        { "title": "What moved", "body": "Auth logic is now in a standalone verifyToken() function. The middleware just calls it." },
        { "title": "What stayed the same", "body": "Public API surface, error codes, and all existing tests are unchanged." }
      ]
    }
  }
}
```

Draw a diagram only when the picture says something the words can't: who
talks to whom, what goes where, what sits on what. One idea per diagram. You
only say what is linked to what. The layout puts each box below the ones that
point at it, keeps arrows from crossing boxes and routes loops around the
side.

Pick the shape:

- `"flow"`, the default: things that pass something along. Arrows run down,
  or right with `direction: "right"`, which fits about 4 short boxes in a
  row. On a page too narrow for them it runs down instead.
- `"stack"`: layers that build on each other, top to bottom in the order
  written. No arrows. A layer can list what it holds in `items`.

Write it like the rest of the page, in plain words:

- `title` says the point. `caption` says how to read it, in one sentence.
- 3 to 7 boxes. A `label` is 1 to 3 everyday words, never a code name or a
  path. A `detail` stays under 8 words.
- Give each box an `icon`, so it is recognised at a glance. Pick one from:
  terminal, plug, server, door, package, puzzle, cog, brain, wrench, shield,
  book, scale, palette, monitor, phone, laptop, radio, window, ban, file,
  folder, list, hourglass, play, hand, check, cross, warning, user, users,
  globe, database, disk, cloud, lock, key, chat, mail, bell, bolt, search,
  branch, code, chip, layers, eye, clock, bot, sparkles, settings, inbox,
  send, refresh, trash, link, box, bug, rocket.
- `groups` draw a labelled zone around the boxes that live in one place,
  like "inside the server". A box joins one with `group`.
- A `step` on an arrow is a short sentence. Steps are numbered on the arrows
  and listed under the diagram, so the reader can walk through it. Use them
  when order matters, at most 6. A `label` is a word or two on the arrow.
- `kind: "maybe"` draws a dashed arrow, for a path that depends on a choice.
  `kind: "never"` draws a dotted one ending in a red cross, for a path that
  must not exist.

A node, a group and a `Card` can take a `tone`: `"blue"`, `"green"`, `"orange"` or
`"violet"`. A tone tells groups apart, like what runs on the machine and what
runs on the site. It has no meaning of its own, so give the same tone to
everything of one group, on the whole page, and say in the text or in
`detail` what the group is. A card about the site then has the tone of the
site's nodes. Leave it out when things are all of one kind, and never use a
tone for good, bad or a warning.

```json
{
  "flow": {
    "type": "DiagramFlow",
    "props": {
      "title": "Where a job's output goes",
      "caption": "Output stays in the server's memory. It never reaches your chat or the model.",
      "groups": [{ "id": "server", "label": "stays in the server", "tone": "green" }],
      "nodes": [
        { "id": "job", "label": "Background job", "icon": "monitor", "detail": "prints output", "group": "server" },
        { "id": "memory", "label": "Server memory", "icon": "brain", "detail": "keeps the newest 64 KB", "group": "server" },
        { "id": "feed", "label": "Live feed", "icon": "radio", "detail": "updates 10 times a second" },
        { "id": "pane", "label": "Job pane", "icon": "window", "detail": "what you see" },
        { "id": "chat", "label": "Chat and model", "icon": "ban", "detail": "never see it", "tone": "orange" }
      ],
      "edges": [
        { "from": "job", "to": "memory", "step": "The job's output goes into the server's memory." },
        { "from": "memory", "to": "feed", "step": "A live feed reads it from there." },
        { "from": "feed", "to": "pane", "step": "The job pane shows it to you." },
        { "from": "memory", "to": "chat", "label": "no path", "kind": "never" }
      ]
    }
  }
}
```

Use step navigation sparingly. `status` can be `"complete"`, `"current"`, or
`"upcoming"`; omit it to mark the first step current and the rest upcoming.
Prefer horizontal for 2-5 short steps. Use vertical only for longer
walkthroughs or dense wide layouts.

## Dynamic values and conditional fields

Beyond `$bindState`, any prop value can be a data-driven expression, and any
element can declare a `visible` condition. These resolve against the same state
model, so they compose with the bound inputs above.

Prop expressions:
- `{ "$state": "/path" }` reads a value from state (one-way).
- `{ "$template": "Hello, ${/form/name}!" }` interpolates state into a string.
- `{ "$cond": <condition>, "$then": <value>, "$else": <value> }` picks a value.

Visibility (`visible` on any element):
- `{ "$state": "/path" }` shows when the value is truthy.
- `{ "$state": "/path", "eq": <value> }` shows when it equals a value.
- `{ "$state": "/path", "not": true }` shows when it is falsy.
- `{ "$and": [<cond>, <cond>] }` / `{ "$or": [<cond>, <cond>] }` combine.

Example: reveal a field only when a checkbox is unticked.

```json
{
  "remote":  { "type": "Checkbox", "props": { "label": "Remote?", "checked": { "$bindState": "/form/remote" } } },
  "address": {
    "type": "TextField",
    "props": { "label": "Office address", "value": { "$bindState": "/form/address" } },
    "visible": { "$state": "/form/remote", "not": true }
  }
}
```
