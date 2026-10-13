export type TerminalKind = 'shell' | 'codex';
export type TerminalStatus = 'running' | 'exited' | 'inactive' | 'error';
export interface TerminalRecord {
  id: string;
  projectId: string;
  cwd: string;
  kind: TerminalKind;
  title: string;
  createdAt: string;
  status: TerminalStatus;
  exitCode: number | null;
  signal?: number;
  pid?: number;
  harnessSessionId?: string;
  operationId?: string;
  error?: string;
  truncated?: boolean;
}
export interface CreateTerminal {
  projectId: string;
  cwd: string;
  kind: TerminalKind;
  executable?: string;
  args?: string[];
  env?: Record<string, string>;
  harnessSessionId?: string;
  operationId?: string;
  title?: string;
}
export interface TerminalScreen {
  id: string;
  generation?: string;
  seq: number;
  cols: number;
  rows: number;
  content: string;
  truncated: boolean;
}
export interface TerminalOutput {
  id: string;
  generation?: string;
  seq: number;
  data: string;
  gap?: boolean;
}
export interface TerminalReplay {
  id: string;
  generation?: string;
  seq: number;
  events: TerminalOutput[];
  gap: boolean;
}
export interface TerminalResize {
  cols: number;
  rows: number;
  viewId: string;
  active: boolean;
}
export interface TerminalOptions {
  scrollback?: number;
  maxReplayBytes?: number;
}
export type TerminalRequest = { id: string; method: string; args?: unknown };
export type TerminalMessage =
  | { type: 'ready' }
  | { type: 'response'; id: string; result?: unknown; error?: { code: string; message: string; diagnosticId?: string } }
  | { type: 'change'; terminals: TerminalRecord[] }
  | { type: 'output'; output: TerminalOutput };
