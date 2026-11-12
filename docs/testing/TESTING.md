# Local and pre-push checks

UI changes require both `pnpm test:catalog` and `pnpm check`. The catalogue gate
validates the reviewed inventory, source/story links, every story in Chromium with
axe in both motion modes, and reviewed state-sheet screenshots without updating
baselines. Its exact-source execution report is separate from story presence and
native Electron qualification. See [the catalogue guide](../../dev/README.md).

`pnpm check` runs typecheck, lint, unit/infrastructure tests and inactive-window Electron E2E.
`pnpm test:e2e` retains the inactive, no-focus default. This mode covers app logic,
persistence, DOM interactions and MCP; it does not prove native desktop composition,
window focus, physical input or browser/overlay hit testing on the desktop.
Inactive-window E2E runs independent scenarios in up to four workers (bounded by available
CPU parallelism). Each scenario owns disposable app data, authenticated loopback endpoints and fixture
servers on dynamically assigned ports. The build completes once before E2E;
steps inside each scenario remain ordered. Use `pnpm exec playwright test --workers=1`
for a sequential diagnostic run. Visible E2E remains on one worker because windows
share OS focus.
With dependencies already installed, the inactive-window gate needs no external network:
packaging uses the pinned local Electron distribution rather than downloading
another copy. Its E2E forbids network access in the packaging process even with
a warm download cache and sets `PROJECTOR_PACKAGE_OUTPUT` to its disposable
directory so the developer's `dist` package is preserved. Missing or mismatched local Electron fails explicitly;
there is no download fallback. The empty dependency fixture for hook tests uses
pnpm offline mode. Dependency installation and the opt-in/full Codex model test
still require their own external services.

`pnpm check:full` deliberately takes window focus on macOS. It runs static and unit
checks, the inactive-window guarantee in background mode, every remaining E2E in ordinary
window mode, including the authenticated Codex integration.
No skipped test is accepted in either full E2E selection. A missing dependency,
authentication or failing test blocks the gate; no fallback is used.
The Codex test uses the configured CLI/model and can consume model usage.

`pnpm hooks:install` installs the tracked `.githooks/pre-push` using local
`core.hooksPath`, refusing existing user hooks. No pre-commit is installed.
Pre-push exports each distinct pushed commit into a disposable directory, installs
its frozen dependencies and runs typecheck, lint and unit/infrastructure tests. Dirty worktree changes cannot
mask a defect in the pushed source. Delete-only pushes do not run tests. Temporary
copies are removed on ordinary completion/failure. Push is blocked on failure.
The hook must be committed along with its test scripts before pushing them.

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

The Codex prerequisite gate uses installed CLI 0.162.1, an isolated HOME/CODEX_HOME, task-owned backend/TUI and a local Responses provider without credentials or authenticated model calls. Evidence lives in `.tmp/tasks/harness-workspaces-20261011/codex-gate/result.json` and `manager-product/result.json`. The prerequisite checked actual Projector MCP; the implementation manager probe separately used a controlled MCP peer. Fresh `actual-http-UcdsCY/qualification.json` and `actual-http-CEgIxw/result.json` additionally qualify the actual product manager/PTy/TUI with the current authenticated HTTP runtime in production preview and a relocated packaged `.app`, respectively: exact New/Resume identity, observed MCP ready, real guide tool output and persisted metadata. Exact identities come from real TUI protocol requests/responses, independently of timestamps, latest files or arbitrary broadcasts. Native Codex added its own UX bookkeeping to the disposable config; model/provider/trust/approval/sandbox and preexisting MCP settings remained, and the launch-only Projector overrides did not persist. Authenticated model Save/attachment reading remains a separate full E2E boundary.

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
The exit scenario waits for confirmed Projector MCP startup before typing the
idle TUI's exit chord: its model header appears earlier, and Ctrl+C during startup
cancels initialization rather than exiting. An exited record awaiting descendant
cleanup is not a live process. PTY exit publishes its status before that cleanup;
a real-PTY regression verifies the notification and retained input rejection.
Neither synchronization boundary allows unexpected diagnostics.


Terminal wheel regressions use the installed xterm and real PTYs in both mouse-reporting and alternate-buffer arrow modes. They assert proportional counts, fractional accumulation, direction changes, bounded frame packets, parser mode resets and inactive-pane isolation. Ordinary scrollback is checked with browser-generated wheel input and must send no PTY input. The warmed measurement test attaches `wheel-measurements.json`: 100 measured actions after 10 warmups, normalized rows, IPC packets, wheel-to-output notification and output-to-DOM latencies. These are fixture pipeline measurements, not physical presentation timing or proof of a Codex CPU/GPU bottleneck. Visible installed Codex qualification uses isolated local history and no model turn; native synthesized gestures do not qualify physical trackpad hardware.

Predominantly vertical TUI wheel gestures remain proportional when they have minor
horizontal drift; Shift and predominantly horizontal gestures retain xterm handling.
The service and renderer coalesce already waiting contiguous output into parser
writes of up to 64 KiB (a single larger incoming fragment stays intact). Original
PTY events and sequence numbers are retained. Regression tests exercise fragmented
Unicode/CSI, batch bounds, replay/generation reconciliation, stop during parsing,
PTY pause/resume under pressure and parser errors. An unknown partial parser result
is surfaced and is never automatically replayed; process cleanup remains available.

Rename qualification adds `brand-compat.test.ts` and `rebrand.spec.ts`: Projector
uses current names while legacy app/project storage, environment variables, artifact
kinds and read-only MCP names remain compatible. The isolated Electron test checks
private answers, byte-identical revision manifests and real legacy localStorage /
cookies through the renamed app. No personal app data, client config or repository
remote is migrated by tests. Existing persisted roots are reused in place, not moved.

## Unexpected-error gate

Both gates audit diagnostics as well as functional assertions. E2E scenarios use the
shared `tests/e2e/test.ts` fixture; launches use its Electron helper and the audited
process helpers. A static boundary test rejects bypasses. Integration unit tests
have the same per-test collector and observe their owned subprocesses.

The journal records test/run identity, process role/PID, compiler thread identity,
phase, severity, message and available stack. Observation starts before application
readiness and persists through cleanup; the gate drains owned children and checks
journals after scenario cleanup. Missing, corrupt or unbound evidence fails. Main,
owned renderer/document/overlay, runtime, compiler, terminal service, Codex and MCP
bridge errors fail even when functional assertions succeed. Native exception exit
policy is retained. Terminal output and external-page diagnostics are recorded as
external evidence; their failures are evaluated by the scenario's own assertions.

A deliberate failure must be declared before its action, with exact source, event
kind, named phase, message/code and count. Unexpected extras, missing expectations
and ambiguous matches fail. Tests do not globally allow IPC, storage, crash or
cleanup errors. Journals and attachments under `.tmp/test-diagnostics` remain
available after failed checks; secret environment values and bearer credentials
are redacted. Captured output is disposable test data, not the operator's terminals.

Known non-error diagnostics have explicit source-specific classifications: Electron
inspector lifecycle, Codex stdin/server endpoint notices, and the pinned Electron
44.7.0 macOS notice about its absent Helper Resources directory (only when that
exact directory is absent). Exact Git worktree metadata probes can report a
non-repository/missing directory as a normal negative result with exit 128;
other command failures remain errors. Raw unknown stderr is not ignored.

`diagnostics.spec.ts` runs nested gates to prove that main/shell errors, unhandled
child rejection, runtime/terminal crashes and post-assertion cleanup errors return
failure after functional success. Compiler fault coverage independently audits the
real worker event even when its caller catches the rejected operation. Known
negative pre-push checks retain captured inner output without presenting their
intentional exit as a failure of the outer gate.

Suite hooks use an unbound diagnostic journal: errors in `beforeAll` or `afterAll`
fault the runner even when every test assertion passes. The console observer uses
one active route across reused Vitest workers. Playwright results use a unique
`.tmp/test-results/<run>` directory, so independent runs cannot remove each other's
traces. Each E2E result includes its complete redacted diagnostic journal.

Nested regressions also cover pre-readiness main errors, document rejection,
annotation overlays and a terminal-service crash during Quit. Journal initialization
and previously observed records must remain present; erasing a journal cannot make
it clean. Worker exceptions and their parent notifications share a primary-event
link and the actual worker ID. Native process output is observed without changing
buffered `execFile` results. Terminal mouse tests cover retained SGR encoding after
screen restoration and high-byte legacy reports through xterm's binary event path.

Authenticated Codex diagnostics are subject to the same strict gate. A successful
model/MCP interaction does not authorize native client warnings or prove the full
gate passed. Native profile/client failures remain visible with their journals;
tests do not repair the operator's profile or silently allow recurring warnings.

Shutdown regression barriers also cover an overlay renderer still alive after its
browser owner is disposed, and runtime replies admitted before Quit. Retired overlay
senders receive a recoverable capture error; the process-owned IPC dispatcher
releases its manager reference. Quit drains admitted RPC acknowledgements within
its existing deadline. Native GPU/compositor errors remain blocking diagnostics;
the gate does not disable hardware acceleration or globally allow them.
Notification lifetime regressions destroy a real Electron child synchronously
during its bounds update, with ordinary close as the negative control. They
verify that pending layout/ready work cannot continue against a retired child.
This controlled native boundary does not qualify physical desktop input.

Runtime, compiler and terminal-service channels carry their protocol/data through
IPC, not stdout. Unknown stdout on those internal service streams therefore fails
alongside stderr. Audited command/Codex/bridge protocol stdout and external PTY
output retain their separate boundaries; the word `Error` is never the classifier.

Renderer console events carry their frame's OS PID and routing identity. Chromium
native stderr prefixes identify the emitting child PID; GPU/viz diagnostics use
`electron-gpu` rather than the main process whose pipe transports them. Source
attribution does not change severity or authorize any native error.

PTY evidence includes the actual PTY PID and terminal ID, including output received
while no renderer view is attached. Ordinary shell command output and exits are
external evidence. An abnormal owned Codex TUI exit fails; an explicitly requested
Stop is distinguished from an unexplained signal. Terminal parser/storage failures
and Codex adapter or MCP-startup failures remain owned errors even when callers
catch them to display a recovery action. Explicit causal IDs link service errors to
forwarded IPC/console notifications without counting the same primary error twice;
these IDs are test diagnostics, not persisted application records or public MCP data.

Codex Quit cancellation uses a distinct lifecycle cause. Read-only discovery may
finish with the current catalog when Quit cancels its admitted operation; a later
OS exit cannot overwrite that cause. Established launches are marked stopped before
concurrent PTY cleanup. Unexpected backend exits and protocol failures keep their
original cause and remain gate failures.

Audited callback/promise execFile and synchronous helpers redact using the child
launch environment too. A secret supplied only to one child is not allowed to leak
through stdout/stderr; the overload regression uses synthetic credentials and
retains the native callback/promise contracts.

The authenticated MCP model client uses `tests/support/codex-client.ts` for
launch-only state boundaries. Codex 0.162.1 gives ephemeral sessions no state DB
handle, but its shell-snapshot cleanup still resolves existing rollouts, emits
`falling_back` for each retained snapshot, and deletes orphan snapshots from its
authentication home. This client disables that optional shell context mechanism
with `features.shell_snapshot=false`; it must not consume or modify the operator's
shell snapshots. SQLite/log directories remain disposable, credentials are neither
copied nor edited by the test, and normal application/TUI launch settings are unchanged.

`codex-client-isolation.test.ts` creates a valid rollout and DB with the installed
Codex and a credential-free loopback provider. Its explicit negative control
reproduces one fallback plus orphan deletion; the shared authenticated-client
arguments then preserve both retained and orphan snapshots. This protects actual
side effects, rather than merely allowing a warning. All other diagnostics remain
subject to the strict collector; the authenticated full MCP scenario still tests
real model access, privacy, Save, full snapshots and attachments.

A requested child Stop authorizes only a clean exit or the observed SIGTERM/SIGKILL
termination of a still-live child. An arbitrary nonzero exit after that request
still fails: the regression handles SIGTERM by exiting7 and verifies rejection.
A Stop marker also cannot retroactively excuse a process that already failed.
