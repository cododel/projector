import { CatalogSheet } from '../fixtures/CatalogSheet';
import React from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';
import { ShellFixture } from '../fixtures/shell';
const meta = {
  title: 'Shell/Feedback panel',
  component: ShellFixture,
  args: { surface: 'feedback', state: 'origin-present', onAction: fn() },
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
export const OriginPresent: Story = {
  args: { state: 'origin-present' },
  parameters: { catalog: { states: ['feedback.origin-present'] } },
  play: async ({ canvas }) => {
    await expect(canvas.getByText('Origin: codex · availability unverified')).toBeVisible();
  },
};
export const OriginAbsent: Story = {
  args: { state: 'origin-absent' },
  parameters: { catalog: { states: ['feedback.origin-absent'] } },
  play: async ({ canvas }) => {
    await expect(canvas.getByText('No agent session attached')).toBeVisible();
  },
};
export const Migration: Story = {
  args: { state: 'migration' },
  parameters: { catalog: { states: ['feedback.migration'] } },
  play: async ({ canvas }) => {
    await expect(
      canvas.getByText(
        'Authored defaults are not confirmed answers. Previous versions retain their state.',
      ),
    ).toBeVisible();
  },
};
export const Downloads: Story = {
  args: { state: 'downloads' },
  parameters: { catalog: { states: ['feedback.downloads'] } },
  play: async ({ canvas }) => {
    await expect(canvas.getByText('example.pdf · completed')).toBeVisible();
  },
};
export const StateSheet: Story = {
  render: () => (
    <CatalogSheet
      height={560}
      frames={[
        { label: 'origin present', static: true, storyId: 'shell-feedback-panel--origin-present' },
        { label: 'origin absent', static: true, storyId: 'shell-feedback-panel--origin-absent' },
        { label: 'migration', static: true, storyId: 'shell-feedback-panel--migration' },
        { label: 'downloads', static: true, storyId: 'shell-feedback-panel--downloads' },
      ]}
    />
  ),
};
