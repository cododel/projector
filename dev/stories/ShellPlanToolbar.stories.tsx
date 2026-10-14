import { CatalogSheet } from '../fixtures/CatalogSheet';
import { shellTransition } from '../fixtures/shell-transitions';
import React from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { ShellFixture } from '../fixtures/shell';
const meta = {
  title: 'Shell/Document toolbar',
  component: ShellFixture,
  args: { surface: 'plan-toolbar', state: 'draft', onAction: fn() },
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
export const Draft: Story = {
  args: { state: 'draft' },
  parameters: { catalog: { states: ['plan-toolbar.draft'] } },
};
export const Review: Story = {
  args: { state: 'review' },
  parameters: { catalog: { states: ['plan-toolbar.review'] } },
};
export const Approved: Story = {
  args: { state: 'approved' },
  parameters: { catalog: { states: ['plan-toolbar.approved'] } },
};
export const History: Story = {
  args: { state: 'history' },
  parameters: { catalog: { states: ['plan-toolbar.history'] } },
};
export const Saving: Story = {
  args: { state: 'saving' },
  parameters: { catalog: { states: ['plan-toolbar.saving'] } },
};
export const Saved: Story = {
  args: { state: 'saved' },
  parameters: { catalog: { states: ['plan-toolbar.saved'] } },
};
export const SaveFailed: Story = {
  args: { state: 'save-failed' },
  parameters: { catalog: { states: ['plan-toolbar.save-failed'] } },
};
export const Annotating: Story = {
  args: { state: 'annotating' },
  parameters: { catalog: { states: ['plan-toolbar.annotating'] } },
};
export const AnnotationDisabled: Story = {
  args: { state: 'annotation-disabled' },
  parameters: { catalog: { states: ['plan-toolbar.annotation-disabled'] } },
};
export const TransitionVersion: Story = {
  args: { state: 'review' },
  parameters: { catalog: { transitions: ['plan-toolbar.version'] } },
  play: shellTransition('plan-toolbar', 'version'),
};
export const TransitionAnnotate: Story = {
  args: { state: 'review' },
  parameters: { catalog: { transitions: ['plan-toolbar.annotate'] } },
  play: shellTransition('plan-toolbar', 'annotate'),
};
export const StateSheet: Story = {
  render: () => (
    <CatalogSheet
      height={320}
      frames={[
        { label: 'draft', storyId: 'shell-document-toolbar--draft' },
        { label: 'review', storyId: 'shell-document-toolbar--review' },
        { label: 'approved', storyId: 'shell-document-toolbar--approved' },
        { label: 'history', storyId: 'shell-document-toolbar--history' },
        { label: 'saving', storyId: 'shell-document-toolbar--saving' },
        { label: 'saved', storyId: 'shell-document-toolbar--saved' },
        { label: 'save failed', storyId: 'shell-document-toolbar--save-failed' },
        { label: 'annotating', storyId: 'shell-document-toolbar--annotating' },
        { label: 'annotation disabled', storyId: 'shell-document-toolbar--annotation-disabled' },
      ]}
    />
  ),
};
