import { CatalogSheet } from '../fixtures/CatalogSheet';
import { shellTransition } from '../fixtures/shell-transitions';
import React from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { ShellFixture } from '../fixtures/shell';
const meta = {
  title: 'Shell/Project sidebar',
  component: ShellFixture,
  args: { surface: 'project-tree', state: 'empty', onAction: fn() },
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
  parameters: { catalog: { states: ['project-tree.empty'] } },
};
export const Populated: Story = {
  args: { state: 'populated' },
  parameters: { catalog: { states: ['project-tree.populated'] } },
};
export const Selected: Story = {
  args: { state: 'selected' },
  parameters: { catalog: { states: ['project-tree.selected'] } },
};
export const Collapsed: Story = {
  args: { state: 'collapsed' },
  parameters: { catalog: { states: ['project-tree.collapsed'] } },
};
export const Unavailable: Story = {
  args: { state: 'unavailable' },
  parameters: { catalog: { states: ['project-tree.unavailable'] } },
};
export const NoSessions: Story = {
  args: { state: 'no-sessions' },
  parameters: { catalog: { states: ['project-tree.no-sessions'] } },
};
export const ManySessions: Story = {
  args: { state: 'many-sessions' },
  parameters: { catalog: { states: ['project-tree.many-sessions'] } },
};
export const TransitionDisclosure: Story = {
  args: { state: 'populated' },
  parameters: { catalog: { transitions: ['project-tree.disclosure'] } },
  play: shellTransition('project-tree', 'disclosure'),
};
export const TransitionSelect: Story = {
  args: { state: 'populated' },
  parameters: { catalog: { transitions: ['project-tree.select'] } },
  play: shellTransition('project-tree', 'select'),
};
export const TransitionOpenFolder: Story = {
  args: { state: 'empty' },
  parameters: { catalog: { transitions: ['project-tree.open-folder'] } },
  play: shellTransition('project-tree', 'open-folder'),
};
export const StateSheet: Story = {
  render: () => (
    <CatalogSheet
      height={320}
      frames={[
        { label: 'empty', storyId: 'shell-project-sidebar--empty' },
        { label: 'populated', storyId: 'shell-project-sidebar--populated' },
        { label: 'selected', storyId: 'shell-project-sidebar--selected' },
        { label: 'collapsed', storyId: 'shell-project-sidebar--collapsed' },
        { label: 'unavailable', storyId: 'shell-project-sidebar--unavailable' },
        { label: 'no sessions', storyId: 'shell-project-sidebar--no-sessions' },
        { label: 'many sessions', storyId: 'shell-project-sidebar--many-sessions' },
      ]}
    />
  ),
};
