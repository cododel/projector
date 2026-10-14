import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { catalog } from '../dev/catalog';
import { coverageTotals, resolveCatalog, validateCatalog } from '../dev/catalog-coverage';
import { readStoryBindings, sourceFiles } from '../dev/catalog-source';

test('inventory names nested screens, document controls and non-React native surfaces', async () => {
  for (const id of ['project-tree','feedback','save-approval','document-widget','browser-overlay','application-menu','mcp-connection']) expect(catalog.some(entry => entry.id === id)).toBe(true);
  const sources = new Set(catalog.flatMap(entry => entry.sources));
  for (const source of sources) await access(source);
  for (const entry of catalog) for (const criterion of entry.nativeEvidence ?? []) for (const check of criterion.checks) await access(check);
  for (const path of (await sourceFiles('src/renderer')).filter(path => path.endsWith('.tsx'))) expect(sources.has(path.replaceAll('\\','/'))).toBe(true);
  expect(validateCatalog(catalog, [])).toEqual([]);
});
test('the reviewed inventory cannot silently lose required entities, states or transitions', async () => {
  const required: { id: string; states: string[]; transitions: string[] }[] = JSON.parse(await readFile('dev/catalog-required.json','utf8'));
  for (const row of required) {
    const entry = catalog.find(item => item.id === row.id);
    expect(entry, row.id).toBeDefined();
    expect(entry!.states.map(state => state.id)).toEqual(expect.arrayContaining(row.states));
    expect(entry!.transitions.map(transition => transition.id)).toEqual(expect.arrayContaining(row.transitions));
  }
});
test('coverage retains missing states and requires real play metadata for transitions', () => {
  const entries = resolveCatalog([]), before = coverageTotals(entries);
  expect(before.states.covered).toBe(0);
  expect(before.states.total).toBeGreaterThan(0);
  const duplicate = structuredClone(catalog); duplicate[0].states.push(duplicate[0].states[0]);
  expect(validateCatalog(duplicate, [])).toContain('Duplicate catalog ID: state:notification-stack.empty');
  const invalid = structuredClone(catalog); invalid[0].transitions[0].toState = 'absent';
  expect(validateCatalog(invalid, [])).toContain('Invalid endpoints: notification-stack.dismiss');
  expect(validateCatalog(catalog, [{id:'fake',title:'fake',name:'fake',states:['absent'],transitions:['notification-stack.dismiss'],interaction:false,sheet:false}],new Set())).toEqual(expect.arrayContaining(['Unregistered story: fake','Unknown state: absent','Transition lacks play: notification-stack.dismiss']));
});
test('every declared story state and transition belongs to the independent inventory', async () => {
  const bindings = await readStoryBindings(resolve('.'));
  expect(bindings.length).toBeGreaterThan(0);
  expect(validateCatalog(catalog,bindings)).toEqual([]);
});

test('an explicitly undefined play is not interaction evidence', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(),'projector-catalog-parser-'));
  try {
    await mkdir(join(root,'dev/stories'),{recursive:true});
    await writeFile(join(root,'dev/stories/Probe.stories.tsx'),"const meta = {title:'Probe'}; export default meta; export const Missing = {play:undefined,parameters:{catalog:{transitions:['notification-stack.dismiss']}}};");
    const bindings = await readStoryBindings(root);
    expect(bindings[0].interaction).toBe(false);
    expect(validateCatalog(catalog,bindings)).toContain('Transition lacks play: notification-stack.dismiss');
  } finally { await rm(root,{recursive:true,force:true}); }
});
