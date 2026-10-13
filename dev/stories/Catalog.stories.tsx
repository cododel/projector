import React from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { catalog } from '../catalog';

function CoverageMap() {
  const included = catalog.filter(c => c.status === 'included');
  return <main className="catalog-page">
    <h1>Projector interface catalog</h1>
    <p>One place to inspect real components, named states and transitions. This is the first catalog increment, not complete application coverage. Every fixture is fictional; stories do not have the application bridge.</p>
    <div className="catalog-stats"><span>{included.length} component families included</span><span>{catalog.filter(c => c.status === 'planned').length} families planned</span><span>{catalog.filter(c => c.status === 'native').length} integration boundaries</span></div>
    <h2>Start here</h2>
    <p>Use the state sheets to compare variants together, individual stories for Controls and keyboard interactions, and the playgrounds to explore transitions. The Accessibility panel audits the rendered state. Reduced motion follows the browser/OS preference; the browser test command runs both preferences.</p>
    <p>Native transparent-window input, Git worktree detection, persistence, model calls and process ownership stay in the application tests. A green browser story does not qualify these boundaries.</p>
    <table className="catalog-table"><caption>Component and interface coverage inventory</caption><thead><tr><th scope="col">Interface / source</th><th scope="col">Coverage</th><th scope="col">States and limits</th></tr></thead><tbody>
      {catalog.map(entry => <tr key={entry.name}><th scope="row">{entry.name}{entry.sources.map(source => <small key={source}><code>{source}</code></small>)}{entry.stories && <div className="catalog-state-links">{entry.stories.map(story => <a key={story.id} href={`./?path=/story/${story.id}`} target="_top">{story.name}</a>)}</div>}</th>
        <td>{entry.status === 'included' ? 'Included' : entry.status === 'native' ? 'Integration boundary' : 'Planned'}</td>
        <td>{entry.states}<p className="catalog-note">{entry.boundary}</p>{entry.notApplicable && <p className="catalog-note">Not applicable: {entry.notApplicable}</p>}</td></tr>)}
    </tbody></table>
  </main>;
}
const meta = { title: 'Catalog/Coverage', component: CoverageMap, tags: ['!autodocs'], parameters: { layout: 'fullscreen' } } satisfies Meta<typeof CoverageMap>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Overview: Story = {};
