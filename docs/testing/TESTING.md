# Local and pre-push checks

`pnpm check` runs typecheck, lint, unit/infrastructure tests and hidden Electron E2E.
`pnpm test:e2e` retains the hidden, no-focus default. This mode covers app logic,
persistence, DOM interactions and MCP; it does not prove native desktop composition,
window focus, physical input or browser/overlay hit testing on the desktop.
Hidden E2E runs independent scenarios in up to four workers (bounded by available
CPU parallelism). Each scenario owns disposable app data, authenticated loopback endpoints and fixture
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

## Current-stage qualification

`pnpm test:performance` builds production sources and runs a separate disposable load profile: 50 artifacts, 10 revisions and saved states each, 20 widgets/annotations, three local browser pages and at least 100 warmed actions per metric. Report includes actual host RAM/CPU and the owned process tree. This benchmark is deliberately outside routine functional E2E selection; it never turns a budget failure into a skip. It is a release qualification, not a pre-push latency claim.

New stage tests cover relocated/copied projects, private answer retention, offline guide and append-only approval revocation. Browser tests use real views/sessions and controlled native dialog answers. Permission callback tests do not use hardware or grant host TCC privileges. File faults are injected at write and directory-sync boundaries; they prove known versus uncertain publication outcomes, not physical device durability.

## Session workspace qualification

The Codex prerequisite gate uses installed CLI 0.162.1, an isolated HOME/CODEX_HOME, task-owned backend/TUI and a local Responses provider without credentials or authenticated model calls. Evidence lives in `.tmp/tasks/harness-workspaces-20261011/codex-gate/result.json` and `manager-product/result.json`. The prerequisite checked actual Blueprint MCP; the implementation manager probe separately used a controlled MCP peer. Fresh `actual-http-UcdsCY/qualification.json` and `actual-http-CEgIxw/result.json` additionally qualify the actual product manager/PTy/TUI with the current authenticated HTTP runtime in production preview and a relocated packaged `.app`, respectively: exact New/Resume identity, observed MCP ready, real guide tool output and persisted metadata. Exact identities come from real TUI protocol requests/responses, independently of timestamps, latest files or arbitrary broadcasts. Native Codex added its own UX bookkeeping to the disposable config; model/provider/trust/approval/sandbox and preexisting MCP settings remained, and the launch-only Blueprint overrides did not persist. Authenticated model Save/attachment reading remains a separate full E2E boundary.

`tests/codex.test.ts` checks paginated metadata across all providers and archived/non-archived sessions with `useStateDbOnly:true`, exact new/fork Resume identity, auth/Origin rejection, ownership, launch cancellation, and Quit while a backend starts. It uses a local protocol fixture and does not modify user profiles. Automatic app discovery in ordinary E2E also uses an empty controlled CLI peer; the harness scenario supplies its own changing catalog, so polling never reads the operator's real session history. The opt-in/full model client remains a separate real Codex check. `tests/terminal-electron.test.ts` qualifies the real Electron utility-process/node-pty boundary on a disposable target; synthetic Unicode and PTY input do not prove physical keyboard/IME behavior. Browser-pane boundary tests establish native attachment/geometry ownership and failed-write guards through controlled Electron doubles; integrated real Electron workspace tests separately establish pane composition and input routing.

Full acceptance also covers session/project independence, nested split and bottom-panel restoration, shared artifact work across views, output replay/backpressure, close-view versus Stop, renderer/service failure, removal of ended screens without command replay, settings/shortcut conflicts and browser beforeunload. Ended terminals and their saved screens are removed after confirmed cleanup; legacy inactive records are discarded on startup. Plans and harness sessions remain. Native focus/clipboard and physical IME need the separately recorded visible checks. Current target is macOS; node-pty/xterm/HTTP portability does not qualify Linux or Windows. No VM or extra system permissions are introduced.

Terminal keyboard regressions use actual xterm keyboard events and disposable PTYs,
not direct `terminalInput` calls for the tested chords. `terminal-codex-keys.spec.ts`
requires the installed compatible `codex` executable (as does the instructions test),
but uses a fresh isolated profile and starts no model turn. It tests actual TUI
exit on Ctrl+D/Ctrl+C; raw-PTY tests independently compare control/navigation byte
streams and real shell tests cover SIGINT and EOF. The resize race test temporarily
SIGSTOPs only its own named utility service and always SIGCONTs it in `finally`.
Synthetic keyboard events do not qualify physical keyboard layouts, native
clipboard integration or OS IME composition.


Terminal wheel regressions use the installed xterm and real PTYs in both mouse-reporting and alternate-buffer arrow modes. They assert proportional counts, fractional accumulation, direction changes, bounded frame packets, parser mode resets and inactive-pane isolation. Ordinary scrollback is checked with browser-generated wheel input and must send no PTY input. The warmed measurement test attaches `wheel-measurements.json`: 100 measured actions after 10 warmups, normalized rows, IPC packets, wheel-to-output notification and output-to-DOM latencies. These are fixture pipeline measurements, not physical presentation timing or proof of a Codex CPU/GPU bottleneck. Visible installed Codex qualification uses isolated local history and no model turn; native synthesized gestures do not qualify physical trackpad hardware.

Predominantly vertical TUI wheel gestures remain proportional when they have minor
horizontal drift; Shift and predominantly horizontal gestures retain xterm handling.
The service and renderer coalesce already waiting contiguous output into parser
writes of up to 64 KiB (a single larger incoming fragment stays intact). Original
PTY events and sequence numbers are retained. Regression tests exercise fragmented
Unicode/CSI, batch bounds, replay/generation reconciliation, stop during parsing,
PTY pause/resume under pressure and parser errors. An unknown partial parser result
is surfaced and is never automatically replayed; process cleanup remains available.
