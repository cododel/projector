# Interface catalog

`pnpm storybook` opens the development server at `http://127.0.0.1:6006/` (loopback
only; open the URL manually). Start with **Catalog → Coverage → Overview**.
Storybook 10.6.2 uses the React/Vite framework, Docs, Controls, Actions, Interactions
and Accessibility. Telemetry is disabled; no account, cloud service or publication
is needed. `pnpm build:storybook` produces `.tmp/storybook-static/`, which can be
served locally or reviewed separately. It is not shipped in the Electron app.

The catalog includes notifications, sessions, controls, layouts, projects, settings, help, documents, annotations, shell panels/dialogs and composed application screens.
Each has individual named stories, a **State Sheet** for comparison and
interaction scenarios for transitions. Controls change real fixture inputs (including row
width); Actions logs local intents. Fixed notification frames pause automatic
expiry and entry animation. Playground uses the actual in-memory controller, live
expiry, pending/result, Retry/Undo, dismissal and reflow. Session hover/focus scroll,
Pin/Archive/Undo and resize use the production row with local callbacks.

`dev/catalog.ts` maps renderer sources, nested surfaces and native UI to explicit
states and transitions. Inventory presence, story presence and passed verification
are distinct. Native qualification remains separate in
[the catalog issue](../docs/issues/[OPEN]-2026-10-13-storybook-interface-state-catalog.md).
No dark application theme is invented: rows use the current production palette,
and notifications keep their production black/severity styling.

## Checks and visual comparison

The browser runner builds a current static catalogue and owns its temporary
loopback server on6007; it does not require the interactive server. This is needed
for real state-sheet child routes inside Vitest’s separate preview host.

Install the matching browser once: `pnpm exec playwright install chromium --only-shell`.
Then run:

```sh
pnpm typecheck
pnpm lint
pnpm build:storybook
pnpm test:storybook
pnpm test:storybook:visual
```

`test:storybook` renders every story and runs its play function and axe audit in
headless Chromium, with both `no-preference` and `reduce` motion. The Accessibility
panel also allows manual inspection; violations fail the browser test. Use your
browser/OS reduced-motion preference when reviewing transitions interactively.
`test:storybook:visual` compares all registered production state sheets against reviewed
PNG baselines in `dev/visual/baselines/`. It builds current sources and starts a disposable static server on6007. Errors in the tested page
fail the visual scenario. Baselines use Chromium, 1400×900, reduced motion and
platform-specific filenames; current baselines qualify macOS. They are not an
automatic claim about fonts/rendering on another OS.

For an intentional design change, run `pnpm test:storybook:visual --update-snapshots`,
inspect each changed PNG and its source, record its SHA-256 and actual reviewer
in `dev/visual/baseline-reviews.json`, then rerun **without** updating snapshots.
The catalogue gate rejects changed or missing review hashes; snapshot regeneration
does not record a review automatically.
Do not refresh baselines to hide an unexpected difference. Result/diff files stay
under `.tmp/storybook-visual-results/`. Storybook checks are a separate development
gate; `pnpm check` retains the existing app/Electron gate and its network-free
behavior after dependencies are installed. Run both when changing catalogued UI.

## Adding or changing a component

1. Update its row in `dev/catalog.ts` with the actual source, supported states,
   inapplicable states and runtime boundary. The inventory unit test detects a new
   renderer TSX file omitted from this map.
2. Add stories under `dev/stories/` using the production component and CSS. Keep
   deterministic fictional data in `dev/fixtures/`; inject local callbacks or a
   narrowly scoped input-only adapter. Never import `src/renderer/main.tsx`, the
   native notification bootstrap or the real preload into the catalog.
3. Cover applicable normal/hover/focus/selected/disabled/pending/empty/result/long
   variants, then add meaningful play assertions for transitions and keyboard.
   Explain unsupported variants instead of fabricating them. Give a family a
   State Sheet only when it makes the comparison useful.
4. Link the actual story IDs from the inventory and run the checks above. Record
   native-only evidence separately; Storybook does not replace Electron E2E.

No catalog fixture reads or changes real project/session/profile data, launches
Codex or a shell, or calls actual Archive/Undo. The catalog intentionally has no
`window.projector` bridge. Git worktree detection, persistence, native transparent
window routing/focus, PTYs and IME remain application verification boundaries.

Setup follows the installed versions and the official
[React/Vite](https://storybook.js.org/docs/get-started/frameworks/react-vite) and
[Vitest addon](https://storybook.js.org/docs/writing-tests/integrations/vitest-addon)
documentation. The existing Node/Vitest test configuration is kept separate.

## Standalone notification storyboard

Run `pnpm storyboard:notifications`, then open `.tmp/notifications-storyboard/index.html`
in a browser. The generated page is self-contained and makes no network requests.

`notifications-storyboard.tsx` renders the production `NotificationStack` and controller.
Nine fixed frames cover hidden, info, warning, error, Undo, pending, three alerts,
overflow and long content. Fixed frames pause automatic timers. Interactive controls
exercise entry/exit, Retry → Undo, dismissal, overflow, details and visible-time expiry
without changing real sessions or files. Reduced motion follows the browser preference.

Its fixed fixtures are shared with Storybook via `dev/fixtures/notifications.ts`.
This remains a notification-specific development surface alongside the growing catalog.
Native Electron pointer routing requires separate desktop validation.

## Complete inventory and required UI gate

`dev/catalog.ts` is the source-grounded register of component families, composed
screens and native surfaces. Each state records its actual occurrence condition;
each transition records endpoints and trigger. IDs are scoped by entity, state and
transition. Story coverage comes from explicit `parameters.catalog.states` and
`parameters.catalog.transitions`, not from a file merely appearing in the map.
Do not remove a missing state to improve a percentage. `catalog-required.json`
locks the reviewed inventory IDs; update it only after a deliberate source inventory
review, never to accommodate missing stories.

The coverage page separates component families, screens, states and transitions.
It filters categories and missing coverage, links stories, and distinguishes play
presence, platform baseline presence and completed execution. Native records have
check-source references and missing/manual status; browser stories do not certify
PTY, OS dialogs, native views, physical input, or window hit testing.

For UI changes both gates are required:

```sh
pnpm test:catalog
pnpm check
```

`test:catalog` validates source coverage and stable IDs, renders every registered
story in Chromium in both motion modes with axe, builds Storybook, checks the live
index/runtime manifest and compares all state sheets. Its ignored report lives in
`.tmp/catalog/evidence.json`. The interactive server serves it only as current when
its source/dependency/config/runtime fingerprint matches. Absence or a failed new
attempt remains unverified. A `play` property is not a passed result.

Visual tests build current sources and serve the immutable result temporarily on
localhost6007; they do not reuse or stop the interactive server on6006. State-sheet
frames mount sequentially and report completed rendering/play to their own parent,
so concurrent iframe input cannot corrupt their states. Fixed-state frames use
`static: true` to disable autoplay and freeze entrance animations at their
completed state; transition stories remain independently tested with real motion.
Frame dimensions preserve desktop breakpoints; narrow states use explicit widths. Failed child plays or
missing frame readiness block capture. Baselines currently qualify macOS Chromium.

To add UI: register its source and explicit states/transitions first, then add real
shared presentation and typed local fixtures. App bootstrap retains IPC, persistence
and lifecycle ownership. Use a fixture-local NotificationProvider; never install a
fake application preload or read user sessions. The actual xterm uses synthetic
output/acknowledgements; browser annotation frames execute the production HTML/CSP
with a frame-local fictional capture API. Add a sheet and meaningful interaction
assertions, review new PNGs, then compare without snapshot updates.
