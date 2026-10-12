import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, readdir, realpath, unlink, access, rename } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  parseDocument,
  areWidgetsCompatible,
  isWidgetValueValid,
  type ParsedDocument,
  type WidgetValue,
} from '../document';
import {
  atomicJson,
  json,
  inside,
  beneath,
  writableInside,
  atomicText,
  commitDirectory,
} from './files';
import { BlueprintError, VERSION } from '../shared/protocol';
import { revisionSummary } from './revision-summary';
import { ArtifactStates, type TextAnchor, type Capture } from './artifact-state';
import {
  canonicalString,
  type AnnotationStateContext,
  type DocumentView,
} from '../shared/annotation-context';
export interface SessionRef {
  harness: 'codex';
  sessionId: string;
}
export interface Project {
  id: string;
  path: string;
  recipient: SessionRef | null;
}
export interface Artifact {
  formatVersion: 1;
  id: string;
  projectId: string;
  title: string;
  kind: 'blueprint';
  archived?: boolean;
  originSession: SessionRef | null;
  latestRevision: string | null;
  revisions: { id: string }[];
}
export interface Revision extends ParsedDocument {
  id: string;
  artifactId: string;
  formatVersion: 1;
  createdAt: string;
  source: string;
}
export interface Annotation {
  id: string;
  artifactId: string;
  revisionId: string | null;
  quote: string;
  prefix: string;
  suffix: string;
  blockId: string;
  comment: string;
  kind?: 'text' | 'document-area' | 'browser-area';
  anchor?: TextAnchor;
  capture?: Capture;
  number?: number;
  stateContext?: AnnotationStateContext;
}
interface Draft {
  annotations: Annotation[];
  answers: Record<
    string,
    { artifactId: string; revisionId: string; values: Record<string, WidgetValue> }
  >;
}
interface State {
  values: Record<string, WidgetValue>;
}
export interface Feedback {
  formatVersion: 1;
  id: string;
  projectId: string;
  recipient: SessionRef;
  createdAt: string;
  status: 'saved';
  annotations: Annotation[];
  answers: Draft['answers'];
  notification: string;
}
function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function isApprovedState(
  state: State,
  approval: { stateHash?: string; savedStateId?: string | null; type?: string } | null,
  saved: { id: string } | null,
  dirty: boolean,
) {
  return (
    !dirty &&
    approval?.type !== 'revoked' &&
    approval?.stateHash === digest(state) &&
    (approval?.savedStateId === undefined || approval.savedStateId === (saved?.id ?? null))
  );
}
export class Store {
  db: DatabaseSync;
  states: ArtifactStates;
  private reads = new AsyncLocalStorage<Map<string, Promise<unknown>>>();
  /** Only snapshot/document reads enter this scope; writes never share cached values. */
  withReadScope<T>(read: () => Promise<T>): Promise<T> {
    return this.reads.run(new Map(), read);
  }
  memoRead<T>(key: readonly string[], read: () => Promise<T>): Promise<T> {
    const scope = this.reads.getStore();
    if (!scope) return read();
    const name = JSON.stringify(key);
    const previous = scope.get(name);
    if (previous) return previous as Promise<T>;
    const result = read();
    scope.set(name, result);
    return result;
  }
  constructor(
    public data: string,
    private compile: (source: string) => Promise<ParsedDocument> = async (source) =>
      parseDocument(source),
  ) {
    this.states = new ArtifactStates(this);
    this.db = new DatabaseSync(join(data, 'registry.sqlite'));
    this.db.exec(
      'PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,path TEXT UNIQUE,recipient TEXT); CREATE TABLE IF NOT EXISTS operations(key TEXT PRIMARY KEY,hash TEXT,result TEXT)',
    );
    if (
      !this.db
        .prepare('PRAGMA table_info(projects)')
        .all()
        .some((row) => row.name === 'removed')
    )
      this.db.exec('ALTER TABLE projects ADD COLUMN removed INTEGER NOT NULL DEFAULT 0');
  }
  close() {
    this.db.close();
  }
  projects(includeRemoved = false): Project[] {
    return this.db
      .prepare(includeRemoved ? 'SELECT * FROM projects' : 'SELECT * FROM projects WHERE removed=0')
      .all()
      .map((row) => ({
        id: String(row.id),
        path: String(row.path),
        recipient: row.recipient ? (JSON.parse(String(row.recipient)) as SessionRef) : null,
      }));
  }
  project(id: string) {
    const p = this.projects(true).find((p) => p.id === id);
    if (!p) throw new BlueprintError('UNKNOWN_PROJECT', 'Select a registered project');
    return p;
  }
  async register(path: string) {
    const canonical = await realpath(path);
    const old = this.projects(true).find((p) => p.path === canonical);
    if (old) {
      const metadata = await json<{ id: string }>(
        await inside(canonical, join(canonical, '.blueprint', 'project.json')),
      );
      if (metadata.id !== old.id)
        throw new BlueprintError('PROJECT_ID_MISMATCH', 'Folder identity changed');
      this.db.prepare('UPDATE projects SET removed=0 WHERE id=?').run(old.id);
      return old;
    }
    let id: string = randomUUID();
    const base = await writableInside(canonical, join(canonical, '.blueprint'));
    await mkdir(base, { recursive: true });
    await inside(canonical, base);
    try {
      const meta = await json<{ id: string; formatVersion: number }>(
        await inside(canonical, join(base, 'project.json')),
      );
      if (meta.formatVersion !== 1 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(meta.id))
        throw new BlueprintError('UNSUPPORTED_FORMAT', 'Unsupported project metadata');
      id = meta.id;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await atomicJson(join(base, 'project.json'), { id, formatVersion: 1 });
    }
    const conflict = this.projects(true).find((p) => p.id === id);
    if (conflict)
      throw new BlueprintError(
        'PROJECT_ID_CONFLICT',
        'This folder copies an existing project identity',
        { projectId: id, originalPath: conflict.path },
      );
    this.db.prepare('INSERT INTO projects(id,path,recipient) VALUES(?,?,NULL)').run(id, canonical);
    return this.project(id);
  }
  async projectAvailability(includeRemoved = false) {
    return Promise.all(
      this.projects(includeRemoved).map(async (project) => {
        try {
          const meta = await json<{ id: string }>(
            await inside(project.path, join(project.path, '.blueprint', 'project.json')),
          );
          return { ...project, available: meta.id === project.id };
        } catch (error) {
          if (!['ENOENT', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? ''))
            throw error;
          return { ...project, available: false };
        }
      }),
    );
  }
  async relocate(projectId: string, path: string) {
    this.project(projectId);
    const canonical = await realpath(path);
    const current = (await this.projectAvailability(true)).find((p) => p.id === projectId);
    if (current?.available && current.path !== canonical)
      throw new BlueprintError(
        'PROJECT_ID_CONFLICT',
        'The original folder still exists. Open the original or register a new empty copy.',
      );
    const other = this.projects(true).find((p) => p.path === canonical && p.id !== projectId);
    if (other)
      throw new BlueprintError('PROJECT_ID_CONFLICT', 'Folder already belongs to another project');
    let meta: { id: string; formatVersion: number };
    try {
      meta = await json(await inside(canonical, join(canonical, '.blueprint', 'project.json')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      throw new BlueprintError(
        'PROJECT_ID_MISMATCH',
        'Choose the folder containing the original project identity',
      );
    }
    if (meta.id !== projectId || meta.formatVersion !== 1)
      throw new BlueprintError(
        'PROJECT_ID_MISMATCH',
        'The selected folder has a different project identity',
      );
    this.db.prepare('UPDATE projects SET path=?,removed=0 WHERE id=?').run(canonical, projectId);
    return this.project(projectId);
  }
  removeProject(projectId: string) {
    this.project(projectId);
    this.db.prepare('UPDATE projects SET removed=1 WHERE id=?').run(projectId);
    return { removed: true };
  }
  async registerCopy(path: string, expectedProjectId: string) {
    const canonical = await realpath(path);
    const original = this.project(expectedProjectId);
    if (canonical === original.path || this.projects(true).some((p) => p.path === canonical))
      throw new BlueprintError(
        'PROJECT_ID_CONFLICT',
        'The registered original cannot be reset as a copy',
      );
    const base = await inside(canonical, join(canonical, '.blueprint'));
    const meta = await json<{ id: string; formatVersion: number }>(
      await inside(canonical, join(base, 'project.json')),
    );
    if (meta.id !== expectedProjectId || meta.formatVersion !== 1)
      throw new BlueprintError(
        'PROJECT_ID_MISMATCH',
        'The copied identity changed; select the folder again',
      );
    const backupPath = join(canonical, '.blueprint-backup-' + randomUUID());
    await rename(base, backupPath);
    try {
      return { ...(await this.register(canonical)), backupPath };
    } catch (error) {
      throw new BlueprintError(
        'PROJECT_COPY_FAILED',
        'Copied history is preserved in the backup folder. Registration did not complete.',
        { backupPath, cause: (error as NodeJS.ErrnoException).code },
      );
    }
  }
  async bind(projectId: string, sessionId: string) {
    this.project(projectId);
    if (this.project(projectId).recipient?.sessionId !== sessionId) {
      const draft = await this.draft(this.project(projectId));
      for (const a of (await this.artifacts()).filter((a) => a.projectId === projectId)) {
        for (const r of a.revisions) {
          if (await this.editor(a.id, r.id))
            throw new BlueprintError(
              'UNSUBMITTED_FEEDBACK',
              'Finish or cancel the pending annotation before changing recipient',
            );
        }
      }
      if (draft.annotations.length || Object.keys(draft.answers).length)
        throw new BlueprintError(
          'UNSUBMITTED_FEEDBACK',
          'Submit pending feedback before changing its recipient',
        );
    }
    const recipient: SessionRef = { harness: 'codex', sessionId };
    this.db
      .prepare('UPDATE projects SET recipient=? WHERE id=?')
      .run(JSON.stringify(recipient), projectId);
    return this.project(projectId);
  }
  async base(project: Project) {
    const path = join(project.path, '.blueprint');
    await inside(project.path, path);
    return path;
  }
  async artifacts(): Promise<Artifact[]> {
    return this.memoRead(['artifacts'], () => this.readArtifacts());
  }
  private async readArtifacts(): Promise<Artifact[]> {
    const output: Artifact[] = [];
    for (const p of (await this.projectAvailability()).filter((p) => p.available)) {
      const root = join(await this.base(p), 'artifacts');
      let dirs: string[] = [];
      try {
        dirs = await readdir(root);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      for (const id of dirs) {
        if (!/^[\w-]+$/.test(id)) continue;
        const dir = await inside(p.path, join(root, id));
        const a = await json<Artifact>(await inside(p.path, join(dir, 'artifact.json')));
        if (a.formatVersion !== 1)
          throw new BlueprintError('UNSUPPORTED_FORMAT', 'Unsupported artifact metadata format');
        if (a.id !== id || a.projectId !== p.id || a.kind !== 'blueprint')
          throw new BlueprintError('CORRUPT_DATA', 'Artifact identity is inconsistent');
        a.revisions = [];
        let revisions: string[] = [];
        try {
          revisions = await readdir(await inside(p.path, join(dir, 'revisions')));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        for (const rev of revisions.filter((x) => !x.startsWith('.')).sort()) {
          const r = await json<Revision>(
            await inside(p.path, join(dir, 'revisions', rev, 'manifest.json')),
          );
          if (r.formatVersion !== 1)
            throw new BlueprintError('UNSUPPORTED_FORMAT', 'Unsupported artifact revision format', {
              expected: 1,
              actual: r.formatVersion,
            });
          a.revisions.push({ id: r.id });
        }
        a.latestRevision = a.revisions.at(-1)?.id ?? null;
        output.push(a);
      }
    }
    return output;
  }
  async artifact(id: string) {
    const a = (await this.artifacts()).find((a) => a.id === id);
    if (!a) throw new BlueprintError('UNKNOWN_ARTIFACT', 'Unknown artifact');
    return a;
  }
  async artifactRoot(a: Artifact) {
    const p = this.project(a.projectId);
    return inside(p.path, join(await this.base(p), 'artifacts', a.id));
  }
  operation<T>(key: string, hash: string): T | undefined {
    const row = this.db.prepare('SELECT * FROM operations WHERE key=?').get(key);
    if (!row) return;
    if (row.hash !== hash)
      throw new BlueprintError(
        'OPERATION_CONFLICT',
        'Operation ID was used with different content',
      );
    return JSON.parse(String(row.result)) as T;
  }
  record(key: string, hash: string, result: unknown) {
    this.db.prepare('INSERT INTO operations VALUES(?,?,?)').run(key, hash, JSON.stringify(result));
  }
  async create(args: {
    projectId: string;
    kind: 'blueprint';
    title: string;
    originSession: SessionRef | null;
    operationId: string;
  }) {
    const p = this.project(args.projectId);
    const hash = digest(args);
    const key = 'create:' + args.operationId;
    const old = this.operation<{ artifactId: string; sourcePath: string }>(key, hash);
    if (old) return old;
    for (const existing of await this.artifacts()) {
      const meta = await json<Artifact & { operationKey?: string; operationHash?: string }>(
        join(await this.artifactRoot(existing), 'artifact.json'),
      );
      if (meta.operationKey === key) {
        if (meta.operationHash !== hash)
          throw new BlueprintError('OPERATION_CONFLICT', 'Operation content changed');
        const result = {
          artifactId: meta.id,
          sourcePath: join(await this.artifactRoot(meta), 'source'),
          sourceFile: 'plan.mdx',
        };
        this.record(key, hash, result);
        return result;
      }
    }
    const id = randomUUID();
    const root = await writableInside(p.path, join(await this.base(p), 'artifacts', id));
    await writableInside(p.path, join(root, 'source'));
    const stage = await writableInside(
      p.path,
      join(await this.base(p), 'artifacts', '.stage-' + id),
    );
    await mkdir(join(stage, 'source'), { recursive: true });
    const artifact: Artifact = {
      formatVersion: 1,
      id,
      projectId: p.id,
      title: args.title,
      kind: args.kind,
      originSession: args.originSession,
      latestRevision: null,
      revisions: [],
    };
    await atomicJson(join(stage, 'artifact.json'), {
      ...artifact,
      operationKey: key,
      operationHash: hash,
    });
    await commitDirectory(stage, root, p.path);
    const result = { artifactId: id, sourcePath: join(root, 'source'), sourceFile: 'plan.mdx' };
    this.record(key, hash, result);
    return result;
  }
  private metadataQueue: Promise<unknown> = Promise.resolve();
  private updateArtifactMetadata(
    artifactId: string,
    key: string,
    hash: string,
    update: (artifact: Artifact) => Partial<Artifact>,
  ) {
    const operation = this.metadataQueue.then(async () => {
      const old = this.operation<{ artifactId: string }>(key, hash);
      if (old) return old;
      const artifact = await this.artifact(artifactId);
      const path = await inside(
        this.project(artifact.projectId).path,
        join(await this.artifactRoot(artifact), 'artifact.json'),
      );
      const metadata = await json<
        Artifact & {
          metadataOperations?: { key: string; hash: string; result: { artifactId: string } }[];
        }
      >(path);
      const recovered = metadata.metadataOperations?.find((entry) => entry.key === key);
      if (recovered) {
        if (recovered.hash !== hash)
          throw new BlueprintError('OPERATION_CONFLICT', 'Operation content changed');
        this.record(key, hash, recovered.result);
        return recovered.result;
      }
      const result = { artifactId };
      // Persist the receipt with the metadata, so a lost acknowledgement can be retried safely.
      await atomicJson(path, {
        ...metadata,
        ...update(metadata),
        metadataOperations: [...(metadata.metadataOperations ?? []), { key, hash, result }],
      });
      this.record(key, hash, result);
      return result;
    });
    this.metadataQueue = operation.catch(() => {});
    return operation;
  }
  async attachSession(args: {
    artifactId: string;
    originSession: SessionRef;
    operationId: string;
  }) {
    return this.updateArtifactMetadata(
      args.artifactId,
      'attach:' + args.operationId,
      digest(args),
      (artifact) => {
        if (
          artifact.originSession &&
          !isDeepStrictEqual(artifact.originSession, args.originSession)
        )
          throw new BlueprintError(
            'SESSION_CONFLICT',
            'Artifact already belongs to another session',
          );
        return { originSession: args.originSession };
      },
    );
  }
  async renamePlan(args: { artifactId: string; title: string; operationId: string }) {
    return this.updateArtifactMetadata(
      args.artifactId,
      'rename:' + args.operationId,
      digest(args),
      () => ({ title: args.title }),
    );
  }
  async archivePlan(args: { artifactId: string; archived: boolean; operationId: string }) {
    return this.updateArtifactMetadata(
      args.artifactId,
      'archive:' + args.operationId,
      digest(args),
      () => ({ archived: args.archived }),
    );
  }
  async publish(args: {
    artifactId: string;
    expectedLatestRevision: string | null;
    operationId: string;
  }) {
    await this.recoverChanges();
    const a = await this.artifact(args.artifactId);
    if (!a.originSession)
      throw new BlueprintError(
        'ORIGIN_SESSION_REQUIRED',
        'Attach an explicit agent session before publishing',
      );
    const root = await this.artifactRoot(a);
    await inside(this.project(a.projectId).path, join(root, 'source'));
    const sourcePath = await inside(root, join(root, 'source', 'plan.mdx'));
    const source = await readFile(sourcePath, 'utf8');
    const hash = digest({ args, source });
    const key = 'publish:' + args.operationId;
    const previous = this.operation<{ revisionId: string }>(key, hash);
    if (previous) return previous;
    // Recover a committed directory if its acknowledgement/index update was interrupted.
    for (const ref of a.revisions) {
      const manifest = await json<Revision & { operationKey?: string; operationHash?: string }>(
        join(root, 'revisions', ref.id, 'manifest.json'),
      );
      if (manifest.operationKey === key) {
        if (manifest.operationHash !== hash)
          throw new BlueprintError('OPERATION_CONFLICT', 'Operation content changed');
        const result = { revisionId: manifest.id };
        this.record(key, hash, result);
        return result;
      }
    }
    if (a.latestRevision !== args.expectedLatestRevision)
      throw new BlueprintError('REVISION_CONFLICT', 'Latest revision changed', {
        expected: a.latestRevision,
        actual: args.expectedLatestRevision,
      });
    const parsed = await this.compile(source);
    const id = String(a.revisions.length + 1).padStart(6, '0') + '-' + randomUUID();
    const revision: Revision = {
      ...parsed,
      id,
      artifactId: a.id,
      formatVersion: 1,
      createdAt: new Date().toISOString(),
      source,
    };
    const staging = await writableInside(
      this.project(a.projectId).path,
      join(root, 'revisions', '.stage-' + randomUUID()),
    );
    await mkdir(staging, { recursive: true });
    await atomicJson(join(staging, 'manifest.json'), {
      ...revision,
      operationKey: key,
      operationHash: hash,
    });
    await atomicText(join(staging, 'plan.mdx'), source);
    if (a.latestRevision) {
      const before = await this.revision(a.id, a.latestRevision);
      const state = await this.state(a.id, before.id);
      const next: State = { values: {} };
      for (const widget of revision.widgets) {
        const previous = before.widgets.find((x) => x.id === widget.id);
        next.values[widget.id] =
          previous && areWidgetsCompatible(previous, widget)
            ? state.values[widget.id]
            : widget.defaultValue;
      }
      const p = this.project(a.projectId);
      const draft = await this.draft(p);
      const inheritedPrivate = Boolean(draft.answers[a.id + ':' + before.id]);
      const priorPublic = await this.publicState(a.id, before.id);
      const baseline: State = { values: {} };
      for (const widget of revision.widgets) {
        const previous = before.widgets.find((w) => w.id === widget.id);
        baseline.values[widget.id] =
          previous && areWidgetsCompatible(previous, widget)
            ? priorPublic.values[widget.id]
            : widget.defaultValue;
      }
      if (inheritedPrivate)
        draft.answers[a.id + ':' + id] = { artifactId: a.id, revisionId: id, values: next.values };
      await atomicJson(join(this.data, 'changes', randomUUID() + '.json'), {
        guardPath: join(root, 'revisions', id, 'manifest.json'),
        writes: [
          { path: this.statePath(a.id, id), value: next },
          { path: beneath(this.data, 'baselines', a.id, id + '.json'), value: baseline },
          ...(inheritedPrivate ? [{ path: this.draftPath(p), value: draft }] : []),
          {
            path: this.states.path(a.id),
            value: {
              ...(await this.states.draft(a.id)),
              answers: {
                ...(await this.states.draft(a.id)).answers,
                [a.id + ':' + id]: { artifactId: a.id, revisionId: id, values: next.values },
              },
            },
          },
        ],
      });
    }
    await commitDirectory(staging, join(root, 'revisions', id), this.project(a.projectId).path);
    await this.recoverChanges();
    const result = { revisionId: id };
    this.record(key, hash, result);
    return result;
  }
  async revision(artifactId: string, revisionId: string) {
    return this.memoRead(['revision', artifactId, revisionId], () =>
      this.readRevision(artifactId, revisionId),
    );
  }
  private async readRevision(artifactId: string, revisionId: string) {
    const a = await this.artifact(artifactId);
    if (!a.revisions.some((r) => r.id === revisionId))
      throw new BlueprintError('UNKNOWN_REVISION', 'Unknown published revision');
    const revision = await json<Revision>(
      await inside(
        await this.artifactRoot(a),
        join(await this.artifactRoot(a), 'revisions', revisionId, 'manifest.json'),
      ),
    );
    if (revision.formatVersion !== 1)
      throw new BlueprintError('UNSUPPORTED_FORMAT', 'Unsupported artifact format', {
        expected: 1,
        actual: revision.formatVersion,
      });
    if (
      revision.id !== revisionId ||
      revision.artifactId !== artifactId ||
      typeof revision.source !== 'string' ||
      !Array.isArray(revision.blocks) ||
      !Array.isArray(revision.widgets)
    )
      throw new BlueprintError('CORRUPT_DATA', 'Published artifact metadata is damaged');
    return revision;
  }
  statePath(id: string, rev: string) {
    return beneath(this.data, 'states', id, rev + '.json');
  }
  async state(id: string, rev: string): Promise<State> {
    return this.memoRead(['state', id, rev], () => this.readState(id, rev));
  }
  private async readState(id: string, rev: string): Promise<State> {
    await this.recoverChanges();
    const revision = await this.revision(id, rev);
    try {
      const state = await json<State>(this.statePath(id, rev));
      if (
        !state.values ||
        revision.widgets.some((widget) => !isWidgetValueValid(widget, state.values[widget.id])) ||
        Object.keys(state.values).some(
          (key) => !revision.widgets.some((widget) => widget.id === key),
        )
      )
        throw new BlueprintError(
          'CORRUPT_DATA',
          'Working state does not satisfy its published definitions',
        );
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { values: Object.fromEntries(revision.widgets.map((w) => [w.id, w.defaultValue])) };
    }
  }
  draftPath(p: Project) {
    if (!p.recipient)
      throw new BlueprintError('SESSION_BINDING_REQUIRED', 'Select a recipient session');
    return join(this.data, 'drafts', p.id, digest(p.recipient) + '.json');
  }
  async draft(p: Project): Promise<Draft> {
    await this.recoverChanges();
    if (!p.recipient) return { annotations: [], answers: {} };
    try {
      return await json<Draft>(this.draftPath(p));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { annotations: [], answers: {} };
    }
  }
  async setValue(artifactId: string, revisionId: string, widgetId: string, value: unknown) {
    const a = await this.artifact(artifactId);
    const p = this.project(a.projectId);
    const revision = await this.revision(artifactId, revisionId);
    const widget = revision.widgets.find((w) => w.id === widgetId);
    if (!widget || !isWidgetValueValid(widget, value))
      throw new BlueprintError('INVALID_STATE', 'Value does not satisfy the widget definition');
    const state = await this.state(artifactId, revisionId);
    state.values[widgetId] = value;
    const draft = await this.draft(p);
    draft.answers[artifactId + ':' + revisionId] = { artifactId, revisionId, values: state.values };
    const journal = join(this.data, 'changes', randomUUID() + '.json');
    await atomicJson(journal, {
      statePath: this.statePath(artifactId, revisionId),
      state,
      writes: [
        { path: this.statePath(artifactId, revisionId), value: state },
        {
          path: this.states.path(artifactId),
          value: {
            ...(await this.states.draft(artifactId)),
            answers: {
              ...(await this.states.draft(artifactId)).answers,
              [artifactId + ':' + revisionId]: { artifactId, revisionId, values: state.values },
            },
          },
        },
        ...(p.recipient ? [{ path: this.draftPath(p), value: draft }] : []),
      ],
    });
    await this.recoverChanges();
  }
  async recoverChanges() {
    return this.memoRead(['recoverChanges'], () => this.readChanges());
  }
  private async readChanges() {
    const directory = join(this.data, 'changes');
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
      const path = join(directory, name);
      const change = await json<{
        statePath: string;
        state: State;
        draftPath: string;
        draft: Draft;
        guardPath?: string;
        writes?: { path: string; value: unknown }[];
      }>(path);
      if (change.guardPath) {
        try {
          await access(change.guardPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          await unlink(path);
          continue;
        }
      }
      if (change.writes) {
        for (const write of change.writes)
          await atomicJson(beneath(this.data, relative(this.data, write.path)), write.value);
        await unlink(path);
        continue;
      }
      const draftPath = beneath(this.data, relative(this.data, change.draftPath));
      const statePath = beneath(this.data, relative(this.data, change.statePath));
      await atomicJson(draftPath, change.draft);
      await atomicJson(statePath, change.state);
      await unlink(path);
    }
  }
  async publicState(artifactId: string, revisionId: string): Promise<State> {
    return this.memoRead(['publicState', artifactId, revisionId], () =>
      this.readPublicState(artifactId, revisionId),
    );
  }
  private async readPublicState(artifactId: string, revisionId: string): Promise<State> {
    const a = await this.artifact(artifactId);
    const saved = await this.states.read(artifactId);
    const key = artifactId + ':' + revisionId;
    if (saved?.answers[key]) return { values: saved.answers[key].values };
    const packets = await this.packages(a.projectId);
    const submitted = packets
      .slice()
      .reverse()
      .map((packet) => packet.answers[key])
      .find(Boolean);
    if (submitted) return { values: submitted.values };
    try {
      return await json<State>(beneath(this.data, 'baselines', artifactId, revisionId + '.json'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const revision = await this.revision(artifactId, revisionId);
    return { values: Object.fromEntries(revision.widgets.map((w) => [w.id, w.defaultValue])) };
  }
  async discard(projectId: string) {
    const p = this.project(projectId);
    const draft = await this.draft(p);
    const writes: { path: string; value: unknown }[] = [];
    for (const answer of Object.values(draft.answers)) {
      writes.push({
        path: this.statePath(answer.artifactId, answer.revisionId),
        value: await this.publicState(answer.artifactId, answer.revisionId),
      });
    }
    writes.push({ path: this.draftPath(p), value: { annotations: [], answers: {} } });
    await atomicJson(join(this.data, 'changes', randomUUID() + '.json'), { writes });
    await this.recoverChanges();
    for (const a of (await this.artifacts()).filter((a) => a.projectId === projectId)) {
      const saved = await this.states.read(a.id);
      const ann =
        saved?.annotations ??
        (await this.packages(projectId)).flatMap((p) =>
          p.annotations.filter((x) => x.artifactId === a.id),
        );
      const current = await this.states.draft(a.id);
      current.annotations = ann;
      for (const rev of a.revisions) {
        const values = (await this.publicState(a.id, rev.id)).values;
        current.answers[a.id + ':' + rev.id] = { artifactId: a.id, revisionId: rev.id, values };
      }
      await this.states.write(a.id, current);
    }
    return { discarded: true };
  }
  async annotate(args: Omit<Annotation, 'id'>) {
    if (args.revisionId === null)
      throw new BlueprintError('UNKNOWN_REVISION', 'Text annotations require a published revision');
    const a = await this.artifact(args.artifactId);
    const revision = await this.revision(a.id, args.revisionId);
    const nodes = revision.blocks.flatMap(function flatten(n): typeof revision.blocks {
      return [n, ...(n.children ?? []).flatMap(flatten)];
    });
    const block =
      args.blockId === 'document'
        ? { type: 'root', children: revision.blocks }
        : nodes.find((n) => n.id === args.blockId);
    const text = (n: (typeof revision.blocks)[number]): string =>
      n.value ?? (n.children ?? []).map(text).join(' ');
    const normalized = (s: string) => s.replace(/\s+/g, ' ').trim();
    if (!args.anchor && (!block || !normalized(text(block)).includes(normalized(args.quote))))
      throw new BlueprintError(
        'INVALID_ANCHOR',
        'Annotation must refer to selected published content',
      );
    if (args.anchor) this.validateAnchor(revision, args.anchor, args.quote);
    const p = this.project(a.projectId);
    const draft = await this.states.draft(a.id);
    const stateContext =
      args.stateContext ?? (await this.captureAnnotationState(a.id, args.revisionId));
    await this.validateAnnotationState(a.id, args.revisionId, stateContext);
    const annotation = {
      ...args,
      stateContext,
      kind: args.kind ?? ('text' as const),
      id: randomUUID(),
    };
    draft.annotations.push(annotation);
    await this.states.write(a.id, draft);
    // Preserve the legacy operator Submit adapter without making it the storage owner.
    if (p.recipient) {
      const legacy = await this.draft(p);
      legacy.annotations.push(annotation);
      await atomicJson(this.draftPath(p), legacy);
    }
    return annotation;
  }
  validateAnchor(revision: Revision, anchor: TextAnchor, quote: string) {
    const leaves: { path: number[]; value: string; id?: string }[] = [];
    const visit = (nodes: Revision['blocks'], path: number[] = []) =>
      nodes.forEach((n, i) => {
        const current = [...path, i];
        if (n.type === 'text' || n.type === 'inlineCode')
          leaves.push({ path: current, value: n.value ?? '', id: n.id });
        if (n.children) visit(n.children, current);
      });
    visit(revision.blocks);
    const start = leaves.findIndex((n) => digest(n.path) === digest(anchor.start.path));
    const end = leaves.findIndex((n) => digest(n.path) === digest(anchor.end.path));
    if (
      start < 0 ||
      end < start ||
      anchor.start.offset < 0 ||
      anchor.end.offset < 0 ||
      anchor.start.offset > (leaves[start]?.value.length ?? 0) ||
      anchor.end.offset > (leaves[end]?.value.length ?? 0) ||
      (start === end && anchor.start.offset >= anchor.end.offset)
    )
      throw new BlueprintError('INVALID_ANCHOR', 'Selection endpoints are outside source text');
    const selected = leaves
      .slice(start, end + 1)
      .map((n, i) =>
        n.value.slice(
          i === 0 ? anchor.start.offset : 0,
          i === end - start ? anchor.end.offset : undefined,
        ),
      )
      .join('');
    if (selected.replace(/\s+/g, '') !== quote.replace(/\s+/g, ''))
      throw new BlueprintError(
        'INVALID_ANCHOR',
        'Selected text does not match exact source endpoints',
      );
  }
  async addAreaAnnotation(args: {
    artifactId: string;
    revisionId: string | null;
    comment: string;
    kind: 'document-area' | 'browser-area';
    capture: Capture;
    stateContext?: AnnotationStateContext;
  }) {
    const artifact = await this.artifact(args.artifactId);
    if (
      args.capture.source.kind !== args.kind ||
      (args.revisionId === null && (args.kind !== 'browser-area' || args.stateContext))
    )
      throw new BlueprintError(
        'INVALID_REFERENCE',
        'Only browser annotations can precede a document',
      );
    if (args.revisionId !== null) await this.revision(artifact.id, args.revisionId);
    const draft = await this.states.draft(artifact.id);
    if (args.stateContext && args.revisionId !== null)
      await this.validateAnnotationState(artifact.id, args.revisionId, args.stateContext);
    const existing = draft.annotations.find((a) => a.capture?.id === args.capture.id);
    if (existing) {
      if (
        existing.revisionId !== args.revisionId ||
        existing.comment !== args.comment ||
        existing.kind !== args.kind ||
        !isDeepStrictEqual(existing.stateContext, args.stateContext) ||
        !isDeepStrictEqual(existing.capture?.source, args.capture.source)
      )
        throw new BlueprintError(
          'OPERATION_CONFLICT',
          'Capture already belongs to a different annotation',
        );
      if (args.capture.png) await this.states.capture(artifact.id, args.capture);
      return { ...existing, number: draft.annotations.findIndex((a) => a.id === existing.id) + 1 };
    }
    const capture = await this.states.capture(artifact.id, args.capture);
    const annotation: Annotation = {
      id: randomUUID(),
      artifactId: artifact.id,
      revisionId: args.revisionId,
      quote:
        args.kind === 'browser-area'
          ? (capture.source.title ?? capture.source.url ?? 'Browser area')
          : 'Document area',
      prefix: '',
      suffix: '',
      blockId: 'document',
      comment: args.comment,
      kind: args.kind,
      capture,
      ...(args.stateContext ? { stateContext: args.stateContext } : {}),
    };
    draft.annotations.push(annotation);
    await this.states.write(artifact.id, draft);
    return { ...annotation, number: draft.annotations.length };
  }
  async editAnnotation(id: string, comment: string | null) {
    for (const a of await this.artifacts()) {
      const draft = await this.states.draft(a.id);
      const item = draft.annotations.find((x) => x.id === id);
      if (!item) continue;
      if (comment === null) draft.annotations = draft.annotations.filter((x) => x.id !== id);
      else item.comment = comment;
      await this.states.write(a.id, draft);
      const p = this.project(a.projectId);
      if (p.recipient) {
        const legacy = await this.draft(p);
        const old = legacy.annotations.find((x) => x.id === id);
        if (comment === null) legacy.annotations = legacy.annotations.filter((x) => x.id !== id);
        else if (old) old.comment = comment;
        await atomicJson(this.draftPath(p), legacy);
      }
      return;
    }
    throw new BlueprintError('UNKNOWN_ANNOTATION', 'Unknown annotation');
  }
  async packages(projectId: string): Promise<Feedback[]> {
    return this.memoRead(['packages', projectId], () => this.readPackages(projectId));
  }
  private async readPackages(projectId: string): Promise<Feedback[]> {
    const p = this.project(projectId);
    const dir = join(await this.base(p), 'feedback');
    let dirs: string[];
    try {
      dirs = await readdir(await inside(p.path, dir));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const output: Feedback[] = [];
    for (const id of dirs.filter((x) => !x.startsWith('.'))) {
      output.push(await json<Feedback>(await inside(p.path, join(dir, id, 'package.json'))));
    }
    return output.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async submit(projectId: string, operationId: string) {
    const p = this.project(projectId);
    if (!p.recipient) throw new BlueprintError('SESSION_BINDING_REQUIRED', 'Select a session');
    const key = 'submit:' + projectId + ':' + operationId;
    const previous = this.operation<Feedback>(key, digest({ projectId, operationId }));
    if (previous) {
      await this.reconcilePacket(previous);
      return previous;
    }
    for (const packet of await this.packages(projectId)) {
      if (packet.id === operationId) {
        this.record(key, digest({ projectId, operationId }), packet);
        await this.reconcilePacket(packet);
        return packet;
      }
    }
    for (const other of (await this.projectAvailability()).filter(
      (other) => other.available && other.id !== p.id,
    )) {
      if ((await this.packages(other.id)).some((packet) => packet.id === operationId))
        throw new BlueprintError(
          'OPERATION_CONFLICT',
          'Package operation ID belongs to another project',
        );
    }
    const draft = await this.draft(p);
    if (!draft.annotations.length && !Object.keys(draft.answers).length)
      throw new BlueprintError('EMPTY_FEEDBACK', 'There is no draft feedback to submit');
    const packet: Feedback = {
      formatVersion: 1,
      id: operationId,
      projectId,
      recipient: p.recipient,
      createdAt: new Date().toISOString(),
      status: 'saved',
      ...draft,
      notification: `Blueprint feedback ${operationId} is ready. Read it with read_feedback(packageId="${operationId}") and follow the bundled annotation guide. This does not authorize implementation.`,
    };
    const dir = join(await this.base(p), 'feedback');
    const stage = await writableInside(p.path, join(dir, '.stage-' + randomUUID()));
    await mkdir(stage, { recursive: true });
    await atomicJson(join(stage, 'package.json'), packet);
    await atomicText(join(stage, 'context.md'), this.context(packet));
    await commitDirectory(stage, join(dir, operationId), p.path);
    this.record(key, digest({ projectId, operationId }), packet);
    await this.reconcilePacket(packet);
    return packet;
  }
  async reconcilePacket(packet: Feedback) {
    const marker = join(this.data, 'submissions', packet.id + '.json');
    try {
      await json(marker);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const p = { ...this.project(packet.projectId), recipient: packet.recipient };
    const draft = await this.draft(p);
    draft.annotations = draft.annotations.filter(
      (a) => !packet.annotations.some((old) => digest(old) === digest(a)),
    );
    for (const [key, value] of Object.entries(packet.answers)) {
      if (draft.answers[key] && digest(draft.answers[key]) === digest(value))
        delete draft.answers[key];
    }
    await atomicJson(this.draftPath(p), draft);
    await atomicJson(marker, { reconciled: true });
  }
  async recover() {
    await this.recoverChanges();
    for (const artifact of await this.artifacts()) await this.states.draft(artifact.id);
    for (const p of (await this.projectAvailability()).filter((p) => p.available)) {
      for (const packet of await this.packages(p.id)) await this.reconcilePacket(packet);
    }
  }
  context(p: Feedback) {
    return `# Blueprint feedback ${p.id}\n\nRecipient: ${p.recipient.harness}/${p.recipient.sessionId}\n\nImplementation authorization: none\n\n## Answers\n\n${JSON.stringify(p.answers, null, 2)}\n\n## Annotations\n\n${p.annotations.map((a) => `### ${a.id}\nArtifact ${a.artifactId}, revision ${a.revisionId}, block ${a.blockId}\n\n> ${a.quote}\n\n${a.comment}`).join('\n\n')}`;
  }
  async feedback(id: string) {
    for (const p of (await this.projectAvailability()).filter((p) => p.available)) {
      const item = (await this.packages(p.id)).find((x) => x.id === id);
      if (item) return item;
    }
    throw new BlueprintError('UNKNOWN_FEEDBACK', 'Unknown published feedback');
  }
  async approvalHistory(artifactId: string, revisionId: string) {
    const a = await this.artifact(artifactId);
    await this.revision(artifactId, revisionId);
    const p = this.project(a.projectId);
    const base = await this.base(p);
    type Approval = {
      type?: 'approved' | 'revoked';
      operationId?: string;
      stateHash?: string;
      savedStateId?: string | null;
      annotationHash?: string;
    };
    const history: Approval[] = [];
    try {
      history.push(
        await json<Approval>(
          await inside(
            p.path,
            join(base, 'approvals', digest({ artifactId, revisionId }) + '.json'),
          ),
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const directory = join(base, 'approvals', 'history', artifactId, revisionId);
    let names: string[] = [];
    try {
      names = await readdir(await inside(p.path, directory));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for (const name of names.filter((n) => n.endsWith('.json')).sort())
      history.push(await json<Approval>(await inside(p.path, join(directory, name))));
    return history;
  }
  async approval(artifactId: string, revisionId: string) {
    return (await this.approvalHistory(artifactId, revisionId)).at(-1) ?? null;
  }
  async approve(artifactId: string, revisionId: string) {
    const a = await this.artifact(artifactId);
    const p = this.project(a.projectId);
    if (await this.editor(artifactId, null))
      throw new BlueprintError(
        'UNSUBMITTED_FEEDBACK',
        'Finish or cancel the pending browser annotation edit before approval',
      );
    for (const rev of a.revisions)
      if (await this.editor(artifactId, rev.id))
        throw new BlueprintError(
          'UNSUBMITTED_FEEDBACK',
          'Finish or cancel the pending annotation before approval',
        );
    if (await this.states.dirty(artifactId))
      throw new BlueprintError(
        'UNSUBMITTED_FEEDBACK',
        'Save or discard working changes before approval',
      );
    try {
      const browserEditor = await json(beneath(this.data, 'browser-editors', artifactId + '.json'));
      if (browserEditor)
        throw new BlueprintError(
          'UNSUBMITTED_FEEDBACK',
          'Finish or cancel the browser annotation before approval',
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const saved = await this.states.read(artifactId);
    const state = await this.state(artifactId, revisionId);
    await atomicJson(
      await writableInside(
        p.path,
        join(
          await this.base(p),
          'approvals',
          'history',
          artifactId,
          revisionId,
          String((await this.approvalHistory(artifactId, revisionId)).length + 1).padStart(8, '0') +
            '-' +
            randomUUID() +
            '.json',
        ),
      ),
      {
        id: randomUUID(),
        artifactId,
        revisionId,
        stateHash: digest(state),
        savedStateId: saved?.id ?? null,
        type: 'approved',
        annotationHash: digest((await this.states.draft(artifactId)).annotations),
        state,
        createdAt: new Date().toISOString(),
        implementationAuthorized: false,
      },
    );
    return { approved: true };
  }
  async revokeApproval(artifactId: string, revisionId: string, operationId: string) {
    const a = await this.artifact(artifactId);
    const key = 'revoke:' + operationId;
    const hash = digest({ artifactId, revisionId });
    const prior = this.operation<{ approved: false }>(key, hash);
    if (prior) return prior;
    const history = await this.approvalHistory(artifactId, revisionId);
    if (!history.some((event) => event.operationId === operationId)) {
      const directory = join(
        await this.base(this.project(a.projectId)),
        'approvals',
        'history',
        artifactId,
        revisionId,
      );
      await atomicJson(
        await writableInside(
          this.project(a.projectId).path,
          join(
            directory,
            String(history.length + 1).padStart(8, '0') + '-' + randomUUID() + '.json',
          ),
        ),
        {
          type: 'revoked',
          id: randomUUID(),
          operationId,
          artifactId,
          revisionId,
          createdAt: new Date().toISOString(),
          implementationAuthorized: false,
        },
      );
    }
    const result = { approved: false as const };
    this.record(key, hash, result);
    return result;
  }
  async editor(artifactId: string, revisionId: string | null) {
    const path = beneath(this.data, 'editors', artifactId, revisionId + '.json');
    try {
      return await json<{
        selection: {
          quote: string;
          prefix: string;
          suffix: string;
          blockId: string;
          kind?: Annotation['kind'];
          anchor?: TextAnchor;
          capture?: Capture;
          stateContext?: AnnotationStateContext;
        };
        comment: string;
        annotationId?: string;
      } | null>(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  async saveEditor(artifactId: string, revisionId: string | null, editor: unknown) {
    if (revisionId !== null) await this.revision(artifactId, revisionId);
    else {
      await this.artifact(artifactId);
      if (editor) {
        const annotationId = (editor as { annotationId?: string }).annotationId;
        const annotation = (await this.states.draft(artifactId)).annotations.find(
          (item) => item.id === annotationId,
        );
        if (!annotation || annotation.kind !== 'browser-area' || annotation.revisionId !== null)
          throw new BlueprintError(
            'INVALID_REFERENCE',
            'Workspace editor requires an existing browser annotation',
          );
      }
    }
    const context = (editor as { selection?: { stateContext?: AnnotationStateContext } } | null)
      ?.selection?.stateContext;
    if (context && revisionId === null)
      throw new BlueprintError('INVALID_REFERENCE', 'Workspace editor has no document state');
    if (context && revisionId !== null)
      await this.validateAnnotationState(artifactId, revisionId, context);
    await atomicJson(beneath(this.data, 'editors', artifactId, revisionId + '.json'), editor);
  }
  async normalizeView(
    artifactId: string,
    revisionId: string,
    view: DocumentView,
  ): Promise<DocumentView> {
    const revision = await this.revision(artifactId, revisionId);
    const ids: string[] = [];
    const visit = (nodes: Revision['blocks']) =>
      nodes.forEach((node) => {
        if (node.type === 'details' && node.id) ids.push(node.id);
        if (node.children) visit(node.children);
      });
    visit(revision.blocks);
    if (
      Object.entries(view.details).some(
        ([id, open]) => !ids.includes(id) || typeof open !== 'boolean',
      )
    )
      throw new BlueprintError(
        'INVALID_VIEW_STATE',
        'Disclosure state must refer to published Details blocks',
      );
    return { details: Object.fromEntries(ids.map((id) => [id, view.details[id] ?? false])) };
  }
  async viewState(artifactId: string, revisionId: string): Promise<DocumentView> {
    let view: DocumentView = { details: {} };
    try {
      view = await json<DocumentView>(
        beneath(this.data, 'view-state', artifactId, revisionId + '.json'),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return this.normalizeView(artifactId, revisionId, view);
  }
  async setViewState(artifactId: string, revisionId: string, view: DocumentView) {
    const normalized = await this.normalizeView(artifactId, revisionId, view);
    await atomicJson(
      beneath(this.data, 'view-state', artifactId, revisionId + '.json'),
      normalized,
    );
    return normalized;
  }
  async captureAnnotationState(
    artifactId: string,
    revisionId: string,
    view?: DocumentView,
  ): Promise<AnnotationStateContext> {
    const values = (await this.state(artifactId, revisionId)).values;
    const normalized = view
      ? await this.normalizeView(artifactId, revisionId, view)
      : await this.viewState(artifactId, revisionId);
    return {
      values,
      view: normalized,
      stateHash: createHash('sha256')
        .update(canonicalString({ artifactId, revisionId, values, view: normalized }))
        .digest('hex'),
    };
  }
  async validateAnnotationState(
    artifactId: string,
    revisionId: string,
    context: AnnotationStateContext,
  ) {
    const revision = await this.revision(artifactId, revisionId);
    const normalized = await this.normalizeView(artifactId, revisionId, context.view);
    if (
      revision.widgets.some((w) => !isWidgetValueValid(w, context.values[w.id])) ||
      Object.keys(context.values).some((id) => !revision.widgets.some((w) => w.id === id)) ||
      canonicalString(normalized) !== canonicalString(context.view) ||
      createHash('sha256')
        .update(
          canonicalString({ artifactId, revisionId, values: context.values, view: normalized }),
        )
        .digest('hex') !== context.stateHash
    )
      throw new BlueprintError(
        'INVALID_ANNOTATION_STATE',
        'Annotation state must match its original revision definitions and canonical hash',
      );
  }
  async document(id: string, rev: string | null) {
    const a = await this.artifact(id);
    if (!rev) {
      let source = '';
      try {
        source = await readFile(
          await inside(
            await this.artifactRoot(a),
            join(await this.artifactRoot(a), 'source', 'plan.mdx'),
          ),
          'utf8',
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const base = {
        draft: true,
        revision: null,
        source,
        waiting: !source.trim(),
        state: { values: {} },
        view: { details: {} },
        annotationState: null,
        annotations: (await this.states.draft(id)).annotations.map((item, index) => ({
          ...item,
          number: index + 1,
        })),
        approved: false,
        editor: await this.editor(id, null),
        latestSavedStateId: null,
        dirty: await this.states.dirty(id),
      };
      if (!source.trim()) return { ...base, preview: null };
      try {
        return { ...base, preview: await this.compile(source) };
      } catch (error) {
        return {
          ...base,
          preview: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    const state = await this.state(id, rev);
    const approval = await this.approval(id, rev);
    const annotations = (await this.states.draft(id)).annotations.map((x, i) => ({
      ...x,
      number: i + 1,
    }));
    const saved = await this.states.read(id);
    const dirty = await this.states.dirty(id);
    return {
      revision: await this.revision(id, rev),
      migrationSummary: revisionSummary(
        a.revisions.findIndex((r) => r.id === rev) > 0
          ? await this.revision(id, a.revisions[a.revisions.findIndex((r) => r.id === rev) - 1].id)
          : null,
        await this.revision(id, rev),
      ),
      editor: (await this.editor(id, rev)) ?? (await this.editor(id, null)),
      state,
      view: await this.viewState(id, rev),
      annotationState: await this.captureAnnotationState(id, rev),
      annotations,
      dirty,
      latestSavedStateId: saved?.id ?? null,
      approved: isApprovedState(state, approval, saved, dirty),
      draft: false,
    };
  }
  /** Sidebar status uses the same approval/dirty rules without compiling or rendering a plan. */
  async artifactStatus(artifact: Artifact) {
    const revisionId = artifact.latestRevision;
    if (!revisionId)
      return { displayStatus: 'Draft', privateChanges: await this.states.dirty(artifact.id) };
    const dirty = await this.states.dirty(artifact.id);
    const state = await this.state(artifact.id, revisionId);
    const approval = await this.approval(artifact.id, revisionId);
    const saved = await this.states.read(artifact.id);
    const approved = isApprovedState(state, approval, saved, dirty);
    return {
      displayStatus: approved ? 'Approved' : 'In review',
      privateChanges: dirty || Boolean(await this.editor(artifact.id, revisionId)),
    };
  }
}
export async function openStore(
  data: string,
  compile?: (source: string) => Promise<ParsedDocument>,
) {
  await mkdir(data, { recursive: true, mode: 0o700 });
  const store = new Store(data, compile);
  await store.recover();
  return store;
}
export { VERSION };
