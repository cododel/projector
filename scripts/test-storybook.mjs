import { setTimeout, clearTimeout } from 'node:timers';
import { spawn } from 'node:child_process';
const run = args => new Promise((resolve,reject) => { const child = spawn('pnpm',args,{stdio:'inherit'}); child.on('error',reject); child.on('exit',code => code === 0 ? resolve() : reject(new Error(`pnpm ${args.join(' ')} failed (${code})`))); });
await run(['build:storybook']);
const server = spawn(process.execPath,['scripts/serve-catalog.mjs','6007'],{stdio:['ignore','pipe','inherit']});
let serverError;
server.on('error',error => { serverError = error; });
const closed = new Promise(resolve => server.once('exit',code => { serverError ??= new Error(`Static catalog server exited (${code})`); resolve(); }));
try {
  await new Promise((resolve,reject) => {
    const timer = setTimeout(() => reject(new Error('Static catalog server did not become ready')),10000);
    server.once('error',error => { clearTimeout(timer); reject(error); });
    server.once('exit',code => { clearTimeout(timer); reject(new Error(`Static catalog server exited before readiness (${code})`)); });
    server.stdout.on('data',chunk => {
      process.stdout.write(chunk);
      if (chunk.toString().includes('Static catalog:')) { clearTimeout(timer); resolve(); }
    });
  });
  if (serverError) throw serverError;
  await run(['exec','vitest','run','--config','vitest.storybook.config.ts',...process.argv.slice(2)]);
} finally { if (server.exitCode === null) server.kill('SIGTERM'); await closed; }
