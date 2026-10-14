import { CatalogSheet } from '../fixtures/CatalogSheet';
import { shellTransition } from '../fixtures/shell-transitions';
import React from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';
import { ShellFixture } from '../fixtures/shell';
const meta = {
  title: 'Shell/Update handoff',
  component: ShellFixture,
  args: { surface: 'handoff', state: 'copy-only', onAction: fn() },
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
export const CopyOnly: Story = {
  args: { state: 'copy-only' },
  parameters: { catalog: { states: ['handoff.copy-only'] } },
};
export const RunningSession: Story = {
  args: { state: 'running-session' },
  parameters: { catalog: { states: ['handoff.running-session'] } },
};
export const ResumeFirst: Story = {
  args: { state: 'resume-first' },
  parameters: { catalog: { states: ['handoff.resume-first'] } },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('combobox', { name: 'Target Codex session' })).toHaveValue(
      'example-session',
    );
    await expect(
      canvas.getByRole('option', { name: 'Review the interface catalog · Resume first' }),
    ).toBeDisabled();
  },
};
export const Copied: Story = {
  args: { state: 'copied' },
  parameters: { catalog: { states: ['handoff.copied'] } },
};
export const TransitionSelect: Story = {
  args: { state: 'default' },
  parameters: { catalog: { transitions: ['handoff.select'] } },
  play: shellTransition('handoff', 'select'),
};
export const TransitionCopy: Story = {
  args: { state: 'default' },
  parameters: { catalog: { transitions: ['handoff.copy'] } },
  play: shellTransition('handoff', 'copy'),
};
export const StateSheet: Story = {
  render: () => (
    <CatalogSheet
      height={350}
      frames={[
        { label: 'copy only', static: true, storyId: 'shell-update-handoff--copy-only' },
        {
          label: 'running session',
          static: true,
          storyId: 'shell-update-handoff--running-session',
        },
        { label: 'resume first', static: true, storyId: 'shell-update-handoff--resume-first' },
        { label: 'copied', static: true, storyId: 'shell-update-handoff--copied' },
      ]}
    />
  ),
};
