import React, { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { resolveCatalog, coverageTotals, visualBaselineName, type CoverageEvidence } from '../catalog-coverage';
import { storyBindings } from '../story-bindings';
import type { CatalogEntry } from '../catalog';

const baselineFiles = import.meta.glob('../visual/baselines/*.png', { query: '?url', import: 'default', eager: true });

function CoverageMap() {
  const [kind, setKind] = useState('all'), [missing, setMissing] = useState(false), [search, setSearch] = useState('');
  const [evidence, setEvidence] = useState<CoverageEvidence | null>(null);
  useEffect(() => { let active = true; void fetch('/catalog-evidence.json').then(response => response.ok ? response.json() : null).then(value => { if (active) setEvidence(value?.sourceCurrent ? value : null); }).catch(() => {}); return () => { active = false; }; }, []);
  const entries = resolveCatalog(storyBindings), totals = coverageTotals(entries);
  const visible = entries.filter(entry => (kind === 'all' || entry.kind === kind) && entry.name.toLowerCase().includes(search.toLowerCase()) && (!missing || (entry.boundary === 'electron' ? entry.nativeEvidence?.some(item => item.status !== 'confirmed') : entry.states.some(state => !state.stories.length) || entry.transitions.some(transition => !transition.stories.length))));
  const links = (ids: string[]) => <span className="catalog-state-links">{ids.length ? ids.map(id => <a key={id} href={`./?path=/story/${id}`} target="_top">{storyBindings.find(story => story.id === id)?.name ?? id}</a>) : <span className="catalog-missing">Missing</span>}</span>;
  const table = (entry: CatalogEntry) => <details key={entry.id} className="catalog-entry" open={missing}>
    <summary><strong>{entry.name}</strong> · {entry.kind} · {entry.boundary === 'electron' ? `${entry.states.length} native states · ${entry.transitions.length} native transitions` : `${entry.states.filter(state => state.stories.length).length}/${entry.states.length} states · ${entry.transitions.filter(transition => transition.stories.length).length}/${entry.transitions.length} transitions`}</summary>
    <p>{entry.sources.map(source => <code key={source}>{source} </code>)} · {entry.boundary}</p>
    {entry.boundary === 'electron' ? <><p>Native surface. Browser stories do not qualify OS behavior.</p>{entry.nativeEvidence?.map(item => <p key={item.criterion}>{item.criterion}: <strong>{item.status}</strong> · {item.checks.join(', ') || 'No linked check'} · {item.checkNames?.join('; ')} · {item.evidence.join(', ') || 'No current execution evidence'}</p>)}
      {evidence?.nativeChecks?.[entry.id]?.length ? <p>Linked controlled Electron checks: {evidence.nativeChecks[entry.id].filter(check => check.passed).length}/{evidence.nativeChecks[entry.id].length} executed successfully. <a href="/catalog-check.log">Exact check log</a>. These results do not confirm the manual criteria above.</p> : null}
      <table className="catalog-table"><caption>{entry.name} native states and transitions</caption><thead><tr><th scope="col">ID</th><th scope="col">Condition or trigger</th><th scope="col">Boundary</th></tr></thead><tbody>
        {entry.states.map(state => <tr key={`state:${state.id}`}><th scope="row">{state.id}</th><td>{state.when}</td><td>Electron · qualification recorded above</td></tr>)}
        {entry.transitions.map(transition => <tr key={`transition:${transition.id}`}><th scope="row">{transition.id}</th><td>{transition.fromState} → {transition.toState} · {transition.trigger}</td><td>Electron · browser coverage excluded</td></tr>)}
      </tbody></table>
    </> : <>
      <table className="catalog-table"><caption>{entry.name} states</caption><thead><tr><th scope="col">State / condition</th><th scope="col">Story</th><th scope="col">Protection</th></tr></thead><tbody>{entry.states.map(state => <tr key={state.id}><th scope="row">{state.name}<small>{state.when}</small></th><td>{links(state.stories)}</td><td>{state.stories.some(id => storyBindings.find(story => story.id === id)?.interaction) ? 'Play present' : 'No play'} · {state.stories.some(id => evidence?.stories[id]?.normal && evidence.stories[id]?.reduced) ? 'Last report: passed both motion modes' : 'Execution unverified'}</td></tr>)}</tbody></table>
      <table className="catalog-table"><caption>{entry.name} transitions</caption><thead><tr><th scope="col">Transition</th><th scope="col">From → to / trigger</th><th scope="col">Interaction story</th></tr></thead><tbody>{entry.transitions.map(transition => <tr key={transition.id}><th scope="row">{transition.id}</th><td>{transition.fromState} → {transition.toState} · {transition.trigger}</td><td>{links(transition.stories)}</td></tr>)}</tbody></table>
    </>}
  </details>;
  return <main className="catalog-page"><span hidden data-catalog-bindings={JSON.stringify(storyBindings)} /><h1>Projector interface catalog</h1><p>Real production components, reachable states and meaningful transitions. Native evidence is tracked separately; a story or play function alone is not a passed check.</p>
    <div className="catalog-stats">{(['components','screens','states','transitions'] as const).map(key => <span key={key}>{totals[key].covered}/{totals[key].total} {key}</span>)}<span>{totals.native} native surfaces</span></div>
    <p role="status">{evidence ? `Saved execution report: ${evidence.generatedAt}. Fingerprint ${evidence.fingerprint.slice(0,12)}. Source fingerprint matches the current checkout.` : 'No execution report loaded. Story links describe implementation presence only.'}</p>
    <div className="catalog-controls"><label>Category <select value={kind} onChange={event => setKind(event.target.value)}><option value="all">All</option><option value="component">Components</option><option value="screen">Screens</option><option value="native">Native matrix</option></select></label><label>Search <input value={search} onChange={event => setSearch(event.target.value)} /></label><label><input type="checkbox" checked={missing} onChange={event => setMissing(event.target.checked)} /> Missing coverage only</label></div>
    <section aria-label="Component and interface coverage inventory">{(['component','screen','native'] as const).map(category => {
      const group = visible.filter(entry => entry.kind === category);
      return group.length ? <section key={category} aria-label={`${category} inventory`}><h2>{category === 'component' ? 'Components' : category === 'screen' ? 'Screens' : 'Native Electron matrix'}</h2>{group.map(table)}</section> : null;
    })}</section>
    <h2>State sheets and visual baselines</h2><p>Separate sheets provide side-by-side comparison. The visual gate reports which sheets have reviewed baselines; individual interaction stories are not inferred to have a baseline.</p><table className="catalog-table"><caption>Visual baseline and execution inventory</caption><thead><tr><th scope="col">State sheet</th><th scope="col">Reviewed baseline</th><th scope="col">Latest execution</th></tr></thead><tbody>{storyBindings.filter(story => story.sheet).map(story => {
      const platform = navigator.platform.startsWith('Mac') ? 'darwin' : navigator.platform.startsWith('Win') ? 'win32' : 'linux';
      const baseline = baselineFiles[`../visual/baselines/${visualBaselineName(story.id)}-${platform}.png`];
      return <tr key={story.id}><th scope="row">{links([story.id])}</th><td>{typeof baseline === 'string' ? <a href={baseline}>Present · {platform}</a> : 'Missing for this platform'}</td><td>{evidence?.visual.includes(story.id) ? 'Passed visual comparison · current fingerprint' : 'Visual execution unverified'}</td></tr>;
    })}</tbody></table>
  </main>;
}
const meta = { title: 'Catalog/Coverage', component: CoverageMap, tags: ['!autodocs'], parameters: { layout: 'fullscreen' } } satisfies Meta<typeof CoverageMap>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Overview: Story = {};
