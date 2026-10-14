import { CatalogSheet } from '../fixtures/CatalogSheet';
import { shellTransition } from '../fixtures/shell-transitions';
import React from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';
import { ShellFixture } from '../fixtures/shell';
const meta = {
  title: 'Shell/Workspace tabs',
  component: ShellFixture,
  args: { surface: 'workspace-tabs', state: 'document', onAction: fn() },
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
export const Document: Story = {
  args: { state: 'document' },
  parameters: { catalog: { states: ['workspace-tabs.document'] } },
};
export const Browser: Story = {
  args: { state: 'browser' },
  parameters: { catalog: { states: ['workspace-tabs.browser'] } },
};
export const Home: Story = {
  args: { state: 'home' },
  parameters: { catalog: { states: ['workspace-tabs.home'] } },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('tab', { name: 'New tab' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  },
};
export const Terminal: Story = {
  args: { state: 'terminal' },
  parameters: { catalog: { states: ['workspace-tabs.terminal'] } },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('tab', { name: 'Terminal' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  },
};
export const Session: Story = {
  args: { state: 'session' },
  parameters: { catalog: { states: ['workspace-tabs.session'] } },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('tab', { name: 'Codex' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  },
};
export const Active: Story = {
  args: { state: 'active' },
  parameters: { catalog: { states: ['workspace-tabs.active'] } },
};
export const Inactive: Story = {
  args: { state: 'inactive' },
  parameters: { catalog: { states: ['workspace-tabs.inactive'] } },
};
export const Busy: Story = {
  args: { state: 'busy' },
  parameters: { catalog: { states: ['workspace-tabs.busy'] } },
};
export const SplitCount: Story = {
  args: { state: 'split-count' },
  parameters: { catalog: { states: ['workspace-tabs.split-count'] } },
};
export const ManyTabs: Story = {
  args: { state: 'many-tabs' },
  parameters: { catalog: { states: ['workspace-tabs.many-tabs'] } },
};
export const TransitionSelect: Story = {
  args: { state: 'default' },
  parameters: { catalog: { transitions: ['workspace-tabs.select'] } },
  play: shellTransition('workspace-tabs', 'select'),
};
export const TransitionClose: Story = {
  args: { state: 'document-home' },
  parameters: { catalog: { transitions: ['workspace-tabs.close'] } },
  play: shellTransition('workspace-tabs', 'close'),
};
export const TransitionNewTab: Story = {
  args: { state: 'default' },
  parameters: { catalog: { transitions: ['workspace-tabs.new-tab'] } },
  play: shellTransition('workspace-tabs', 'new-tab'),
};
export const StateSheet: Story = {
  render: () => (
    <CatalogSheet
      height={320}
      frames={[
        { label: 'document', static: true, storyId: 'shell-workspace-tabs--document' },
        { label: 'browser', static: true, storyId: 'shell-workspace-tabs--browser' },
        { label: 'home', static: true, storyId: 'shell-workspace-tabs--home' },
        { label: 'terminal', static: true, storyId: 'shell-workspace-tabs--terminal' },
        { label: 'session', static: true, storyId: 'shell-workspace-tabs--session' },
        { label: 'active', static: true, storyId: 'shell-workspace-tabs--active' },
        { label: 'inactive', static: true, storyId: 'shell-workspace-tabs--inactive' },
        { label: 'busy', static: true, storyId: 'shell-workspace-tabs--busy' },
        { label: 'split count', static: true, storyId: 'shell-workspace-tabs--split-count' },
        { label: 'many tabs', static: true, storyId: 'shell-workspace-tabs--many-tabs' },
      ]}
    />
  ),
};
export const KeyboardSelectAndClose: Story = {
  args: { state: 'document-home' },
  parameters: { catalog: { transitions: ['workspace-tabs.select', 'workspace-tabs.close'] } },
  play: async ({ canvas, userEvent, args }) => {
    const tab = canvas.getByRole('tab', { name: 'Plan' });
    const owner = canvas.getByRole('tablist', { name: 'Workspace tabs' });
    await expect(owner.getAttribute('aria-owns')?.split(' ')).toContain(tab.id);
    tab.focus();
    await userEvent.keyboard('{Enter}');
    await expect(args.onAction).toHaveBeenCalledTimes(1);
    await expect(args.onAction).toHaveBeenCalledWith('select');
    await userEvent.tab();
    await expect(canvas.getByRole('button', { name: 'Close plan tab' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(canvas.queryByRole('tab', { name: 'Plan' })).toBeNull();
    await expect(canvas.getByRole('tab', { name: 'New tab' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(args.onAction).toHaveBeenCalledTimes(2);
    await expect(args.onAction).toHaveBeenCalledWith('close');
  },
};
