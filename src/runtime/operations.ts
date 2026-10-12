import { runtimeLimits } from '../shared/runtime-limits';
import { z } from 'zod';
import { writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getGuide, SERVER_INSTRUCTIONS } from '../guide';
import { Store, VERSION } from './store';
import { BlueprintError } from '../shared/protocol';
const id = z
  .string()
  .min(1)
  .max(150)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const session = z.object({ harness: z.literal('codex'), sessionId: id }).strict();
function parseRecipientInput(input: unknown): string {
  const value = z.string().trim().min(1).max(2048).parse(input);
  if (id.safeParse(value).success) return value;
  const link = /^codex:\/\/threads\/([A-Za-z0-9][A-Za-z0-9._-]{0,149})(?:[?#]\S*)?$/i.exec(value);
  if (!link)
    throw new BlueprintError(
      'INVALID_SESSION_LINK',
      'Enter a session ID or a codex://threads/<session-id> link.',
    );
  return link[1];
}
const endpoint = z
  .object({
    blockId: id,
    path: z.array(z.number().int().nonnegative()).min(1).max(100),
    offset: z.number().int().nonnegative(),
  })
  .strict();
const anchor = z.object({ start: endpoint, end: endpoint }).strict();
const view = z.object({ details: z.record(id, z.boolean()) }).strict();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const stateContext = z
  .object({
    stateHash: hash,
    values: z.record(id, z.union([z.string().max(100000), z.array(z.string().max(100000))])),
    view,
  })
  .strict();
const rect = z
  .object({
    x: z.number().finite().nonnegative(),
    y: z.number().finite().nonnegative(),
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
  })
  .strict();
const capture = z
  .object({
    id,
    png: z.string().max(24000000).optional(),
    source: z
      .object({
        kind: z.enum(['document-area', 'browser-area']),
        url: z.string().max(10000).optional(),
        title: z.string().max(10000).optional(),
        capturedAt: z.iso.datetime(),
        viewport: z
          .object({
            width: z.number().positive().max(20000),
            height: z.number().positive().max(20000),
            deviceScaleFactor: z.number().positive().max(10),
          })
          .strict(),
        rect,
        pointer: z
          .object({ x: z.number().finite().nonnegative(), y: z.number().finite().nonnegative() })
          .strict()
          .optional(),
        zoomFactor: z.number().positive().max(10),
        scroll: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
        pageId: z.string().max(250).optional(),
        stateHash: hash.optional(),
        layoutHash: hash.optional(),
        elementAnchor: z
          .object({
            path: z.array(z.number().int().nonnegative()).max(100),
            tag: z.string().min(1).max(100),
            id: z.string().max(10000).optional(),
            textHash: hash,
            pointerOffset: z
              .object({ x: z.number().finite(), y: z.number().finite() })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict()
  .refine(
    (c) =>
      c.source.rect.x + c.source.rect.width <= c.source.viewport.width + 1 &&
      c.source.rect.y + c.source.rect.height <= c.source.viewport.height + 1 &&
      (!c.source.pointer ||
        (c.source.pointer.x <= c.source.viewport.width &&
          c.source.pointer.y <= c.source.viewport.height)),
    'Area exceeds viewport',
  );
const selection = z
  .object({
    quote: z.string().max(10000),
    prefix: z.string().max(1000),
    suffix: z.string().max(1000),
    blockId: id,
    kind: z.enum(['text', 'document-area', 'browser-area']).optional(),
    anchor: anchor.optional(),
    capture: capture.optional(),
    stateContext: stateContext.optional(),
  })
  .strict();
const schemas = {
  get_blueprint_guide: z
    .object({
      topic: z
        .enum(['overview', 'planning', 'authoring', 'widgets', 'annotations', 'all'])
        .optional(),
      reference: z.string().optional(),
    })
    .strict(),
  get_blueprint_context: z.object({ projectPath: z.string().optional() }).strict(),
  create_artifact: z
    .object({
      projectId: id,
      kind: z.literal('blueprint'),
      title: z.string().min(1).max(300),
      originSession: session,
      operationId: id,
    })
    .strict(),
  attach_artifact_session: z
    .object({ artifactId: id, originSession: session, operationId: id })
    .strict(),
  publish_artifact: z
    .object({ artifactId: id, expectedLatestRevision: id.nullable(), operationId: id })
    .strict(),
  read_artifact: z
    .object({
      artifactId: id,
      revisionId: id.optional(),
      savedStateId: id.optional(),
      part: z.enum(['manifest', 'source', 'state']).optional(),
      cursor: z.string().optional(),
    })
    .strict(),
  show_artifact: z.object({ artifactId: id, revisionId: id }).strict(),
  show_content: z.object({ artifactId: id, url: z.url().max(10000) }).strict(),
  read_attachment: z
    .object({ artifactId: id, savedStateId: id, attachmentId: id, cursor: z.string().optional() })
    .strict(),
  list_feedback: z
    .object({ projectId: id, recipient: session, cursor: z.string().optional() })
    .strict(),
  read_feedback: z
    .object({
      packageId: id,
      part: z.enum(['manifest', 'context']).optional(),
      cursor: z.string().optional(),
    })
    .strict(),
  report_feedback: z
    .object({
      packageId: id,
      outcomes: z.array(
        z
          .object({
            itemId: z.string(),
            status: z.enum(['addressed', 'needs_clarification', 'deferred']),
            note: z.string(),
          })
          .strict(),
      ),
      revisedrefs: z.array(z.object({ artifactId: id, revisionId: id }).strict()).default([]),
    })
    .strict(),
};
const descriptions: Record<keyof typeof schemas, string> = {
  get_blueprint_guide:
    'Get the bundled versioned Blueprint guide. Topics: overview, planning, authoring, widgets, annotations, all; references load examples on demand.',
  get_blueprint_context:
    'Read explicitly selected project and capabilities. Artifact originSession must be supplied by the agent; never infer a session.',
  create_artifact: 'Create a Blueprint source directory in a registered project.',
  attach_artifact_session:
    'Explicitly attach a known agent session to an operator-created workspace. Idempotent; a different session cannot replace an existing binding.',
  publish_artifact: 'Validate and publish immutable plan.mdx with optimistic version checking.',
  read_artifact:
    'Read immutable document manifest/source or explicit saved state. part=state defaults latest Save, savedStateId selects an exact snapshot. Private autosaves are never returned; large results are paginated.',
  show_artifact: 'Show a specific published revision without taking focus.',
  show_content:
    'Open an HTTP/HTTPS browser tab belonging to this artifact, without taking focus. No agent browser controls.',
  read_attachment:
    'Read a saved state attachment as paginated base64. Private draft images are never returned.',
  list_feedback: 'List immutable submitted feedback for an explicit recipient.',
  read_feedback: 'Read submitted feedback manifest or paginated context.',
  report_feedback:
    'Record an agent statement about feedback; does not approve a plan or resolve operator comments.',
};
export const tools = Object.entries(schemas).map(([name, schema]) => ({
  name,
  description: descriptions[name as keyof typeof schemas],
  inputSchema: z.toJSONSchema(schema),
  annotations: {
    readOnlyHint: [
      'get_blueprint_guide',
      'get_blueprint_context',
      'read_artifact',
      'read_attachment',
      'list_feedback',
      'read_feedback',
    ].includes(name),
    destructiveHint: false,
    openWorldHint: name === 'show_content',
    idempotentHint: name !== 'report_feedback',
  },
}));
function page(content: string, cursor?: string) {
  const offset = cursor ? Number(cursor) : 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > content.length)
    throw new BlueprintError('INVALID_CURSOR', 'Invalid cursor');
  const next = offset + 12000;
  return {
    content: content.slice(offset, next),
    complete: next >= content.length,
    cursor: next < content.length ? String(next) : null,
  };
}
export class Operations {
  selected: { artifactId: string; revisionId: string | null } | null = null;
  selectedProject: string | null = null;
  editing = false;
  pendingContent: { artifactId: string; projectId: string; url: string } | null = null;
  pending: { artifactId: string; revisionId: string | null } | null = null;
  constructor(
    public store: Store,
    public emit: (event: unknown) => void,
  ) {
    this.selectedProject = store.projects()[0]?.id ?? null;
  }
  hello() {
    return { version: VERSION, instructions: SERVER_INSTRUCTIONS, tools };
  }
  refresh() {
    this.emit({ type: 'refresh' });
  }
  async show(artifactId: string, revisionId: string | null, notifyShell = true) {
    if (revisionId) await this.store.revision(artifactId, revisionId);
    else await this.store.artifact(artifactId);
    if (this.editing) {
      this.pending = { artifactId, revisionId };
      return { status: 'deferred' };
    }
    this.selected = { artifactId, revisionId };
    this.selectedProject = (await this.store.artifact(artifactId)).projectId;
    if (notifyShell) this.emit({ type: 'show-artifact', artifactId, revisionId });
    this.refresh();
    return { status: 'shown' };
  }
  async tool(name: string, input: unknown): Promise<unknown> {
    if (!Object.hasOwn(schemas, name)) throw new BlueprintError('UNKNOWN_TOOL', 'Unsupported tool');
    const parsed = schemas[name as keyof typeof schemas].parse(input);
    switch (name) {
      case 'get_blueprint_guide':
        return getGuide(schemas.get_blueprint_guide.parse(parsed));
      case 'get_blueprint_context': {
        const args = schemas.get_blueprint_context.parse(parsed);
        const canonicalPath = args.projectPath ? await realpath(args.projectPath) : undefined;
        const p = canonicalPath
          ? this.store.projects().find((p) => p.path === canonicalPath)
          : this.store.projects().find((p) => p.id === this.selectedProject);
        if (!p)
          throw new BlueprintError('PROJECT_SELECTION_REQUIRED', 'Select the project in Blueprint');
        return {
          project: { id: p.id, path: p.path },
          sessionBinding: 'artifact_origin_unverified',
          version: VERSION,
          formatVersion: 1,
          capabilities: {
            planning: true,
            prototypes: false,
            browser: true,
            savedStates: true,
            supportedSavedStateVersions: [1, 2],
            chat: false,
            automaticDelivery: false,
            limits: runtimeLimits(),
          },
        };
      }
      case 'create_artifact': {
        const result = await this.store.create(schemas.create_artifact.parse(parsed));
        this.refresh();
        return result;
      }
      case 'attach_artifact_session': {
        const result = await this.store.attachSession(
          schemas.attach_artifact_session.parse(parsed),
        );
        this.refresh();
        return result;
      }
      case 'publish_artifact': {
        const result = await this.store.publish(schemas.publish_artifact.parse(parsed));
        this.refresh();
        return result;
      }
      case 'read_artifact': {
        const a = schemas.read_artifact.parse(parsed);
        const artifact = await this.store.artifact(a.artifactId);
        if (a.part === 'state') {
          const saved = await this.store.states.read(a.artifactId, a.savedStateId);
          return saved
            ? {
                artifactId: a.artifactId,
                savedStateId: saved.id,
                part: 'state',
                privateStateIncluded: false,
                ...page(JSON.stringify(saved), a.cursor),
              }
            : {
                artifactId: a.artifactId,
                savedState: null,
                complete: true,
                cursor: null,
                privateStateIncluded: false,
              };
        }
        if (a.savedStateId)
          throw new BlueprintError('INVALID_INPUT', 'savedStateId applies only to part=state');
        const revisionId = a.revisionId ?? artifact.latestRevision;
        if (!revisionId) {
          if (a.part === 'source')
            throw new BlueprintError(
              'UNKNOWN_REVISION',
              'Artifact has no published document revision',
            );
          return {
            artifactId: artifact.id,
            revisionId: null,
            originSession: artifact.originSession,
            sourcePath: join(await this.store.artifactRoot(artifact), 'source'),
            sourceFile: 'plan.mdx',
            formatVersion: 1,
            widgets: [],
            parts: ['manifest', 'state'],
            latestSavedStateId: null,
            approval: null,
            approvalHistory: [],
            privateStateIncluded: false,
          };
        }
        const revision = await this.store.revision(a.artifactId, revisionId);
        if (a.part === 'source')
          return { revisionId: revision.id, ...page(revision.source, a.cursor) };
        return {
          artifactId: a.artifactId,
          sourcePath: join(
            await this.store.artifactRoot(await this.store.artifact(a.artifactId)),
            'source',
          ),
          revisionId: revision.id,
          formatVersion: revision.formatVersion,
          widgets: revision.widgets,
          createdAt: revision.createdAt,
          parts: ['source', 'state'],
          originSession: artifact.originSession,
          latestSavedStateId: (await this.store.states.read(a.artifactId))?.id ?? null,
          approval: await this.store.approval(a.artifactId, revisionId),
          approvalHistory: await this.store.approvalHistory(a.artifactId, revisionId),
          privateStateIncluded: false,
        };
      }
      case 'show_artifact': {
        const a = schemas.show_artifact.parse(parsed);
        return this.show(a.artifactId, a.revisionId);
      }
      case 'show_content': {
        const a = schemas.show_content.parse(parsed);
        const url = new URL(a.url);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
          throw new BlueprintError(
            'INVALID_URL',
            'Only HTTP/HTTPS URLs without embedded credentials are allowed',
          );
        const artifact = await this.store.artifact(a.artifactId);

        if (this.editing) {
          this.pendingContent = {
            artifactId: artifact.id,
            projectId: artifact.projectId,
            url: url.href,
          };
          return { status: 'deferred' };
        }
        await this.show(artifact.id, artifact.latestRevision);
        this.emit({
          type: 'show-content',
          artifactId: artifact.id,
          projectId: artifact.projectId,
          url: url.href,
        });
        return { status: 'requested', artifactId: artifact.id, url: url.href };
      }
      case 'read_attachment': {
        const a = schemas.read_attachment.parse(parsed);
        const result = await this.store.states.attachment(
          a.artifactId,
          a.savedStateId,
          a.attachmentId,
        );
        const { base64, ...metadata } = result;
        return { ...metadata, encoding: 'base64', ...page(base64, a.cursor) };
      }
      case 'list_feedback': {
        const a = schemas.list_feedback.parse(parsed);
        const items = (await this.store.packages(a.projectId)).filter(
          (p) => p.recipient.sessionId === a.recipient.sessionId,
        );
        const offset = a.cursor ? Number(a.cursor) : 0;
        if (!Number.isSafeInteger(offset) || offset < 0)
          throw new BlueprintError('INVALID_CURSOR', 'Invalid cursor');
        return {
          items: items
            .slice(offset, offset + 20)
            .map(({ id, createdAt, status }) => ({ id, createdAt, status })),
          complete: offset + 20 >= items.length,
          cursor: offset + 20 < items.length ? String(offset + 20) : null,
        };
      }
      case 'read_feedback': {
        const a = schemas.read_feedback.parse(parsed);
        const packet = await this.store.feedback(a.packageId);
        return {
          packageId: packet.id,
          formatVersion: 1,
          part: a.part ?? 'manifest',
          ...page(
            a.part === 'context' ? this.store.context(packet) : JSON.stringify(packet),
            a.cursor,
          ),
        };
      }
      case 'report_feedback': {
        const a = schemas.report_feedback.parse(parsed);
        const packet = await this.store.feedback(a.packageId);
        const items = new Set([
          ...packet.annotations.map((x) => x.id),
          ...Object.keys(packet.answers),
        ]);
        if (a.outcomes.some((o) => !items.has(o.itemId)))
          throw new BlueprintError(
            'INVALID_REFERENCE',
            'Outcome refers to an unknown feedback item',
          );
        for (const r of a.revisedrefs) await this.store.revision(r.artifactId, r.revisionId);
        const receipt = {
          ...a,
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          agentStatement: true,
        };
        await import('./files').then(async ({ atomicJson, writableInside }) =>
          atomicJson(
            await writableInside(
              this.store.project(packet.projectId).path,
              join(
                this.store.project(packet.projectId).path,
                '.blueprint',
                'feedback',
                packet.id,
                'receipts',
                receipt.id + '.json',
              ),
            ),
            receipt,
          ),
        );
        return receipt;
      }
    }
    throw new BlueprintError('UNKNOWN_TOOL', 'Unsupported tool');
  }
  async operator(name: string, input: unknown): Promise<unknown> {
    if (name === 'snapshot' || name === 'getDocument')
      return this.store.withReadScope(() => this.performOperator(name, input));
    return this.performOperator(name, input);
  }
  private async performOperator(name: string, input: unknown): Promise<unknown> {
    const args = z.record(z.string(), z.unknown()).parse(input ?? {});
    const required = (key: string) => id.parse(args[key]);
    switch (name) {
      case 'snapshot': {
        const projects = await this.store.projectAvailability();
        const artifacts = await this.store.artifacts();
        const annotations = (
          await Promise.all(
            artifacts.map(async (a) =>
              (await this.store.states.draft(a.id)).annotations.map((x, i) => ({
                ...x,
                number: i + 1,
              })),
            ),
          )
        ).flat();
        const savedStates = (await Promise.all(artifacts.map((a) => this.store.states.list(a.id))))
          .flat()
          .map(({ id, artifactId, revisionId, createdAt, notification }) => ({
            id,
            artifactId,
            revisionId,
            createdAt,
            notification,
          }));
        return {
          projects,
          selectedProject: this.selectedProject,
          artifacts: await Promise.all(
            artifacts.map(async (artifact) => {
              return {
                ...artifact,
                ...(await this.store.artifactStatus(artifact)),
              };
            }),
          ),
          savedStates,
          selected:
            this.selected && artifacts.some((a) => a.id === this.selected!.artifactId)
              ? this.selected
              : null,
          draft: { annotations },
          packages: (
            await Promise.all(
              projects.filter((p) => p.available).map((p) => this.store.packages(p.id)),
            )
          ).flat(),
        };
      }
      case 'register': {
        const p = await this.store.register(z.string().parse(args.path));
        this.selectedProject = p.id;
        this.refresh();
        return p;
      }
      case 'registerCopy': {
        const p = await this.store.registerCopy(z.string().parse(args.path), required('projectId'));
        this.selectedProject = p.id;
        this.refresh();
        return p;
      }
      case 'relocateProject': {
        const p = await this.store.relocate(required('projectId'), z.string().parse(args.path));
        this.refresh();
        return p;
      }
      case 'removeProject': {
        const projectId = required('projectId');
        const selectedArtifact =
          this.selected &&
          (await this.store.artifacts()).find((a) => a.id === this.selected!.artifactId);
        if (selectedArtifact?.projectId === projectId || !selectedArtifact) this.selected = null;
        const result = this.store.removeProject(projectId);
        if (this.selectedProject === projectId) this.selectedProject = null;
        this.refresh();
        return result;
      }
      case 'selectProject':
        this.selectedProject = this.store.project(required('projectId')).id;
        this.refresh();
        return {};
      case 'bindSession': {
        const result = await this.store.bind(
          required('projectId'),
          parseRecipientInput(args.sessionId),
        );
        this.refresh();
        return result;
      }
      case 'openArtifact':
        return this.show(
          required('artifactId'),
          args.revisionId == null ? null : required('revisionId'),
          args.workspace !== true,
        );
      case 'archivePlan': {
        const input = z
          .object({ artifactId: id, operationId: id, archived: z.boolean() })
          .strict()
          .parse(args);
        const result = await this.store.archivePlan(input);
        this.refresh();
        return result;
      }
      case 'renamePlan': {
        const input = z
          .object({ artifactId: id, operationId: id, title: z.string().trim().min(1).max(300) })
          .strict()
          .parse(args);
        const result = await this.store.renamePlan(input);
        this.refresh();
        return result;
      }
      case 'artifactProperties':
        return this.store.artifact(required('artifactId'));
      case 'browserEditor': {
        const artifactId = required('artifactId');
        await this.store.artifact(artifactId);
        const { beneath, json } = await import('./files');
        try {
          return await json(beneath(this.store.data, 'browser-editors', artifactId + '.json'));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        }
      }
      case 'saveBrowserEditor': {
        const artifactId = required('artifactId');
        await this.store.artifact(artifactId);
        const { beneath, atomicJson } = await import('./files');
        const editor = z
          .object({
            artifactId: id,
            tabId: id,
            revisionId: id.nullable().optional(),
            comment: z.string().max(20000),
            capture: z
              .object({
                ...capture.shape,
                source: capture.shape.source.extend({ rect: rect.optional() }),
              })
              .strict(),
          })
          .strict()
          .nullable()
          .parse(args.editor ?? null);
        if (
          editor &&
          (editor.artifactId !== artifactId || editor.capture.source.kind !== 'browser-area')
        )
          throw new BlueprintError(
            'INVALID_REFERENCE',
            'Browser composer belongs to a different artifact',
          );
        await atomicJson(beneath(this.store.data, 'browser-editors', artifactId + '.json'), editor);
        return { saved: true };
      }
      case 'getDocument':
        return this.store.document(
          required('artifactId'),
          args.revisionId == null ? null : required('revisionId'),
        );
      case 'saveEditor': {
        const editor = z
          .object({ selection, comment: z.string().max(100000), annotationId: id.optional() })
          .strict()
          .nullable()
          .parse(args.editor);
        await this.store.saveEditor(
          required('artifactId'),
          args.revisionId === null ? null : required('revisionId'),
          editor,
        );
        return { saved: true };
      }
      case 'setValue':
        await this.store.setValue(
          required('artifactId'),
          required('revisionId'),
          required('widgetId'),
          args.value,
        );
        break;
      case 'setViewState': {
        const normalized = await this.store.setViewState(
          required('artifactId'),
          required('revisionId'),
          view.parse(args.view),
        );
        return { saved: true, view: normalized };
      }
      case 'captureAnnotationState':
        return this.store.captureAnnotationState(
          required('artifactId'),
          required('revisionId'),
          args.view === undefined ? undefined : view.parse(args.view),
        );
      case 'addAnnotation': {
        const a = z
          .object({
            artifactId: id,
            revisionId: id,
            quote: z.string().min(1).max(10000),
            prefix: z.string().max(1000).default(''),
            suffix: z.string().max(1000).default(''),
            blockId: id,
            kind: z.enum(['text', 'document-area', 'browser-area']).optional(),
            anchor: anchor.optional(),
            capture: capture.optional(),
            stateContext: stateContext.optional(),
            comment: z.string().min(1).max(100000),
          })
          .strict()
          .parse(args);
        const result =
          a.kind && a.kind !== 'text' && a.capture
            ? await this.store.addAreaAnnotation({ ...a, kind: a.kind, capture: a.capture })
            : await this.store.annotate(a);
        this.refresh();
        return result;
      }
      case 'editAnnotation':
        await this.store.editAnnotation(
          required('annotationId'),
          z.string().min(1).max(100000).parse(args.comment),
        );
        break;
      case 'deleteAnnotation':
        await this.store.editAnnotation(required('annotationId'), null);
        break;
      case 'addAreaAnnotation': {
        const a = z
          .object({
            artifactId: id,
            revisionId: id.nullable(),
            kind: z.enum(['document-area', 'browser-area']),
            comment: z.string().min(1).max(100000),
            capture,
            stateContext: stateContext.optional(),
          })
          .strict()
          .parse(args);
        const result = await this.store.addAreaAnnotation(a);
        this.refresh();
        return result;
      }
      case 'saveState': {
        const a = z
          .object({
            artifactId: id,
            revisionId: id.nullable(),
            operationId: id,
            expectedLatestSavedStateId: id.nullable(),
          })
          .strict()
          .parse(args);
        if (a.revisionId === null)
          throw new BlueprintError(
            'NO_PUBLISHED_REVISION',
            'Publish the first document before Save',
          );
        if (this.editing)
          throw new BlueprintError(
            'UNFINISHED_ANNOTATION',
            'Save or cancel the unfinished annotation first',
          );
        const result = await this.store.states.save({ ...a, revisionId: a.revisionId });
        this.refresh();
        return result;
      }
      case 'getCapture': {
        const artifact = await this.store.artifact(required('artifactId'));
        const annotation = (await this.store.states.draft(artifact.id)).annotations.find(
          (x) => x.id === required('annotationId'),
        );
        if (!annotation?.capture)
          throw new BlueprintError('UNKNOWN_ATTACHMENT', 'Unknown private capture');
        const file = await import('./files');
        const png = await import('node:fs/promises').then((f) =>
          f.readFile(
            file.beneath(this.store.data, 'captures', artifact.id, annotation.capture!.id + '.png'),
          ),
        );
        return {
          capture: annotation.capture,
          png: png.toString('base64'),
          number:
            (await this.store.states.draft(artifact.id)).annotations.findIndex(
              (x) => x.id === annotation.id,
            ) + 1,
        };
      }
      case 'submit': {
        const result = await this.store.submit(required('projectId'), required('operationId'));
        this.refresh();
        return result;
      }
      case 'discard': {
        const result = await this.store.discard(required('projectId'));
        this.refresh();
        return result;
      }
      case 'revokeApproval': {
        const result = await this.store.revokeApproval(
          required('artifactId'),
          required('revisionId'),
          required('operationId'),
        );
        this.refresh();
        return result;
      }
      case 'approve': {
        const result = await this.store.approve(required('artifactId'), required('revisionId'));
        this.refresh();
        return result;
      }
      case 'editing':
        this.editing = z.boolean().parse(args.active);
        if (!this.editing && this.pending) {
          const next = this.pending;
          this.pending = null;
          await this.show(next.artifactId, next.revisionId);
        }
        if (!this.editing && this.pendingContent) {
          const content = this.pendingContent;
          this.pendingContent = null;
          const artifact = await this.store.artifact(content.artifactId);
          await this.show(content.artifactId, artifact.latestRevision);
          this.emit({ type: 'show-content', ...content });
        }
        return {};
      case 'demo': {
        const p = this.store.project(required('projectId'));
        if (args.originSession == null)
          throw new BlueprintError(
            'ORIGIN_SESSION_REQUIRED',
            'Supply originSession for the demo; a project recipient does not identify its origin.',
          );
        const originSession = session.parse(args.originSession);
        const a = await this.store.create({
          projectId: p.id,
          kind: 'blueprint',
          title: 'Access policy planning',
          originSession,
          operationId: randomUUID(),
        });
        await writeFile(join(a.sourcePath, 'plan.mdx'), DEMO);
        const r = await this.store.publish({
          artifactId: a.artifactId,
          expectedLatestRevision: null,
          operationId: randomUUID(),
        });
        return this.show(a.artifactId, r.revisionId);
      }
      default:
        throw new BlueprintError('UNKNOWN_COMMAND', 'Unsupported operator command');
    }
    this.refresh();
    return { saved: true };
  }
}
const DEMO = `# Access policy planning

Agree on the permission contract before implementation.

## Goal and boundaries

Owners manage membership. Members read project documents. Guests have no access by default. No billing or authentication changes are included.

| Role | Read | Invite | Remove |
| --- | --- | --- | --- |
| Owner | Yes | Yes | Yes |
| Member | Yes | Decision below | No |
| Guest | No | No | No |

## Decisions

<Choice id="invites" meaning="Who may invite project members?" semanticsVersion="1" options={["Owner only","Owner and members"]} defaultValue="Owner only" />

<TextAnswer id="exceptions" meaning="List exceptions to the role policy" semanticsVersion="1" defaultValue="" />

<Checklist id="acceptance" meaning="Required acceptance boundaries" semanticsVersion="1" options={["Last owner cannot be removed","Cross-project access is denied","Permission changes are audited"]} defaultValue={[]} />

<Details title="Contract reconciliation">

After agreement, compare repository permission contracts with these decisions. Update contracts under project rules. Approval here does not authorize implementation.

</Details>

\`\`\`mermaid
flowchart LR
 Owner --> Membership
 Member --> Documents
 Membership --> Audit
\`\`\`

## Acceptance

Unauthorized requests are rejected at the server boundary. Role changes are observable in the audit history. Existing project rules remain authoritative.
`;
