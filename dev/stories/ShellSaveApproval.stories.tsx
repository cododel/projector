import { CatalogSheet } from '../fixtures/CatalogSheet';
import { shellTransition } from '../fixtures/shell-transitions';
import React from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { ShellFixture } from '../fixtures/shell';
const meta = {
  title: 'Shell/Save and approval',
  component: ShellFixture,
  args: { surface: 'save-approval', state: 'dirty', onAction: fn() },
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
export const Dirty: Story = {
  args: { state: 'dirty' },
  parameters: { catalog: { states: ['save-approval.dirty'] } },
};
export const Unchanged: Story = {
  args: { state: 'unchanged' },
  parameters: { catalog: { states: ['save-approval.unchanged'] } },
};
export const Busy: Story = {
  args: { state: 'busy' },
  parameters: { catalog: { states: ['save-approval.busy'] } },
};
export const Autosaving: Story = {
  args: { state: 'autosaving' },
  parameters: { catalog: { states: ['save-approval.autosaving'] } },
};
export const Retry: Story = {
  args: { state: 'retry' },
  parameters: { catalog: { states: ['save-approval.retry'] } },
};
export const Blocked: Story = {
  args: { state: 'blocked' },
  parameters: { catalog: { states: ['save-approval.blocked'] } },
};
export const Approved: Story = {
  args: { state: 'approved' },
  parameters: { catalog: { states: ['save-approval.approved'] } },
};
export const RevokeBlocked: Story = {
  args: { state: 'revoke-blocked' },
  parameters: { catalog: { states: ['save-approval.revoke-blocked'] } },
};
export const TransitionSave: Story = {
  args: { state: 'dirty' },
  parameters: { catalog: { transitions: ['save-approval.save'] } },
  play: shellTransition('save-approval', 'save'),
};
export const TransitionRetry: Story = {
  args: { state: 'retry' },
  parameters: { catalog: { transitions: ['save-approval.retry'] } },
  play: shellTransition('save-approval', 'retry'),
};
export const TransitionApprove: Story = {
  args: { state: 'unchanged' },
  parameters: { catalog: { transitions: ['save-approval.approve'] } },
  play: shellTransition('save-approval', 'approve'),
};
export const TransitionRevoke: Story = {
  args: { state: 'approved' },
  parameters: { catalog: { transitions: ['save-approval.revoke'] } },
  play: shellTransition('save-approval', 'revoke'),
};
export const StateSheet: Story = {
  render: () => (
    <CatalogSheet
      height={700}
      frames={[
        { label: 'dirty', storyId: 'shell-save-and-approval--dirty' },
        { label: 'unchanged', storyId: 'shell-save-and-approval--unchanged' },
        { label: 'busy', storyId: 'shell-save-and-approval--busy' },
        { label: 'autosaving', storyId: 'shell-save-and-approval--autosaving' },
        { label: 'retry', storyId: 'shell-save-and-approval--retry' },
        { label: 'blocked', storyId: 'shell-save-and-approval--blocked' },
        { label: 'approved', storyId: 'shell-save-and-approval--approved' },
        { label: 'revoke blocked', storyId: 'shell-save-and-approval--revoke-blocked' },
      ]}
    />
  ),
};
