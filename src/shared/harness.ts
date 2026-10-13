export type HarnessSessionStatus = 'unknown' | 'idle' | 'active' | 'error';
export interface HarnessSession {
  /** Exact Codex thread.id; never inferred from a filename or PID. */
  id: string;
  harness: 'codex';
  /** Codex session-tree root, which can differ from a fork's thread.id. */
  rootSessionId?: string;
  projectId: string | null;
  cwd: string;
  /** Verified linked Git worktree working directory; transient catalog metadata. */
  worktreePath?: string;
  title: string;
  /** Seconds since epoch, as returned by the Codex protocol. */
  updatedAt: number;
  archived?: boolean;
  /** Protocol classification; hidden from the shared session catalog, not deleted. */
  isSubAgent?: boolean;
  status: HarnessSessionStatus;
  processState: 'unknown' | 'running' | 'stopped';
  terminalId?: string;
  launchId?: string;
}
export interface CodexCompatibility {
  executable: string;
  version: string | null;
  qualified: boolean;
  error?: string;
}
export interface HarnessSnapshot {
  sessions: HarnessSession[];
  compatibility: CodexCompatibility | null;
  error: string | null;
  mcpStartup: HarnessMcpStartup[];
}
/** Observed startup of Projector MCP in one app-owned Codex backend.
 * `ready` records a startup notification, not continuous transport health.
 */
export interface HarnessMcpStartup {
  launchId: string;
  projectId: string;
  sessionId?: string;
  terminalId?: string;
  status: 'unknown' | 'starting' | 'ready' | 'failed' | 'cancelled' | 'stopped';
  /** Time of the protocol notification or owned gateway stop. */
  observedAt?: string;
  error?: string;
  failureReason?: 'reauthenticationRequired';
}
export interface HarnessProject {
  id: string;
  path: string;
}
export interface CodexLaunch {
  launchId: string;
  executable: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}
