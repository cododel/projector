# Projector Alpha 1

**Projector by Cododel** is a workspace uniting projects, agents and tools.

*Your projects. Your agents. Your workspace.*

Projects are the main entity: each owns sessions, plans and shared terminals. Sessions have their own terminals, tabs and layouts. Saved working state, explicit actions and inspectable results make work predictable. The current alpha integrates Codex CLI and visual planning through MDX documents, questions, annotations and immutable **Save** snapshots. Approval records agreement and never starts implementation.

Additional harnesses, file and Git workflows, environment management and repeatable-operation automation are development directions; they are not claimed as delivered features.

Comment entry starts as one compact row and grows up to six text lines; longer comments scroll inside the field. **Enter** fixes the private comment, **Shift+Enter** adds a line, and **Escape** cancels. Clicking outside fixes nonempty text or cancels an empty new/edit comment. IME composition does not submit early. Edit mode provides Delete, Cancel and Save. Artifact **Save** still publishes the state separately.

## Run from source

macOS, Node.js **24.20.0**, pnpm **10.33.0**:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

For the production build:

```sh
pnpm build
pnpm start
```

Closing the last window on macOS leaves the local runtime and owned terminal processes running. Use **Projector → Quit Projector** to stop them. Restoring a workspace never starts a shell or resumes Codex; both require an operator action. There is no LaunchAgent or Projector cloud account.

## Connect Codex

Open a project folder. When calling `create_artifact`, the agent supplies `originSession` for that artifact; no project-level session binding is required. If the agent does not know its session ID, it asks you. Two artifacts in one project may belong to different sessions. The session link in artifact properties is metadata, not confirmation that the harness is alive.

For local testing in this checkout, an explicitly requested project connection can be stored in `.codex/config.toml`; that personal file is excluded by `.gitignore`. The generated setup prompt continues to default to user-level setup. Project configuration must be loaded by a trusted Codex project; reconnect the client after configuration changes.

Open **MCP connection**, click **Copy setup prompt**, and paste the prompt into your agent. It includes the exact configuration for this running instance and asks the agent to configure only your user-level `CODEX_HOME/config.toml` (when `CODEX_HOME` is set), otherwise `~/.codex/config.toml`. This connection is shared across projects. Personal executable and runtime descriptor paths must not be written to project `.codex/config.toml` or committed. The prompt preserves other servers, policies, skills, hooks and `AGENTS.md`; project overrides are inspected read-only for conflicts. You can preview the prompt or use **Copy configuration** under **Connection details and manual configuration** for manual setup in the same user-level file. Projector itself does not edit your configuration. Reconnect or restart the MCP client when its configuration requires it; saving the config does not prove the tools are loaded in the current session and does not resume an old session.

The app generates configuration for its actual launch mode and runtime descriptor. `pnpm dev` is **Development**; `pnpm build && pnpm start` is **Production build from source**. Both use your system Node.js and the real absolute `out/bridge.cjs` path. To choose a specific Node executable, launch a source build with `PROJECTOR_NODE=/absolute/path/to/node`.

A packaged `.app` uses its own `Contents/Resources/mcp/projector-mcp` helper and bundled Node runtime. Its path follows the actual application location; no system Node discovery or source-directory fallback is used. The generated MCP config includes `PROJECTOR_RUNTIME_DESCRIPTOR` for the running instance. The runtime chooses a free port on `127.0.0.1`; its atomically written descriptor contains `protocolVersion`, `instanceId`, the `/mcp` URL and a random token. On macOS the descriptor has mode `0600` in a private runtime directory. The bridge verifies the runtime identity before connecting. Keep the descriptor and its token private; configuration contains its path, not a copied token.

Keep Projector running. If the runtime is absent, the bridge prints a diagnostic to stderr and exits without launching the app. After moving the `.app`, copy its newly generated configuration; an existing config retains the old path. Reconnect the MCP client after restarting Projector.

If the operator IPC connection drops during a call, the app reports `UNKNOWN_RESULT` instead of claiming that an uncertain mutation failed or repeating it. An operation may already have completed; reconcile its persisted result before retrying. Projector does not automatically replay mutations.

## Package a local macOS app

```sh
pnpm package:mac
```

This builds an **unsigned** `dist/Projector-darwin-<architecture>/Projector.app` for the build machine's architecture. Packaging requires macOS Node.js **24.20.0**; it copies that Node executable, its license and the compiled bridge into the `.app`. `PROJECTOR_NODE` can select an equivalent official Node distribution at build time. Use the same architecture for Node and Electron. Packaging uses the already installed, version-checked Electron distribution and does not download from GitHub; missing or mismatched dependencies fail explicitly. This is a local development package; Developer ID signing, notarization, cross-architecture release builds and public distribution are not implemented yet.

Open the generated `.app` and use its **MCP connection** dialog to get the command at its current location. The packaged helper needs neither a Node entry in `PATH` nor the source project. Missing helper resources are reported explicitly; the app does not emit a configuration that falls back to an external Node installation.

## Demonstration cycle

1. Open a disposable project and ask the agent to call `get_projector_guide`, then `create_artifact` with its explicitly known `originSession`. Only agents create plans. The agent writes `plan.mdx`, publishes it and calls `show_artifact`. Open the project panel to find its plans; the project **+** starts a new Codex CLI session.
2. Choose widget answers. Select text to reveal **Annotate**; only clicking it opens the comment popover. Save or cancel the comment. Answers, annotations and unfinished comment text autosave privately and survive restart.
3. Click **+** in the plan's tab strip and enter an HTTP(S) URL on **New tab**, or ask the agent to call `show_content({artifactId,url})`. In annotation mode, hover frames an element, click selects it, and drag selects an arbitrary region. The captured image contains the complete tab viewport. A pointed number badge targets the exact click position, or the mouse-release position after dragging; that original point is retained in the saved image. The browser uses a persistent isolated profile for each project.
4. Finish or cancel any unfinished comment, then click **Save**. It waits for autosave and creates a complete immutable snapshot of this artifact's answers and all annotations, including references to earlier document versions. Comments remain visible and editable for the next Save.
5. Select the intended session and click **Copy update message**. The message contains `projectId`, `artifactId` and `savedStateId`; Projector activates that terminal. Paste and send it yourself. Choosing an executor never changes the artifact's authoring `originSession`. Copying is not delivery or proof that the agent processed the update.
6. The agent calls `read_artifact({artifactId,part:"state",savedStateId})`, follows cursors and reads saved images through `read_attachment`. It considers the decisions, updates source and publishes another revision.
7. Review the revision. Compatible widget values carry forward; old annotation anchors and approvals remain attached to their original versions/states. Markers are shown only when the current widget values and Details state match the annotation context. Clicking an annotation from another state opens a read-only original-context preview without replacing your working answers; return to working state to continue. Browser marks appear only for a matching page/state/layout and valid element anchor; otherwise the original frozen capture is shown.
8. **Approve this version** separately when there are no unsaved substantive changes. Approval does not send an update message or start implementation. Repository contracts must still be reconciled under project rules; implementation needs its own authorization.

The guide is bundled with the application, versioned with its release, and available offline through MCP. No Projector skill or hook installation is required.

After a comment is committed locally, the frozen viewport shows only its area frame and numbered pointer. The comment remains in the feedback sidebar and JSON; the input appears only while editing. The original capture is reused even if the live page changes during typing. A local write failure keeps the editor open. Explicit Save fixes the attachment numbering in the immutable state.

## Workspace navigation

Projector is project-centric: a project owns sessions, plans and shared terminals, while each session keeps its own workspace and terminal views. The project disclosure toggles its non-archived standalone session list; the project name opens its control panel. All plans live in that panel. The project **+** and native **New session** menu launch Codex CLI explicitly, without duplicate launches during an operation. Discovery never starts or resumes an agent. Plans are agent-created through MCP only. Rename changes the title; Archive sets independent metadata, preserving history, approvals and private work. **Show archived plans** and **Restore** provide recovery. Remove from list remains confirmed and never deletes project data. Canonical cwd keeps separate checkout/worktree projects distinct. A fixed second panel directly below the tab strip contains the **Version N** selector and status. On document tabs it also contains **Annotate** and the private-save status, which remain visible while the document scrolls. A compact top row shares the workspace column grid, keeping native macOS controls and draggable backgrounds. Sidebar sections keep toggles at their inner edges; hidden sidebar toggles move into the central tab section. Both stay available when sidebars are hidden and on the welcome screen. Buttons are excluded from dragging; visibility is retained locally and the browser viewport resizes with the workspace.

Each session retains its own tab strip, nested horizontal/vertical splits, ratios and active pane. Documents, **New tab**, browsers and terminals share the main tab strip. The project also retains a standalone Plans workspace when no session is selected. Existing plan tabs migrate without changing artifact data. The plus button creates a home screen with a focused URL field; navigation converts that same tab into a browser. Address and navigation controls appear only in browser tabs. Empty plans can open browsers and create private browser annotations before publication. Save and Approve require an attached agent session and a first published document. Selecting a plan in the tree opens or reuses its document tab; closing the last tab leaves **Open plan** and **New tab** actions.

Cross buttons and middle-click share the same close behavior. Tab/plan changes first complete any comment and wait for private writes. Closing a tab preserves Projector answers and annotations locally; it does not **Save**, approve, notify the agent or delete the plan. A failed write blocks closing and offers Retry or Cancel. A site's `beforeunload` warning separately asks **Close tab / Cancel**, with Cancel as the default, before its native view is destroyed.

Refresh notifications are coalesced into one reader. Updates received during a read, plan transition or private autosave remain pending and are read afterward; a departing document ignores refreshes for a different artifact/version. The plan list reads status metadata without compiling document previews. Repeated registry/state reads share a cache only within one read operation; subsequent operations revalidate the files.

Tab order, pane layout, selected document version, browser URLs, workspace scroll position, settings and sidebar visibility are versioned local app metadata. Browser views restore lazily by URL after restart; unsaved website form contents and full browser history are not restored. Frozen annotation captures retain their original context. Repeated cleanup or a page destroyed before window shutdown must not cause a lifecycle exception.

## Terminals, sessions and settings

Use **New Codex session** or explicit **Resume** to launch the qualified Codex CLI **0.162.1**. Projector owns the backend and attached CLI TUI for that launch; it binds the exact `thread.id` observed in the TUI protocol. It does not infer IDs from recent files, titles or activity. External sessions open as metadata cards; Resume uses the exact selected ID and never takes over another terminal. External process presence remains unknown unless evidenced. Missing or unqualified Codex is reported without installing it or changing login, sandbox, model, approvals, trust, hooks or user configuration. Projector MCP configuration is supplied for this launch only.

Manual **Split right/down** starts a shell with the source terminal's cwd, or the project cwd when the source pane is a document/browser. Plans default to opening beside the active terminal; **Settings → General** can choose a new tab instead. An already open document is reused in that workspace. The same artifact can be shown in several session workspaces: answers and annotations belong to the artifact, while layout and scroll belong to each workspace. Each browser pane uses its actual content bounds; only the active browser pane owns annotation controls and live markers.

The bottom panel contains shared **project terminals**, independent of the selected session. It has its own tabs, selected terminal and saved height; use **⌘J** to toggle it. Closing a terminal tab or pane removes its view and leaves the process running. Reopen it from the project's terminal list; **Stop** asks before terminating the owned process. Closing a window or recovering the renderer preserves PTYs. **Quit**, service failure or reboot removes ended terminals and their saved screens; **Start shell** and exact **Resume** are explicit actions, and project commands are never replayed automatically.

A dedicated terminal service owns `node-pty`; xterm.js renders its output. One PTY may have several views, with input and geometry controlled by the active visible view. Standard terminal keys reach the PTY unchanged: Ctrl+C interrupts/cancels and Ctrl+D supplies EOF/quits according to the running program. While resize awaits acknowledgement, up to 64 KiB of input is buffered in memory and sent in order after the latest confirmation. Deactivation/disposal cancels unsent input; uncertain delivery never replays keystrokes. Ordered output and replay recover subscriptions without relaunch. Saved screens/output default to the last **10,000 lines**, with truncation marked; there is no separate keystroke journal. Terminal output can include sensitive command results; local screens are removed when the process ends.

TUI scrolling follows wheel distance at normal speed: small movements accumulate, and reversing direction discards pending movement. Large gestures are bounded to two terminal heights and delivered in portions of up to 16 lines per frame. Normal terminal scrollback retains xterm behavior; scrolling never selects another pane.

Open **Settings** with **⌘,** for General, Terminal, Harnesses and Keyboard shortcuts. Configure plan placement and restoration, shell/arguments, font/size, saved output limit, Codex executable/profile, and searched/remapped/disabled/reset shortcuts with conflict detection. Defaults include **⌘W**, **Control+Tab**, **Control+Shift+Tab**, **⌘J** and **⌘,**; split/pane-navigation shortcuts initially have no assignment. Ordinary terminal input and IME composition are not shortcut commands.

**Harnesses** displays observed Projector MCP startup status for owned Codex launches. `ready` confirms the backend's startup event, not ongoing connection health or receipt of a saved state. External client status remains unknown. The selected Codex profile synchronizes automatically on startup, profile/project changes and every 15 seconds; **Refresh local sessions** remains available. Discovery never starts or resumes sessions. The shared catalog and handoff picker show non-archived standalone sessions; protocol-marked subagents and archived sessions are hidden, while user forks and unknown sources remain visible. Hiding an entry retains its workspace, history and owned process. Session rows expose Pin and Archive on hover or keyboard focus. Pin is a local Projector preference, persisted across restarts and ordered first within each project. Archive uses Codex thread/archive by exact thread ID; a compact animated notification offers Undo through thread/unarchive, without an archive viewer. Hiding a session retains its workspace, plans and processes. Undo requires the original Codex profile; mutations are not replayed after a lost acknowledgement.

The current qualification targets macOS. Portable transport and PTY libraries do not establish Linux/Windows support. Automatic orchestration, worktree management, chat and automatic message delivery remain outside this stage.

## Authoring

`create_artifact` takes `projectId`, `kind="projector"`, `title`, explicit `originSession` and `operationId`, and returns a source directory. Write `plan.mdx` there, then publish it with the current `expectedLatestRevision` (null for the first revision) and a unique `operationId`. Request `authoring`, `widgets`, or reference `permissions-plan` with `get_projector_guide` for exact examples.

Supported: Markdown/GFM, tables, safe diagram fences, Details, Callout, Choice, TextAnswer and Checklist. No imports, executable expressions, custom handlers, arbitrary TSX or remote resources. Values are explicit serializable decisions with a stable ID, meaning and semantic version. Source changes are made by the agent, not the operator. Unpublished artifacts open as **Draft preview**, with widgets disabled. Missing source shows a waiting state; invalid MDX shows diagnostics and source text without publishing it.

## Local data

Each selected folder, including a separate worktree, is a project. `.projector` contains source directories, immutable document revisions, saved state snapshots with their attachments, preserved legacy Submit packages and approval records. Private working values, draft images and unfinished comments live under `~/Library/Application Support/Projector`, scoped to an artifact rather than a project recipient. Browser annotations made before the first document retain `revisionId:null`; saved snapshots containing them use `formatVersion:2`. Version 1 remains readable; capabilities declares `supportedSavedStateVersions:[1,2]`. Published documents and old images are unchanged. Saved-state JSON is authoritative; readable Markdown is derived. Each new document annotation records its original widget values and Details state in `source.stateContext`. Optional browser page/state/layout/element anchors support valid live placement; frozen captures always retain the original context. Autosave does not publish any of these drafts through MCP. Existing private drafts migrate without publication; old Submit packages and approvals remain readable. These are interface privacy boundaries, not protection against other programs running as the same macOS user.

The runtime exposes public MCP tools through authenticated Streamable HTTP on loopback and a compatible stdio bridge. It validates Host, rejects browser Origin headers and verifies the runtime instance; no CORS access is granted to external pages. Operator commands and PTY control use private Electron IPC and never become MCP tools. Documents have a separate origin, sandboxed rendering and a narrow bridge. Widgets cannot Save, approve, access shell or call MCP tools. External browser pages run without Node integration, shell or operator-command access. HTTP(S), including localhost, is supported; privileged schemes are rejected. Browser annotations expose only the image chosen by the operator after Save, not cookies, network history or live agent browser control.

## Checks

```sh
pnpm check
```

The checks use disposable projects and app data. Electron, PTY and HTTP tests need an environment that permits local GUI processes and loopback listeners. They never edit your Codex configuration or use real project sessions. The standard suite tests a real MCP client transport and Electron. The opt-in `PROJECTOR_CODEX_TEST=1 pnpm exec playwright test tests/e2e/codex.spec.ts` also invokes your authenticated Codex CLI and a model in a disposable project; it uses ephemeral command-line MCP/approval settings and makes no config-file edits. See `docs/CODEX-COMPATIBILITY.md` for the separately recorded Codex evidence.

`pnpm check`, `pnpm test:e2e` and direct `pnpm exec playwright test` run Electron in the background by default: windows stay hidden and cannot take native focus; background throttling is disabled so rendering, input and captures continue. This also applies to development, packaged-app tests and standalone fixtures. A native-event audit fails the run if a test window is shown or receives focus, or the app becomes active; its log is retained in `.tmp/e2e-window-audit-*/windows.jsonl`. Normal `pnpm dev` / `pnpm start` behavior is unchanged.

For deliberate visible debugging, use `pnpm test:e2e:visible`, or `PROJECTOR_E2E_VISIBLE=1 pnpm exec playwright test <test-file>`. These commands can interrupt desktop work. Hidden rendering is not a replacement for separate checks of native focus, system IME, menus/dialogs or normal visibility/throttling behavior. Background E2E is verified on macOS with Electron 44.7.0; it still requires a graphical session and is not a headless backend.

Local `pnpm check` runs hidden E2E without activating windows; it does not prove desktop composition or native focus/input. `pnpm check:full` runs static checks, units, the hidden-mode guarantee, all applicable visible E2E (including authenticated Codex). Project pre-push validates each pushed commit in an isolated checkout. No VM or pre-commit dependency. Full runs intentionally take focus; see [Testing](docs/testing/TESTING.md).

`PROJECTOR_DATA` and `PROJECTOR_RUNTIME_DESCRIPTOR` allow isolated test runtimes. `PROJECTOR_SOCKET` is rejected with migration instructions: remove the old setting and copy the current MCP configuration from the application. The normal application needs no environment variables.

## Status

See `ALPHA-1.md` for the implemented subset and `PRD.md` for the target product. Alpha 1 supports source launch and local unsigned macOS packaging; signed distribution is deferred. npm delivery through `npx`/`bunx` is recorded in `docs/issues/[OPEN]-2026-10-09-mcp-npm-stdio-distribution.md` and is not available yet. Automatic steer, chat/file annotation, arbitrary TSX prototypes and prototype case replay remain deferred. Browser and document area annotation captures the full visible viewport and original click/release point; it does not guarantee replay of dynamic page state. Browser capture checks the selected target/region together with navigation, viewport, scroll and zoom. Unrelated page activity does not by itself reject a capture. Same-document history updates before selection keep the uncaptured tool active; navigation during capture still rejects the attempt. Changes within the selection may be retried up to three times; persistent target changes ask the operator to select again without creating a partial comment. Current Codex TUI, workspace/runtime gates and their remaining manual boundaries are recorded in [the acceptance matrix](docs/acceptance/CURRENT-STAGE.md); previous saved-state evidence is retained separately. Historical Submit evidence is preserved separately. Annotation state context, hover selection and conditional live markers require their own acceptance results; their documentation is not a claim that testing is complete.

## Current-stage completion

Projects support **Locate folder**, **Remove from list**, and explicit creation of an empty copy after backing up its copied `.projector`. Relocation preserves identity and private work. Removed projects retain their identity ownership, so reopening a copy cannot silently import the original's private work. Version changes show **Retained / New / Requires response / Removed** answers. **Revoke approval** appends an event; it never alters an earlier approval.

The offline **Projector guide** uses the same content and guideVersion as MCP. Closing the window keeps the runtime running; **Quit** stops the app. A crashed or unresponsive shell offers **Reload view** from confirmed local work.

Browser controls include Stop, 50–200% zoom/Reset, external HTTP(S) opening, user-gesture popups, Save As, and explicit camera/microphone/location decisions scoped to one tab and origin. Profile cleanup respects beforeunload and preserves documents and captures. External authentication is not imported back. Live annotation supports arrows (Shift for larger steps), Enter for element selection, and Space/arrows/Enter for a region.

`get_projector_context.capabilities.limits` reports versioned effective limits. `PROJECTOR_COMPILE_TIMEOUT_MS` and `PROJECTOR_CAPTURE_TIMEOUT_MS` accept 100–300000 ms, with defaults 30000/10000. A capture timeout cannot later create an editor. Write failures before rename differ from an **UNKNOWN_RESULT** after rename; retries reconcile the operation and manifest. Delayed writes display progress without claiming cancellation. Pending Save operations remain scoped to their artifact and revision.

`pnpm test:performance` runs a separate representative load qualification. Functional gates and pre-push remain in place; no pre-commit hook was added. [Current acceptance](docs/acceptance/CURRENT-STAGE.md) records evidence and remaining manual checks. Physical IME, OS composition and device permissions are not proven by Playwright. Chat, TSX, cases, automatic delivery, signing/notarization and npm publication remain outside this stage.

Вкладки каждого плана находятся в компактном тайтлбаре; документная вкладка — **Plan**. Имя плана видно в дереве проектов. Ниже закреплены версия, статус и Annotate; плюс и переключатели сайдбаров доступны независимо от прокрутки вкладок.

Each session keeps a permanent first **Codex** tab. It cannot be closed with the cross, middle-click, Command-W or a pane-close command. Ordinary tabs and split siblings remain closable. When its process ends, the PTY and screen are removed, while the session tab remains with metadata and explicit exact-ID Resume. Restoring older workspaces adds the missing tab without starting Codex or replacing plans/private work. Standalone project workspaces have no pinned session tab.

On macOS, drop local files onto a live terminal to insert their absolute paths. Multiple paths are separated and shell-sensitive names are quoted. Dropping selects the target terminal pane and uses xterm paste; it never adds Enter, uploads file contents or starts a stopped terminal.

## Rename compatibility

The product, source package and repository identity are **Projector** (`projector`), with macOS bundle ID `dev.cododel.projector`. The current checkout directory may remain `agentic-blueprint` so IDE and workspace settings keep their paths. The new remote is configured separately by the operator; no remote URL is assumed.

New installs use `Projector` application data and new projects use `.projector`. Existing populated `Blueprint` or `agentic-blueprint` app-data roots and `.blueprint` project roots are reused **in place** so absolute recovery paths, IDs, private work and browser profiles survive. Directories containing only known Electron shell files do not count as competing app stores; their files are left untouched. Unknown files and persistent browser partitions still count as data. Two populated candidates cause an explicit conflict; Projector does not merge, move or overwrite them. `PROJECTOR_DATA` can select the intended app-data root. Old browser partition names are retained only when their stored profile exists.

Current setup uses the `projector` MCP entry, `projector-mcp` packaged helper and `PROJECTOR_*` variables. Legacy `BLUEPRINT_*` environment values remain fallbacks; new values win. Legacy `get_blueprint_guide` / `get_blueprint_context` calls and `kind: "blueprint"` artifact records remain supported. New guide/context names are `get_projector_guide` / `get_projector_context`; new artifacts use `kind: "projector"`. Published revisions, saved states and historical evidence are not rewritten.

After installing the renamed app, copy its new setup configuration and reconnect your client. Projector does not rename an installed app, edit personal Codex configuration or rewrite old configured executable paths automatically. Do not run both brands against the same data simultaneously.

## License

Projector is licensed under the custom **Projector Source-Available License 1.0**, with `Copyright (c) 2026 Cododel`. See [LICENSE](LICENSE). It is not MIT, GPL, Apache or an OSI-approved open-source license.

- **Free use:** individuals and organizations of any size, including commercial and client work. Internal modifications may stay private.
- **Free distribution:** original versions and forks must include complete corresponding source publicly available to everyone, retain copyright and LICENSE, and use the same terms for derivatives.
- **Paid services:** installation, support and commissioned modifications are allowed when the program itself is supplied free of charge; distribution conditions still apply.
- **Independent extensions:** plugins, harness adapters and integrations containing no Projector code may be sold under their own licenses. Public API use and UI integration alone are unrestricted.
- **Separate agreement:** selling program copies, licensing derivatives for a fee and paid hosted access to Projector/forks. Copying Projector code into another standalone product requires separate permission; free forks remain allowed.
- **Excluded:** user projects and outputs; third-party components retain their own licenses. Permanent UI branding or advertising attribution is not required.

The license text was prepared from the owner's agreed policy and has **not been legally reviewed**. Obtain legal review before publication. The license includes standard warranty and liability disclaimers.
