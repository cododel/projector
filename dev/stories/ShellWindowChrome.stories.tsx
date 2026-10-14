import { CatalogSheet } from '../fixtures/CatalogSheet';
import { shellTransition } from '../fixtures/shell-transitions';
import React from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';
import { ShellFixture } from '../fixtures/shell';
const meta = {
  title: 'Shell/Application chrome',
  component: ShellFixture,
  args: { surface: 'window-chrome', state: 'default', onAction: fn() },
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
export const Default: Story = {
  args: { state: 'default' },
  parameters: { catalog: { states: ['window-chrome.default'] } },
};
export const LeftHidden: Story = {
  args: { state: 'left-hidden' },
  parameters: { catalog: { states: ['window-chrome.left-hidden'] } },
  play: async ({ canvasElement }) => {
    await expect(
      (canvasElement.querySelector('.app') as HTMLElement).style.getPropertyValue(
        '--left-sidebar-width',
      ),
    ).toBe('0px');
  },
};
export const RightHidden: Story = {
  args: { state: 'right-hidden' },
  parameters: { catalog: { states: ['window-chrome.right-hidden'] } },
  play: async ({ canvasElement }) => {
    await expect(
      (canvasElement.querySelector('.app') as HTMLElement).style.getPropertyValue(
        '--right-sidebar-width',
      ),
    ).toBe('0px');
  },
};
export const BothHidden: Story = {
  args: { state: 'both-hidden' },
  parameters: { catalog: { states: ['window-chrome.both-hidden'] } },
  play: async ({ canvasElement }) => {
    await expect(
      (canvasElement.querySelector('.app') as HTMLElement).style.getPropertyValue(
        '--left-sidebar-width',
      ),
    ).toBe('0px');
  },
};
export const Busy: Story = {
  args: { state: 'busy' },
  parameters: { catalog: { states: ['window-chrome.busy'] } },
};
export const TransitionLeftToggle: Story = {
  args: { state: 'default' },
  parameters: { catalog: { transitions: ['window-chrome.left-toggle'] } },
  play: shellTransition('window-chrome', 'left-toggle'),
};
export const TransitionRightToggle: Story = {
  args: { state: 'default' },
  parameters: { catalog: { transitions: ['window-chrome.right-toggle'] } },
  play: shellTransition('window-chrome', 'right-toggle'),
};
export const StateSheet: Story = {
  render: () => (
    <CatalogSheet
      height={320}
      frames={[
        { label: 'default', static: true, storyId: 'shell-application-chrome--default' },
        { label: 'left hidden', static: true, storyId: 'shell-application-chrome--left-hidden' },
        { label: 'right hidden', static: true, storyId: 'shell-application-chrome--right-hidden' },
        { label: 'both hidden', static: true, storyId: 'shell-application-chrome--both-hidden' },
        { label: 'busy', static: true, storyId: 'shell-application-chrome--busy' },
      ]}
    />
  ),
};
