import type { StoryObj } from '@storybook/react-vite';
import { expect, waitFor } from 'storybook/test';
import { ShellFixture } from './shell';
type Play = NonNullable<StoryObj<typeof ShellFixture>['play']>;
export function shellTransition(surface: string, transition: string): Play {
  return async ({ canvas, userEvent, args, canvasElement }) => {
    const initialDialog = canvas.queryByRole('dialog');
    if (initialDialog) await waitFor(() => expect(initialDialog).toBeVisible());
    const click = async (name: string) => userEvent.click(canvas.getByRole('button', { name }));
    switch (surface) {
      case 'window-chrome': {
        const left = transition === 'left-toggle';
        await click(`Hide ${left ? 'projects' : 'feedback'} sidebar`);
        await expect(
          canvas.getByRole('button', { name: `Show ${left ? 'projects' : 'feedback'} sidebar` }),
        ).toBeVisible();
        await expect(args.onAction).toHaveBeenCalledWith(transition);
        break;
      }
      case 'project-tree':
        if (transition === 'disclosure') {
          await click('Collapse sessions in project');
          await expect(
            canvas.getByRole('button', { name: 'Expand sessions in project' }),
          ).toHaveAttribute('aria-expanded', 'false');
        } else {
          await click(transition === 'select' ? 'Open project project' : '+ Open project folder');
          await expect(args.onAction).toHaveBeenCalledWith(
            transition === 'select' ? 'select' : 'open-folder',
          );
          if (transition === 'select')
            await expect(canvas.getByRole('button', { name: 'Open project project' })).toHaveClass(
              'current',
            );
          else
            await expect(
              canvas.getByRole('button', { name: 'Open project project' }),
            ).toBeVisible();
        }
        break;
      case 'workspace-tabs':
        if (transition === 'new-tab') {
          const n = canvas.getAllByRole('tab').length;
          await click('New tab');
          await expect(canvas.getAllByRole('tab')).toHaveLength(n + 1);
          await expect(canvas.getAllByRole('tab', { name: 'New tab' }).at(-1)).toHaveAttribute(
            'aria-selected',
            'true',
          );
        } else if (transition === 'close') {
          await click('Close plan tab');
          await expect(canvas.queryByRole('tab', { name: 'Plan' })).toBeNull();
          await expect(canvas.getByRole('tab', { name: 'New tab' })).toHaveAttribute(
            'aria-selected',
            'true',
          );
          await expect(canvas.queryByRole('button', { name: 'Close codex tab' })).toBeNull();
        } else {
          await userEvent.click(canvas.getByRole('tab', { name: /Browser/ }));
          await expect(canvas.getByRole('tab', { name: /Browser/ })).toHaveAttribute(
            'aria-selected',
            'true',
          );
        }
        break;
      case 'other-sessions':
        await userEvent.click(canvas.getByText('Other sessions', { selector: 'summary' }));
        await expect(canvas.getByRole('button', { name: 'Read metadata' })).toBeVisible();
        if (transition === 'metadata') {
          await click('Read metadata');
          await waitFor(() =>
            expect(canvas.getByRole('dialog', { name: 'Codex session metadata' })).toBeVisible(),
          );
        }
        break;
      case 'session-home':
        if (transition === 'details') {
          await userEvent.click(canvas.getByText('Details', { selector: 'summary' }));
          await expect(canvas.getByRole('button', { name: 'Copy session ID' })).toBeVisible();
        } else {
          await click(
            transition === 'resume'
              ? 'Resume'
              : transition === 'new'
                ? 'Start new session'
                : 'Open terminal',
          );
          await expect(args.onAction).toHaveBeenCalledWith(transition);
          await expect(canvas.getByRole('button', { name: 'Open terminal' })).toBeVisible();
        }
        break;
      case 'plan-toolbar':
        if (transition === 'version') {
          await userEvent.selectOptions(
            canvas.getByRole('combobox', { name: 'Document version' }),
            'version-1',
          );
          await expect(canvas.getByRole('combobox', { name: 'Document version' })).toHaveValue(
            'version-1',
          );
        } else {
          await click('Annotate document');
          await expect(canvas.getByRole('button', { name: 'Annotate document' })).toHaveAttribute(
            'aria-pressed',
            'true',
          );
        }
        break;
      case 'browser-toolbar':
        if (transition === 'address' || transition === 'navigate') {
          const input = canvas.getByRole('textbox', { name: 'Browser address' });
          await userEvent.clear(input);
          await userEvent.type(input, 'https://example.invalid/catalog');
          await expect(input).toHaveValue('https://example.invalid/catalog');
          if (transition === 'navigate') {
            await userEvent.keyboard('{Enter}');
            await expect(canvas.getByRole('button', { name: 'Stop' })).toBeVisible();
          }
        } else if (transition === 'zoom') {
          await userEvent.selectOptions(
            canvas.getByRole('combobox', { name: 'Browser zoom' }),
            '1.5',
          );
          await expect(canvas.getByRole('combobox', { name: 'Browser zoom' })).toHaveValue('1.5');
        } else if (transition === 'stop') {
          await click('Stop');
          await expect(canvas.getByRole('button', { name: 'Reload' })).toBeVisible();
        } else {
          await click('Annotate browser');
          await expect(canvas.getByRole('button', { name: 'Annotate browser' })).toHaveAttribute(
            'aria-pressed',
            'true',
          );
        }
        break;
      case 'workspace-empty':
        if (transition === 'copy') {
          await click('Copy message for agent');
          await expect(canvas.getByRole('button', { name: 'Copied' })).toBeVisible();
        } else {
          await click('Open project folder');
          await expect(args.onAction).toHaveBeenCalledWith('open');
        }
        break;
      case 'bottom-terminals':
        if (transition === 'resize') {
          const separator = canvas.getByRole('separator', { name: 'Resize project terminals' });
          separator.focus();
          await userEvent.keyboard('{ArrowUp}');
          await expect(separator).toHaveAttribute('aria-valuenow', '260');
        } else if (transition === 'toggle') {
          await click('Toggle project terminals');
          await expect(canvas.getByRole('region', { name: 'Project terminals' })).toBeVisible();
          await expect(canvas.queryAllByRole('tab')).toHaveLength(0);
        } else if (transition === 'select') {
          await userEvent.click(canvas.getByRole('tab', { name: 'Review' }));
          await expect(canvas.getByRole('tab', { name: 'Review' })).toHaveAttribute(
            'aria-selected',
            'true',
          );
        } else {
          if (transition === 'new') {
            await userEvent.click(
              canvas.getAllByRole('button', { name: 'New project terminal' })[0],
            );
            await expect(canvas.getByRole('tab', { name: 'Build' })).toBeVisible();
          } else {
            await click('Close Build view');
            await expect(canvas.queryAllByRole('tab')).toHaveLength(0);
          }
          await expect(args.onAction).toHaveBeenCalledWith(transition);
        }
        break;
      case 'save-approval':
        await click(
          transition === 'save'
            ? 'Save'
            : transition === 'retry'
              ? 'Retry Save'
              : transition === 'approve'
                ? 'Approve this version'
                : 'Revoke approval',
        );
        await expect(args.onAction).toHaveBeenCalledWith(transition);
        if (transition === 'save' || transition === 'retry') {
          await expect(canvas.getByRole('button', { name: 'Working…' })).toBeDisabled();
          await waitFor(() => expect(canvas.getByText(/Saved state is unchanged/)).toBeVisible());
          await expect(await canvas.findByRole('button', { name: 'Copy update message' })).toBeVisible();
          await expect(canvas.queryByRole('button', { name: 'Working…' })).not.toBeInTheDocument();
          await expect(canvas.queryByRole('button', { name: 'Retry Save' })).toBeNull();
        }
        await expect(
          canvas.getByRole('button', {
            name: transition === 'approve' ? 'Revoke approval' : 'Approve this version',
          }),
        ).toBeVisible();
        break;
      case 'handoff':
        if (transition === 'select') {
          await userEvent.selectOptions(
            canvas.getByRole('combobox', { name: 'Target Codex session' }),
            'example-session',
          );
          await expect(canvas.getByRole('combobox', { name: 'Target Codex session' })).toHaveValue(
            'example-session',
          );
        } else {
          await click('Copy update message');
          await expect(canvas.getByRole('button', { name: 'Copied' })).toBeVisible();
        }
        break;
      case 'history':
        await userEvent.click(canvas.getByText('Saved states', { selector: 'summary' }));
        await expect(canvas.getByRole('button', { name: 'Copy update message' })).toBeVisible();
        if (transition === 'copy') {
          await click('Copy update message');
          await expect(args.onAction).toHaveBeenCalledWith('copy');
        }
        break;
      case 'rename-plan':
        if (transition === 'edit') {
          await userEvent.clear(canvas.getByRole('textbox', { name: 'Plan name' }));
          await expect(canvas.getByRole('button', { name: 'Save' })).toBeDisabled();
          await userEvent.type(canvas.getByRole('textbox', { name: 'Plan name' }), 'Revised plan');
          await expect(canvas.getByRole('button', { name: 'Save' })).toBeEnabled();
        } else if (transition === 'failure') {
          await waitFor(() =>
            expect(canvas.getByRole('alert')).toHaveTextContent('Could not rename'),
          );
          await expect(canvas.getByRole('button', { name: 'Save' })).toBeEnabled();
        } else {
          await click(transition === 'save' ? 'Save' : 'Cancel');
          if (transition === 'save')
            await expect(canvas.getByRole('button', { name: 'Save' })).toBeDisabled();
          await waitFor(() => expect(canvas.queryByRole('dialog')).toBeNull());
        }
        break;
      case 'session-metadata':
        await click('Close');
        await expect(canvas.queryByRole('dialog')).toBeNull();
        break;
      case 'mcp-connection':
        if (transition === 'close') {
          canvas.getByRole('button', { name: 'Close' }).focus();
          await userEvent.keyboard('{Escape}');
          await expect(canvas.queryByRole('dialog')).toBeNull();
        } else if (transition === 'copy') {
          await click('Copy setup prompt');
          await expect(canvas.getByRole('button', { name: 'Copied' })).toBeVisible();
        } else {
          await userEvent.click(
            canvas.getByText(
              transition === 'prompt'
                ? 'Preview setup prompt'
                : 'Connection details and manual configuration',
              { selector: 'summary' },
            ),
          );
          await expect(canvasElement.querySelectorAll('details[open]')).toHaveLength(1);
        }
        break;
    }
  };
}
