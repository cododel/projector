import packageMetadata from '../../package.json';
import { guideTopics, guideReferences } from './materials';

/** Bundled once; all instruction delivery channels consume these exports. */
export const GUIDE_VERSION = `${packageMetadata.version}+guide.11`;
export const SERVER_INSTRUCTIONS =
  'Projector unites projects, agents and tools. Use its MDX plans, widgets and annotations for interdependent decisions, significant uncertainty or visual exploration. Call get_projector_guide(topic="overview") before authoring or reading feedback; load topics and examples as needed. Follow user instructions and project contracts. Draft feedback is private until Save; approval does not authorize implementation.';

export const GUIDE_TOPICS = [
  'overview',
  'planning',
  'authoring',
  'widgets',
  'annotations',
  'all',
] as const;
export type GuideTopic = (typeof GUIDE_TOPICS)[number];
export interface GuideReference {
  id: string;
  title: string;
  description: string;
}
export interface GuideResponse {
  guideVersion: string;
  topic?: GuideTopic;
  reference?: string;
  content: string;
  references: GuideReference[];
}

export class GuideInputError extends Error {
  readonly code = 'INVALID_INPUT';
  readonly guideReference = 'overview';
}

export function getGuide(input: { topic?: string; reference?: string } = {}): GuideResponse {
  if (input.topic !== undefined && input.reference !== undefined) {
    throw new GuideInputError(
      'Choose topic OR reference. Available topics: ' + GUIDE_TOPICS.join(', ') + '.',
    );
  }
  const references: GuideReference[] = Object.entries(guideReferences).map(([id, material]) => ({
    id,
    title: material.title,
    description: material.description,
  }));
  if (input.reference !== undefined) {
    const material = Object.hasOwn(guideReferences, input.reference)
      ? guideReferences[input.reference]
      : undefined;
    if (!material)
      throw new GuideInputError(
        'Unknown reference. Available references: ' +
          references.map((item) => item.id).join(', ') +
          '.',
      );
    return {
      guideVersion: GUIDE_VERSION,
      reference: input.reference,
      content: material.content,
      references,
    };
  }
  const topic = input.topic ?? 'overview';
  if (!GUIDE_TOPICS.includes(topic as GuideTopic)) {
    throw new GuideInputError('Unknown topic. Available topics: ' + GUIDE_TOPICS.join(', ') + '.');
  }
  const content =
    topic === 'all'
      ? Object.entries(guideTopics)
          .map(([name, text]) => `# ${name}\n\n${text}`)
          .join('\n\n')
      : guideTopics[topic as Exclude<GuideTopic, 'all'>];
  return { guideVersion: GUIDE_VERSION, topic: topic as GuideTopic, content, references };
}
