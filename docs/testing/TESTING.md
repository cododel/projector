# Local and pre-push checks

`pnpm check` runs typecheck, lint, unit/infrastructure tests and hidden Electron E2E.
`pnpm test:e2e` retains the hidden, no-focus default. This mode covers app logic,
persistence, DOM interactions and MCP; it does not prove native desktop composition,
window focus, physical input or browser/overlay hit testing on the desktop.
Hidden E2E runs independent scenarios in up to four workers (bounded by available
CPU parallelism). Each scenario owns disposable app data, sockets and fixture
servers on dynamically assigned ports. The build completes once before E2E;
steps inside each scenario remain ordered. Use `pnpm exec playwright test --workers=1`
for a sequential diagnostic run. Visible E2E remains on one worker because windows
share OS focus.
With dependencies already installed, the hidden gate needs no external network:
packaging uses the pinned local Electron distribution rather than downloading
another copy. Its E2E forbids network access in the packaging process even with
a warm download cache and sets `BLUEPRINT_PACKAGE_OUTPUT` to its disposable
directory so the developer's `dist` package is preserved. Missing or mismatched local Electron fails explicitly;
there is no download fallback. The empty dependency fixture for hook tests uses
pnpm offline mode. Dependency installation and the opt-in/full Codex model test
still require their own external services.

`pnpm check:full` deliberately takes window focus on macOS. It runs static and unit
checks, the hidden-window guarantee in hidden mode, every remaining E2E in ordinary
window mode, including the authenticated Codex integration.
No skipped test is accepted in either full E2E selection. A missing dependency,
authentication or failing test blocks the gate; no fallback is used.
The Codex test uses the configured CLI/model and can consume model usage.

`pnpm hooks:install` installs the tracked `.githooks/pre-push` using local
`core.hooksPath`, refusing existing user hooks. No pre-commit is installed.
Pre-push exports each distinct pushed commit into a disposable directory, installs
its frozen dependencies and runs its `check:full`. Dirty worktree changes cannot
mask a defect in the pushed source. Delete-only pushes do not run tests. Temporary
copies are removed on ordinary completion/failure. Push is blocked on failure.
The hook must be committed along with the full-check scripts before pushing them.

These checks use Playwright and Electron APIs without Accessibility or Screen
Recording permissions, Swift helpers or system-wide input injection. Visible
windows exercise ordinary Electron visibility and throttling, but do not prove
physical desktop input, OS-level focus routing, compositor freshness, real IME,
physical gestures or other monitors. Those remain manual validation boundaries;
no CoreGraphics native smoke is required by pre-push.

A focused full run is expected to interrupt desktop work briefly; use it before
infrequent pushes. Neither Tart nor a macOS restore image is a development dependency.
