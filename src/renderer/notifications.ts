import type { Notification } from '../shared/notifications';

export interface NotificationAction {
  label: string;
  pendingLabel?: string;
  run(): Promise<'dismiss' | 'keep' | void> | 'dismiss' | 'keep' | void;
}
export type NotificationInput = Pick<Notification, 'source' | 'context' | 'operation' | 'level' | 'title'> &
  Partial<Pick<Notification, 'body' | 'details' | 'pending' | 'lifetime'>> & { actions?: NotificationAction[] };

/** Closures live only in the owning shell; native overlay receives opaque action IDs. */
export class NotificationController {
  private notices: Notification[] = [];
  private listeners = new Set<() => void>();
  private handlers = new Map<string, NotificationAction['run']>();
  constructor(private uuid = () => crypto.randomUUID()) {}
  snapshot = (): Notification[] => this.notices;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private emit(): void { for (const listener of this.listeners) listener(); }
  find(source: string, context: string, operation: string): Notification | undefined {
    return this.notices.find(n => n.source === source && n.context === context && n.operation === operation);
  }
  push(input: NotificationInput): string {
    const existing = this.find(input.source, input.context, input.operation);
    if (existing) {
      this.update(existing.id, input);
      this.notices = this.notices.map(n => n.id === existing.id ? { ...n, repeats: n.repeats + 1 } : n);
      this.emit();
      return existing.id;
    }
    const id = this.uuid();
    this.notices = [{ ...input, id, pending: input.pending ?? false, repeats: 1,
      lifetime: input.lifetime ?? 'sticky', actions: this.bind(input.actions ?? []) }, ...this.notices];
    this.emit();
    return id;
  }
  private bind(actions: NotificationAction[]): Notification['actions'] {
    return actions.map(({ run, ...action }) => {
      const id = this.uuid(); this.handlers.set(id, run); return { ...action, id };
    });
  }
  update(id: string, patch: Partial<Omit<NotificationInput, 'source' | 'context' | 'operation'>>): void {
    const previous = this.notices.find(n => n.id === id);
    if (!previous) return;
    if (patch.actions) for (const action of previous.actions) this.handlers.delete(action.id);
    this.notices = this.notices.map(n => n.id === id ? { ...n, ...patch,
      actions: patch.actions ? this.bind(patch.actions) : n.actions } : n);
    this.emit();
  }
  dismiss(id: string): void {
    const previous = this.notices.find(n => n.id === id);
    for (const action of previous?.actions ?? []) this.handlers.delete(action.id);
    this.notices = this.notices.filter(n => n.id !== id); this.emit();
  }
  resolve(id: string): void {
    this.update(id, { pending: false }); this.dismiss(id);
  }
  async run(id: string, actionId: string): Promise<void> {
    const notice = this.notices.find(n => n.id === id);
    const run = notice?.actions.some(a => a.id === actionId) ? this.handlers.get(actionId) : undefined;
    if (!notice || notice.pending || !run) return;
    this.update(id, { pending: true });
    try {
      const result = await run();
      this.update(id, { pending: false });
      if (result === 'dismiss') this.dismiss(id);
    } catch (error) {
      this.update(id, { pending: false, level: 'error', body: error instanceof Error ? error.message : String(error), lifetime: 'sticky' });
    }
  }
}

export const notifications = new NotificationController();
export function notifyError(error: unknown, source: string, context: string, operation = crypto.randomUUID()): string {
  return notifications.push({ source, context, operation, level: 'error', title: 'Operation failed',
    body: error instanceof Error ? error.message : String(error) });
}
