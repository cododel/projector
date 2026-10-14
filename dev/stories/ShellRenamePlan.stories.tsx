import { CatalogSheet } from '../fixtures/CatalogSheet';
import { shellTransition } from '../fixtures/shell-transitions';
import React from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { ShellFixture } from '../fixtures/shell';
const meta = {
  title: 'Shell/Rename plan dialog',
  component: ShellFixture,
  decorators: [
    (Story) => (
      <div style={{ minHeight: 680 }}>
        <Story />
      </div>
    ),
  ],
  args: { surface: 'rename-plan', state: 'empty', onAction: fn() },
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
export const Empty: Story = {
  args: { state: 'empty' },
  parameters: { catalog: { states: ['rename-plan.empty'] } },
};
export const Valid: Story = {
  args: { state: 'valid' },
  parameters: { catalog: { states: ['rename-plan.valid'] } },
};
export const LongTitle: Story = {
  args: { state: 'long-title' },
  parameters: { catalog: { states: ['rename-plan.long-title'] } },
};
export const Busy: Story = {
  args: { state: 'busy' },
  parameters: { catalog: { states: ['rename-plan.busy'] } },
};
export const Error: Story = {
  args: { state: 'error' },
  parameters: { catalog: { states: ['rename-plan.error'] } },
};
export const TransitionEdit: Story = {
  args: { state: 'empty' },
  parameters: { catalog: { transitions: ['rename-plan.edit'] } },
  play: shellTransition('rename-plan', 'edit'),
};
export const TransitionSave: Story = {
  args: { state: 'valid' },
  parameters: { catalog: { transitions: ['rename-plan.save'] } },
  play: shellTransition('rename-plan', 'save'),
};
export const TransitionFailure: Story = {
  args: { state: 'failing' },
  parameters: { catalog: { transitions: ['rename-plan.failure'] } },
  play: shellTransition('rename-plan', 'failure'),
};
export const TransitionCancel: Story = {
  args: { state: 'valid' },
  parameters: { catalog: { states: ['rename-plan.closed'], transitions: ['rename-plan.cancel'] } },
  play: shellTransition('rename-plan', 'cancel'),
};
export const StateSheet: Story = {
  render: () => (
    <CatalogSheet
      height={560}
      frames={[
        { label: 'empty', storyId: 'shell-rename-plan-dialog--empty' },
        { label: 'valid', storyId: 'shell-rename-plan-dialog--valid' },
        { label: 'long title', storyId: 'shell-rename-plan-dialog--long-title' },
        { label: 'busy', storyId: 'shell-rename-plan-dialog--busy' },
        { label: 'error', storyId: 'shell-rename-plan-dialog--error' },
      ]}
    />
  ),
};
