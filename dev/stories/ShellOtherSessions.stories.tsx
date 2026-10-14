import { CatalogSheet } from '../fixtures/CatalogSheet';
import { shellTransition } from '../fixtures/shell-transitions';
import React from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, waitFor } from 'storybook/test';
import { ShellFixture } from '../fixtures/shell';
const meta = {
  title: 'Shell/Other sessions',
  component: ShellFixture,
  args: { surface: 'other-sessions', state: 'collapsed', onAction: fn() },
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
export const Collapsed: Story = {
  args: { state: 'collapsed' },
  parameters: { catalog: { states: ['other-sessions.collapsed'] } },
};
export const Expanded: Story = {
  args: { state: 'expanded' },
  parameters: { catalog: { states: ['other-sessions.expanded'] } },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('button', { name: 'Read metadata' })).toBeVisible();
  },
};
export const LongTitle: Story = {
  args: { state: 'long-title' },
  parameters: { catalog: { states: ['other-sessions.long-title'] } },
};
export const LongPath: Story = {
  args: { state: 'long-path' },
  parameters: { catalog: { states: ['other-sessions.long-path'] } },
};
export const Metadata: Story = {
  args: { state: 'metadata' },
  parameters: { catalog: { states: ['other-sessions.metadata'] } },
  play: async ({ canvas }) => {
    await waitFor(() =>
      expect(canvas.getByRole('dialog', { name: 'Codex session metadata' })).toBeVisible(),
    );
  },
};
export const TransitionExpand: Story = {
  args: { state: 'default' },
  parameters: { catalog: { transitions: ['other-sessions.expand'] } },
  play: shellTransition('other-sessions', 'expand'),
};
export const TransitionMetadata: Story = {
  args: { state: 'default' },
  parameters: { catalog: { transitions: ['other-sessions.metadata'] } },
  play: shellTransition('other-sessions', 'metadata'),
};
export const StateSheet: Story = {
  render: () => (
    <CatalogSheet
      height={320}
      frames={[
        { label: 'collapsed', storyId: 'shell-other-sessions--collapsed' },
        { label: 'expanded', storyId: 'shell-other-sessions--expanded' },
        { label: 'long title', storyId: 'shell-other-sessions--long-title' },
        { label: 'long path', storyId: 'shell-other-sessions--long-path' },
        { label: 'metadata', storyId: 'shell-other-sessions--metadata' },
      ]}
    />
  ),
};
