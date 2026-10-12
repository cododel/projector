#!/usr/bin/env node
import process from 'node:process';
import console from 'node:console';
import { URL } from 'node:url';
import { setTimeout, setInterval, clearInterval } from 'node:timers';
import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { WebSocket, WebSocketServer } from 'ws';
const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
const cwd = process.env.CODEX_FIXTURE_PROJECT || process.cwd();
const id = process.env.CODEX_FIXTURE_ID || 'thread-exact-fixture';
let metadata = JSON.parse(process.env.CODEX_FIXTURE_SESSION_METADATA || '{}');
const thread = (threadId = id, path = cwd) => ({
  id: threadId,
  sessionId: 'root-exact-fixture',
  cwd: path,
  name: process.env.CODEX_FIXTURE_NAME ?? 'Exact fixture session',
  preview: process.env.CODEX_FIXTURE_PREVIEW ?? 'Preview',
  updatedAt: 1750000000,
  status: { type: 'notLoaded' },
  ephemeral: false,
  parentThreadId: process.env.CODEX_FIXTURE_PARENT_THREAD || null,
  archived: threadId === 'archived-exact-fixture',
  threadSource: 'user',
  ...metadata[threadId],
});
if (process.env.CODEX_FIXTURE_AUDIT)
  appendFileSync(process.env.CODEX_FIXTURE_AUDIT, JSON.stringify({ kind: 'spawn', args }) + '\n');
if (args.includes('--version')) {
  console.log('codex-cli ' + (process.env.CODEX_FIXTURE_VERSION || '0.162.1'));
  process.exit(0);
}
if (args.includes('--remote')) {
  const token = process.env[flag('--remote-auth-token-env')];
  const socket = new WebSocket(flag('--remote'), { headers: { Authorization: `Bearer ${token}` } });
  socket.on('open', () =>
    socket.send(
      JSON.stringify({
        id: 'initialize',
        method: 'initialize',
        params: { clientInfo: { name: 'fixture-tui', version: '1' } },
      }),
    ),
  );
  socket.on('message', (raw) => {
    const value = JSON.parse(raw);
    if (value.id === 'initialize') {
      socket.send(JSON.stringify({ method: 'initialized', params: {} }));
      // The control peer sees an unrelated ephemeral thread before the real request.
      socket.send(
        JSON.stringify({
          id: 'automatic-title',
          method: 'thread/start',
          params: { ephemeral: true, threadSource: 'thread_title', cwd },
        }),
      );
      socket.send(
        JSON.stringify({
          id: 'owned-start',
          method: args.includes('resume') ? 'thread/resume' : 'thread/start',
          params: args.includes('resume')
            ? { threadId: args[args.indexOf('resume') + 1], cwd }
            : { ephemeral: false, threadSource: 'user', cwd },
        }),
      );
    }
  });
  socket.on('error', () => process.exit(1));
  socket.on('close', () => process.exit(0));
  process.on('SIGTERM', () => {
    socket.terminate();
    process.exit(0);
  });
} else if (args.includes('app-server')) {
  if (process.env.CODEX_FIXTURE_DESCENDANT_AUDIT) {
    const worker = spawn(
      process.execPath,
      ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],
      { stdio: 'ignore' },
    );
    appendFileSync(process.env.CODEX_FIXTURE_DESCENDANT_AUDIT, String(worker.pid) + '\n');
  }
  const dispatch = (value, send) => {
    if (process.env.CODEX_FIXTURE_AUDIT)
      appendFileSync(
        process.env.CODEX_FIXTURE_AUDIT,
        JSON.stringify({ kind: 'request', method: value.method, params: value.params }) + '\n',
      );
    let result;
    switch (value.method) {
      case 'fixture/mcp-status':
        // Emit on the app-server side of the real gateway. Downstream client
        // assertions cannot manufacture a trusted upstream observation.
        send({ method: 'mcpServer/startupStatus/updated', params: value.params });
        result = {};
        break;
      case 'initialize':
        result = {
          userAgent: 'fixture',
          codexHome: process.env.CODEX_HOME || cwd,
          platformFamily: 'unix',
          platformOs: 'macos',
        };
        break;
      case 'initialized':
        return;
      case 'thread/list':
        if (process.env.CODEX_FIXTURE_METADATA_FILE)
          metadata = JSON.parse(readFileSync(process.env.CODEX_FIXTURE_METADATA_FILE, 'utf8'));
        if (process.env.CODEX_FIXTURE_EMPTY === '1') {
          result = { data: [], nextCursor: null };
          break;
        }
        result = value.params?.archived
          ? { data: [thread('archived-exact-fixture')], nextCursor: null }
          : value.params?.cursor
            ? {
                data: [
                  thread(
                    'other-worktree',
                    process.env.CODEX_FIXTURE_OTHER_PROJECT || cwd + '/other',
                  ),
                ],
                nextCursor: null,
              }
            : {
                data: [thread(id), { ...thread('temporary-title'), ephemeral: true }].filter(
                  (entry) => !entry.archived,
                ),
                nextCursor: 'page-two',
              };
        if (!value.params?.cursor)
          result.data.push(
            ...Object.entries(metadata)
              .filter(
                ([key, entry]) =>
                  !result.data.some((entry) => entry.id === key) &&
                  (key !== 'other-worktree' || value.params?.archived) &&
                  Boolean(entry.archived) === Boolean(value.params?.archived),
              )
              .map(([key]) =>
                thread(
                  key,
                  key === 'other-worktree' ? process.env.CODEX_FIXTURE_OTHER_PROJECT || cwd : cwd,
                ),
              ),
          );
        result.data = result.data.filter(
          (entry) => Boolean(entry.archived) === Boolean(value.params?.archived),
        );
        break;
      case 'thread/archive':
      case 'thread/unarchive': {
        const key = value.params.threadId;
        if (process.env.CODEX_FIXTURE_ARCHIVE_FAILURE === 'before') {
          send({ id: value.id, error: { code: -32603, message: 'Archive refused' } });
          return;
        }
        metadata[key] = { ...metadata[key], archived: value.method === 'thread/archive' };
        if (process.env.CODEX_FIXTURE_METADATA_FILE) {
          const path = process.env.CODEX_FIXTURE_METADATA_FILE;
          writeFileSync(path + '.tmp', JSON.stringify(metadata));
          renameSync(path + '.tmp', path);
        }
        if (process.env.CODEX_FIXTURE_ARCHIVE_FAILURE === 'after') {
          send({ id: value.id, error: { code: -32603, message: 'Acknowledgement lost' } });
          return;
        }
        result =
          value.method === 'thread/archive'
            ? {}
            : {
                thread: thread(
                  process.env.CODEX_FIXTURE_WRONG_UNARCHIVE === '1' ? 'wrong-id' : key,
                ),
              };
        break;
      }
      case 'thread/read':
        if (process.env.CODEX_FIXTURE_ACTIVE_WRITER === value.params.threadId) {
          send({ id: value.id, error: { code: -32600, message: `thread ${value.params.threadId} already has an active writer` } });
          return;
        }
        result = {
          thread: thread(
            process.env.CODEX_FIXTURE_WRONG_READ === '1' ? 'wrong-id' : value.params.threadId,
          ),
        };
        break;
      case 'thread/start':
        if (value.params.ephemeral) {
          result = {
            thread: { ...thread('automatic-title'), ephemeral: true, threadSource: 'thread_title' },
          };
          break;
        }
        // A wrong broadcast cannot bind a UI session: only request/response correlation may do that.
        send({
          method: 'thread/started',
          params: { thread: thread('unrelated-background-thread') },
        });
        result = { thread: { ...thread(id), status: { type: 'idle' } } };
        break;
      case 'thread/resume':
        result = {
          thread: {
            ...thread(
              process.env.CODEX_FIXTURE_WRONG_RESUME === '1'
                ? 'wrong-resume-id'
                : value.params.threadId,
            ),
            status: { type: 'idle' },
          },
        };
        break;
      default:
        send({ id: value.id, error: { code: -32601, message: 'Unsupported fixture method' } });
        return;
    }
    if (
      value.method === 'thread/list' &&
      value.params?.archived &&
      process.env.CODEX_FIXTURE_LIST_GATE
    ) {
      const gate = process.env.CODEX_FIXTURE_LIST_GATE;
      writeFileSync(gate + '.waiting', 'waiting');
      const timer = setInterval(() => {
        let released = false;
        try {
          released = readFileSync(gate, 'utf8') === 'release';
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        if (!released) return;
        clearInterval(timer);
        send({ id: value.id, result });
      }, 10);
      return;
    }
    send({ id: value.id, result });
    if (
      process.env.CODEX_FIXTURE_MCP_STARTUP_STATUS &&
      ['thread/start', 'thread/resume'].includes(value.method) &&
      result.thread &&
      !result.thread.ephemeral
    )
      send({
        method: 'mcpServer/startupStatus/updated',
        params: {
          name: 'projector',
          status: process.env.CODEX_FIXTURE_MCP_STARTUP_STATUS,
          threadId: result.thread.id,
          ...(process.env.CODEX_FIXTURE_MCP_STARTUP_ERROR
            ? { error: process.env.CODEX_FIXTURE_MCP_STARTUP_ERROR }
            : {}),
        },
      });
  };
  if (flag('--listen') === 'stdio://') {
    const lines = createInterface({ input: process.stdin });
    lines.on('line', (line) =>
      dispatch(JSON.parse(line), (value) => {
        const output = Buffer.from(JSON.stringify(value) + '\n');
        const separator = output.indexOf(Buffer.from('\u2028'));
        if (process.env.CODEX_FIXTURE_FRAGMENT_STDIO === '1' && separator !== -1) {
          // Split inside the UTF-8 code point, rather than on a character boundary.
          process.stdout.write(output.subarray(0, separator + 1));
          setTimeout(() => process.stdout.write(output.subarray(separator + 1)), 5);
        } else process.stdout.write(output);
      }),
    );
  } else {
    const listener = new URL(flag('--listen'));
    const server = createServer();
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
      const token = (request.headers.authorization || '').replace(/^Bearer /, '');
      if (createHash('sha256').update(token).digest('hex') !== flag('--ws-token-sha256')) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
    });
    wss.on('connection', (socket) =>
      socket.on('message', (raw) =>
        dispatch(JSON.parse(raw), (value) => socket.send(JSON.stringify(value))),
      ),
    );
    setTimeout(
      () => server.listen(Number(listener.port), listener.hostname),
      Number(process.env.CODEX_FIXTURE_BACKEND_DELAY || 0),
    );
    process.on('SIGTERM', () => {
      for (const socket of wss.clients) socket.terminate();
      server.close(() => process.exit(0));
    });
  }
} else {
  console.error('Unsupported fixture CLI invocation');
  process.exit(1);
}
