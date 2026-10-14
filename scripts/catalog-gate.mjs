import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { readStoryBindings, catalogFingerprint } from '../dev/catalog-source.ts';
import { resolveCatalog, validateCatalog, coverageTotals, visualBaselineName } from '../dev/catalog-coverage.ts';

const root = resolve('.'), output = resolve('.tmp/catalog');
await mkdir(output, { recursive: true });
const bindings = await readStoryBindings(root), entries = resolveCatalog(bindings);
const errors = validateCatalog(entries,bindings);
const reviews = JSON.parse(await readFile(resolve('dev/visual/baseline-reviews.json'),'utf8'));
for (const binding of bindings.filter(binding => binding.sheet)) {
  const filename = `${visualBaselineName(binding.id)}-${process.platform}.png`;
  try {
    const checksum = createHash('sha256').update(await readFile(resolve('dev/visual/baselines',filename))).digest('hex');
    if (reviews[filename]?.sha256 !== checksum || !reviews[filename]?.reviewedAt || !reviews[filename]?.reviewer) errors.push(`Unreviewed or changed visual baseline: ${filename}`);
  } catch { errors.push(`Missing visual baseline: ${filename}`); }
}
for (const entry of entries.filter(entry => entry.boundary === 'browser')) {
  for (const state of entry.states) if (!state.stories.length) errors.push(`Missing state: ${state.id}`);
  for (const transition of entry.transitions) if (!transition.stories.length) errors.push(`Missing interaction: ${transition.id}`);
}
const fingerprint = await catalogFingerprint(root);
await writeFile(`${output}/inventory.json`,JSON.stringify({ fingerprint,totals:coverageTotals(entries),entries,bindings,errors },null,2)+'\n');
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else {
  const run = async (args) => {
    console.log(`pnpm ${args.join(' ')}`);
    const code = await new Promise((resolveCode,reject) => { const child = spawn('pnpm',args,{cwd:root,stdio:'inherit'});child.on('error',reject);child.on('exit',resolveCode); });
    if (code !== 0) throw new Error(`Failed pnpm ${args.join(' ')} (${code})`);
  };
  const evidence = { fingerprint, generatedAt:new Date().toISOString(), sourceCurrent:true, stories:{}, visual:[], fullGate:'not-run' };
  // A failed new attempt replaces old green evidence, rather than leaving it reusable.
  await writeFile(`${output}/evidence.json`,JSON.stringify(evidence,null,2)+'\n');
  try {
    await run(['exec','vitest','run','tests/catalog.test.ts']);
    await run(['test:storybook','--reporter=default','--reporter=json','--reporter=./scripts/catalog-reporter.mjs',`--outputFile=${output}/stories.json`]);
    await run(['test:storybook:visual']);
    const result = JSON.parse(await readFile(`${output}/stories.json`,'utf8'));
    if (!result.success || result.numFailedTests || result.numPendingTests) throw new Error('Incomplete browser execution report.');
    const motion = JSON.parse(await readFile(`${output}/motion.json`,'utf8'));
    if (motion.errors.length || motion.reason !== 'passed') throw new Error('Incomplete motion execution report.');
    for (const binding of bindings) {
      const assertions = result.testResults.filter(suite => suite.name.replaceAll('\\','/').endsWith(binding.file)).flatMap(suite => suite.assertionResults ?? []);
      const matching = assertions.filter(assertion => assertion.status === 'passed' && assertion.title === binding.name);
      if (matching.length !== 2) throw new Error(`Story did not pass both motion projects: ${binding.id} (${matching.length})`);
      for (const project of ['catalog-no-preference-chromium','catalog-reduce-chromium']) {
        const exact = motion.tests.filter(test => test.file.replaceAll('\\','/').endsWith(binding.file) && test.name === binding.name && test.project === project && test.state === 'passed');
        if (exact.length !== 1) throw new Error(`Missing exact project execution: ${binding.id} / ${project}`);
      }
      evidence.stories[binding.id] = {normal:true,reduced:true};
    }
    evidence.visual = bindings.filter(binding => binding.sheet).map(binding => binding.id);
    if (await catalogFingerprint(root) !== fingerprint) throw new Error('Source changed during the catalog gate; evidence is invalid.');
    await writeFile(`${output}/evidence.json`,JSON.stringify(evidence,null,2)+'\n');
    await writeFile(resolve('.tmp/storybook-static/catalog-evidence.json'),JSON.stringify(evidence,null,2)+'\n');
    console.log(JSON.stringify({status:'passed',totals:coverageTotals(entries)},null,2));
  } catch(error) { console.error(error);process.exitCode=1; }
}
