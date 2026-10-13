import { z } from 'zod';

const text = z.string().max(100000);
const identity = z.string().min(1).max(2000);
export const notificationSchema = z.object({
  id: identity, source: identity, context: text, operation: identity,
  level: z.enum(['info', 'warning', 'error']), title: text, body: text.optional(), details: text.optional(),
  pending: z.boolean(), repeats: z.number().int().positive(),
  actions: z.array(z.object({ id: identity, label: text, pendingLabel: text.optional() }).strict()).max(20),
  lifetime: z.enum(['visible', 'sticky']),
}).strict();
export type Notification = z.infer<typeof notificationSchema>;
export const notificationsSchema = z.array(notificationSchema);
export type NotificationCommand =
  | { type: 'action'; id: string; actionId: string }
  | { type: 'dismiss'; id: string }
  | { type: 'ready' | 'focus' | 'blur' }
  | { type: 'layout'; width: number; height: number }
  | { type: 'pointer'; interactive: boolean };
export const notificationCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('action'), id: identity, actionId: identity }).strict(),
  z.object({ type: z.literal('dismiss'), id: identity }).strict(),
  z.object({ type: z.enum(['ready', 'focus', 'blur']) }).strict(),
  z.object({ type: z.literal('layout'), width: z.number().finite().nonnegative().max(10000), height: z.number().finite().nonnegative().max(10000) }).strict(),
  z.object({ type: z.literal('pointer'), interactive: z.boolean() }).strict(),
]);
export interface NotificationTransport {
  publish(notifications: Notification[]): Promise<void>;
  onCommand(callback: (command: NotificationCommand) => void): () => void;
  focus(): void;
}
export interface NotificationOverlayBridge {
  command(command: NotificationCommand): void;
  onState(callback: (state: { notifications: Notification[]; visible: boolean; maxHeight: number }) => void): () => void;
  onFocus(callback: () => void): () => void;
}

/** Only elapsed time while the entire alert is visible consumes its lifetime. */
export class VisibleLifetime {
  private remaining = 5000;
  private since: number | null = null;
  update(now: number, running: boolean): number {
    if (this.since !== null) this.remaining = Math.max(0, this.remaining - Math.max(0, now - this.since));
    this.since = running ? now : null;
    return this.remaining;
  }
}
