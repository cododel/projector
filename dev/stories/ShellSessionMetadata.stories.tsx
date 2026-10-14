import { CatalogSheet } from '../fixtures/CatalogSheet';
import { shellTransition } from '../fixtures/shell-transitions';
import React from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { ShellFixture } from '../fixtures/shell';
const meta = {
  title: 'Shell/Session metadata dialog',
  component: ShellFixture,
  decorators: [
    (Story) => (
      <div style={{ minHeight: 680 }}>
        <Story />
      </div>
    ),
  ],
  args: { surface: 'session-metadata', state: 'fallback', onAction: fn() },
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
export const Fallback: Story = {
  args: { state: 'fallback' },
  parameters: { catalog: { states: ['session-metadata.fallback'] } },
};
export const LongPath: Story = {
  args: { state: 'long-path' },
  parameters: { catalog: { states: ['session-metadata.long-path'] } },
};
export const Unknown: Story = {
  args: { state: 'unknown' },
  parameters: { catalog: { states: ['session-metadata.unknown'] } },
};
export const Running: Story = {
  args: { state: 'running' },
  parameters: { catalog: { states: ['session-metadata.running'] } },
};
export const Stopped: Story = {
  args: { state: 'stopped' },
  parameters: { catalog: { states: ['session-metadata.stopped'] } },
};
export const TransitionClose: Story = {
  args: { state: 'default' },
  parameters: { catalog: { transitions: ['session-metadata.close'] } },
  play: shellTransition('session-metadata', 'close'),
};
export const StateSheet: Story = {
  render: () => (
    <CatalogSheet
      height={560}
      frames={[
        { label: 'fallback', storyId: 'shell-session-metadata-dialog--fallback' },
        { label: 'long path', storyId: 'shell-session-metadata-dialog--long-path' },
        { label: 'unknown', storyId: 'shell-session-metadata-dialog--unknown' },
        { label: 'running', storyId: 'shell-session-metadata-dialog--running' },
        { label: 'stopped', storyId: 'shell-session-metadata-dialog--stopped' },
      ]}
    />
  ),
};
