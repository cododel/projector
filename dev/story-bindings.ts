import { toId, storyNameFromExport, isExportStory } from 'storybook/internal/csf';
import type { StoryBinding } from './catalog-coverage';
interface Story { parameters?: { catalog?: { states?: string[]; transitions?: string[]; sheet?: boolean } }; play?: unknown; name?: string; tags?: string[] }
interface StoryModule { default: { title: string; includeStories?: string[] | RegExp; excludeStories?: string[] | RegExp; parameters?: Story['parameters'] }; [name: string]: Story | { title: string } }
const modules = import.meta.glob<StoryModule>(['./stories/**/*.stories.tsx', '!./stories/Catalog.stories.tsx'], { eager: true });
export const storyBindings: StoryBinding[] = Object.values(modules).flatMap(module => Object.entries(module).filter(([name]) => name !== 'default' && !name.startsWith('__') && isExportStory(name,module.default)).map(([exportName, value]) => {
  const story = value as Story;
  const metadata = story.parameters?.catalog ?? module.default.parameters?.catalog;
  return { id: toId(module.default.title, storyNameFromExport(exportName)), title: module.default.title, name: story.name ?? storyNameFromExport(exportName),
    states: metadata?.states ?? [], transitions: metadata?.transitions ?? [], interaction: Boolean(story.play), sheet: metadata?.sheet ?? exportName === 'StateSheet' };
}));
