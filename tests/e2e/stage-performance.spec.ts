import { test, expect, electron } from './test';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { execFile } from '../support/process';
import { promisify } from 'node:util';
import { platform, release, totalmem, cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { Mcp } from './mcp';

const exec = promisify(execFile);
const p95 = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];

// Standalone, explicitly selected by scripts/testing/stage-performance.mjs.
// UI operations cross the production preload/runtime boundary and use real writes.
test('qualifies the current-stage dataset at production boundaries', async () => {
  const root = process.env.PROJECTOR_PERFORMANCE_ROOT;
  const reportPath = process.env.PROJECTOR_PERFORMANCE_REPORT;
  if (!root || !reportPath)
    throw Error('Run pnpm test:performance; this qualification needs its isolated dataset');
  const fixture = JSON.parse(await readFile(join(root, 'fixture.json'), 'utf8')) as {
    artifacts: { id: string; revisionId: string; title: string }[];
    projectId: string;
  };
  const diagnostic = process.env.PROJECTOR_PERFORMANCE_DIAGNOSE_TABS === '1';
  const socket = join(root, 'service.sock');
  const app = await electron.launch({
    args: [resolve('.')],
    env: {
      ...process.env,
      PROJECTOR_DATA: join(root, 'data'),
      PROJECTOR_RUNTIME_DESCRIPTOR: socket,
    },
  });
  let mcp: Mcp | undefined;
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(
      `<!doctype html><title>Performance browser ${req.url}</title><style>body{height:4000px}header{position:sticky;top:0;background:#eef}</style><header>Browser fixture</header><table>${Array.from({ length: 100 }, (_, i) => `<tr><td>Row ${i}</td></tr>`).join('')}</table>`,
    );
  });
  const report: Record<string, unknown> = {
    createdAt: new Date().toISOString(),
    build: Object.fromEntries(
      await Promise.all(
        [
          'out/main/index.js',
          'out/runtime/service.cjs',
          'out/runtime/compiler.cjs',
          'out/renderer/index.html',
          'out/bridge.cjs',
        ].map(async (file) => [
          file,
          createHash('sha256')
            .update(await readFile(resolve(file)))
            .digest('hex'),
        ]),
      ),
    ),
    environment: {
      platform: platform(),
      release: release(),
      ramBytes: totalmem(),
      cpu: cpus()[0].model,
      cpuCount: cpus().length,
      electron: await app.evaluate(() => process.versions.electron),
      node: process.version,
    },
    dataset: {
      artifacts: 50,
      revisionsPerArtifact: 10,
      statesPerArtifact: 10,
      widgetsPerRevision: 20,
      annotationsPerLatestState: 20,
      browserTabs: 3,
    },
    qualification: !diagnostic,
    mode: 'production build, hidden window, isolated data; no 16 GB or native compositor claim',
  };
  const sampleTree = async () => {
    const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,%cpu=,rss=,time=']);
    const rows = stdout
      .trim()
      .split('\n')
      .map((line) => {
        const fields = line.trim().split(/\s+/);
        const [pid, ppid, cpu, rss] = fields.slice(0, 4).map(Number);
        const cpuSeconds = fields[4]
          .split(':')
          .map(Number)
          .reduce((total, part) => total * 60 + part, 0);
        return { pid, ppid, cpu, rss, cpuSeconds };
      });
    const ids = new Set([app.process().pid!, mcp!.child.pid!]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows)
        if (ids.has(row.ppid) && !ids.has(row.pid)) {
          ids.add(row.pid);
          changed = true;
        }
    }
    const tree = rows.filter((row) => ids.has(row.pid));
    return {
      rssBytes: tree.reduce((sum, row) => sum + row.rss * 1024, 0),
      cpuLifetimePercent: tree.reduce((sum, row) => sum + row.cpu, 0),
      processes: tree,
    };
  };
  const samplePhase = async () => {
    const samples = [];
    let previous = await sampleTree();
    let previousTime = performance.now();
    for (let i = 0; i < 10; i++) {
      await new Promise((done) => setTimeout(done, 250));
      const current = await sampleTree();
      const now = performance.now();
      const old = new Map(previous.processes.map((row) => [row.pid, row.cpuSeconds]));
      const cpuDelta = current.processes.reduce(
        (sum, row) => sum + Math.max(0, row.cpuSeconds - (old.get(row.pid) ?? row.cpuSeconds)),
        0,
      );
      samples.push({ ...current, intervalCpuPercent: (cpuDelta * 100000) / (now - previousTime) });
      previous = current;
      previousTime = now;
    }
    return {
      samples,
      maxRssBytes: Math.max(...samples.map((s) => s.rssBytes)),
      meanIntervalCpuPercent:
        samples.reduce((sum, item) => sum + item.intervalCpuPercent, 0) / samples.length,
      cpuMeaning:
        'CPU time deltas over 250 ms intervals, summed over owned tree; 100% equals one fully occupied core. ps lifetime average retained separately. RSS sum includes shared pages and is not private physical memory.',
    };
  };
  try {
    const page = await app.firstWindow();
    await expect(
      page.getByRole('button', { name: fixture.artifacts[0].title, exact: true }),
    ).toBeVisible();
    mcp = new Mcp(socket);
    await mcp.initialize();
    const opened: number[] = [],
      acknowledgements: number[] = [],
      tabs: number[] = [];
    const open = async (index: number) => {
      const artifact = fixture.artifacts[index];
      const start = performance.now();
      await page.getByRole('button', { name: artifact.title, exact: true }).click();
      await expect(
        page.frameLocator('iframe').getByLabel('Decision 0', { exact: true }),
      ).toHaveValue(`Plan ${index} decision 0`);
      await expect(page.locator('.annotation')).toHaveCount(20);
      return performance.now() - start;
    };
    if (!diagnostic) {
      // Warm every artifact through the UI before sampling cached opens.
      for (let i = 0; i < 50; i++) await open(i);
      for (let i = 0; i < 100; i++) opened.push(await open((i * 7) % 50));
      report.cachedDocumentOpen = { samples: opened, p95Ms: p95(opened), budgetMs: 2000 };
      await writeFile(reportPath, JSON.stringify(report, null, 2));
      await open(0);
      report.idle = await samplePhase();
      for (let i = 0; i < 105; i++) {
        const value = `Confirmed private performance answer ${i}`;
        const start = performance.now();
        await page.frameLocator('iframe').getByLabel('Decision 0', { exact: true }).fill(value);
        // Filesystem state plus the displayed ack, not optimistic widget state, is the oracle.
        await expect
          .poll(
            async () => {
              const state = JSON.parse(
                await readFile(
                  join(
                    root,
                    'data',
                    'states',
                    fixture.artifacts[0].id,
                    fixture.artifacts[0].revisionId + '.json',
                  ),
                  'utf8',
                ),
              ) as { values: Record<string, string> };
              return state.values.answer0;
            },
            { intervals: [5, 10, 20] },
          )
          .toBe(value);
        await expect(page.locator('.document-save-status')).toHaveText('Saved locally');
        if (i >= 5) acknowledgements.push(performance.now() - start);
      }
      const privateDraft = JSON.parse(
        await readFile(
          join(root, 'data', 'artifact-drafts', fixture.artifacts[0].id + '.json'),
          'utf8',
        ),
      ) as { annotations: { id: string }[] };
      expect(privateDraft.annotations).toHaveLength(20);
      expect(new Set(privateDraft.annotations.map((a) => a.id)).size).toBe(20);
      report.autosaveAcknowledgement = {
        samples: acknowledgements,
        p95Ms: p95(acknowledgements),
        budgetMs: 1000,
      };
      await writeFile(reportPath, JSON.stringify(report, null, 2));
    } else {
      await open(0);
      report.idle = await samplePhase();
    }
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('No fixture port');
    for (let i = 0; i < 3; i++)
      await mcp.tool('show_content', {
        artifactId: fixture.artifacts[0].id,
        url: `http://127.0.0.1:${address.port}/tab-${i}`,
      });
    await app.evaluate(() => {
      const { Socket } = process.getBuiltinModule('net');
      const original = Socket.prototype.write;
      const observed = new WeakSet<InstanceType<typeof Socket>>();
      const requests = new Map<string, { name: string; start: number }>();
      const results: { name: string; elapsedMs: number }[] = [];
      Object.assign(globalThis, { performanceRpc: results });
      Socket.prototype.write = function (
        chunk: string | Uint8Array,
        encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
        callback?: (error?: Error | null) => void,
      ) {
        if (typeof chunk === 'string') {
          try {
            const request = JSON.parse(chunk) as {
              id?: string;
              method?: string;
              params?: { name?: string };
            };
            if (request.id && request.method === 'operator' && request.params?.name) {
              requests.set(request.id, { name: request.params.name, start: performance.now() });
              if (!observed.has(this)) {
                observed.add(this);
                let buffer = '';
                this.on('data', (data: Buffer) => {
                  const lines = (buffer + data.toString()).split('\n');
                  buffer = lines.pop()!;
                  for (const line of lines) {
                    if (!line) continue;
                    const response = JSON.parse(line) as { id?: string };
                    const pending = response.id ? requests.get(response.id) : undefined;
                    if (pending) {
                      results.push({
                        name: pending.name,
                        elapsedMs: performance.now() - pending.start,
                      });
                      requests.delete(response.id!);
                    }
                  }
                });
              }
            }
          } catch {
            /* Other writes are unrelated to runtime JSON RPC. */
          }
        }
        return Reflect.apply(original, this, [chunk, encodingOrCallback, callback]);
      };
    });
    await expect(page.getByRole('tab')).toHaveCount(4);
    await expect
      .poll(
        () =>
          app
            .context()
            .pages()
            .filter((p) => p.url().startsWith(`http://127.0.0.1:${address.port}`)).length,
      )
      .toBe(3);
    for (let i = 0; i < (diagnostic ? 25 : 105); i++) {
      const tab = page.getByRole('tab').nth(1 + (i % 3));
      await expect(tab).toBeEnabled();
      // Start at the DOM action, excluding Playwright selector/actionability latency.
      // The production click handler and its IPC/snapshot work remain unchanged.
      const elapsed = await tab.evaluate(
        (element) =>
          new Promise<number>((done, reject) => {
            const start = performance.now();
            const timer = setTimeout(() => {
              observer.disconnect();
              reject(Error('Tab activation timed out'));
            }, 10000);
            const finish = () => {
              if (element.getAttribute('aria-selected') !== 'true') return;
              clearTimeout(timer);
              observer.disconnect();
              done(performance.now() - start);
            };
            const observer = new MutationObserver(finish);
            observer.observe(element, { attributes: true, attributeFilter: ['aria-selected'] });
            (element as HTMLButtonElement).click();
            finish();
          }),
      );
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      if (i >= 5) tabs.push(elapsed);
    }
    report.browser = await samplePhase();
    report.tabRpcWaterfall = await app.evaluate(
      () =>
        (globalThis as unknown as { performanceRpc: { name: string; elapsedMs: number }[] })
          .performanceRpc,
    );
    report.metrics = {
      cachedDocumentOpen: { samples: opened, p95Ms: p95(opened), budgetMs: 2000 },
      autosaveAcknowledgement: {
        samples: acknowledgements,
        p95Ms: p95(acknowledgements),
        budgetMs: 1000,
      },
      shellTabResponse: { samples: tabs, p95Ms: p95(tabs), budgetMs: 300 },
    };
    // Private measurements must not publish the changed answer to MCP.
    const state = await mcp.tool('read_artifact', {
      artifactId: fixture.artifacts[0].id,
      part: 'state',
    });
    expect(JSON.stringify(state.content)).not.toContain('Confirmed private performance answer');
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    if (!diagnostic) {
      expect(p95(opened), 'cached document open p95').toBeLessThanOrEqual(2000);
      expect(p95(acknowledgements), 'confirmed autosave p95').toBeLessThanOrEqual(1000);
    }
    expect(p95(tabs), 'shell tab response p95').toBeLessThanOrEqual(300);
  } catch (error) {
    report.error = String(error);
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    throw error;
  } finally {
    mcp?.close();
    await app.close();
    if (server.listening) await new Promise<void>((done) => server.close(() => done()));
  }
});
