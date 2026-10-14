import { CatalogSheet } from '../fixtures/CatalogSheet';
import { shellTransition } from '../fixtures/shell-transitions';
import React from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';
import { ShellFixture } from '../fixtures/shell';
const meta = {
  title: 'Shell/Session home',
  component: ShellFixture,
  args: { surface: 'session-home', state: 'unknown', onAction: fn() },
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Actual production presentation; local callbacks and fictional data. IPC, persistence and native actions are not executed.',
      },
    },
  },
} satisfies Meta<typeof ShellFixture>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Unknown: Story = {
  args: { state: 'unknown' },
  parameters: { catalog: { states: ['session-home.unknown'] } },
};
export const Running: Story = {
  args: { state: 'running' },
  parameters: { catalog: { states: ['session-home.running'] } },
};
export const Stopped: Story = {
  args: { state: 'stopped' },
  parameters: { catalog: { states: ['session-home.stopped'] } },
};
export const Unavailable: Story = {
  args: { state: 'unavailable' },
  parameters: { catalog: { states: ['session-home.unavailable'] } },
};
export const Details: Story = {
  args: { state: 'details' },
  parameters: { catalog: { states: ['session-home.details'] } },
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByText('Details', { selector: 'summary' }));
    await expect(canvas.getByRole('button', { name: 'Copy session ID' })).toBeVisible();
  },
};
export const Busy: Story = {
  args: { state: 'busy' },
  parameters: { catalog: { states: ['session-home.busy'] } },
};
export const TransitionDetails: Story = {
  args: { state: 'unknown' },
  parameters: { catalog: { transitions: ['session-home.details'] } },
  play: shellTransition('session-home', 'details'),
};
export const TransitionResume: Story = {
  args: { state: 'stopped' },
  parameters: { catalog: { transitions: ['session-home.resume'] } },
  play: shellTransition('session-home', 'resume'),
};
export const TransitionOpenTerminal: Story = {
  args: { state: 'running' },
  parameters: { catalog: { transitions: ['session-home.open-terminal'] } },
  play: shellTransition('session-home', 'open-terminal'),
};
export const TransitionNew: Story = {
  args: { state: 'unavailable' },
  parameters: { catalog: { transitions: ['session-home.new'] } },
  play: shellTransition('session-home', 'new'),
};
export const StateSheet: Story = {
  render: () => (
    <CatalogSheet
      height={700}
      frames={[
        { label: 'unknown', storyId: 'shell-session-home--unknown' },
        { label: 'running', storyId: 'shell-session-home--running' },
        { label: 'stopped', storyId: 'shell-session-home--stopped' },
        { label: 'unavailable', storyId: 'shell-session-home--unavailable' },
        { label: 'details', storyId: 'shell-session-home--details' },
        { label: 'busy', storyId: 'shell-session-home--busy' },
      ]}
    />
  ),
};
