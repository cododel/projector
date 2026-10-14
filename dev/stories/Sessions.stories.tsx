import React, { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, waitFor } from 'storybook/test';
import { ProjectSessionRow } from '../../src/renderer/ProjectSessionRow';
import { SessionActions } from '../../src/renderer/SessionActions';
import type { HarnessSession } from '../../src/shared/harness';

const session: HarnessSession = {
  id: 'catalog-session', harness: 'codex', projectId: 'catalog-project', cwd: '/example/project',
  title: 'Review notification interactions', updatedAt: 0, status: 'idle', processState: 'stopped',
};
const longTitle = 'Review every notification interaction and preserve independent project session workspaces';
type RowProps = {
  title: string; active: boolean; pinned: boolean; pending: boolean;
  running: boolean; worktree: boolean; width: number;
  onSelect: () => void; onPin: () => void; onArchive: () => void;
};
function SessionFixture(args: RowProps) {
  return <div className="catalog-row-stage" style={{ width: args.width }}>
    <ProjectSessionRow session={{ ...session, title: args.title, processState: args.running ? 'running' : 'stopped', worktreePath: args.worktree ? '/example/project-worktree' : undefined }} active={args.active} pinned={args.pinned} onSelect={args.onSelect}
      actions={<SessionActions title={args.title || 'Codex session'} pinned={args.pinned} pending={args.pending} onPin={args.onPin} onArchive={args.onArchive} />} />
  </div>;
}
const meta = {
  title: 'Sessions/Project row',
  component: SessionFixture,
  args: { title: 'Review notifications', active: false, pinned: false, pending: false, running: false, worktree: false, width: 320, onSelect: fn(), onPin: fn(), onArchive: fn() },
  argTypes: {
    width: { control: { type: 'range', min: 200, max: 720, step: 10 } },
    onSelect: { control: false }, onPin: { control: false }, onArchive: { control: false },
  },
  parameters: { docs: { description: { component: 'Production ProjectSessionRow + SessionActions. Actions are local spies, never real Archive/Pin. Long titles fade by 20 px; hover or focus starts a one-way 30 px/s scroll after 300 ms. Reduced motion follows the actual browser preference. Pending disables actions, not selection. The running dot stays at the leading edge before the title; actions and worktree remain on the right. Git detection is tested in the main process.' } } },
} satisfies Meta<typeof SessionFixture>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Short: Story = {
  parameters: { catalog: { states: ["session-row.short"], transitions: [] } },};
export const Long: Story = {
  parameters: { catalog: { states: ["session-row.long"], transitions: [] } }, args: { title: longTitle } };
export const FallbackTitle: Story = {
  parameters: { catalog: { states: ["session-row.fallback"], transitions: [] } }, args: { title: '' } };
export const Selected: Story = {
  parameters: { catalog: { states: ["session-row.selected"], transitions: [] } }, args: { active: true } };
export const Pinned: Story = {
  parameters: { catalog: { states: ["session-row.pinned"], transitions: [] } }, args: { pinned: true } };
const dotStaysLeft: NonNullable<Story['play']> = async ({ canvas, canvasElement, userEvent }) => {
  const dot = canvasElement.querySelector<HTMLElement>('.runtime-dot')!;
  const title = canvasElement.querySelector<HTMLElement>('.session-title')!;
  const left = dot.getBoundingClientRect().left;
  const check = async () => {
    await expect(dot.getBoundingClientRect().right).toBeLessThan(title.getBoundingClientRect().left);
    await expect(dot.getBoundingClientRect().left).toBe(left);
  };
  await check();
  const select = canvas.getAllByRole('button')[0];
  select.focus();
  await check();
  await userEvent.hover(select);
  await check();
};
export const Running: Story = {
  parameters: { catalog: { states: ["session-row.running"], transitions: [] } }, args: { running: true }, play: dotStaysLeft };
export const Worktree: Story = {
  parameters: { catalog: { states: ["session-row.worktree"], transitions: [] } }, args: { worktree: true } };
export const SelectedPinnedWorktree: Story = {
  parameters: { catalog: { states: ["session-row.combined"], transitions: [] } }, args: { ...Long.args, active: true, pinned: true, running: true, worktree: true }, play: dotStaysLeft };
export const Narrow: Story = {
  parameters: { catalog: { states: ["session-row.narrow"], transitions: [] } }, args: { ...Long.args, width: 220, worktree: true } };
export const PendingActions: Story = {
  parameters: { catalog: { states: ["session-row.pending"], transitions: [] } },
  args: { pending: true },
  play: async ({ canvas, userEvent }) => {
    await userEvent.hover(canvas.getByRole('button', { name: 'Review notifications' }));
    await expect(canvas.getByRole('button', { name: 'Archive Review notifications' })).toBeDisabled();
    await expect(canvas.getByRole('button', { name: 'Review notifications' })).toBeEnabled();
  },
};
export const Hover: Story = {
  parameters: { catalog: { states: ["session-row.hover"], transitions: ["session-row.hover"] } },
  args: Long.args,
  play: async ({ canvas, userEvent, canvasElement }) => {
    await userEvent.hover(canvas.getByRole('button', { name: longTitle }));
    const pin = canvas.getByRole('button', { name: `Pin ${longTitle}` });
    await waitFor(() => expect(getComputedStyle(pin).opacity).toBe('1'));
    await expect(canvasElement.querySelector('.project-session-row')).toHaveClass('engaged');
  },
};
export const KeyboardFocus: Story = {
  parameters: { catalog: { states: ["session-row.focus"], transitions: ["session-row.focus"] } },
  args: SelectedPinnedWorktree.args,
  play: async ({ canvas, userEvent, args }) => {
    canvas.getByRole('button', { name: longTitle }).focus();
    await userEvent.tab();
    await expect(canvas.getByRole('button', { name: `Unpin ${longTitle}` })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(args.onPin).toHaveBeenCalledOnce();
    await expect(args.onSelect).not.toHaveBeenCalled();
    await userEvent.tab();
    await userEvent.keyboard('{Enter}');
    await expect(args.onArchive).toHaveBeenCalledOnce();
    await expect(args.onSelect).not.toHaveBeenCalled();
  },
};
export const ScrollAndReset: Story = {
  parameters: { catalog: { states: ["session-row.long", "session-row.reset", "session-row.reduced-motion"], transitions: ["session-row.leave"] } },
  args: Long.args,
  play: async ({ canvas, userEvent, canvasElement }) => {
    const text = canvasElement.querySelector<HTMLElement>('.session-title-text')!;
    await userEvent.hover(canvas.getByRole('button', { name: longTitle }));
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      await expect(text.getAnimations()).toHaveLength(0);
    } else {
      await waitFor(() => expect(getComputedStyle(text).transform).not.toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/));
    }
    await userEvent.unhover(canvas.getByRole('button', { name: longTitle }));
    await waitFor(() => expect(text.getAnimations()).toHaveLength(0));
    await expect(getComputedStyle(text).transform).toBe('none');
  },
};

function SessionPlayground(args: RowProps) {
  const [pinned, setPinned] = useState(false);
  const [active, setActive] = useState(false);
  const [archived, setArchived] = useState(false);
  const [width, setWidth] = useState(320);
  return <>
    <label className="catalog-width">Panel width: {width} px<input type="range" min="200" max="720" value={width} onChange={event => setWidth(Number(event.target.value))} /></label>
    {archived ? <button onClick={() => setArchived(false)}>Undo local archive</button> : <SessionFixture {...args} title={longTitle} active={active} pinned={pinned} width={width} worktree running onSelect={() => setActive(true)} onPin={() => setPinned(v => !v)} onArchive={() => setArchived(true)} />}
    <p className="catalog-row-status" role="status">{archived ? 'Archived locally in this story.' : active ? 'Selected locally in this story.' : 'No session selected.'} No application data is changed.</p>
  </>;
}
export const Playground: Story = {
  parameters: { catalog: { states: ["session-row.pinned", "session-row.reset"], transitions: ["session-row.pin", "session-row.archive"] } },
  render: args => <SessionPlayground {...args} />,
  play: async ({ canvas, userEvent }) => {
    canvas.getByRole('button', { name: longTitle }).focus();
    await userEvent.hover(canvas.getByRole('button', { name: longTitle }));
    await waitFor(() => expect(getComputedStyle(canvas.getByRole('button', { name: `Pin ${longTitle}` })).pointerEvents).toBe('auto'));
    await userEvent.click(canvas.getByRole('button', { name: `Pin ${longTitle}` }));
    await expect(canvas.getByRole('button', { name: `Unpin ${longTitle}` })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(canvas.getByRole('button', { name: `Archive ${longTitle}` }));
    await userEvent.click(canvas.getByRole('button', { name: 'Undo local archive' }));
    await expect(canvas.getByRole('button', { name: longTitle })).toBeInTheDocument();
    await expect(canvas.getByRole('status')).toHaveTextContent('No session selected.');
  },
};

export const StateSheet: Story = {
  parameters: { controls: { disable: true }, catalog: { sheet: true } },
  render: args => <div className="catalog-grid">{[
    { name: 'Short', props: {} }, { name: 'Long / fade', props: Long.args },
    { name: 'Selected', props: Selected.args }, { name: 'Pinned', props: Pinned.args },
    { name: 'Running', props: Running.args }, { name: 'Worktree', props: Worktree.args },
    { name: 'Selected + pinned + running + worktree', props: SelectedPinnedWorktree.args },
    { name: 'Pending actions', props: PendingActions.args }, { name: 'Fallback title', props: FallbackTitle.args },
  ].map(state => <section key={state.name}><h2>{state.name}</h2><SessionFixture {...args} {...state.props} width={320} /></section>)}</div>,
};

export const ScrollToEnd: Story = {
  args: { title: 'A long title with visible final words', width: 240 },
  parameters: { catalog: { states: ['session-row.scroll-end'], transitions: ['session-row.scroll'] } },
  play: async ({ canvas, canvasElement, userEvent }) => {
    const button = canvas.getByRole('button', { name: 'A long title with visible final words' });
    await userEvent.hover(button);
    const viewport = canvasElement.querySelector<HTMLElement>('.session-title')!;
    const text = canvasElement.querySelector<HTMLElement>('.session-title-text')!;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      await expect(text.getAnimations()).toHaveLength(0);
      await expect(button).toHaveAttribute('title', expect.stringContaining('A long title with visible final words'));
    } else {
      await waitFor(() => expect(viewport).toHaveClass('at-end'), { timeout: 20000 });
      const distance = text.scrollWidth - viewport.clientWidth;
      await expect(new DOMMatrix(getComputedStyle(text).transform).m41).toBeCloseTo(-distance, 0);
      await expect(getComputedStyle(viewport).maskImage).toBe('none');
    }
  },
};
function SelectionFixture(args: RowProps) {
  const [selected, setSelected] = useState(false);
  return <SessionFixture {...args} active={selected} onSelect={() => setSelected(true)} />;
}
export const Select: Story = {
  render: args => <SelectionFixture {...args} />,
  parameters: { catalog: { states: ['session-row.selected'], transitions: ['session-row.select'] } },
  play: async ({ canvas, canvasElement, userEvent }) => {
    await userEvent.click(canvas.getByRole('button', { name: 'Review notifications' }));
    await expect(canvasElement.querySelector('.project-session-row')).toHaveClass('active');
  },
};
