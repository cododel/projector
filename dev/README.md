# Interface catalog

`pnpm storybook` opens the development server at `http://127.0.0.1:6006/` (loopback
only; open the URL manually). Start with **Catalog → Coverage → Overview**.
Storybook 10.6.2 uses the React/Vite framework, Docs, Controls, Actions, Interactions
and Accessibility. Telemetry is disabled; no account, cloud service or publication
is needed. `pnpm build:storybook` produces `.tmp/storybook-static/`, which can be
served locally or reviewed separately. It is not shipped in the Electron app.

The initial catalog includes **Notifications → Stack** and **Sessions → Project row**.
Each has individual named stories, a **State Sheet** for comparison and a
**Playground** for transitions. Controls change real fixture inputs (including row
width); Actions logs local intents. Fixed notification frames pause automatic
expiry and entry animation. Playground uses the actual in-memory controller, live
expiry, pending/result, Retry/Undo, dismissal and reflow. Session hover/focus scroll,
Pin/Archive/Undo and resize use the production row with local callbacks.

`dev/catalog.ts` maps every renderer TSX source to its current coverage, states and
integration boundary. **Included**, **Planned** and **Integration boundary** are
distinct; an inventory entry is not story coverage. The first two component
families are included, while the full catalog remains in progress in
[the catalog issue](../docs/issues/[OPEN]-2026-10-13-storybook-interface-state-catalog.md).
No dark application theme is invented: rows use the current production palette,
and notifications keep their production black/severity styling.

## Checks and visual comparison

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
`test:storybook:visual` compares the two production state sheets against reviewed
PNG baselines in `dev/visual/baselines/`. It starts the local server if necessary;
an existing local catalog server is reused outside CI. Errors in the tested page
fail the visual scenario. Baselines use Chromium, 1100×900, reduced motion and
platform-specific filenames; current baselines qualify macOS. They are not an
automatic claim about fonts/rendering on another OS.

For an intentional design change, run `pnpm test:storybook:visual --update-snapshots`,
inspect each changed PNG and its source, then rerun **without** updating snapshots.
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
