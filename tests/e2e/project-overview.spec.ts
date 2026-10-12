import { newTerminal, workspaceAction, openProjectOverview } from './workspace-ui';
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Mcp } from './mcp';
import { paneLeaves, type ApplicationWorkspaceSnapshot } from '../../src/shared/application-workspace';
import type { TerminalRecord } from '../../src/shared/terminal';

let app: ElectronApplication | undefined, mcp: Mcp | undefined, root: string;
test.afterEach(async () => {
  mcp?.close(); mcp = undefined;
  await app?.close(); app = undefined;
  if (root) await rm(root, {recursive: true, force: true});
});
const invoke = <T>(page: Page, name: string, args: Record<string, unknown> = {}) => page.evaluate(
  ({name,args}) => (window as unknown as {projector: {invoke(name: string,args: Record<string,unknown>): Promise<unknown>}}).projector.invoke(name,args), {name,args},
) as Promise<T>;

test('project overview owns plans and archives without changing history; project plus starts exactly one Codex session', async () => {
  root = await realpath(await mkdtemp(join(tmpdir(),'bp-project-overview-')));
  const project = join(root,'project'), data=join(root,'data'), home=join(root,'home');
  await Promise.all([project,data,home].map(path=>mkdir(path)));
  const descriptor=join(root,'endpoint.json'), audit=join(root,'audit.jsonl'), metadata=join(root,'metadata.json');
  const sessionId='overview-codex-session';
  await writeFile(metadata,JSON.stringify({[sessionId]:{name:'Project agent',source:'cli'}}));
  const launch=()=>electron.launch({
    ...(process.env.PROJECTOR_UI_EXECUTABLE ? {executablePath:process.env.PROJECTOR_UI_EXECUTABLE,args:[]} : {args:[resolve('.')]}),
    env:{...process.env,
    PROJECTOR_DATA:data,PROJECTOR_RUNTIME_DESCRIPTOR:descriptor,CODEX_HOME:home,
    PROJECTOR_E2E_CODEX_EXECUTABLE:resolve('tests/fixtures/codex-cli.mjs'),
    CODEX_FIXTURE_PROJECT:project,CODEX_FIXTURE_EMPTY:'0',CODEX_FIXTURE_ID:sessionId,
    CODEX_FIXTURE_METADATA_FILE:metadata,CODEX_FIXTURE_AUDIT:audit,PROJECTOR_E2E_HARNESS_INTERVAL_MS:'200',
  }});
  app=await launch(); let page=await app.firstWindow();
  await app.evaluate(({dialog},path)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path]});},project);
  await page.getByRole('button',{name:'+ Open project folder',exact:true}).click();
  mcp=new Mcp(descriptor);await mcp.initialize();
  const context=await mcp.tool('get_projector_context',{});
  const projectId=(context.project as {id:string}).id;
  const sidebar=page.locator('.sidebar');
  await expect(page.locator('.feedback-panel')).toBeHidden();
  await expect(sidebar.getByText('Codex sessions', {exact:true})).toHaveCount(0);
  await expect(sidebar.getByRole('button', {name:'Refresh sessions in project',exact:true})).toHaveCount(0);
  await expect(sidebar.getByRole('button',{name:'Project agent',exact:true})).toBeVisible();
  await expect(sidebar.locator('.project-folder')).toHaveCount(0);
  const toggle=sidebar.getByRole('button',{name:'Collapse sessions in project',exact:true});
  await toggle.click();
  await expect(sidebar.getByRole('button',{name:'Expand sessions in project',exact:true})).toHaveAttribute('aria-expanded','false');
  await expect(sidebar.getByRole('button',{name:'Project agent',exact:true})).toHaveCount(0);
  await sidebar.getByRole('button',{name:'Open project project',exact:true}).click();
  await expect(page.locator('.project-dashboard')).toBeVisible();
  await expect(sidebar.getByRole('button',{name:'Expand sessions in project',exact:true})).toHaveAttribute('aria-expanded','false');
  await expect(page.getByText('No plans yet',{exact:true})).toBeVisible();
  await expect(sidebar.getByRole('button',{name:/New plan/})).toHaveCount(0);
  await expect(invoke(page,'createEmptyPlan',{projectId,operationId:randomUUID()})).rejects.toThrow('Unsupported operator command');

  await app.evaluate(({Menu}) => {
    Menu.prototype.popup = function(options) {
      Object.assign(globalThis,{projectMenuLabels:this.items.map(item => item.label)});
      this.items.find(item => item.label === 'Refresh sessions')!.click();
      options?.callback?.();
    };
  });
  await sidebar.getByRole('button',{name:'Project actions for project',exact:true}).click();
  await expect.poll(() => app!.evaluate(() => (globalThis as unknown as {projectMenuLabels:string[]}).projectMenuLabels)).toEqual(['New session','Refresh sessions','','Remove from list']);
  await expect(sidebar.getByRole('button',{name:'Project agent',exact:true})).toHaveCount(0);

  const capture = async (mode: string) => {
    const directory = resolve('.tmp/tasks/shell-simplification-20261013/visual');
    await mkdir(directory, {recursive:true});
    await page.screenshot({path:join(directory, `${process.env.PROJECTOR_UI_VARIANT ?? (process.env.PROJECTOR_E2E_VISIBLE === '1' ? 'visible' : 'hidden')}-${mode}.png`)});
  };
  await capture('project');
  await sidebar.getByRole('button', {name:'Expand sessions in project',exact:true}).click();
  await sidebar.getByRole('button', {name:'Project agent',exact:true}).click();
  await expect(page.locator('.session-home')).toBeVisible();
  await expect(page.locator('.feedback-panel')).toBeHidden();
  await expect(page.locator('.workspace-tools')).toHaveCount(0);
  await expect(page.getByRole('button', {name:'New terminal',exact:true})).toHaveCount(0);
  await expect(page.getByText(sessionId,{exact:true})).toBeHidden();
  await page.locator('.session-details summary').click();
  await expect(page.getByText(sessionId,{exact:true})).toBeVisible();
  await app.evaluate(({clipboard}) => { clipboard.writeText = async text => { Object.assign(globalThis,{copiedSessionDetail:text}); }; });
  await page.getByRole('button',{name:'Copy session ID',exact:true}).click();
  expect(await app.evaluate(() => (globalThis as unknown as {copiedSessionDetail:string}).copiedSessionDetail)).toBe(sessionId);
  await page.locator('.session-details summary').click();
  await capture('session');
  await page.getByRole('button',{name:'Workspace actions',exact:true}).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem',{name:'Split right',exact:true})).toBeFocused();
  await expect(page.getByRole('menuitem',{name:'Close panel',exact:true})).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button',{name:'Workspace actions',exact:true})).toBeFocused();
  await newTerminal(page);
  await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
  await expect(page.locator('.feedback-panel')).toBeHidden();
  await expect(page.locator('.workspace-pane.active')).toHaveCSS('background-color','rgb(255, 255, 255)');
  await capture('terminal');
  await workspaceAction(page,'Split right');
  await expect.poll(async () => (await invoke<{terminals:TerminalRecord[]}>(page,'applicationSnapshot')).terminals.length).toBe(2);
  await workspaceAction(page,'All terminals');
  await expect(page.getByRole('menu',{name:'All terminals',exact:true}).getByRole('menuitem',{name:'Shell · running',exact:true})).toHaveCount(2);
  await page.getByRole('menuitem',{name:'Shell · running',exact:true}).first().click();
  expect((await invoke<{terminals:TerminalRecord[]}>(page,'applicationSnapshot')).terminals).toHaveLength(2);
  await page.getByRole('button',{name:'Workspace actions',exact:true}).click();
  await page.locator('.tree-heading').click();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await openProjectOverview(page);

  const originSession={harness:'codex',sessionId:'explicit-plan-author'};
  const plan=await mcp.tool('create_artifact',{projectId,kind:'projector',title:'Project decision',originSession,operationId:randomUUID()});
  await writeFile(join(String(plan.sourcePath),'plan.mdx'),'# Project decision\n\n<TextAnswer id="choice" meaning="Decision" semanticsVersion="1" defaultValue="" />');
  const revision=await mcp.tool('publish_artifact',{artifactId:plan.artifactId,expectedLatestRevision:null,operationId:randomUUID()});
  await expect(page.getByRole('region',{name:'Project plans'}).getByRole('button',{name:'Project decision',exact:true})).toBeVisible();
  await expect(sidebar.locator('.plan-row')).toHaveCount(0);
  await expect(sidebar.getByRole('button',{name:'Project decision',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Project decision',exact:true}).click();
  await page.frameLocator('iframe').getByLabel('Decision',{exact:true}).fill('Private project answer');
  await expect(page.getByText('Saved locally',{exact:true})).toBeVisible();
  await expect(page.locator('.feedback-panel')).toBeVisible();
  await capture('plan');
  await page.getByRole('button',{name:'Hide feedback sidebar',exact:true}).click();
  await openProjectOverview(page);
  await expect(page.locator('.feedback-panel')).toBeHidden();
  await page.getByRole('button',{name:'Project decision',exact:true}).click();
  await expect(page.locator('.feedback-panel')).toBeHidden();
  await page.getByRole('button',{name:'Show feedback sidebar',exact:true}).click();
  await expect(page.locator('.feedback-panel')).toBeVisible();
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(980,800));
  await page.getByRole('button',{name:'Workspace actions',exact:true}).click();
  const menuBounds = (await page.getByRole('menu',{name:'Workspace actions',exact:true}).boundingBox())!;
  expect(menuBounds.x).toBeGreaterThanOrEqual(0);
  expect(menuBounds.x + menuBounds.width).toBeLessThanOrEqual(980);
  await capture('plan-minimum-menu');
  await page.keyboard.press('Escape');

  expect(await mcp.tool('read_artifact',{artifactId:plan.artifactId,part:'state'})).toMatchObject({savedState:null});
  await openProjectOverview(page);
  await page.getByRole('button',{name:'Archive plan Project decision',exact:true}).click();
  await expect(page.getByRole('button',{name:'Project decision',exact:true})).toHaveCount(0);
  const manifestPath=join(project,'.projector','artifacts',String(plan.artifactId),'artifact.json');
  expect(JSON.parse(await readFile(manifestPath,'utf8'))).toMatchObject({archived:true,originSession});
  expect(await mcp.tool('read_artifact',{artifactId:plan.artifactId,part:'manifest'})).toMatchObject({revisionId:revision.revisionId,originSession});
  await page.getByLabel('Show archived plans',{exact:true}).check();
  await expect(page.getByRole('button',{name:'Restore plan Project decision',exact:true})).toBeVisible();
  mcp.close();mcp=undefined;await app.close();app=await launch();page=await app.firstWindow();
  // Project surface itself restores, without first activating a retained document.
  await expect(page.locator('.project-dashboard')).toBeVisible();
  await expect(page.locator('iframe')).toHaveCount(0);
  await expect(page.getByLabel('Show archived plans',{exact:true})).not.toBeChecked();
  await expect(page.getByRole('button',{name:'Project decision',exact:true})).toHaveCount(0);
  await page.getByLabel('Show archived plans',{exact:true}).check();
  await page.getByRole('button',{name:'Restore plan Project decision',exact:true}).click();
  await page.getByLabel('Show archived plans',{exact:true}).uncheck();
  await page.getByRole('button',{name:'Project decision',exact:true}).click();
  await expect(page.frameLocator('iframe').getByLabel('Decision',{exact:true})).toHaveValue('Private project answer');
  expect(JSON.parse(await readFile(manifestPath,'utf8'))).toMatchObject({archived:false,originSession});
  mcp=new Mcp(descriptor); await mcp.initialize();
  expect(await mcp.tool('read_artifact',{artifactId:plan.artifactId,part:'manifest'})).toMatchObject({revisionId:revision.revisionId,originSession});

  const sessionState = await invoke<ApplicationWorkspaceSnapshot>(page,'applicationSnapshot');
  const sessionKey = `${projectId}/${sessionId}`;
  for (const tab of sessionState.workspaces[sessionKey].tabs.filter(tab => !paneLeaves(tab.root).some(pane => pane.content.kind === 'session'))) {
    if (!tab.root || tab.root.kind !== 'pane' || tab.root.content.kind !== 'session')
      await invoke(page,'applicationCommand',{action:'closeTab',projectId,key:sessionKey,tabId:tab.id});
  }
  // An operator's doubled activation creates one owned backend/TUI, never two.
  await page.getByRole('button',{name:'New Codex session in project',exact:true}).evaluate(button=>{
    button.dispatchEvent(new MouseEvent('click',{bubbles:true}));
    button.dispatchEvent(new MouseEvent('click',{bubbles:true}));
  });
  const state=()=>invoke<ApplicationWorkspaceSnapshot & {terminals:TerminalRecord[]}>(page,'applicationSnapshot');
  await expect.poll(async()=> (await state()).terminals.filter(record=>record.harnessSessionId===sessionId && record.status==='running').length).toBe(1);
  await expect.poll(async()=> (await state()).selectedWorkspace).toBe(`${projectId}/${sessionId}`);
  await expect(page.locator('.sidebar').getByRole('button',{name:'Collapse sessions in project',exact:true})).toHaveAttribute('aria-expanded','true');
  const requests=(await readFile(audit,'utf8')).trim().split('\n').map(line=>JSON.parse(line) as {method?:string;params?:{ephemeral?:boolean}});
  expect(requests.filter(event=>event.method==='thread/start'&&event.params?.ephemeral===false)).toHaveLength(1);
  expect(requests.some(event=>event.method==='thread/resume')).toBe(false);
  await openProjectOverview(page);
  await expect(page.getByRole('button',{name:'Project decision',exact:true})).toBeVisible();
  expect((await state()).terminals.filter(record=>record.harnessSessionId===sessionId&&record.status==='running')).toHaveLength(1);
  // Reopening a session terminal selects its existing workspace, rather than
  // reclassifying it as a shared project terminal or launching another process.
  await page.getByRole('region', { name: 'Project terminals', exact: true })
    .getByRole('button', { name: 'Codex · running · session', exact: true }).click();
  await expect.poll(async () => (await state()).selectedWorkspace).toBe(`${projectId}/${sessionId}`);
  expect((await state()).bottom[projectId]?.tabs ?? []).toHaveLength(0);
  await openProjectOverview(page);
  await page.getByRole('region', { name: 'Project terminals', exact: true })
    .getByRole('button', { name: 'New project terminal', exact: true }).click();
  await expect(page.locator('.project-dashboard')).toBeVisible();
  await expect.poll(async () => (await state()).bottom[projectId]?.tabs.length).toBe(1);
  const finalState = await state();
  expect(finalState.selectedSurface).toBe('project');
  expect(finalState.workspaces[`${projectId}/${sessionId}`].tabs).toHaveLength(1);
  expect(finalState.terminals.filter(record => record.kind === 'codex')).toHaveLength(1);
  await page.locator('.project-row').first().hover();
  const iconOffsets = await page.locator('button:has(> svg:only-child)').evaluateAll(buttons => buttons.flatMap(button => {
    const icon = button.firstElementChild;
    if (!icon) return [];
    const box = button.getBoundingClientRect(), glyph = icon.getBoundingClientRect();
    if (!box.width || !box.height) return [];
    return [{ name: button.getAttribute('aria-label'), x: Math.abs(box.x + box.width / 2 - glyph.x - glyph.width / 2), y: Math.abs(box.y + box.height / 2 - glyph.y - glyph.height / 2) }];
  }));
  expect(iconOffsets.length).toBeGreaterThan(5);
  expect(iconOffsets.filter(offset => offset.x > 0.5 || offset.y > 0.5)).toEqual([]);
  await page.screenshot({path:'.tmp/project-overview.png'});
});
