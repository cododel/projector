import { CatalogSheet } from '../fixtures/CatalogSheet';
import { shellTransition } from '../fixtures/shell-transitions';
import React from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { ShellFixture } from '../fixtures/shell';
const meta = {
  title: 'Shell/Project terminal panel',
  component: ShellFixture,
  args: { surface: 'bottom-terminals', state: 'hidden', onAction: fn() },
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
export const Hidden: Story = {
  args: { state: 'hidden' },
  parameters: { catalog: { states: ['bottom-terminals.hidden'] } },
};
export const Empty: Story = {
  args: { state: 'empty' },
  parameters: { catalog: { states: ['bottom-terminals.empty'] } },
};
export const Populated: Story = {
  args: { state: 'populated' },
  parameters: { catalog: { states: ['bottom-terminals.populated'] } },
};
export const Selected: Story = {
  args: { state: 'selected' },
  parameters: { catalog: { states: ['bottom-terminals.selected'] } },
};
export const Resizing: Story = {
  args: { state: 'resizing' },
  parameters: { catalog: { states: ['bottom-terminals.resizing'] } },
};
export const TransitionToggle: Story = {
  args: { state: 'hidden' },
  parameters: { catalog: { transitions: ['bottom-terminals.toggle'] } },
  play: shellTransition('bottom-terminals', 'toggle'),
};
export const TransitionNew: Story = {
  args: { state: 'empty' },
  parameters: { catalog: { transitions: ['bottom-terminals.new'] } },
  play: shellTransition('bottom-terminals', 'new'),
};
export const TransitionSelect: Story = {
  args: { state: 'default' },
  parameters: { catalog: { transitions: ['bottom-terminals.select'] } },
  play: shellTransition('bottom-terminals', 'select'),
};
export const TransitionClose: Story = {
  args: { state: 'selected' },
  parameters: { catalog: { transitions: ['bottom-terminals.close'] } },
  play: shellTransition('bottom-terminals', 'close'),
};
export const TransitionResize: Story = {
  args: { state: 'default' },
  parameters: { catalog: { transitions: ['bottom-terminals.resize'] } },
  play: shellTransition('bottom-terminals', 'resize'),
};
export const StateSheet: Story = {
  render: () => (
    <CatalogSheet
      height={560}
      frames={[
        { label: 'hidden', static: true, storyId: 'shell-project-terminal-panel--hidden' },
        { label: 'empty', static: true, storyId: 'shell-project-terminal-panel--empty' },
        { label: 'populated', static: true, storyId: 'shell-project-terminal-panel--populated' },
        { label: 'selected', static: true, storyId: 'shell-project-terminal-panel--selected' },
        { label: 'resizing', static: true, storyId: 'shell-project-terminal-panel--resizing' },
      ]}
    />
  ),
};
