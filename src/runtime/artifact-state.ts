import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  atomicJson,
  atomicText,
  beneath,
  inside,
  writableInside,
  commitDirectory,
  json,
} from './files';
import { BlueprintError } from '../shared/protocol';
import type { Annotation, Store, SessionRef } from './store';
import { isWidgetValueValid, type WidgetValue } from '../document';
import { markerGeometry } from '../shared/annotation-marker';
import type { AnnotationStateContext } from '../shared/annotation-context';

export interface TextEndpoint {
  blockId: string;
  path: number[];
  offset: number;
}
export interface TextAnchor {
  start: TextEndpoint;
  end: TextEndpoint;
}
export interface Capture {
  id: string;
  png?: string;
  source: {
    kind: 'browser-area' | 'document-area';
    url?: string;
    title?: string;
    capturedAt: string;
    viewport: { width: number; height: number; deviceScaleFactor: number };
    rect: { x: number; y: number; width: number; height: number };
    pointer?: { x: number; y: number };
    zoomFactor: number;
    scroll: { x: number; y: number };
    pageId?: string;
    stateHash?: string;
    layoutHash?: string;
    elementAnchor?: {
      path: number[];
      tag: string;
      id?: string;
      textHash: string;
      pointerOffset?: { x: number; y: number };
    };
  };
}
export interface ArtifactDraft {
  annotations: Annotation[];
  answers: Record<
    string,
    { artifactId: string; revisionId: string; values: Record<string, WidgetValue> }
  >;
}
export interface SavedAnnotation extends Annotation {
  number: number;
  text: string;
  annotation: string;
  source: {
    artifactId: string;
    revisionId: string;
    kind: string;
    anchor?: TextAnchor;
    blockId: string;
    prefix: string;
    suffix: string;
    capture?: Capture['source'];
    attachmentId?: string;
    stateContext?: AnnotationStateContext;
  };
}
export interface SavedState {
  formatVersion: 1;
  id: string;
  artifactId: string;
  revisionId: string;
  originSession: SessionRef;
  createdAt: string;
  previousSavedStateId: string | null;
  answers: ArtifactDraft['answers'];
  annotations: SavedAnnotation[];
  attachments: {
    id: string;
    mimeType: string;
    file: string;
    annotationId: string;
    number: number;
  }[];
  notification: string;
  implementationAuthorized: false;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** Private artifact workspace and explicit immutable operator checkpoints. Legacy files remain untouched. */
export class ArtifactStates {
  constructor(private store: Store) {}
  path(artifactId: string) {
    return beneath(this.store.data, 'artifact-drafts', artifactId + '.json');
  }
  async draft(artifactId: string): Promise<ArtifactDraft> {
    await this.store.recoverChanges();
    try {
      return await json<ArtifactDraft>(this.path(artifactId));
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const artifact = await this.store.artifact(artifactId);
    const project = this.store.project(artifact.projectId);
    const draft: ArtifactDraft = { annotations: [], answers: {} };
    // Recover all recipient namespaces, not just the currently selected legacy recipient.
    const legacyDirectory = beneath(this.store.data, 'drafts', project.id);
    let names: string[] = [];
    try {
      names = await readdir(legacyDirectory);
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const legacy = [];
    for (const packet of await this.store.packages(project.id)) legacy.push(packet);
    for (const name of names.filter((n) => n.endsWith('.json')).sort())
      legacy.push(await json<ArtifactDraft>(beneath(legacyDirectory, name)));
    for (const item of legacy) {
      for (const annotation of item.annotations.filter((a) => a.artifactId === artifactId)) {
        const index = draft.annotations.findIndex((a) => a.id === annotation.id);
        if (index < 0) draft.annotations.push(annotation);
        else draft.annotations[index] = annotation;
      }
      for (const [key, answer] of Object.entries(item.answers))
        if (answer.artifactId === artifactId) draft.answers[key] = answer;
    }
    // Authoritative per-revision workspace survives even if its old project draft was reconciled.
    for (const reference of artifact.revisions) {
      const key = artifactId + ':' + reference.id;
      const legacyAnswer = draft.answers[key];
      try {
        await readFile(this.store.statePath(artifactId, reference.id));
      } catch (error) {
        if (!missing(error)) throw error;
        if (legacyAnswer) {
          const revision = await this.store.revision(artifactId, reference.id);
          if (
            revision.widgets.some((w) => !isWidgetValueValid(w, legacyAnswer.values[w.id])) ||
            Object.keys(legacyAnswer.values).some((k) => !revision.widgets.some((w) => w.id === k))
          )
            throw new BlueprintError(
              'CORRUPT_DATA',
              'Legacy answer does not satisfy its published definitions',
            );
          await atomicJson(this.store.statePath(artifactId, reference.id), {
            values: legacyAnswer.values,
          });
        }
      }
      const state = await this.store.state(artifactId, reference.id);
      draft.answers[key] = {
        artifactId,
        revisionId: reference.id,
        values: state.values,
      };
    }
    await atomicJson(this.path(artifactId), draft);
    return draft;
  }
  async write(artifactId: string, draft: ArtifactDraft) {
    await atomicJson(this.path(artifactId), draft);
  }
  async list(artifactId: string): Promise<SavedState[]> {
    const artifact = await this.store.artifact(artifactId);
    const root = await this.store.artifactRoot(artifact);
    let names: string[];
    try {
      names = await readdir(await inside(root, join(root, 'states')));
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }
    const items: (SavedState & { operationKey?: string; operationHash?: string })[] = [];
    for (const name of names.filter((n) => !n.startsWith('.')).sort()) {
      const item = await json<SavedState>(
        await inside(root, join(root, 'states', name, 'state.json')),
      );
      if (item.formatVersion !== 1 || item.artifactId !== artifactId || item.id !== name)
        throw new BlueprintError('CORRUPT_DATA', 'Saved state identity is inconsistent');
      items.push(item);
    }
    return items;
  }
  async read(artifactId: string, savedStateId?: string): Promise<SavedState | null> {
    const items = await this.list(artifactId);
    const found = savedStateId ? items.find((item) => item.id === savedStateId) : items.at(-1);
    if (savedStateId && !found)
      throw new BlueprintError('UNKNOWN_SAVED_STATE', 'Unknown saved state for this artifact');
    return found ?? null;
  }
  async save(args: {
    artifactId: string;
    revisionId: string;
    operationId: string;
    expectedLatestSavedStateId: string | null;
  }) {
    await this.store.recoverChanges();
    const artifact = await this.store.artifact(args.artifactId);
    const project = this.store.project(artifact.projectId);
    const key = 'save:' + args.artifactId + ':' + args.operationId;
    // Intent identifies a retry. Mutable workspace is deliberately excluded from this hash.
    const intentHash = hash(args);
    const recorded = this.store.operation<SavedState>(key, intentHash);
    if (recorded) return recorded;
    const snapshots = await this.list(artifact.id);
    for (const item of snapshots as (SavedState & {
      operationKey?: string;
      operationHash?: string;
    })[]) {
      if (item.operationKey === key) {
        if (item.operationHash !== intentHash)
          throw new BlueprintError('OPERATION_CONFLICT', 'Save operation changed');
        this.store.record(key, intentHash, item);
        return item;
      }
    }
    await this.store.revision(artifact.id, args.revisionId);
    for (const rev of artifact.revisions)
      if (await this.store.editor(artifact.id, rev.id))
        throw new BlueprintError(
          'UNFINISHED_ANNOTATION',
          'Save or cancel the unfinished annotation first',
        );
    try {
      const pending = await json(
        beneath(this.store.data, 'browser-editors', artifact.id + '.json'),
      );
      if (pending)
        throw new BlueprintError(
          'UNFINISHED_ANNOTATION',
          'Save or cancel the unfinished browser annotation first',
        );
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const latest = snapshots.at(-1)?.id ?? null;
    if (latest !== args.expectedLatestSavedStateId)
      throw new BlueprintError('STATE_CONFLICT', 'Latest saved state changed', {
        expected: args.expectedLatestSavedStateId,
        actual: latest,
      });
    const draft = await this.draft(artifact.id);
    for (const rev of artifact.revisions) {
      const values = (await this.store.state(artifact.id, rev.id)).values;
      draft.answers[artifact.id + ':' + rev.id] = {
        artifactId: artifact.id,
        revisionId: rev.id,
        values,
      };
    }
    const id = String(snapshots.length + 1).padStart(6, '0') + '-' + randomUUID();
    const root = await this.store.artifactRoot(artifact);
    const stage = await writableInside(
      project.path,
      join(root, 'states', '.stage-' + randomUUID()),
    );
    await mkdir(stage, { recursive: true });
    const annotations: SavedAnnotation[] = [];
    const attachments: SavedState['attachments'] = [];
    for (const [index, item] of draft.annotations.entries()) {
      await this.store.revision(artifact.id, item.revisionId);
      const number = index + 1;
      const annotation: SavedAnnotation = {
        ...item,
        number,
        text: item.quote,
        annotation: item.comment,
        source: {
          artifactId: artifact.id,
          revisionId: item.revisionId,
          kind: item.kind ?? 'text',
          blockId: item.blockId,
          prefix: item.prefix,
          suffix: item.suffix,
          ...(item.anchor ? { anchor: item.anchor } : {}),
          ...(item.stateContext ? { stateContext: item.stateContext } : {}),
        },
      };
      if (item.capture) {
        const capture = item.capture;
        const raw = await readFile(
          beneath(this.store.data, 'captures', artifact.id, capture.id + '.png'),
        );
        const rect = capture.source.rect;
        // SVG wraps the captured pixels; stable numbering is applied at the snapshot boundary.
        const width = capture.source.viewport.width;
        const height = capture.source.viewport.height;
        const pointer = capture.source.pointer ?? { x: rect.x, y: rect.y };
        const { cx, cy, path: markerPath } = markerGeometry(pointer, { width, height });
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><image width="${width}" height="${height}" href="data:image/png;base64,${raw.toString('base64')}"/><rect x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}" fill="none" stroke="#1688ff" stroke-width="3"/><path d="${markerPath}" fill="#4263da" stroke="white" stroke-width="1.5" stroke-linejoin="round"/><text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" font-size="12" font-weight="600" font-family="sans-serif" fill="white">${number}</text></svg>`;
        const attachmentId = capture.id;
        const file = 'attachments/' + attachmentId + '.svg';
        await atomicText(join(stage, file), svg);
        attachments.push({
          id: attachmentId,
          mimeType: 'image/svg+xml',
          file,
          annotationId: item.id,
          number,
        });
        annotation.source.capture = capture.source;
        annotation.source.attachmentId = attachmentId;
        annotation.capture = { ...capture, png: undefined };
      }
      annotations.push(annotation);
    }
    const snapshot: SavedState = {
      formatVersion: 1,
      id,
      artifactId: artifact.id,
      revisionId: args.revisionId,
      originSession: artifact.originSession,
      createdAt: new Date().toISOString(),
      previousSavedStateId: latest,
      answers: draft.answers,
      annotations,
      attachments,
      notification: `Blueprint artifact ${artifact.id} has saved state ${id}. Read read_artifact(artifactId="${artifact.id}", part="state", savedStateId="${id}"). This does not authorize implementation.`,
      implementationAuthorized: false,
    };
    const manifest = { ...snapshot, operationKey: key, operationHash: intentHash };
    await atomicJson(join(stage, 'state.json'), manifest);
    await atomicText(join(stage, 'context.md'), this.context(snapshot));
    await commitDirectory(stage, join(root, 'states', id), project.path);
    this.store.record(key, intentHash, manifest);
    await this.write(artifact.id, draft);
    return manifest;
  }
  context(state: SavedState) {
    return (
      `# Blueprint saved state\n\nArtifact: ${state.artifactId}\nState: ${state.id}\nOrigin session: ${state.originSession.sessionId}\nImplementation authorization: none\n\n## Answers\n\n${JSON.stringify(state.answers, null, 2)}\n\n## Annotations\n\n` +
      state.annotations
        .map(
          (a) =>
            `### Annotation ${a.number}\n\n> ${a.text}\n\n${a.annotation}\n\nSource: ${JSON.stringify(a.source)}\nStable ID: ${a.id}`,
        )
        .join('\n\n')
    );
  }
  async attachment(artifactId: string, savedStateId: string, attachmentId: string) {
    const state = await this.read(artifactId, savedStateId);
    const ref = state?.attachments.find((a) => a.id === attachmentId);
    if (!ref) throw new BlueprintError('UNKNOWN_ATTACHMENT', 'Unknown saved attachment');
    const artifact = await this.store.artifact(artifactId);
    const root = await this.store.artifactRoot(artifact);
    const stateRoot = await inside(root, join(root, 'states', savedStateId));
    const path = await inside(stateRoot, join(stateRoot, ref.file));
    const bytes = await readFile(path);
    return { ...ref, savedStateId, artifactId, base64: bytes.toString('base64') };
  }
  async capture(artifactId: string, capture: Capture) {
    if (!capture.png || capture.png.length > 24_000_000 || !/^[A-Za-z0-9+/=]+$/.test(capture.png))
      throw new BlueprintError('INVALID_CAPTURE', 'Invalid captured image');
    const bytes = Buffer.from(capture.png, 'base64');
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      throw new BlueprintError('INVALID_CAPTURE', 'Expected a PNG capture');
    const path = beneath(this.store.data, 'captures', artifactId, capture.id + '.png');
    // Private PNGs have an immutable capture identity. Never overwrite a referenced image.
    const { open } = await import('node:fs/promises');
    await mkdir(beneath(this.store.data, 'captures', artifactId), { recursive: true, mode: 0o700 });
    try {
      const file = await open(path, 'wx', 0o600);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!(await readFile(path)).equals(bytes))
        throw new BlueprintError(
          'OPERATION_CONFLICT',
          'Capture ID already belongs to different pixels',
        );
    }
    return { ...capture, png: undefined };
  }
  async dirty(artifactId: string) {
    const artifact = await this.store.artifact(artifactId);
    const draft = await this.draft(artifactId);
    const saved = await this.read(artifactId);
    const publicAnnotations =
      saved?.annotations ??
      (await this.store.packages(artifact.projectId)).flatMap((p) =>
        p.annotations.filter((a) => a.artifactId === artifactId),
      );
    const normalize = (items: Annotation[]) =>
      items.map((a) => ({
        id: a.id,
        revisionId: a.revisionId,
        comment: a.comment,
        quote: a.quote,
        anchor: a.anchor,
        capture: a.capture,
        kind: a.kind,
        stateContext: a.stateContext,
      }));
    if (hash(normalize(draft.annotations)) !== hash(normalize(publicAnnotations))) return true;
    for (const rev of artifact.revisions) {
      const state = await this.store.state(artifactId, rev.id);
      const baseline = await this.store.publicState(artifactId, rev.id);
      if (hash(state) !== hash(baseline)) return true;
    }
    return false;
  }
}
