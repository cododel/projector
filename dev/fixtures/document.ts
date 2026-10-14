import documentCaptureImage from './document-capture.png?inline';
import type { DocumentNode, WidgetDefinition } from '../../src/document/types';
const text = (value: string): DocumentNode => ({ type: 'text', value });
const paragraph = (value: string): DocumentNode => ({ type: 'paragraph', children: [text(value)] });
export const documentWidgets: WidgetDefinition[] = [
  { id: 'choice', kind: 'choice', meaning: 'Choose rollout', semanticsVersion: '1', options: ['Canary', 'All users'], defaultValue: '', schemaFingerprint: 'catalog-choice' },
  { id: 'checklist', kind: 'checklist', meaning: 'Release checks', semanticsVersion: '1', options: ['Review', 'Verify'], defaultValue: [], schemaFingerprint: 'catalog-checklist' },
  { id: 'answer', kind: 'text', meaning: 'Implementation notes', semanticsVersion: '1', defaultValue: '', schemaFingerprint: 'catalog-text' },
];
export const documentBlocks: DocumentNode[] = [
  ...Array.from({ length: 6 }, (_, index) => ({ type: 'heading', props: { depth: index + 1 }, children: [text(`Heading ${index + 1}`)] })),
  { type: 'paragraph', children: [text('Normal text '), { type: 'strong', children: [text('strong')] }, text(', '), { type: 'emphasis', children: [text('emphasis')] }, text(', '), { type: 'delete', children: [text('removed')] }, text(' and '), { type: 'inlineCode', value: 'typedValue' }] },
  { type: 'code', props: { language: 'ts' }, value: 'const prepared = await verify();\nreturn prepared;' },
  { type: 'blockquote', children: [paragraph('Source-backed review note.')] },
  { type: 'list', children: [{ type: 'listItem', children: [paragraph('First item')] }, { type: 'listItem', props: { checked: true }, children: [paragraph('Checked task')] }] },
  { type: 'list', props: { ordered: true, start: 3 }, children: [{ type: 'listItem', children: [paragraph('Ordered continuation')] }] },
  { type: 'table', children: [{ type: 'tableRow', children: [{ type: 'tableCell', children: [text('Criterion')] }, { type: 'tableCell', children: [text('Status')] }] }, { type: 'tableRow', children: [{ type: 'tableCell', children: [text('Local review')] }, { type: 'tableCell', children: [text('Prepared')] }] }] },
  { type: 'paragraph', children: [{ type: 'link', props: { url: 'https://example.test' }, children: [text('Reference link')] }, { type: 'break' }, text('Line after break')] },
  { type: 'image', props: { alt: 'Example illustration' } }, { type: 'thematicBreak' },
  { type: 'Callout', props: { title: 'Review note' }, children: [paragraph('Only local fictional data is used.')] },
  { type: 'Callout', children: [paragraph('Body-only review note without a title.')] },
  { type: 'Details', id: 'details', props: { title: 'Implementation details' }, children: [paragraph('Additional detail is privately expanded.')] },
  ...documentWidgets.map((widget) => ({ type: 'component', props: { widgetId: widget.id } })),
];
/** Fictional screenshot of the actual WidgetsSelected document story; no user data. */
export const documentCapturePng = documentCaptureImage.slice(documentCaptureImage.indexOf(',') + 1);
