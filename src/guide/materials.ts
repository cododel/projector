/** Content lives in the application bundle, never in user skills or hooks. */
export const guideTopics = {
  overview: `Blueprint Alpha 1 is a local sidecar for visual planning and requirements agreement. Use it when decisions depend on each other, uncertainty is substantial, or spatial presentation makes the plan easier to inspect. A short linear task usually needs no Blueprint.

Read the relevant topic before authoring or processing saved feedback; refresh this overview when guideVersion changes. Use get_blueprint_context to identify the registered project. You supply originSession when creating an artifact. clientInfo, titles and recent activity do not establish your session ID. If you do not know the ID, ask the operator; do not guess. No project-level recipient binding is required.

The cycle is: create artifact, write sources, publish and show a revision, let the operator respond and annotate, wait for an explicit Save, read the saved state, and publish a revised document. The operator uses Copy update message to tell you the artifactId and savedStateId manually. Copying is not delivery or proof of processing. get_blueprint_guide(topic="planning"|"authoring"|"widgets"|"annotations") provides the detailed rules; reference IDs load examples separately.

User instructions and repository contracts retain their authority. Blueprint adds decisions, rationale, answers and annotations; it does not replace project rules. Agreement is a reason to check contract consistency. Approval does not authorize or start implementation. Follow the project's rules for contract changes and implementation permission.

Alpha supports restricted MDX, built-in questions, exact text annotations, document/browser area annotations, saved-state snapshots and artifact-associated HTTP(S) browser tabs. Arbitrary TSX, prototype case capture and chat/file annotation are later capabilities. Automatic steer is unavailable. Session metadata is not proof that a harness is reachable. Connecting MCP installs no skills, hooks, AGENTS.md or shared rules.

The offline Blueprint guide is also available in the app without a project. Closing its window keeps the local runtime running; Quit stops Blueprint. Project folder relocation and copy creation are explicit operator actions; a copied history is backed up before a new empty identity is created.

Autosaved working values, comments, unfinished composers and images remain private until explicit Save. Save does not clear comments. The server validates formats and allowed operations independently of whether you read the guide. read_artifact(part="state") exposes saved snapshots only, never current private work.`,
  planning: `Make a standalone planning document: goals, scope, requirements, constraints, meaningful alternatives with tradeoffs, explicit assumptions, unresolved questions, risks and observable acceptance criteria. Include details required to understand the agreement even if they were mentioned earlier in chat.

Use text for simple explanations; tables for comparable alternatives or permissions; diagrams for dependencies; declared questions for choices that affect behavior. Collapsed detail remains part of the document. Visual compression must not remove semantic explanations needed by the agent. The operator annotates and answers controls rather than editing source.

Distinguish confirmed decisions from proposals and unanswered questions. A widget default is not agreement. Do not invent product priorities or implementation authority. Interactive prototyping is an optional later use case; Alpha 1 does not execute arbitrary TSX.

Keep repository contracts as the authority for stable development obligations. Once a revision/state is approved, reconcile its decisions against those contracts and update them by project rules. Save publishes an immutable state snapshot; Approve records agreement on a specific document revision and substantive state; implementation permission comes from user/project authority outside Blueprint. Neither Save nor Approve starts implementation.

Use the permissions-plan reference to demonstrate planning without an algorithm prototype. For a newer saved state, review all answers and annotations, compare stable IDs with earlier snapshots, and preserve the rationale for agreed decisions.`,
  authoring: `First read get_blueprint_context. Call create_artifact with projectId, kind="blueprint", title, your explicitly known originSession and a fresh operationId. No project binding is required and the server does not require a project recipient match. A legacy project recipient is not evidence of your session identity and must not be copied as originSession. If the session ID is unknown, ask the operator. The returned sourcePath is the authorized source directory: write plan.mdx there. Do not invent artifact IDs or write beyond that directory.

Alpha builds the publication manifest from the registered artifact and parsed document. Do not author an independent manifest. Artifact formats, state formats, SDK versions and guideVersion are separate contracts; use the versions actually returned by the runtime.

Supported content is Markdown/GFM tables, fenced Mermaid diagrams, Details, Callout, Choice, TextAnswer and Checklist. Components and literal data props are allowlisted. Imports, exports, arbitrary JavaScript, event handlers and unknown JSX are rejected. Publication never runs package scripts, shell commands or dependency installation. Unpublished artifacts have a read-only Draft preview; preview does not publish source or enable substantive answers.

Call publish_artifact with expectedLatestRevision=null for a first publication; otherwise supply the actual latest revision ID. A stale expectation is a conflict: inspect current data before changing source. Reuse operationId only to recover the same uncertain operation; changed input under that ID is a conflict. A failed build preserves the prior publication.

show_artifact takes artifactId and an explicit revisionId, reuses the document tab without taking focus, and may defer while the operator writes a comment. Published revisions are immutable; edit source and publish another revision. Compatible values may transfer, but annotations retain original anchors and approval never transfers. The operator sees Retained, New, Requires response and Removed categories; authored defaults are not confirmed answers.

read_artifact accepts part="manifest"|"source"|"state", optional revisionId, optional savedStateId for state, and cursor. State defaults to the latest explicit Save snapshot; an exact savedStateId reads that immutable snapshot. Pin the returned savedStateId on every following state page, and the returned revisionId on every following source page, so a concurrent Save or publication cannot mix versions. Follow all cursors and source revision references. Absence of a saved state does not reveal defaults as operator answers. read_attachment({artifactId,savedStateId,attachmentId,cursor?}) reads only attachments committed with that snapshot.

show_content({artifactId,url}) opens an artifact-associated browser tab for the operator. Only HTTP and HTTPS, including localhost, are accepted. You receive no browser-control, DOM, cookie or arbitrary capture API. Opening a URL grants no access to private drafts and does not Save anything. Downloads, permission grants and profile cleanup are operator-only actions. External-browser authentication is not imported back.

get_blueprint_context.capabilities.limits reports effective versioned document, image, request and read-page limits. Runtime defaults are 30 seconds for compilation and 10 seconds for capture. A delayed write or UNKNOWN_RESULT is not proof of cancellation: reconcile the same operationId and saved manifest before retrying, rather than publishing a second uncertain state.`,
  widgets: `Alpha 1 provides Choice, TextAnswer and Checklist. Every question declares a stable id, meaning, semanticsVersion and defaultValue. The meaning is also its visible label. Choice and Checklist require options. Reuse IDs across revisions only for the same decision and semantics.

Values are serializable JSON: Choice is one allowed string, TextAnswer a string, Checklist an array of allowed strings. The application derives and validates schemas. Changes in schema, semantic definition or semanticsVersion prevent transfer. New questions receive authored defaults and remain unanswered by the operator. Explain each alternative's consequences in semantic text, rather than render code alone.

Values autosave privately, independently of viewing state such as collapsed sections or scroll position. A document annotation records widget values and Details state as source.stateContext to preserve what the operator reviewed; that context is not a new answer, approval or restoration command. Only operator Save publishes answers and annotations to an immutable state. Save waits for pending autosave and requires the unfinished comment to be saved or cancelled. An older saved snapshot never changes when the operator changes a value later.

The document surface can read declared values, persist valid answers and request annotations. It cannot access shell, files, MCP tools, browser cookies, Save, Approve or implementation authority. Arbitrary React code and hidden useState are not supported. The widget-api reference supplies literal syntax. Browser/document area screenshots capture visible context; they do not serialize unannounced JavaScript state or guarantee replay of a dynamic run.`,
  annotations: `Read the update message's artifactId and savedStateId with read_artifact(part="state"). Without savedStateId the tool returns the latest saved snapshot. Drafts and draft images are unavailable by design. Save fixes all answers and annotations of that artifact, including comments on older document revisions; it does not clear comments. Later edits produce private work for the next Save, preserving every historical snapshot.

Read every indicated cursor and referenced source revision before interpretation. Saved annotations have stable internal IDs and binding kinds, plus text, annotation and source. Source identifies the artifact, original revision and exact anchor or captured image. Text anchors carry precise ranges, blocks, quoted text and surrounding context. New document annotations also carry source.stateContext={stateHash,values,view:{details}}. stateHash is a SHA-256 digest of the artifact, revision, canonical widget values and open/closed Details state at annotation creation. It identifies that recorded context, not approval or model correctness. Treat a comment as referring to those original values and details, even if the selected saved state contains newer working answers. Identical phrases and overlapping selections are distinct; do not relocate through a first string match. Numbering follows the annotation array in the selected saved state. Cards, inline marks and numbered images share that numbering; compare IDs across states because later Save may renumber.

read_attachment({artifactId,savedStateId,attachmentId,cursor?}) retrieves an image committed inside that saved state; follow its paging and encoding metadata. Area captures include the full visible tab viewport screenshot, rectangle, zoom and scroll. New captures also record pointer, the exact click or drag-release coordinate in captured viewport pixels; the marked image points there. Do not infer a missing pointer in legacy captures. Browser captures also record URL, title and capture time, and may include pageId, stateHash, layoutHash and elementAnchor. Browser page identity uses Chromium Navigation API entry keys, with a conservative fallback when unavailable, without rewriting the website's history.state. These optional anchors guard live placement; they do not serialize hidden page memory or prove reproducibility. The frozen marked image remains the authoritative visible context.

Document markers appear only when current widget values and open/closed Details match the annotation context. Clicking an annotation from another state opens a read-only original-context preview; it must not replace private working answers. Return to working state restores the ongoing workspace. Browser live markers require matching page/context/layout; element anchors can track ordinary scrolled, sticky or table elements, while invalid matches hide the mark. A changed page or ambiguous legacy area is shown as a frozen capture rather than misleading current coordinates. Legacy annotations remain readable; absent context must not be fabricated.

In the document/browser annotation tool, hover frames a candidate element, clicking selects it, and dragging selects an arbitrary rectangle. Ordinary text selection retains its separate Annotate action. Area badges point to the exact click or drag-release position (source.capture.pointer), rather than an inferred rectangle corner; text badges remain tied to the precise quoted range, and the same numbering applies to cards, saved context and marked images.

Handle each answer/comment under user instructions and project rules. Clarify contradictory feedback, inspect original revisions where needed, then correct source and publish another revision. Preserve rationale rather than merely deleting disagreement. Reading the guide is not proof of compliance or correct processing.

Legacy Submit packages remain readable through list_feedback/read_feedback and existing report_feedback statements remain historical agent reports. They are not new saved states and do not expose migrated private drafts. report_feedback records an agent statement about a legacy package, not correctness, operator resolution or authority to implement.

Approval is a separate operator action for a concrete revision and substantive saved state. It does not send a message, Save a draft or authorize implementation. Autosaved changes cannot inherit an older approval. Revoke approval appends an immutable history event. Older events without a type remain approvals; the current status follows the event history and concrete saved state. Revocation grants no implementation authority.`,
} satisfies Record<string, string>;

export const guideReferences: Record<
  string,
  { title: string; description: string; content: string }
> = {
  'widget-api': {
    title: 'Alpha widget reference',
    description: 'Built-in questions, semantic fields and compatibility rules.',
    content: `Alpha document/state schema version: 1. Built-in controls accept literal data only. Each has id, meaning, semanticsVersion and defaultValue. Choice and Checklist also require options. There is no separate label prop or child content; meaning provides the visible question.

<Choice id="revocation" meaning="When must removed members lose access?" semanticsVersion="1" options={["Immediately","Next request"]} defaultValue="Next request" />

<TextAnswer id="owner-transfer" meaning="What happens when the last owner tries to leave?" semanticsVersion="1" defaultValue="" />

<Checklist id="acceptance" meaning="Which acceptance cases are required?" semanticsVersion="1" options={["Viewer write denied","Last owner protected"]} defaultValue={[]} />

<Details title="Tradeoffs">

Both revocation approaches require explicit server authorization checks.

</Details>

<Callout title="Authority" tone="info">

Approval does not authorize implementation.

</Callout>

Choice values are strings in the declared options; TextAnswer values are strings; Checklist values are arrays of declared option strings. All values must be valid finite JSON. The definitions determine automatic transfer compatibility across source revisions. Source changes do not permit an incompatible value to carry forward. Viewing state is not a substantive answer.

Details and Callout organize explanatory content. Fenced mermaid diagrams express dependencies with strict rendering; they cannot inject scripts or navigation actions. Raw executable MDX, imports and arbitrary HTML/JSX are not an API.`,
  },
  'permissions-plan': {
    title: 'Permissions planning example',
    description: 'A standalone requirements plan with a permissions matrix and questions.',
    content: `# Workspace permissions change

## Goal
Allow a workspace owner to share read-only access without granting editing or membership administration.

## Scope
Add viewer access for existing workspaces. Public sharing, billing and cross-workspace roles are excluded.

## Permission matrix
| Action | Owner | Editor | Viewer |
| --- | --- | --- | --- |
| Read workspace | Yes | Yes | Yes |
| Edit items | Yes | Yes | No |
| Manage members | Yes | No | No |

## Decisions to agree
Choose whether removing a member invalidates existing sessions immediately or at the next request. Explain the tradeoff between implementation complexity and the acceptable revocation window. Ask what happens when the last owner attempts to leave.

## Proposed safeguards
Permission checks run on the server on every protected operation; the UI is informative rather than an access boundary. The last owner cannot leave until ownership transfers. These are proposals until the operator agrees.

## Acceptance
A viewer can read but cannot mutate data through any API. An editor cannot change membership. A removed member loses access within the agreed revocation window. Removing the last owner follows the chosen rule. Existing roles preserve their agreed permissions.

## Contract follow-up
After agreement, compare the selected rules with repository authorization contracts and update them by project procedure. Approval of this document alone does not authorize implementation.`,
  },
};
