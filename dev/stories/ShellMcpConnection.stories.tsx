import { CatalogSheet } from '../fixtures/CatalogSheet';
import { shellTransition } from '../fixtures/shell-transitions';
import React from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, waitFor } from 'storybook/test';
import { ShellFixture } from '../fixtures/shell';
const meta = {
  title: 'Shell/MCP connection dialog',
  component: ShellFixture,
  decorators: [
    (Story) => (
      <div style={{ minHeight: 680 }}>
        <Story />
      </div>
    ),
  ],
  args: { surface: 'mcp-connection', state: 'packaged', onAction: fn() },
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
export const Packaged: Story = {
  args: { state: 'packaged' },
  parameters: { catalog: { states: ['mcp-connection.packaged'] } },
};
export const Development: Story = {
  args: { state: 'development' },
  parameters: { catalog: { states: ['mcp-connection.development'] } },
};
export const Source: Story = {
  args: { state: 'source' },
  parameters: { catalog: { states: ['mcp-connection.source'] } },
};
export const PromptExpanded: Story = {
  args: { state: 'prompt-expanded' },
  parameters: { catalog: { states: ['mcp-connection.prompt-expanded'] } },
  play: async ({ canvas }) => {
    await waitFor(() => expect(canvas.getByRole('dialog')).toBeVisible());
    await expect(
      canvas.getByText(
        'Configure a fictional local Projector MCP connection. No real files are read.',
        { selector: 'pre' },
      ),
    ).toBeVisible();
  },
};
export const ConfigExpanded: Story = {
  args: { state: 'config-expanded' },
  parameters: { catalog: { states: ['mcp-connection.config-expanded'] } },
  play: async ({ canvas }) => {
    await waitFor(() => expect(canvas.getByRole('dialog')).toBeVisible());
    await expect(canvas.getByText('projector-mcp', { selector: 'pre' })).toBeVisible();
  },
};
export const Copied: Story = {
  args: { state: 'copied' },
  parameters: { catalog: { states: ['mcp-connection.copied'] } },
};
export const TransitionPrompt: Story = {
  args: { state: 'development-interaction' },
  parameters: { catalog: { transitions: ['mcp-connection.prompt'] } },
  play: shellTransition('mcp-connection', 'prompt'),
};
export const TransitionConfig: Story = {
  args: { state: 'development-interaction' },
  parameters: { catalog: { transitions: ['mcp-connection.config'] } },
  play: shellTransition('mcp-connection', 'config'),
};
export const TransitionCopy: Story = {
  args: { state: 'development-interaction' },
  parameters: { catalog: { transitions: ['mcp-connection.copy'] } },
  play: shellTransition('mcp-connection', 'copy'),
};
export const TransitionClose: Story = {
  args: { state: 'development-interaction' },
  parameters: { catalog: { transitions: ['mcp-connection.close'] } },
  play: shellTransition('mcp-connection', 'close'),
};
export const StateSheet: Story = {
  render: () => (
    <CatalogSheet
      height={1120}
      frames={[
        { label: 'packaged', static: true, storyId: 'shell-mcp-connection-dialog--packaged' },
        { label: 'development', static: true, storyId: 'shell-mcp-connection-dialog--development' },
        { label: 'source', static: true, storyId: 'shell-mcp-connection-dialog--source' },
        {
          label: 'prompt expanded',
          static: true,
          storyId: 'shell-mcp-connection-dialog--prompt-expanded',
        },
        {
          label: 'config expanded',
          static: true,
          storyId: 'shell-mcp-connection-dialog--config-expanded',
        },
        { label: 'copied', static: true, storyId: 'shell-mcp-connection-dialog--copied' },
      ]}
    />
  ),
};

export const ConfigurationCopy: Story = {
  args: { state: 'development' },
  parameters: {
    catalog: { transitions: ['mcp-connection.copy'], states: ['mcp-connection.copied'] },
  },
  play: async ({ canvas, userEvent }) => {
    await waitFor(() => expect(canvas.getByRole('dialog')).toBeVisible());
    await userEvent.click(canvas.getByRole('button', { name: 'Copy configuration' }));
    await expect(canvas.getByRole('button', { name: 'Copied' })).toHaveClass('secondary');
    await expect(canvas.getByRole('button', { name: 'Copy setup prompt' })).toBeVisible();
  },
};
