# Project components

A project can add its own components to a page, next to the built-in ones in
`authoring.md`. A component is one plain JavaScript file in the project. There
is no build step and the skill is not changed.

Read this to use the components a project already has, or to write a new one
for the user.

## Where they live

```
.agents/artifacts/components/
  PriceTable.js        a component, used in a spec as "type": "PriceTable"
  lib/money.js         a helper, not a component
```

- Every `.js` file at the top of the folder is a component. Its file name
  without `.js` is the `type` a spec uses, with the same upper and lower case.
- Any file name works. Name them like the built-ins (`PriceTable`) so a spec
  reads the same everywhere.
- Helper files go in a subfolder. A file at the top is always a component.
- A component with the name of a built-in replaces it. `create.mjs` says so on
  stderr.

## Before you author a page

List `.agents/artifacts/components/` and read the files. The `description` and
`props` of each one are the project's part of the catalog: they say what the
component shows, when to use it and which props it takes. There is no other
list. Prefer a project component over building the same thing from built-ins.

A project component is a block like any other. It goes inside a `Section`.

## The contract

A component file has three exports.

```ts
// For agents: what it shows and when to use it.
export const description: string;

// The props a spec can give. The page checks every element against it.
export const props: z.ZodObject;

// Called like a React component, so hooks work.
export function render(block: {
  props: z.infer<typeof props>; // values bound to state are already filled in
  children?: ReactNode; // the child elements of the spec, already rendered
  bindings?: Record<string, string>; // prop name to state path, for props bound with $bindState
}): ReactNode;
```

```js
// .agents/artifacts/components/PriceTable.js
import { z } from "zod";
import { html } from "htm/react";
import { useBoundProp } from "@json-render/react";
import { Prose, stop } from "yourturn";
import { money } from "./lib/money.js";

export const description = "Table of plans with prices. Use it to compare options and let the reader pick one.";

export const props = z.object({
  intro: z.string(),
  rows: z.array(z.object({ plan: z.string(), price: z.number() })),
  value: z.string().nullish() // bind it with $bindState to get the picked plan back
});

export function render({ props, bindings }) {
  const [picked, setPicked] = useBoundProp(props.value ?? undefined, bindings?.value);
  return html`<div>
    <p><${Prose} text=${props.intro} /></p>
    <table ...${stop}>
      <tbody>
        ${props.rows.map(
          (r) => html`<tr key=${r.plan}>
            <td>${r.plan}</td>
            <td>${money(r.price)}</td>
            <td><button disabled=${picked === r.plan} onClick=${() => setPicked(r.plan)}>Pick</button></td>
          </tr>`
        )}
      </tbody>
    </table>
  </div>`;
}
```

A spec uses it like a built-in:

```json
{
  "type": "PriceTable",
  "props": {
    "intro": "These are the **plans** we have.",
    "rows": [{ "plan": "free", "price": 0 }, { "plan": "pro", "price": 9 }],
    "value": { "$bindState": "/plan" }
  }
}
```

## Rules for the file

- **Plain JavaScript modules.** No JSX and no TypeScript, nothing compiles the
  file. Write markup with `html` from `htm/react`. It is JSX in a template
  string: `<${Component} prop=${value} />` for a component and `${...}` for
  values.
- **Imports are names from the import map or relative files.** The names are
  `react`, `react/jsx-runtime`, `react-dom`, `zod`, `htm/react`,
  `@json-render/react`, `@json-render/core` and `yourturn`. A relative import
  needs the full file name, like `./lib/money.js`.
- **Another package needs an entry** in `imports` of
  `.agents/artifacts/config.json`, like
  `{ "imports": { "d3": "https://esm.sh/d3@7.9.0" } }`. Pin the exact
  version, so a page looks the same later. For a package that uses React,
  put every name of the page's import map that it imports into `external`
  of its esm.sh address, or the page loads a second copy and hooks break.
  That is `?external=react` for most packages and
  `?external=react,react-dom` for one that also imports `react-dom`, like
  `recharts`. To check, fetch the address and look at the imports in the
  reply: none may name `react@` or `react-dom@`.
- **A package with dependencies of its own takes `bundle`** in its address,
  like `https://esm.sh/recharts@3.10.1?bundle&external=react,react-dom,react-is`.
  Its dependencies are then built into one file. Without it the CDN picks
  them again on every load, so a page can change after it was made, and it
  asks for a hundred files where one will do. A name in `external` that the
  page's map does not have, like `react-is` here, gets an entry of its own
  with an exact version. The CDN may still build that file again one day.
  For a page that must never change, point the entry at a copy of the built
  file in the project. The same `imports` can point any name at another CDN
  or at vendored files.
- **Text that should be read aloud goes through `Prose`** from `yourturn`. It
  takes `{ text }`, splits sentences and marks `**keywords**`. Text rendered
  any other way is skipped by the player.
- **An input binds its value with `useBoundProp`** from `@json-render/react`,
  as above. The value then comes back in `result` under the path the spec
  bound.
- **An input spreads `stop`** from `yourturn` on the element that holds its
  controls, as above. The player then says "Your turn" and stops there, like
  it does for the built-in inputs. Put it after the text the component reads
  aloud, the player goes in page order. Leave it out on a component that only
  shows things.
- **Props are JSON.** A spec is data, so no functions and no markup in props.
- **Style it by the visual rules below**, with inline styles or the classes
  of the built-ins. A component has no stylesheet of its own.
- **Nothing remote besides imports.** Images and data files go in the
  artifact's `assets/` folder, see `authoring.md`. A component reads a data
  file with `fetch("assets/rows.json")`, the path is relative to the page.
  Small data is simpler as a prop.

## Visual rules

A component should look like a part of the page and not like a guest on it.

The theme is the `:root` block of `dist/_core/style.css` in the skill folder,
under the comment that starts with "The theme". **Read it before you style anything.** It holds every variable
with a comment that says what it is for. That block is the only list, so it is
not repeated here. The rest of the file shows how the built-ins use it.

- **Every colour is a theme variable.** Never write a colour value, not a hex
  code, not `rgb()` and not a colour name. A library that takes colours as
  props gets the variable as a string, like `fill="var(--fg)"`. That works
  when it draws SVG or HTML. A canvas cannot read a variable, so do not pick
  a library that draws on one.
- **The page is grey.** A hue is only for the meaning its variable has, like
  an error or what is active. Do not use one to decorate.
- **Tones tell groups apart.** `--blue`, `--green`, `--orange` and `--violet`
  mean nothing by themselves. Use them wherever groups need telling apart,
  like the series of a chart, as a line or as a fill. Text on a fill is a
  dark shade of the same hue,
  `color-mix(in srgb, var(--blue) 30%, var(--tone-fg))`. Say in words what
  each tone is, and never use one for a state.
- **Light and dark mode come with the variables.** Do not write a dark rule
  and do not check the colour scheme.
- **Need a shade in between? Mix two variables**, like
  `color-mix(in srgb, var(--card) 88%, var(--fg))` for a soft fill.
- **A box has one shape:** `border-radius: var(--radius)` with
  `corner-shape: squircle`, and a 1px `var(--border)` line when it needs an
  edge. A round control like a chip or a count is a `999px` pill. There are no
  other corner sizes.
- **A state is a line, not a fill.** An error is a `var(--error)` border and
  text on the normal background. What is active or focused gets a
  `var(--accent)` outline.
- **Text inherits the font and the size of the page.** Headings and labels
  are `var(--fg)`, paragraphs `var(--text)`, and secondary text is 14px in
  `var(--muted)`.
- **No shadows on what sits in the page.** Only something that floats over
  the page has one.
- **Reuse a class of a built-in when one fits**, like `card`, `field`,
  `field-label`, `field-help`, `input` and `text muted`. They follow all of
  the above already.

```js
// A box with a label, a helper line and an error state.
html`<div className="card">
  <span className="field-label">Monthly price</span>
  <span className="field-help">Before tax.</span>
  ${props.rows.length ? null : html`<p style=${{ color: "var(--error)" }}>No plans yet.</p>`}
</div>`
```

## How a mistake shows up

`create.mjs` accepts any element whose type matches a file in the folder. It
reads the import lines of every file there and fails when one names a
package the import map does not have, with the file and the name. It
cannot check the props, because the file only runs in a browser. The page
checks them instead. A component shows an error card in its place and is
listed in `errors` of the answer when:

- the file does not load, for example a relative import of a file that is
  not there,
- it does not export `props` and `render`,
- the props of an element do not match `props`,
- `render` throws.

The rest of the page still works. So a broken component never blocks the
user, and you learn about it from the answer.

## Writing one for the user

1. Agree on what it shows, which props it takes and whether it returns a
   value.
2. Write the file in `.agents/artifacts/components/`. Keep it to one file
   unless a helper is shared.
3. Make a small page that uses it with real props and open it. Ask the user if
   it looks right.
4. Read `errors` in the answer. Fix and repeat until it is empty.

Every artifact keeps a copy of the components from the moment it was created.
An old page is not changed by an edit, and a new page gets the new version.
