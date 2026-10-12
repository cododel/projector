import { expect } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
export class Mcp {
  child: ChildProcessWithoutNullStreams;
  pending = new Map<number, (value: Record<string, unknown>) => void>();
  next = 0;
  constructor(socket: string) {
    this.child = spawn(process.execPath, [resolve('out/bridge.cjs')], {
      env: { ...process.env, PROJECTOR_RUNTIME_DESCRIPTOR: socket },
    });
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (typeof value.id === 'number') {
        this.pending.get(value.id)?.(value);
        this.pending.delete(value.id);
      }
    });
    this.child.stderr.on('data', (chunk) => console.error(String(chunk)));
  }
  request(method: string, params: unknown): Promise<Record<string, unknown>> {
    const id = ++this.next;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async initialize() {
    const result = await this.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'alpha-e2e', version: '1' },
    });
    expect(result.result).toMatchObject({
      instructions: expect.stringContaining('approval does not authorize implementation'),
    });
    this.child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
    );
  }
  async tool(name: string, args: unknown): Promise<Record<string, unknown>> {
    const response = await this.request('tools/call', { name, arguments: args });
    const result = response.result as { content: { text: string }[]; isError?: boolean };
    if (result.isError) throw new Error(result.content[0].text);
    return JSON.parse(result.content[0].text) as Record<string, unknown>;
  }
  close() {
    this.child.stdin.end();
  }
}
