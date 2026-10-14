import { CatalogSheet } from '../fixtures/CatalogSheet';
import { shellTransition } from '../fixtures/shell-transitions';
import React from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';
import { ShellFixture } from '../fixtures/shell';
const meta = {
  title: 'Shell/Browser toolbar',
  component: ShellFixture,
  args: { surface: 'browser-toolbar', state: 'idle', onAction: fn() },
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
export const Idle: Story = {
  args: { state: 'idle' },
  parameters: { catalog: { states: ['browser-toolbar.idle'] } },
};
export const Loading: Story = {
  args: { state: 'loading' },
  parameters: { catalog: { states: ['browser-toolbar.loading'] } },
};
export const BackDisabled: Story = {
  args: { state: 'back-disabled' },
  parameters: { catalog: { states: ['browser-toolbar.back-disabled'] } },
};
export const ForwardDisabled: Story = {
  args: { state: 'forward-disabled' },
  parameters: { catalog: { states: ['browser-toolbar.forward-disabled'] } },
};
export const Address: Story = {
  args: { state: 'address' },
  parameters: { catalog: { states: ['browser-toolbar.address'] } },
  play: async ({ canvas, userEvent }) => {
    const address = canvas.getByRole('textbox', { name: 'Browser address' });
    await userEvent.clear(address);
    await userEvent.type(address, 'https://example.invalid/edited-before-submit');
    await expect(address).toHaveValue('https://example.invalid/edited-before-submit');
    await expect(address).toHaveFocus();
  },
};
export const Zoom: Story = {
  args: { state: 'zoom' },
  parameters: { catalog: { states: ['browser-toolbar.zoom'] } },
};
export const Annotating: Story = {
  args: { state: 'annotating' },
  parameters: { catalog: { states: ['browser-toolbar.annotating'] } },
};
export const TransitionNavigate: Story = {
  args: { state: 'idle' },
  parameters: { catalog: { transitions: ['browser-toolbar.navigate'] } },
  play: shellTransition('browser-toolbar', 'navigate'),
};
export const TransitionStop: Story = {
  args: { state: 'loading' },
  parameters: { catalog: { transitions: ['browser-toolbar.stop'] } },
  play: shellTransition('browser-toolbar', 'stop'),
};
export const TransitionAddress: Story = {
  args: { state: 'idle' },
  parameters: { catalog: { transitions: ['browser-toolbar.address'] } },
  play: shellTransition('browser-toolbar', 'address'),
};
export const TransitionZoom: Story = {
  args: { state: 'idle' },
  parameters: { catalog: { transitions: ['browser-toolbar.zoom'] } },
  play: shellTransition('browser-toolbar', 'zoom'),
};
export const TransitionAnnotate: Story = {
  args: { state: 'idle' },
  parameters: { catalog: { transitions: ['browser-toolbar.annotate'] } },
  play: shellTransition('browser-toolbar', 'annotate'),
};
export const StateSheet: Story = {
  render: () => (
    <CatalogSheet
      height={320}
      frames={[
        { label: 'idle', storyId: 'shell-browser-toolbar--idle' },
        { label: 'loading', storyId: 'shell-browser-toolbar--loading' },
        { label: 'back disabled', storyId: 'shell-browser-toolbar--back-disabled' },
        { label: 'forward disabled', storyId: 'shell-browser-toolbar--forward-disabled' },
        { label: 'address', storyId: 'shell-browser-toolbar--address' },
        { label: 'zoom', storyId: 'shell-browser-toolbar--zoom' },
        { label: 'annotating', storyId: 'shell-browser-toolbar--annotating' },
      ]}
    />
  ),
};
