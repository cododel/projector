import { CatalogSheet } from '../fixtures/CatalogSheet';
import { shellTransition } from '../fixtures/shell-transitions';
import React from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';
import { ShellFixture } from '../fixtures/shell';
const meta = {
  title: 'Shell/Saved state history',
  component: ShellFixture,
  args: { surface: 'history', state: 'empty', onAction: fn() },
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
  parameters: { catalog: { states: ['history.empty'] } },
};
export const SavedStates: Story = {
  args: { state: 'saved-states' },
  parameters: { catalog: { states: ['history.saved-states'] } },
};
export const LegacyPackages: Story = {
  args: { state: 'legacy-packages' },
  parameters: { catalog: { states: ['history.legacy-packages'] } },
};
export const Expanded: Story = {
  args: { state: 'expanded' },
  parameters: { catalog: { states: ['history.expanded'] } },
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByText('Saved states', { selector: 'summary' }));
    await expect(canvas.getByRole('button', { name: 'Copy update message' })).toBeVisible();
  },
};
export const TransitionExpand: Story = {
  args: { state: 'default' },
  parameters: { catalog: { transitions: ['history.expand'] } },
  play: shellTransition('history', 'expand'),
};
export const TransitionCopy: Story = {
  args: { state: 'default' },
  parameters: { catalog: { transitions: ['history.copy'] } },
  play: shellTransition('history', 'copy'),
};
export const StateSheet: Story = {
  render: () => (
    <CatalogSheet
      height={320}
      frames={[
        { label: 'empty', storyId: 'shell-saved-state-history--empty' },
        { label: 'saved states', storyId: 'shell-saved-state-history--saved-states' },
        { label: 'legacy packages', storyId: 'shell-saved-state-history--legacy-packages' },
        { label: 'expanded', storyId: 'shell-saved-state-history--expanded' },
      ]}
    />
  ),
};
