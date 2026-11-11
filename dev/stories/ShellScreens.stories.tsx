import { Isolated } from '../fixtures/components';
import React from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, waitFor } from 'storybook/test';
import { ShellScreen } from '../fixtures/shell-screen';
import { CatalogSheet } from '../fixtures/CatalogSheet';
async function documentFrameIsRendered(canvasElement: HTMLElement) {
  const frame = canvasElement.querySelector<HTMLIFrameElement>('iframe.document-frame');
  await waitFor(() =>
    expect(
      frame?.contentDocument?.querySelector('.surface > article.plan-document'),
    ).toBeTruthy(),
  );
  const article = frame!.contentDocument!.querySelector('article.plan-document')!;
  await expect(frame!.contentWindow!.getComputedStyle(article).fontSize).toBe('14px');
  await expect(frame!.contentDocument!.documentElement.scrollHeight).toBeGreaterThan(
    frame!.clientHeight,
  );
}
const meta = {
  title: 'Screens/Application',
  component: ShellScreen,
  decorators: [
    (Story) => (
      <Isolated showNotices={false}>
        <Story />
      </Isolated>
    ),
  ],
  args: { screen: 'welcome', onAction: fn() },
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Shared production ShellLayout, chrome, panels and real content. Native browser content intentionally stays an empty boundary; navigation and PTY use local adapters.',
      },
    },
  },
} satisfies Meta<typeof ShellScreen>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Welcome: Story = {
  parameters: { catalog: { states: ['application-screen.welcome'] } },
  play: async ({ canvas }) => {
    await expect(canvas.queryAllByRole('tab')).toHaveLength(0);
    await expect(canvas.queryByRole('button', { name: 'Open project project' })).toBeNull();
    await expect(canvas.queryByRole('button', { name: 'Workspace actions' })).toBeNull();
    await expect(canvas.getByRole('button', { name: 'New tab' })).toBeDisabled();
    await expect(canvas.getByRole('button', { name: 'Show feedback sidebar' })).toBeDisabled();
    await expect(canvas.queryByRole('button', { name: 'Save' })).toBeNull();
  },
};
export const Project: Story = {
  args: { screen: 'project' },
  parameters: { catalog: { states: ['application-screen.project'] } },
  play: async ({ canvas, userEvent }) => {
    await expect(canvas.queryAllByRole('tab')).toHaveLength(0);
    await expect(canvas.getByRole('button', { name: 'Show feedback sidebar' })).toBeDisabled();
    await expect(canvas.queryByRole('button', { name: 'Save' })).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: 'Workspace actions' }));
    await expect(canvas.getByRole('menuitem', { name: 'Split right' })).toBeDisabled();
    await userEvent.keyboard('{Escape}');
  },
};
export const Session: Story = {
  args: { screen: 'session' },
  parameters: { catalog: { states: ['application-screen.session'] } },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('tab', { name: 'Codex' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(canvas.queryByRole('button', { name: 'Annotate document' })).toBeNull();
    await expect(canvas.queryByRole('button', { name: 'Save' })).toBeNull();
    await expect(canvas.getByRole('button', { name: 'Show feedback sidebar' })).toBeDisabled();
  },
};
export const Document: Story = {
  args: { screen: 'document' },
  parameters: { catalog: { states: ['application-screen.document'] } },
  play: async ({ canvas, canvasElement }) => {
    await documentFrameIsRendered(canvasElement);
    await expect(canvas.getByRole('button', { name: 'Annotate document' })).toBeEnabled();
    await expect(canvas.getByRole('button', { name: 'Save' })).toBeEnabled();
    await expect(canvas.getByRole('button', { name: 'Hide feedback sidebar' })).toBeEnabled();
  },
};
export const Browser: Story = {
  args: { screen: 'browser' },
  parameters: { catalog: { states: ['application-screen.browser'] } },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('combobox', { name: 'Document version' })).toBeVisible();
    await expect(canvas.getByRole('textbox', { name: 'Browser address' })).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Annotate document' })).toBeNull();
    await expect(canvas.getByRole('button', { name: 'Save' })).toBeEnabled();
  },
};
export const Terminal: Story = {
  args: { screen: 'terminal' },
  parameters: { catalog: { states: ['application-screen.terminal'] } },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('tab', { name: 'Terminal' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(canvas.queryByRole('combobox', { name: 'Document version' })).toBeNull();
    await expect(canvas.queryByRole('button', { name: 'Save' })).toBeNull();
  },
};
export const Split: Story = {
  args: { screen: 'split' },
  parameters: { catalog: { states: ['application-screen.split'] } },
  play: async ({ canvas, canvasElement }) => {
    await documentFrameIsRendered(canvasElement);
    await expect(canvas.getByRole('tab', { name: 'Plan · 2' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(canvas.getByRole('separator')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Save' })).toBeEnabled();
  },
};
export const ProjectToSession: Story = {
  args: Project.args,
  parameters: { catalog: { transitions: ['application-screen.project-session'] } },
  play: async ({ canvas, userEvent, args }) => {
    await userEvent.click(
      canvas.getAllByRole('button', { name: 'Review the interface catalog' })[0],
    );
    await expect(canvas.getByRole('button', { name: 'Resume' })).toBeVisible();
    await expect(args.onAction).toHaveBeenCalledWith('session');
  },
};
export const SessionToDocument: Story = {
  args: Session.args,
  parameters: { catalog: { transitions: ['application-screen.session-document'] } },
  play: async ({ canvas, userEvent, args }) => {
    await userEvent.click(canvas.getByRole('tab', { name: 'Plan' }));
    await expect(canvas.getByRole('button', { name: 'Annotate document' })).toBeVisible();
    await expect(args.onAction).toHaveBeenCalledWith('document');
  },
};
export const DocumentToBrowser: Story = {
  args: Document.args,
  parameters: { catalog: { transitions: ['application-screen.document-browser'] } },
  play: async ({ canvas, userEvent, args }) => {
    await userEvent.click(canvas.getByRole('tab', { name: 'Browser' }));
    await expect(canvas.getByRole('textbox', { name: 'Browser address' })).toBeVisible();
    await expect(args.onAction).toHaveBeenCalledWith('browser');
  },
};
export const TerminalToSplit: Story = {
  args: Terminal.args,
  parameters: { catalog: { transitions: ['application-screen.terminal-split'] } },
  play: async ({ canvas, userEvent, args }) => {
    await userEvent.click(canvas.getByRole('button', { name: 'Workspace actions' }));
    await userEvent.click(canvas.getByRole('menuitem', { name: 'Split right' }));
    await expect(canvas.getByRole('separator')).toBeVisible();
    await expect(args.onAction).toHaveBeenCalledWith('split');
    await expect(canvas.getByRole('tab', { name: 'Terminal · 2' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(canvas.queryByRole('button', { name: 'Annotate document' })).toBeNull();
    await expect(canvas.queryByRole('button', { name: 'Save' })).toBeNull();
  },
};
export const DarkWorkspace: Story = {
  args: { screen: 'split', appearance: 'dark' },
  render: (args) => <div data-appearance="dark"><ShellScreen {...args} /></div>,
  parameters: { catalog: { states: ['application-screen.dark'] } },
  play: async ({ canvasElement }) => {
    await documentFrameIsRendered(canvasElement);
    const frame = canvasElement.querySelector<HTMLIFrameElement>('iframe.document-frame')!;
    await expect(frame.contentWindow!.getComputedStyle(frame.contentDocument!.documentElement).colorScheme).toBe('dark');
    await expect(canvasElement.querySelector('.sidebar')).toHaveStyle({ backgroundColor: 'rgb(16, 17, 20)' });
    await expect(canvasElement.querySelector('.terminal-pane')).toHaveStyle({ backgroundColor: 'rgb(23, 25, 29)' });
    await expect(canvasElement.querySelector('.feedback-panel')).toHaveStyle({ backgroundColor: 'rgb(32, 34, 38)' });
  },
};
export const StateSheet: Story = {
  render: () => (
    <div className="catalog-screen-sheet">
      <CatalogSheet
        height={740}
        frames={['welcome', 'project', 'session', 'document', 'browser', 'terminal', 'split', 'dark-workspace'].map(
          (name) => ({ label: name, storyId: `screens-application--${name}` }),
        )}
      />
    </div>
  ),
};
