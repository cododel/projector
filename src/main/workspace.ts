import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { atomicJson } from '../runtime/files';
import type {
  WorkspaceSnapshot,
  WorkspaceTab,
  PlanWorkspace,
  WorkspaceLayout,
} from '../shared/workspace';
const tab = z.discriminatedUnion('kind', [
  z.object({ id: z.string(), kind: z.literal('document'), revisionId: z.string().nullable() }),
  z.object({ id: z.string(), kind: z.literal('home'), address: z.string() }),
  z.object({ id: z.string(), kind: z.literal('browser'), url: z.string(), title: z.string() }),
]);
const layoutSchema = z
  .object({ leftSidebarVisible: z.boolean(), rightSidebarVisible: z.boolean() })
  .strict();
const defaultLayout: WorkspaceLayout = { leftSidebarVisible: true, rightSidebarVisible: true };
const schema = z.object({
  formatVersion: z.literal(1),
  layout: layoutSchema.default(defaultLayout),
  plans: z.record(
    z.string(),
    z.object({
      tabs: z.array(tab),
      activeTabId: z.string().nullable(),
      lastDocumentRevisionId: z.string().nullable().optional(),
    }),
  ),
});
/** App-owned view metadata; never publishes or discards operator state. */
export class Workspace {
  private layout: WorkspaceLayout = { ...defaultLayout };
  private plans: Record<string, PlanWorkspace> = {};
  private writes: Promise<void> = Promise.resolve();
  constructor(private path: string) {}
  async load() {
    try {
      const stored = schema.parse(JSON.parse(await readFile(this.path, 'utf8')));
      this.plans = stored.plans;
      this.layout = stored.layout;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  snapshot(): WorkspaceSnapshot {
    return structuredClone({ plans: this.plans, layout: this.layout });
  }
  restore(snapshot: WorkspaceSnapshot) {
    this.plans = structuredClone(snapshot.plans);
    this.layout = structuredClone(snapshot.layout);
  }
  setLayout(value: WorkspaceLayout) {
    this.layout = layoutSchema.parse(value);
  }
  plan(artifactId: string): PlanWorkspace {
    return (this.plans[artifactId] ??= { tabs: [], activeTabId: null });
  }
  find(artifactId: string, id: string) {
    const found = this.plan(artifactId).tabs.find((t) => t.id === id);
    if (!found) throw new Error('WORKSPACE_TAB_NOT_FOUND');
    return found;
  }
  document(artifactId: string, revisionId: string | null) {
    const plan = this.plan(artifactId);
    plan.lastDocumentRevisionId = revisionId;
    let entry = plan.tabs.find((t) => t.kind === 'document');
    if (!entry) {
      entry = { id: randomUUID(), kind: 'document', revisionId };
      plan.tabs.unshift(entry);
    } else if (entry.kind === 'document') entry.revisionId = revisionId;
    plan.activeTabId = entry.id;
    return entry;
  }
  home(artifactId: string) {
    const entry: WorkspaceTab = { id: randomUUID(), kind: 'home', address: '' };
    const plan = this.plan(artifactId);
    plan.tabs.push(entry);
    plan.activeTabId = entry.id;
    return entry;
  }
  address(artifactId: string, id: string, address: string) {
    const entry = this.find(artifactId, id);
    if (entry.kind !== 'home') throw new Error('WORKSPACE_HOME_REQUIRED');
    entry.address = address;
  }
  browser(artifactId: string, value: { id: string; url: string; title: string }, homeId?: string) {
    const plan = this.plan(artifactId);
    const existing = homeId
      ? this.find(artifactId, homeId)
      : plan.tabs.find((t) => t.kind === 'browser' && t.nativeId === value.id);
    const entry: WorkspaceTab = {
      id: existing?.id ?? randomUUID(),
      kind: 'browser',
      url: value.url,
      title: value.title,
      nativeId: value.id,
    };
    if (existing) plan.tabs[plan.tabs.indexOf(existing)] = entry;
    else plan.tabs.push(entry);
    plan.activeTabId = entry.id;
    return entry;
  }
  select(artifactId: string, id: string) {
    this.find(artifactId, id);
    this.plan(artifactId).activeTabId = id;
  }
  close(artifactId: string, id: string) {
    const plan = this.plan(artifactId),
      index = plan.tabs.findIndex((t) => t.id === id);
    if (index < 0) return;
    plan.tabs.splice(index, 1);
    if (plan.activeTabId === id)
      plan.activeTabId = plan.tabs[Math.min(index, plan.tabs.length - 1)]?.id ?? null;
  }
  sync(values: { id: string; url: string; title: string }[]) {
    let changed = false;
    for (const plan of Object.values(this.plans))
      for (const entry of plan.tabs)
        if (entry.kind === 'browser') {
          const value = values.find((v) => v.id === entry.nativeId);
          if (value && (entry.url !== value.url || entry.title !== value.title)) {
            entry.url = value.url;
            entry.title = value.title;
            changed = true;
          }
        }
    return changed;
  }
  save() {
    const value = schema.parse({ formatVersion: 1, plans: this.plans, layout: this.layout });
    const write = this.writes.catch(() => {}).then(() => atomicJson(this.path, value));
    this.writes = write;
    return write;
  }
}
