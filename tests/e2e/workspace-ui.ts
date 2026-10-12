import { expect, type Page } from '@playwright/test';

export async function openProjectOverview(page: Page): Promise<void> {
  await page.locator('.project-name.current').click();
}
export async function newTerminal(page: Page): Promise<void> {
  await page
    .getByRole('toolbar', { name: 'Window toolbar', exact: true })
    .getByRole('button', { name: 'New tab', exact: true })
    .click();
  await page.getByRole('menuitem', { name: 'New terminal', exact: true }).click();
}
export async function newBrowserTab(page: Page): Promise<void> {
  await page
    .getByRole('toolbar', { name: 'Window toolbar', exact: true })
    .getByRole('button', { name: 'New tab', exact: true })
    .click();
  await page.getByRole('menuitem', { name: 'New browser tab', exact: true }).click();
}
export async function workspaceAction(page: Page, label: string): Promise<void> {
  await page.getByRole('button', { name: 'Workspace actions', exact: true }).click();
  await page.getByRole('menuitem', { name: label, exact: true }).click();
}
export async function expectNewTerminalEnabled(page: Page): Promise<void> {
  await page
    .getByRole('toolbar', { name: 'Window toolbar', exact: true })
    .getByRole('button', { name: 'New tab', exact: true })
    .click();
  await expect(page.getByRole('menuitem', { name: 'New terminal', exact: true })).toBeEnabled();
  await page.keyboard.press('Escape');
}
