import metadata from '../../package.json';
export const VERSION = metadata.version;
export interface McpSetup {
  mode: 'development' | 'production-preview' | 'packaged';
  executable: string;
  args: string[];
  env: { PROJECTOR_RUNTIME_DESCRIPTOR: string };
  descriptorPath: string;
  command: string;
  config: string;
  prompt: string;
}
export class ProjectorError extends Error {
  constructor(
    public code: string,
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
export interface RpcRequest {
  id: string;
  method: string;
  params?: unknown;
  token?: string;
}
export interface RpcResponse {
  id: string;
  result?: unknown;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}
