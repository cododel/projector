# Blueprint Alpha 1

Local visual planning alongside an external agent. Publish an MDX plan through MCP, answer its questions, annotate passages or captured regions and explicitly **Save** an immutable state snapshot. Approval records agreement and never starts implementation.

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

Closing the last window on macOS leaves the local runtime running. Use **Blueprint → Quit Blueprint** to stop it. There is no LaunchAgent, cloud account or automatic harness startup.

## Connect Codex

Open a project folder. When calling `create_artifact`, the agent supplies `originSession` for that artifact; no project-level session binding is required. If the agent does not know its session ID, it asks you. Two artifacts in one project may belong to different sessions. The session link in artifact properties is metadata, not confirmation that the harness is alive.

For local testing in this checkout, an explicitly requested project connection can be stored in `.codex/config.toml`; that personal file is excluded by `.gitignore`. The generated setup prompt continues to default to user-level setup. Project configuration must be loaded by a trusted Codex project; reconnect the client after configuration changes.

Open **MCP connection**, click **Copy setup prompt**, and paste the prompt into your agent. It includes the exact configuration for this running instance and asks the agent to configure only your user-level `CODEX_HOME/config.toml` (when `CODEX_HOME` is set), otherwise `~/.codex/config.toml`. This connection is shared across projects. Personal executable and socket paths must not be written to project `.codex/config.toml` or committed. The prompt preserves other servers, policies, skills, hooks and `AGENTS.md`; project overrides are inspected read-only for conflicts. You can preview the prompt or use **Copy configuration** under **Connection details and manual configuration** for manual setup in the same user-level file. Blueprint itself does not edit your configuration. Reconnect or restart the MCP client when its configuration requires it; saving the config does not prove the tools are loaded in the current session and does not resume an old session.

The app generates configuration for its actual launch mode and runtime socket. `pnpm dev` is **Development**; `pnpm build && pnpm start` is **Production build from source**. Both use your system Node.js and the real absolute `out/bridge.cjs` path. To choose a specific Node executable, launch a source build with `BLUEPRINT_NODE=/absolute/path/to/node`.

A packaged `.app` uses its own `Contents/Resources/mcp/blueprint-mcp` helper and bundled Node runtime. Its path follows the actual application location; no system Node discovery or source-directory fallback is used. The generated MCP config includes `BLUEPRINT_SOCKET` for the running instance, including isolated/custom runtimes. No TCP port is used.

Keep Blueprint running. If the runtime is absent, the bridge prints a diagnostic to stderr and exits without launching the app. After moving the `.app`, copy its newly generated configuration; an existing config retains the old path. Reconnect the MCP client after restarting Blueprint.

If the operator connection drops during a call, the app reports `UNKNOWN_RESULT` instead of an uncaught socket exception. An operation may already have completed; reconcile its persisted result before retrying. Blueprint does not automatically replay mutations.

## Package a local macOS app

```sh
pnpm package:mac
```

This builds an **unsigned** `dist/Blueprint-darwin-<architecture>/Blueprint.app` for the build machine's architecture. Packaging requires macOS Node.js **24.20.0**; it copies that Node executable, its license and the compiled bridge into the `.app`. `BLUEPRINT_NODE` can select an equivalent official Node distribution at build time. Use the same architecture for Node and Electron. Packaging uses the already installed, version-checked Electron distribution and does not download from GitHub; missing or mismatched dependencies fail explicitly. This is a local development package; Developer ID signing, notarization, cross-architecture release builds and public distribution are not implemented yet.

Open the generated `.app` and use its **MCP connection** dialog to get the command at its current location. The packaged helper needs neither a Node entry in `PATH` nor the source project. Missing helper resources are reported explicitly; the app does not emit a configuration that falls back to an external Node installation.

## Demonstration cycle

1. Open a disposable project and ask the agent to call `get_blueprint_guide`, then create an artifact with its explicit `originSession`. The bundled `permissions-plan` reference is a planning example. The agent writes `plan.mdx`, publishes it and calls `show_artifact`.
2. Choose widget answers. Select text to reveal **Annotate**; only clicking it opens the comment popover. Save or cancel the comment. Answers, annotations and unfinished comment text autosave privately and survive restart.
3. Click **+** in the plan's tab strip and enter an HTTP(S) URL on **New tab**, or ask the agent to call `show_content({artifactId,url})`. In annotation mode, hover frames an element, click selects it, and drag selects an arbitrary region. The captured image contains the complete tab viewport. A pointed number badge targets the exact click position, or the mouse-release position after dragging; that original point is retained in the saved image. The browser uses a persistent isolated profile for each project.
4. Finish or cancel any unfinished comment, then click **Save**. It waits for autosave and creates a complete immutable snapshot of this artifact's answers and all annotations, including references to earlier document versions. Comments remain visible and editable for the next Save.
5. Click **Copy update message** and paste it into the artifact's associated agent session. The message contains `artifactId` and `savedStateId`. Copying is not delivery or proof that the agent processed the update.
6. The agent calls `read_artifact({artifactId,part:"state",savedStateId})`, follows cursors and reads saved images through `read_attachment`. It considers the decisions, updates source and publishes another revision.
7. Review the revision. Compatible widget values carry forward; old annotation anchors and approvals remain attached to their original versions/states. Markers are shown only when the current widget values and Details state match the annotation context. Clicking an annotation from another state opens a read-only original-context preview without replacing your working answers; return to working state to continue. Browser marks appear only for a matching page/state/layout and valid element anchor; otherwise the original frozen capture is shown.
8. **Approve this version** separately when there are no unsaved substantive changes. Approval does not send an update message or start implementation. Repository contracts must still be reconciled under project rules; implementation needs its own authorization.

The guide is bundled with the application, versioned with its release, and available offline through MCP. No Blueprint skill or hook installation is required.

After a comment is committed locally, the frozen viewport shows only its area frame and numbered pointer. The comment remains in the feedback sidebar and JSON; the input appears only while editing. The original capture is reused even if the live page changes during typing. A local write failure keeps the editor open. Explicit Save fixes the attachment numbering in the immutable state.

## Workspace navigation

The sidebar groups compact plan rows under collapsible project folders. The left icon shows Draft, In review or Approved with a status tooltip; the separate private-change indicator does not imply publication. The Codex button opens the plan's recorded session deep link without selecting the plan or verifying that the session is available. A fixed second panel directly below the tab strip contains the plan title, **Version N** selector and status. On document tabs it also contains **Annotate** and the private-save status, which remain visible while the document scrolls. A compact window title bar keeps the native macOS controls and a draggable background. The projects toggle sits beside the window controls; the feedback toggle sits at the right edge. Both stay available when sidebars are hidden and on the welcome screen. Buttons are excluded from dragging; visibility is retained locally and the browser viewport resizes with the workspace.

Each plan retains its own document, **New tab** and browser tabs. The plus button creates a home screen with a focused URL field; navigation converts that same tab into a browser. Address and navigation controls appear only in browser tabs. Draft plans can be previewed, but browser opening requires a published revision. Selecting a plan in the tree opens or reuses its document tab; closing the last tab leaves **Open plan** and **New tab** actions.

Cross buttons and middle-click share the same close behavior. Tab/plan changes first complete any comment and wait for private writes. Closing a tab preserves Blueprint answers and annotations locally; it does not **Save**, approve, notify the agent or delete the plan. A failed write blocks closing and offers Retry or Cancel. A site's `beforeunload` warning separately asks **Close tab / Cancel**, with Cancel as the default, before its native view is destroyed.

Refresh notifications are coalesced into one reader. Updates received during a read, plan transition or private autosave remain pending and are read afterward; a departing document ignores refreshes for a different artifact/version. The plan list reads status metadata without compiling document previews. Repeated registry/state reads share a cache only within one read operation; subsequent operations revalidate the files.

Tab order, selected document version, browser URLs and sidebar visibility are local app metadata. Browser views restore lazily by URL after restart; unsaved website form contents and full browser history are not restored. Frozen annotation captures retain their original context. Repeated cleanup or a page destroyed before window shutdown must not cause a lifecycle exception.

## Authoring

`create_artifact` takes `projectId`, `kind="blueprint"`, `title`, explicit `originSession` and `operationId`, and returns a source directory. Write `plan.mdx` there, then publish it with the current `expectedLatestRevision` (null for the first revision) and a unique `operationId`. Request `authoring`, `widgets`, or reference `permissions-plan` with `get_blueprint_guide` for exact examples.

Supported: Markdown/GFM, tables, safe diagram fences, Details, Callout, Choice, TextAnswer and Checklist. No imports, executable expressions, custom handlers, arbitrary TSX or remote resources. Values are explicit serializable decisions with a stable ID, meaning and semantic version. Source changes are made by the agent, not the operator. Unpublished artifacts open as **Draft preview**, with widgets disabled. Missing source shows a waiting state; invalid MDX shows diagnostics and source text without publishing it.

## Local data

Each selected folder, including a separate worktree, is a project. `.blueprint` contains source directories, immutable document revisions, saved state snapshots with their attachments, preserved legacy Submit packages and approval records. Private working values, draft images and unfinished comments live under `~/Library/Application Support/Blueprint`, scoped to an artifact rather than a project recipient. Saved-state JSON is authoritative; readable Markdown is derived. Each new document annotation records its original widget values and Details state in `source.stateContext`. Optional browser page/state/layout/element anchors support valid live placement; frozen captures always retain the original context. Autosave does not publish any of these drafts through MCP. Existing private drafts migrate without publication; old Submit packages and approvals remain readable. These are interface privacy boundaries, not protection against other programs running as the same macOS user.

The local Unix socket is restricted to the current user. Documents have a separate origin, sandboxed rendering and a narrow bridge. Widgets cannot Save, approve, access shell or call MCP tools. External browser pages run without Node integration, shell or operator-command access. HTTP(S), including localhost, is supported; privileged schemes are rejected. Browser annotations expose only the image chosen by the operator after Save, not cookies, network history or live agent browser control.

## Checks

```sh
pnpm check
```

The checks use disposable projects and app data. Electron and Unix-socket tests need an environment that permits local GUI processes and sockets. They never edit your Codex configuration or use real project sessions. The standard suite tests a real MCP client transport and Electron. The opt-in `BLUEPRINT_CODEX_TEST=1 pnpm exec playwright test tests/e2e/codex.spec.ts` also invokes your authenticated Codex CLI and a model in a disposable project; it uses ephemeral command-line MCP/approval settings and makes no config-file edits. See `docs/CODEX-COMPATIBILITY.md` for the separately recorded Codex evidence.

`pnpm check`, `pnpm test:e2e` and direct `pnpm exec playwright test` run Electron in the background by default: windows stay hidden and cannot take native focus; background throttling is disabled so rendering, input and captures continue. This also applies to development, packaged-app tests and standalone fixtures. A native-event audit fails the run if a test window is shown or receives focus, or the app becomes active; its log is retained in `.tmp/e2e-window-audit-*/windows.jsonl`. Normal `pnpm dev` / `pnpm start` behavior is unchanged.

For deliberate visible debugging, use `pnpm test:e2e:visible`, or `BLUEPRINT_E2E_VISIBLE=1 pnpm exec playwright test <test-file>`. These commands can interrupt desktop work. Hidden rendering is not a replacement for separate checks of native focus, system IME, menus/dialogs or normal visibility/throttling behavior. Background E2E is verified on macOS with Electron 44.7.0; it still requires a graphical session and is not a headless backend.

Local `pnpm check` runs hidden E2E without activating windows; it does not prove desktop composition or native focus/input. `pnpm check:full` runs static checks, units, the hidden-mode guarantee, all applicable visible E2E (including authenticated Codex). Project pre-push validates each pushed commit in an isolated checkout. No VM or pre-commit dependency. Full runs intentionally take focus; see [Testing](docs/testing/TESTING.md).

`BLUEPRINT_DATA` and `BLUEPRINT_SOCKET` allow isolated test runtimes. The normal application needs no environment variables.

## Status

See `ALPHA-1.md` for the implemented subset and `PRD.md` for the target product. Alpha 1 supports source launch and local unsigned macOS packaging; signed distribution is deferred. npm delivery through `npx`/`bunx` is recorded in `docs/issues/[OPEN]-2026-10-09-mcp-npm-stdio-distribution.md` and is not available yet. Automatic steer, chat/file annotation, arbitrary TSX prototypes and prototype case replay remain deferred. Browser and document area annotation captures the full visible viewport and original click/release point; it does not guarantee replay of dynamic page state. Browser capture checks the selected target/region together with navigation, viewport, scroll and zoom. Unrelated page activity does not by itself reject a capture. Same-document history updates before selection keep the uncaptured tool active; navigation during capture still rejects the attempt. Changes within the selection may be retried up to three times; persistent target changes ask the operator to select again without creating a partial comment. The full gate separately verifies the saved-state cycle with Codex CLI 0.162.1; historical Submit evidence is preserved separately. Annotation state context, hover selection and conditional live markers require their own acceptance results; their documentation is not a claim that testing is complete.

## Current-stage completion

Projects support **Locate folder**, **Remove from list**, and explicit creation of an empty copy after backing up its copied `.blueprint`. Relocation preserves identity and private work. Removed projects retain their identity ownership, so reopening a copy cannot silently import the original's private work. Version changes show **Retained / New / Requires response / Removed** answers. **Revoke approval** appends an event; it never alters an earlier approval.

The offline **Blueprint guide** uses the same content and guideVersion as MCP. Closing the window keeps the runtime running; **Quit** stops the app. A crashed or unresponsive shell offers **Reload view** from confirmed local work.

Browser controls include Stop, 50–200% zoom/Reset, external HTTP(S) opening, user-gesture popups, Save As, and explicit camera/microphone/location decisions scoped to one tab and origin. Profile cleanup respects beforeunload and preserves documents and captures. External authentication is not imported back. Live annotation supports arrows (Shift for larger steps), Enter for element selection, and Space/arrows/Enter for a region.

`get_blueprint_context.capabilities.limits` reports versioned effective limits. `BLUEPRINT_COMPILE_TIMEOUT_MS` and `BLUEPRINT_CAPTURE_TIMEOUT_MS` accept 100–300000 ms, with defaults 30000/10000. A capture timeout cannot later create an editor. Write failures before rename differ from an **UNKNOWN_RESULT** after rename; retries reconcile the operation and manifest. Delayed writes display progress without claiming cancellation. Pending Save operations remain scoped to their artifact and revision.

`pnpm test:performance` runs a separate representative load qualification. Functional gates and pre-push remain in place; no pre-commit hook was added. [Current acceptance](docs/acceptance/CURRENT-STAGE.md) records evidence and remaining manual checks. Physical IME, OS composition and device permissions are not proven by Playwright. Chat, TSX, cases, automatic delivery, signing/notarization and npm publication remain outside this stage.
