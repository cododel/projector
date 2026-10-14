import { CatalogSheet } from '../fixtures/CatalogSheet';
import React, { useLayoutEffect, useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, waitFor } from 'storybook/test';
import { DocumentContent } from '../../src/renderer/document/DocumentContent';
import { commentPosition } from '../../src/shared/annotation-marker';
import { DocumentAnnotations } from '../../src/renderer/document/DocumentAnnotations';
import { DocumentSelection } from '../../src/renderer/document/DocumentSelection';
import { DocumentAreaSelection } from '../../src/renderer/document/DocumentAreaSelection';
import { CommentComposer } from '../../src/renderer/CommentComposer';
import { AnnotationList } from '../../src/renderer/document/AnnotationList';
type Props = { mode: string; initial: string; pending: boolean; onJump(): void; captureContext(): Promise<void> };
type Point = { x: number; y: number };
type Rect = Point & { width: number; height: number };
function AnnotationFixture(args: Props) {
  const article = useRef<HTMLElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState(['editor','pending'].includes(args.mode));
  const [contextPending, setContextPending] = useState(args.mode === 'pending');
  const [comment, setComment] = useState(args.initial);
  const [focused, setFocused] = useState(args.mode === 'focused');
  const [area, setArea] = useState(args.mode.startsWith('area'));
  const [hovered, setHovered] = useState(['area-hover','area-keyboard'].includes(args.mode));
  const [start, setStart] = useState<Point | null>(null);
  const [end, setEnd] = useState<Point | null>(null);
  const [geometry, setGeometry] = useState<{ rects: Rect[]; pointer: Point; block: Rect; position: Point; visible: boolean } | null>(null);
  useLayoutEffect(() => {
    const root = article.current;
    const passage = root?.querySelector<HTMLElement>('p [data-text-path]');
    const block = passage?.closest('p');
    if (!root || !passage || !block) return;
    const measure = () => {
      const range = document.createRange();
      range.selectNodeContents(passage);
      const rects = Array.from(range.getClientRects());
      const last = rects.at(-1);
      if (!last) return;
      const bounds = block.getBoundingClientRect();
      // Production highlights/markers use document coordinates. Selection and
      // area controls use viewport coordinates, including after window scroll.
      const pointer = args.mode === 'marker'
        ? { x: bounds.right, y: bounds.top + bounds.height / 4 }
        : { x: last.right, y: last.top + last.height / 4 };
      const anchor = args.mode.startsWith('area') ? end ?? { x: bounds.right, y: bounds.bottom } : pointer;
      const size = popover.current?.getBoundingClientRect();
      setGeometry({
        rects: (args.mode === 'marker' ? [bounds] : rects).map(rect => ({ x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height })),
        pointer: { x: pointer.x + scrollX, y: pointer.y + scrollY },
        block: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
        position: selection && size
          ? commentPosition(anchor, { width: innerWidth, height: innerHeight }, size)
          : { x: Math.max(12, Math.min(rects[0].x, innerWidth - 340)), y: Math.max(12, Math.min(last.bottom + 8, innerHeight - 260)) },
        visible: pointer.x >= 0 && pointer.x <= innerWidth && pointer.y >= 0 && pointer.y <= innerHeight,
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    observer.observe(block);
    if (popover.current) observer.observe(popover.current);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    document.fonts.addEventListener('loadingdone', measure);
    let active = true;
    void document.fonts.ready.then(() => { if (active) measure(); });
    measure();
    return () => {
      active = false;
      observer.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
      document.fonts.removeEventListener('loadingdone', measure);
    };
  }, [args.mode, selection, contextPending, end]);
  const mark = geometry && { id: 'mark', number: 1, markerVisible: args.mode !== 'clipped' && geometry.visible, pointer: geometry.pointer, rects: geometry.rects };
  const marks = mark ? args.mode === 'overlap' ? [mark, { ...mark, id: 'second', number: 2 }] : [mark] : [];
  const seededStart = args.mode === 'area-drag' && geometry ? { x: geometry.block.x, y: geometry.block.y } : null;
  const seededEnd = args.mode === 'area-drag' && geometry ? { x: geometry.block.x + geometry.block.width, y: geometry.block.y + geometry.block.height } : null;
  return <div className="surface" style={{ minHeight: 450 }}><article ref={article} className="plan-document" inert={contextPending}><DocumentContent blocks={[{ type: 'heading', props: { depth: 1 }, children: [{ type: 'text', value: 'Annotation review' }] }, { type: 'paragraph', children: [{ type: 'text', value: 'Review this passage and keep comments private. The marker follows the selected text.' }] }]} widgets={[]} values={{}} details={{}} update={() => {}} onDetailsChange={() => {}} /></article>
    {['text','focused','overlap','clipped','marker'].includes(args.mode) && <><DocumentAnnotations highlights={marks} focused={focused ? 'mark' : ''} /><button onClick={() => setFocused(true)}>Focus annotation</button></>}
    <DocumentSelection candidate={args.mode === 'candidate' || selection} selection={selection} contextPending={contextPending} position={geometry?.position ?? { x: 12, y: 12 }} popoverRef={popover} onBegin={() => { setContextPending(true); void args.captureContext().then(() => setSelection(true)).finally(() => setContextPending(false)); }}>
      <CommentComposer label="Annotation comment" saveLabel="Save private annotation" value={comment} disabled={args.pending} onChange={setComment} onSave={() => new Promise<void>(() => {})} onCancel={async () => { setSelection(false); }} onError={() => {}} />
    </DocumentSelection>
    {area && <DocumentAreaSelection hovered={hovered ? geometry?.block : null} areaStart={start ?? seededStart} areaEnd={end ?? seededEnd} onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); setStart({ x: event.clientX, y: event.clientY }); setEnd({ x: event.clientX, y: event.clientY }); }} onPointerMove={(event) => { if (start) setEnd({ x: event.clientX, y: event.clientY }); else setHovered(true); }} onKeyDown={(event) => { if (event.key === 'ArrowDown') setHovered(true); if (event.key === 'Escape') setArea(false); if (event.key === 'Enter') { setArea(false); setSelection(true); } }} />}
  </div>;
}
const meta = { title: 'Document/Annotations', component: AnnotationFixture, args: { mode: 'text', initial: '', pending: false, onJump: fn(), captureContext: fn(async () => {}) }, parameters: { layout: 'fullscreen' } } satisfies Meta<typeof AnnotationFixture>;
export default meta;
type Story = StoryObj<typeof meta>;
export const TextHighlight: Story = { parameters: { catalog: { states: ['document-annotations.text-highlight'], transitions: [] } } };
export const Focused: Story = { args: { mode: 'focused' }, parameters: { catalog: { states: ['document-annotations.focused'], transitions: [] } } };
export const AreaMarker: Story = { args: { mode: 'marker' }, parameters: { catalog: { states: ['document-annotations.area-marker'], transitions: [] } } };
export const Overlapping: Story = { args: { mode: 'overlap' }, parameters: { catalog: { states: ['document-annotations.overlapping-markers'], transitions: [] } } };
export const ClippedMarker: Story = { args: { mode: 'clipped' }, parameters: { catalog: { states: ['document-annotations.clipped-marker'], transitions: [] } } };
export const Focus: Story = { parameters: { catalog: { states: [], transitions: ['document-annotations.focus'] } }, play: async ({ canvas, userEvent, canvasElement }) => { await userEvent.click(canvas.getByRole('button', { name: 'Focus annotation' })); await expect(canvasElement.querySelector('.text-highlight')).toHaveClass('focused'); } };
export const Candidate: Story = { args: { mode: 'candidate' }, parameters: { catalog: { states: ['document-annotations.candidate'], transitions: [] } }, play: async ({ canvas }) => { await expect(canvas.getByRole('button', { name: 'Annotate' })).toBeVisible(); } };
export const Begin: Story = { args: { mode: 'candidate' }, parameters: { catalog: { states: [], transitions: ['document-annotations.begin'] } }, play: async ({ canvas, userEvent }) => { await userEvent.click(canvas.getByRole('button', { name: 'Annotate' })); await expect(canvas.getByRole('textbox', { name: 'Annotation comment' })).toHaveValue(''); } };
export const EmptyEditor: Story = { args: { mode: 'editor' }, parameters: { catalog: { states: ['document-annotations.editor-empty'], transitions: [] } }, play: async ({ canvas }) => { await expect(canvas.getByRole('textbox', { name: 'Annotation comment' })).toHaveValue(''); await expect(canvas.getByRole('button', { name: 'Save private annotation' })).toBeDisabled(); } };
export const TypeComment: Story = { args: { mode: 'editor' }, parameters: { catalog: { states: [], transitions: ['document-annotations.type'] } }, play: async ({ canvas, userEvent }) => { await expect(canvas.getByRole('button', { name: 'Save private annotation' })).toBeDisabled(); await userEvent.type(canvas.getByRole('textbox', { name: 'Annotation comment' }), 'Private comment'); await expect(canvas.getByRole('button', { name: 'Save private annotation' })).toBeEnabled(); } };
export const TextEditor: Story = { args: { mode: 'editor', initial: 'Private comment' }, parameters: { catalog: { states: ['document-annotations.editor-text'], transitions: [] } }, play: async ({ canvas }) => { await expect(canvas.getByRole('textbox', { name: 'Annotation comment' })).toHaveValue('Private comment'); await expect(canvas.getByRole('button', { name: 'Save private annotation' })).toBeEnabled(); } };
export const SaveComment: Story = { args: { mode: 'editor', initial: 'Private comment' }, parameters: { catalog: { states: [], transitions: ['document-annotations.save'] } }, play: async ({ canvas, userEvent }) => { await userEvent.click(canvas.getByRole('button', { name: 'Save private annotation' })); await waitFor(() => expect(canvas.getByRole('textbox', { name: 'Annotation comment' })).toBeDisabled()); } };
export const CancelEditor: Story = { args: { mode: 'candidate', initial: 'Private comment' }, parameters: { catalog: { states: [], transitions: ['document-annotations.cancel'] } }, play: async ({ canvas, userEvent }) => { await userEvent.click(canvas.getByRole('button', { name: 'Annotate' })); await userEvent.keyboard('{Escape}'); await waitFor(() => expect(canvas.getByRole('button', { name: 'Annotate' })).toBeInTheDocument()); } };
export const PendingEditor: Story = { args: { mode: 'editor', initial: 'Private comment', pending: true }, parameters: { catalog: { states: ['document-annotations.editor-pending'], transitions: [] } } };
export const ContextPending: Story = { args: { mode: 'pending' }, parameters: { catalog: { states: ['document-annotations.context-pending'], transitions: [] } }, play: async ({ canvas, canvasElement }) => { await expect(canvasElement.querySelector('.capture-input-shield')).toBeInTheDocument(); await expect(canvas.queryByRole('textbox', { name: 'Annotation comment' })).not.toBeInTheDocument(); } };
export const CaptureContext: Story = { args: { mode: 'candidate' }, parameters: { catalog: { states: [], transitions: ['document-annotations.capture-start', 'document-annotations.capture-complete'] } }, play: async ({ canvas, canvasElement, userEvent, args }) => {
  let complete!: () => void;
  args.captureContext.mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; }));
  await userEvent.click(canvas.getByRole('button', { name: 'Annotate' }));
  await expect(args.captureContext).toHaveBeenCalledOnce();
  await expect(canvasElement.querySelector('.capture-input-shield')).toBeInTheDocument();
  await expect(canvas.queryByRole('textbox')).not.toBeInTheDocument();
  complete();
  await waitFor(() => expect(canvas.getByRole('textbox', { name: 'Annotation comment' })).toHaveValue(''));
  await expect(canvasElement.querySelector('.capture-input-shield')).not.toBeInTheDocument();
} };
export const AreaMode: Story = { args: { mode: 'area' }, parameters: { catalog: { states: ['document-annotations.area-mode'], transitions: [] } } };
export const HoveredBlock: Story = { args: { mode: 'area-hover' }, parameters: { catalog: { states: ['document-annotations.hovered-block'], transitions: [] } } };
export const DragSelection: Story = { args: { mode: 'area-drag' }, parameters: { catalog: { states: ['document-annotations.drag-selection'], transitions: [] } } };
export const KeyboardPointer: Story = { args: { mode: 'area-keyboard' }, parameters: { catalog: { states: ['document-annotations.keyboard-pointer'], transitions: [] } }, play: async ({ canvas }) => { await expect(canvas.getByRole('application', { name: 'Select annotation area' })).toBeVisible(); } };
export const KeyboardSelect: Story = { args: { mode: 'area-keyboard' }, parameters: { catalog: { states: [], transitions: ['document-annotations.keyboard-begin'] } }, play: async ({ canvas, userEvent }) => { canvas.getByRole('application', { name: 'Select annotation area' }).focus(); await userEvent.keyboard('{ArrowDown}{Enter}'); await waitFor(() => expect(canvas.getByRole('textbox', { name: 'Annotation comment' })).toBeVisible()); } };
export const AreaDrag: Story = { args: { mode: 'area' }, parameters: { catalog: { states: [], transitions: ['document-annotations.area'] } }, play: async ({ canvas, canvasElement, userEvent }) => { const overlay = canvas.getByRole('application', { name: 'Select annotation area' }); await userEvent.pointer([{ keys: '[MouseLeft>]', target: overlay, coords: { x: 70, y: 90 } }, { target: overlay, coords: { x: 290, y: 190 } }]); await waitFor(() => expect(canvasElement.querySelector('.area-rectangle')).not.toBeNull()); await userEvent.pointer({ keys: '[/MouseLeft]', target: overlay }); } };

function ListFixture({ variant, onJump }: { variant: string; onJump(): void }) {
  const [items, setItems] = useState(variant === 'empty' ? [] : [{ id: 'first', quote: 'Selected passage', comment: variant === 'long' ? 'Review this carefully. '.repeat(60) : 'Private review note', number: 1 }, ...(variant === 'areas' ? [{ id: 'second', quote: '', comment: 'Area review note', number: 2, kind: 'document-area' }, { id: 'third', quote: '', comment: 'Browser review note', number: 3, kind: 'browser-area' }] : [])]);
  const [editing, setEditing] = useState(variant === 'editing' ? 'first' : '');
  const [comment, setComment] = useState('Private review note');
  return <aside className="feedback-panel" style={{ width: 380 }}><AnnotationList annotations={items} editingId={editing} disabled={variant === 'disabled' || Boolean(editing)} onJump={onJump} onEdit={(item) => { setEditing(item.id); setComment(item.comment); }} onDelete={(item) => setItems((all) => all.filter((entry) => entry.id !== item.id))} renderEditor={(item) => <CommentComposer editing label="Edit annotation" saveLabel="Save comment" value={comment} onChange={setComment} onSave={async () => { setItems((all) => all.map((entry) => entry.id === item.id ? { ...entry, comment } : entry)); setEditing(''); }} onCancel={async () => { setEditing(''); }} onDelete={async () => { setItems((all) => all.filter((entry) => entry.id !== item.id)); setEditing(''); }} onError={() => {}} />} /></aside>;
}
export const ListEmpty: Story = { render: (args) => <ListFixture variant="empty" onJump={args.onJump} />, parameters: { catalog: { states: ['feedback.empty'], transitions: [] } } };
export const ListPopulated: Story = { render: (args) => <ListFixture variant="normal" onJump={args.onJump} />, parameters: { catalog: { states: ['feedback.populated','feedback.text-annotation'], transitions: [] } }, play: async ({ canvas, userEvent, args }) => { await userEvent.click(canvas.getByRole('button', { name: /Selected passage/ })); await expect(args.onJump).toHaveBeenCalled(); } };
export const ListAreas: Story = { render: (args) => <ListFixture variant="areas" onJump={args.onJump} />, parameters: { catalog: { states: ['feedback.area-annotation'], transitions: ['feedback.jump'] } }, play: async ({ canvas, userEvent, args }) => { await userEvent.click(canvas.getAllByRole('button', { name: /Selected area/ })[0]); await expect(args.onJump).toHaveBeenCalled(); } };
export const ListEditing: Story = { render: (args) => <ListFixture variant="editing" onJump={args.onJump} />, parameters: { catalog: { states: ['feedback.editing'], transitions: [] } } };
export const ListDisabled: Story = { render: (args) => <ListFixture variant="disabled" onJump={args.onJump} />, parameters: { catalog: { states: ['feedback.disabled'], transitions: [] } } };
export const ListLong: Story = { render: (args) => <ListFixture variant="long" onJump={args.onJump} />, parameters: { catalog: { states: ['feedback.long-comment'], transitions: [] } } };
export const ListEditSave: Story = { render: (args) => <ListFixture variant="normal" onJump={args.onJump} />, parameters: { catalog: { states: [], transitions: ['feedback.edit','feedback.save','feedback.cancel'] } }, play: async ({ canvas, userEvent }) => { await userEvent.click(canvas.getByRole('button', { name: 'Edit annotation 1' })); await userEvent.type(canvas.getByRole('textbox', { name: 'Edit annotation' }), ' updated'); await userEvent.click(canvas.getByRole('button', { name: 'Save comment' })); await expect(canvas.getByText('Private review note updated')).toBeInTheDocument(); await userEvent.click(canvas.getByRole('button', { name: 'Edit annotation 1' })); await userEvent.keyboard('{Escape}'); await waitFor(() => expect(canvas.queryByRole('textbox')).not.toBeInTheDocument()); } };
export const ListDelete: Story = { render: (args) => <ListFixture variant="normal" onJump={args.onJump} />, parameters: { catalog: { states: [], transitions: ['feedback.delete'] } }, play: async ({ canvas, userEvent }) => { await userEvent.click(canvas.getByRole('button', { name: 'Delete annotation 1' })); await expect(canvas.getByText(/Select a passage/)).toBeInTheDocument(); } };

export const StateSheet: Story = { render: () => <CatalogSheet height={700} frames={[{"static": true, "label": "Highlight", "storyId": "document-annotations--text-highlight"}, {"static": true, "label": "Focused", "storyId": "document-annotations--focused"}, {"static": true, "label": "Overlapping markers", "storyId": "document-annotations--overlapping"}, {"static": true, "label": "Candidate", "storyId": "document-annotations--candidate"}, {"static": true, "label": "Empty editor", "storyId": "document-annotations--empty-editor"}, {"static": true, "label": "Text editor", "storyId": "document-annotations--text-editor"}, {"static": true, "label": "Area hover", "storyId": "document-annotations--hovered-block"}, {"static": true, "label": "Area drag", "storyId": "document-annotations--drag-selection"}, {"static": true, "label": "Context pending", "storyId": "document-annotations--context-pending"}, {"static": true, "label": "Annotation list", "storyId": "document-annotations--list-areas"}]} /> };
