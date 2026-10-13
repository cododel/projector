import React, { useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, waitFor, within } from 'storybook/test';
import { NotificationStack } from '../../src/renderer/NotificationStack';
import { NotificationController } from '../../src/renderer/notifications';
import type { Notification, NotificationCommand, NotificationOverlayBridge } from '../../src/shared/notifications';
import { makeNotice, notificationFrames } from '../fixtures/notifications';

const bridgeFor = (command: NotificationOverlayBridge['command']): NotificationOverlayBridge => ({
  command, onState: () => () => {}, onFocus: () => () => {}, onPointer: () => () => {},
});
type FixtureProps = {
  notices: Notification[];
  maxHeight: number;
  width: number;
  onCommand: (command: NotificationCommand) => void;
};

function NotificationFixture({ notices, maxHeight, width, onCommand }: FixtureProps) {
  const [dismissed, setDismissed] = useState<string[]>([]);
  const bridge = useMemo(() => bridgeFor(command => {
    onCommand(command);
    if (command.type === 'dismiss') setDismissed(ids => [...ids, command.id]);
  }), [onCommand]);
  return <div className="catalog-stage catalog-freeze" style={{ width, maxWidth: '100%' }}>
    <NotificationStack notifications={notices.filter(n => !dismissed.includes(n.id))} visible={false} maxHeight={maxHeight} bridge={bridge} />
  </div>;
}

const meta = {
  title: 'Notifications/Stack',
  component: NotificationFixture,
  args: { notices: [], maxHeight: 440, width: 544, onCommand: fn() },
  argTypes: { onCommand: { control: false }, notices: { control: 'object' }, width: { control: { type: 'range', min: 240, max: 720, step: 8 } } },
  parameters: { docs: { description: { component: 'Production NotificationStack. Fixed stories pause expiry and entry animation for comparison; Dismiss, details and overflow remain interactive. Actions emit local events only. Native windows/pointer routing require the application E2E and desktop smoke.' } } },
} satisfies Meta<typeof NotificationFixture>;
export default meta;
type Story = StoryObj<typeof meta>;
const frame = (key: string) => notificationFrames.find(n => n.key === key)!.notices;

export const Empty: Story = {
  args: { notices: frame('empty') },
  play: async ({ canvas }) => { await expect(canvas.getByRole('group', { name: 'Notifications' })).toBeInTheDocument(); },
};
export const Info: Story = { args: { notices: frame('info') } };
export const Warning: Story = { args: { notices: frame('warning') } };
export const Error: Story = { args: { notices: frame('error') } };
export const Undo: Story = { args: { notices: frame('undo') } };
export const Pending: Story = {
  args: { notices: [{ ...makeNotice('pending-action', 'warning', 'Archiving session', 'Local demonstration only.', ['Archive']), pending: true }] },
  play: async ({ canvas }) => { await expect(canvas.getByRole('button', { name: 'Working…' })).toBeDisabled(); },
};
export const Waiting: Story = { args: { notices: frame('pending') } };
export const Repeated: Story = { args: { notices: [{ ...frame('warning')[0], repeats: 3 }] } };
export const ThreeAlerts: Story = { args: { notices: frame('three') } };
export const Overflow: Story = {
  args: { notices: frame('overflow') },
  play: async ({ canvas, userEvent }) => {
    await expect(canvas.getAllByRole('button', { name: /^Dismiss / })).toHaveLength(3);
    await userEvent.click(canvas.getByRole('button', { name: 'More · 2' }));
    await expect(canvas.getAllByRole('button', { name: /^Dismiss / })).toHaveLength(5);
    await userEvent.click(canvas.getByRole('button', { name: 'Show latest' }));
    await expect(canvas.getAllByRole('button', { name: /^Dismiss / })).toHaveLength(3);
  },
};
export const LongDetails: Story = { args: { notices: frame('long'), width: 360 } };
export const ExpandedDetails: Story = {
  args: LongDetails.args,
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole('button', { name: 'Show details' }));
    await expect(canvas.getByRole('button', { name: 'Hide details' })).toHaveAttribute('aria-expanded', 'true');
    await expect(canvas.getByText(/Write confirmation failed;/)).toBeVisible();
  },
};
export const Dismiss: Story = {
  args: { notices: frame('warning') },
  play: async ({ canvas, userEvent, args }) => {
    await userEvent.click(canvas.getByRole('button', { name: 'Dismiss Session is in use' }));
    await expect(args.onCommand).toHaveBeenCalledWith({ type: 'dismiss', id: 'warning' });
    await waitFor(() => expect(canvas.queryByRole('button', { name: 'Dismiss Session is in use' })).not.toBeInTheDocument());
  },
};
export const Keyboard: Story = {
  args: { notices: frame('warning') },
  play: async ({ canvas, userEvent, args }) => {
    canvas.getByRole('button', { name: 'Retry' }).focus();
    await userEvent.keyboard('{Enter}');
    await expect(args.onCommand).toHaveBeenCalledWith({ type: 'action', id: 'warning', actionId: 'Retry' });
    await userEvent.tab();
    await expect(canvas.getByRole('button', { name: 'Dismiss Session is in use' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    await expect(args.onCommand).toHaveBeenCalledWith({ type: 'blur' });
  },
};

function NotificationPlayground() {
  const [controller] = useState(() => {
    let next = 0;
    return new NotificationController(() => `catalog-0000-0000-0000-${++next}`);
  });
  const notices = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const [visible, setVisible] = useState(true);
  const sequence = useRef(0);
  const bridge = useMemo(() => bridgeFor(command => {
    if (command.type === 'dismiss') controller.dismiss(command.id);
    if (command.type === 'action') void controller.run(command.id, command.actionId);
  }), [controller]);
  const push = (level: Notification['level']) => {
    const operation = `operation-${++sequence.current}`;
    controller.push({ source: 'catalog', context: 'fictional-project', operation, level,
      title: level === 'info' ? 'Operation completed' : level === 'warning' ? 'Session is in use' : 'Operation failed',
      body: 'Catalog only. No files, sessions or processes are changed.', lifetime: level === 'info' ? 'visible' : 'sticky',
      actions: level === 'warning' ? [{ label: 'Retry', run: () => {
        const notice = controller.find('catalog', 'fictional-project', operation)!;
        controller.update(notice.id, { level: 'info', title: 'Archived chat', actions: [{ label: 'Undo', run: () => 'dismiss' }] });
        return 'keep';
      } }] : undefined });
  };
  return <>
    <div className="catalog-controls">
      <button onClick={() => push('info')}>Add info</button><button onClick={() => push('warning')}>Add warning</button><button onClick={() => push('error')}>Add error</button>
      <button onClick={() => controller.push({ source: 'catalog', context: 'fictional-project', operation: `operation-${++sequence.current}`, level: 'warning', title: 'Waiting for local storage', pending: true, actions: [{ label: 'Archive', run: () => 'keep' }] })}>Start pending operation</button>
      <button disabled={!notices.some(n => n.pending)} onClick={() => {
        const pending = notices.find(n => n.pending);
        if (pending) controller.update(pending.id, { pending: false, level: 'info', title: 'Operation completed', actions: [], lifetime: 'visible' });
      }}>Complete pending operation</button>
      <button onClick={() => notices.forEach(n => controller.dismiss(n.id))}>Clear</button>
      <button aria-pressed={!visible} onClick={() => setVisible(v => !v)}>{visible ? 'Pause visible time' : 'Resume visible time'}</button>
    </div>
    <p className="catalog-note">Entry/exit 180 ms; reflow 220 ms. Info expires after 5 visible seconds; hover/focus pauses it. Retry → Undo keeps the original operation. Reduced motion follows your browser/OS preference.</p>
    <div className="catalog-stage"><NotificationStack notifications={notices} visible={visible} maxHeight={440} bridge={bridge} /></div>
  </>;
}
export const Playground: Story = {
  render: () => <NotificationPlayground />,
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole('button', { name: 'Add warning' }));
    await userEvent.click(await canvas.findByRole('button', { name: 'Retry' }));
    await userEvent.click(await canvas.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(canvas.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument());
    await userEvent.click(canvas.getByRole('button', { name: 'Add error' }));
    const alert = canvas.getByRole('alert');
    await waitFor(() => expect(within(alert).getByText('Operation failed')).toBeVisible());
    await userEvent.click(canvas.getByRole('button', { name: 'Start pending operation' }));
    await expect(await canvas.findByRole('button', { name: 'Working…' })).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: 'Complete pending operation' }));
    await expect(await canvas.findByText('Operation completed')).toBeInTheDocument();
  },
};

export const StateSheet: Story = {
  parameters: { controls: { disable: true } },
  render: args => <div className="catalog-grid">{notificationFrames.map(frame => <section key={frame.key}>
    <h2>{frame.name}</h2><p>{frame.caption}</p>
    <NotificationFixture {...args} notices={frame.notices} width={544} maxHeight={800} />
  </section>)}</div>,
};
