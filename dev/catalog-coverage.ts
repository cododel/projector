import { catalog, type CatalogEntry } from './catalog.ts';
export interface StoryBinding { id: string; title: string; name: string; states: string[]; transitions: string[]; interaction: boolean; sheet: boolean; file?: string }
export interface CoverageEvidence { fingerprint: string; generatedAt: string; sourceCurrent: boolean; stories: Record<string, { normal: boolean; reduced: boolean }>; visual: string[]; fullGate: 'passed' | 'failed' | 'not-run'; nativeChecks?: Record<string, { name: string; passed: boolean }[]> }
export function resolveCatalog(bindings: StoryBinding[]): CatalogEntry[] {
  return catalog.map(entry => ({ ...entry,
    states: entry.states.map(state => ({ ...state, stories: bindings.filter(story => story.states.includes(state.id)).map(story => story.id) })),
    transitions: entry.transitions.map(transition => ({ ...transition, stories: bindings.filter(story => story.interaction && story.transitions.includes(transition.id)).map(story => story.id) })),
  }));
}
export function coverageTotals(entries: CatalogEntry[]) {
  const browser = entries.filter(entry => entry.boundary === 'browser');
  const count = (kind: CatalogEntry['kind']) => {
    const group = browser.filter(entry => entry.kind === kind);
    return { covered: group.filter(entry => entry.states.every(state => state.stories.length) && entry.transitions.every(transition => transition.stories.length)).length, total: group.length };
  };
  const states = browser.flatMap(entry => entry.states), transitions = browser.flatMap(entry => entry.transitions);
  return { components: count('component'), screens: count('screen'), states: { covered: states.filter(state => state.stories.length).length, total: states.length }, transitions: { covered: transitions.filter(transition => transition.stories.length).length, total: transitions.length }, native: entries.filter(entry => entry.kind === 'native').length };
}
export function validateCatalog(entries: CatalogEntry[], bindings: StoryBinding[], registered?: Set<string>): string[] {
  const errors: string[] = [], ids = new Set<string>();
  const storyIds = new Set<string>();
  const states = new Set(entries.flatMap(entry => entry.states.map(state => state.id)));
  const transitions = new Set(entries.flatMap(entry => entry.transitions.map(transition => transition.id)));
  for (const entry of entries) {
    const namedIds = [`entity:${entry.id}`, ...entry.states.map(state => `state:${state.id}`), ...entry.transitions.map(transition => `transition:${transition.id}`)];
    for (const key of namedIds) {
      if (ids.has(key)) errors.push(`Duplicate catalog ID: ${key}`); ids.add(key);
    }
    for (const transition of entry.transitions) {
      if (!entry.states.some(state => state.id === transition.fromState) || !entry.states.some(state => state.id === transition.toState)) errors.push(`Invalid endpoints: ${transition.id}`);
    }
  }
  for (const story of bindings) {
    if (storyIds.has(story.id)) errors.push(`Duplicate story ID: ${story.id}`); storyIds.add(story.id);
    if (registered && !registered.has(story.id)) errors.push(`Unregistered story: ${story.id}`);
    for (const id of story.states) if (!states.has(id)) errors.push(`Unknown state: ${id}`);
    for (const id of story.transitions) {
      if (!transitions.has(id)) errors.push(`Unknown transition: ${id}`);
      if (!story.interaction) errors.push(`Transition lacks play: ${id}`);
    }
  }
  return errors;
}

export function visualBaselineName(id: string): string {
  return id === 'notifications-stack--state-sheet' ? 'notifications' : id === 'sessions-project-row--state-sheet' ? 'sessions' : id.replace(/--state-sheet$/, '');
}
