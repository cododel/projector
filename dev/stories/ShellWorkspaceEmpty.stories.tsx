import { CatalogSheet } from '../fixtures/CatalogSheet';
import { shellTransition } from '../fixtures/shell-transitions';
import React from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { ShellFixture } from '../fixtures/shell';
const meta = {
  title: 'Shell/Empty workspace views',
  component: ShellFixture,
  args: { surface: 'workspace-empty', state: 'welcome', onAction: fn() },
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
export const Welcome: Story = {
  args: { state: 'welcome' },
  parameters: { catalog: { states: ['workspace-empty.welcome'] } },
};
export const NoTabs: Story = {
  args: { state: 'no-tabs' },
  parameters: { catalog: { states: ['workspace-empty.no-tabs'] } },
};
export const Waiting: Story = {
  args: { state: 'waiting' },
  parameters: { catalog: { states: ['workspace-empty.waiting'] } },
};
export const Copied: Story = {
  args: { state: 'copied' },
  parameters: { catalog: { states: ['workspace-empty.copied'] } },
};
export const TerminalUnavailable: Story = {
  args: { state: 'terminal-unavailable' },
  parameters: { catalog: { states: ['workspace-empty.terminal-unavailable'] } },
};
export const PlanUnavailable: Story = {
  args: { state: 'plan-unavailable' },
  parameters: { catalog: { states: ['workspace-empty.plan-unavailable'] } },
};
export const ProjectUnavailable: Story = {
  args: { state: 'project-unavailable' },
  parameters: { catalog: { states: ['workspace-empty.project-unavailable'] } },
};
export const TransitionCopy: Story = {
  args: { state: 'waiting' },
  parameters: { catalog: { transitions: ['workspace-empty.copy'] } },
  play: shellTransition('workspace-empty', 'copy'),
};
export const TransitionOpen: Story = {
  args: { state: 'welcome' },
  parameters: { catalog: { transitions: ['workspace-empty.open'] } },
  play: shellTransition('workspace-empty', 'open'),
};
export const StateSheet: Story = {
  render: () => (
    <CatalogSheet
      height={620}
      frames={[
        { label: 'welcome', storyId: 'shell-empty-workspace-views--welcome' },
        { label: 'no tabs', storyId: 'shell-empty-workspace-views--no-tabs' },
        { label: 'waiting', storyId: 'shell-empty-workspace-views--waiting' },
        { label: 'copied', storyId: 'shell-empty-workspace-views--copied' },
        {
          label: 'terminal unavailable',
          storyId: 'shell-empty-workspace-views--terminal-unavailable',
        },
        { label: 'plan unavailable', storyId: 'shell-empty-workspace-views--plan-unavailable' },
        {
          label: 'project unavailable',
          storyId: 'shell-empty-workspace-views--project-unavailable',
        },
      ]}
    />
  ),
};
