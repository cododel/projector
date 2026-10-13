import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface DiagnosticEvent {
  version: 1;
  id: string;
  runId: string;
  testId: string;
  role: string;
  pid: number;
  workerId?: number | string;
  phase: string;
  kind: string;
  message: string;
  stack?: string;
  level: 'error' | 'warning' | 'info';
  external?: boolean;
  forwardedFrom?: string;
}

export interface DiagnosticExpectation {
  role: string;
  kind: string;
  phase: string;
  message: string | RegExp;
  count: number;
  external?: boolean;
}

function validEvent(value: unknown): value is DiagnosticEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  return (
    event.version === 1 &&
    ['id', 'runId', 'testId', 'role', 'phase', 'kind'].every(
      (key) => typeof event[key] === 'string' && event[key] !== '',
    ) &&
    typeof event.message === 'string' &&
    Number.isInteger(event.pid) &&
    Number(event.pid) > 0 &&
    ['error', 'warning', 'info'].includes(String(event.level)) &&
    (event.stack === undefined || typeof event.stack === 'string') &&
    (event.forwardedFrom === undefined || typeof event.forwardedFrom === 'string') &&
    (event.external === undefined || typeof event.external === 'boolean') &&
    (event.workerId === undefined ||
      typeof event.workerId === 'string' ||
      (typeof event.workerId === 'number' && Number.isInteger(event.workerId)))
  );
}

/** One journal per test invocation; expectations never authorize earlier events. */
export class DiagnosticCollector {
  readonly path: string;
  readonly runId: string;
  readonly testId: string;
  readonly env: Record<string, string>;
  private readonly initializationId = randomUUID();
  private observedCount = 0;
  private expectations: Array<DiagnosticExpectation & { after: number }> = [];

  constructor(options: { testId: string; runId?: string; directory?: string }) {
    if (!options.testId.trim()) throw new Error('Diagnostic collector requires a test ID');
    this.testId = options.testId;
    this.runId = options.runId ?? randomUUID();
    const directory = resolve(options.directory ?? '.tmp/test-diagnostics');
    mkdirSync(directory, { recursive: true });
    this.path = resolve(directory, `${randomUUID()}.jsonl`);
    writeFileSync(this.path, '', { flag: 'wx', mode: 0o600 });
    this.env = {
      PROJECTOR_TEST_DIAGNOSTICS: this.path,
      PROJECTOR_TEST_ID: this.testId,
      PROJECTOR_TEST_RUN_ID: this.runId,
    };
    this.phase('startup');
    this.append({version:1,id:this.initializationId,runId:this.runId,testId:this.testId,role:'collector',
      pid:process.pid,phase:'startup',kind:'collector-ready',message:'Diagnostic collector ready',level:'info'});
  }

  phase(value: string): void {
    if (!value.trim() || /[\r\n]/.test(value)) throw new Error('Invalid diagnostic phase');
    const temporary = `${this.path}.phase.${randomUUID()}`;
    writeFileSync(temporary, value, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, `${this.path}.phase`);
  }

  installEnvironment(): () => void {
    const previous = Object.fromEntries(
      Object.keys(this.env).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, this.env);
    return () => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    };
  }

  append(event: DiagnosticEvent): void {
    if (!validEvent(event)) throw new Error('Invalid diagnostic event');
    appendFileSync(this.path, `${JSON.stringify(event)}\n`, { encoding: 'utf8' });
  }

  events(): DiagnosticEvent[] {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (cause) {
      throw new Error(`Diagnostic journal unavailable: ${this.path}`, { cause });
    }
    if (text && !text.endsWith('\n')) throw new Error('Truncated diagnostic journal');
    const records: DiagnosticEvent[] = [];
    const seen = new Map<string, string>();
    for (const [index, line] of text.split('\n').slice(0, -1).entries()) {
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch (cause) {
        throw new Error(`Malformed diagnostic record ${index + 1}`, { cause });
      }
      if (!validEvent(event)) throw new Error(`Invalid diagnostic record ${index + 1}`);
      if (event.runId !== this.runId || event.testId !== this.testId)
        throw new Error(`Unbound diagnostic event ${event.id}`);
      const serialized = JSON.stringify(event);
      const existing = seen.get(event.id);
      if (existing !== undefined) {
        if (existing !== serialized) throw new Error(`Conflicting diagnostic event ${event.id}`);
        continue;
      }
      seen.set(event.id, serialized);
      records.push(event);
    }
    if (records[0]?.id !== this.initializationId)
      throw new Error('Diagnostic journal lost its initialization record');
    if (records.length < this.observedCount) throw new Error('Diagnostic journal lost recorded events');
    this.observedCount = records.length;
    for (const record of records)
      if (
        record.forwardedFrom &&
        !records.some(
          (primary) =>
            primary.id === record.forwardedFrom &&
            primary.level !== 'info',
        )
      )
        throw new Error(`Unbound forwarded diagnostic ${record.id}`);
    return records.slice(1);
  }

  expect(expectation: DiagnosticExpectation): void {
    if (
      !Number.isInteger(expectation.count) ||
      expectation.count < 1 ||
      !expectation.role ||
      !expectation.kind ||
      !expectation.phase ||
      !(typeof expectation.message === 'string' || expectation.message instanceof RegExp)
    )
      throw new Error(
        'Expected diagnostics require source, kind, phase, message and positive count',
      );
    this.expectations.push({ ...expectation, after: this.events().length });
  }

  assertClean(): void {
    const events = this.events();
    const counts = this.expectations.map(() => 0);
    const unexpected: DiagnosticEvent[] = [];
    events.forEach((event, index) => {
      const candidates = this.expectations.flatMap((expectation, expectationIndex) => {
        if (
          index < expectation.after ||
          event.role !== expectation.role ||
          event.kind !== expectation.kind ||
          event.phase !== expectation.phase ||
          Boolean(event.external) !== Boolean(expectation.external)
        )
          return [];
        const matcher = expectation.message;
        const matches =
          typeof matcher === 'string'
            ? event.message === matcher
            : new RegExp(matcher.source, matcher.flags.replace(/[gy]/g, '')).test(event.message);
        return matches ? [expectationIndex] : [];
      });
      if (candidates.length > 1) throw new Error(`Ambiguous expected diagnostic ${event.id}`);
      if (candidates.length === 1) counts[candidates[0]]++;
      else if (!event.external && event.level !== 'info') unexpected.push(event);
    });
    const missing = this.expectations.flatMap((expectation, index) =>
      counts[index] === expectation.count
        ? []
        : [
            `${expectation.role}/${expectation.kind}/${expectation.phase}: expected ${expectation.count}, received ${counts[index]}`,
          ],
    );
    if (unexpected.length || missing.length)
      throw new Error(
        [
          ...unexpected.map(
            (event) =>
              `Unexpected ${event.level} [${event.role}/${event.kind}/${event.phase}]: ${event.message}${event.stack ? `\n${event.stack}` : ''}`,
          ),
          ...missing,
          `Diagnostic journal: ${this.path}`,
        ].join('\n'),
      );
  }

  /** Call after child shutdown: wait for a quiet journal, never discard late errors. */
  async drain(options: { quietMs?: number; timeoutMs?: number } = {}): Promise<void> {
    const quietMs = options.quietMs ?? 50;
    const timeoutMs = options.timeoutMs ?? 1000;
    if (quietMs < 0 || timeoutMs < quietMs) throw new Error('Invalid diagnostic drain bounds');
    const start = Date.now();
    let changed = start;
    let previous = readFileSync(this.path, 'utf8');
    while (Date.now() - changed < quietMs) {
      if (Date.now() - start >= timeoutMs) throw new Error('Diagnostic journal did not drain');
      await new Promise((resolve) => setTimeout(resolve, Math.min(10, quietMs)));
      const current = readFileSync(this.path, 'utf8');
      if (current !== previous) {
        previous = current;
        changed = Date.now();
      }
    }
    this.assertClean();
  }
}
