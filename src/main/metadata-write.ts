import { open, readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { atomicJson } from '../runtime/files';
import { ProjectorError } from '../shared/protocol';

/** One metadata owner; an unknown rename is confirmed without replaying its caller's action. */
export class MetadataWriter {
  private writes: Promise<void> = Promise.resolve();
  private pending: { text: string; error: ProjectorError } | null = null;
  constructor(private readonly path: string) {}

  hasPendingConfirmation(): boolean { return this.pending !== null; }
  assertConfirmed(): void { if (this.pending) throw this.pending.error; }

  write(value: unknown): Promise<void> {
    const text = JSON.stringify(value, null, 2);
    if (text === undefined) return Promise.reject(new Error('Invalid metadata snapshot'));
    return this.enqueue(async () => {
      this.assertConfirmed();
      try { await atomicJson(this.path, JSON.parse(text)); }
      catch (error) {
        if (!(error instanceof ProjectorError) || error.code !== 'UNKNOWN_RESULT' ||
            error.details?.phase !== 'after-rename') throw error;
        this.pending = { text, error };
        await this.reconcile();
      }
    });
  }

  confirmPending(): Promise<void> { return this.enqueue(() => this.reconcile()); }

  private enqueue(action: () => Promise<void>): Promise<void> {
    const write = this.writes.catch(() => {}).then(action);
    this.writes = write;
    return write;
  }

  private async reconcile(): Promise<void> {
    const pending = this.pending;
    if (!pending) return;
    try {
      // Equality alone is insufficient: the exact file and its directory must be synced.
      if (await readFile(this.path, 'utf8') !== pending.text) throw new Error('Metadata changed');
      const file = await open(this.path, 'r');
      try {
        if (await file.readFile('utf8') !== pending.text) throw new Error('Metadata changed');
        await file.sync();
        const directory = await open(dirname(this.path), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
        const owned = await file.stat(), current = await stat(this.path);
        if (owned.dev !== current.dev || owned.ino !== current.ino ||
            await readFile(this.path, 'utf8') !== pending.text) throw new Error('Metadata changed');
      } finally { await file.close(); }
      this.pending = null;
    } catch {
      // Retain the attempted outcome; later mutations cannot overwrite an unknown commit.
      pending.error = new ProjectorError('UNKNOWN_RESULT',
        'Workspace metadata may already be saved. Retry confirmation before making another change.',
        { phase: 'after-rename', reconcileBeforeRetry: true, metadataConfirmation: true });
      throw pending.error;
    }
  }
}
