import { it, expect } from 'vitest';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from './support/process';
import { diagnostics } from './support/vitest-diagnostics';
import { authenticatedCodexStateArguments } from './support/codex-client';

it('keeps authenticated-client launch state away from retained and orphan shell snapshots', async () => {
  const root = await mkdtemp(resolve('.tmp/codex-client-isolation-'));
  const home = join(root, 'home'), project = join(home, 'project');
  await mkdir(project, {recursive:true});
  const server = createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    const message = {id:'msg_local',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Acknowledged.',annotations:[]}]};
    const result = {id:'resp_local',object:'response',status:'completed',output:[message],usage:{input_tokens:1,output_tokens:1,total_tokens:2}};
    response.writeHead(200, {'content-type':'text/event-stream'});
    for (const event of [
      {type:'response.created',response:{...result,status:'in_progress',output:[]}},
      {type:'response.output_item.added',output_index:0,item:{...message,status:'in_progress',content:[]}},
      {type:'response.output_text.delta',item_id:message.id,output_index:0,content_index:0,delta:'Acknowledged.'},
      {type:'response.output_item.done',output_index:0,item:message},
      {type:'response.completed',response:result},
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  await new Promise<void>(done => server.listen(0,'127.0.0.1',done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing local provider');
  const overrides = {
    model_provider:'isolation_probe',model:'gpt-6.1-sol','features.plugins':false,'features.remote_plugin':false,
    'model_providers.isolation_probe.name':'Local isolation probe',
    'model_providers.isolation_probe.base_url':`http://127.0.0.1:${address.port}/v1`,
    'model_providers.isolation_probe.wire_api':'responses',
    'model_providers.isolation_probe.requires_openai_auth':false,
    'model_providers.isolation_probe.request_max_retries':0,
    'model_providers.isolation_probe.stream_max_retries':0,
    'model_providers.isolation_probe.stream_idle_timeout_ms':10000,
  };
  const run = async (stateArgs: string[]) => {
    const child = spawn('codex', ['exec',...stateArgs,'--ignore-user-config','--ignore-rules','--skip-git-repo-check','--sandbox','read-only','--json','-C',project,
      ...Object.entries(overrides).flatMap(([key,value]) => ['-c',`${key}=${JSON.stringify(value)}`]),
      'Return acknowledgement. Do not call tools or change files.'], {
      env:{PATH:process.env.PATH,HOME:home,CODEX_HOME:home,TMPDIR:'/private/tmp',LANG:'en_US.UTF-8',RUST_LOG:'warn'},stdio:['ignore','pipe','pipe'],
    });
    let stdout = '';
    child.stdout!.on('data',chunk => {stdout += String(chunk);});
    const code = await new Promise<number|null>((done,reject) => {child.once('error',reject);child.once('close',done);});
    expect(code).toBe(0);
    const events = stdout.trim().split('\n').map(line => JSON.parse(line) as {type:string;thread_id?:string;item?:{type:string;text?:string}});
    expect(events.some(event => event.item?.type === 'agent_message' && event.item.text === 'Acknowledged.')).toBe(true);
    return events.find(event => event.type === 'thread.started')!.thread_id!;
  };
  try {
    const id = await run([]); // Native Codex creates the valid rollout and DB.
    const snapshots = join(home,'shell_snapshots');
    await mkdir(snapshots,{recursive:true});
    const retained = join(snapshots,`${id}.123.sh`), orphan = join(snapshots,`${randomUUID()}.456.sh`);
    await writeFile(retained,'# Synthetic retained snapshot\n');
    await writeFile(orphan,'# Synthetic orphan snapshot\n');
    diagnostics().phase('unisolated-ephemeral');
    diagnostics().expect({role:'codex-cli',kind:'stderr',phase:'unisolated-ephemeral',message:/^\d{4}-\d{2}-\d{2}T[^ ]+\s+WARN codex_rollout::list: state db discrepancy during find_thread_path_by_id_str_in_subdir: falling_back$/,count:1});
    await run(['--ephemeral']);
    await expect(readFile(orphan)).rejects.toMatchObject({code:'ENOENT'});
    expect(await readFile(retained,'utf8')).toBe('# Synthetic retained snapshot\n');
    await writeFile(orphan,'# Synthetic orphan snapshot\n');
    diagnostics().phase('isolated-client');
    await run(authenticatedCodexStateArguments(root));
    expect(await readFile(retained,'utf8')).toBe('# Synthetic retained snapshot\n');
    expect(await readFile(orphan,'utf8')).toBe('# Synthetic orphan snapshot\n');
  } finally {
    diagnostics().phase('test');
    await new Promise<void>(done => server.close(() => done()));
    await rm(root,{recursive:true,force:true});
  }
}, 15000);
