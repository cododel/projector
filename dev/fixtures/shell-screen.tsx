import { SessionActions } from '../../src/renderer/SessionActions';
import { WorkspaceMenu } from '../../src/renderer/WorkspaceMenu';
import { SidebarToggle, SidebarUtilities } from '../../src/renderer/shell/SidebarUtilities';
import { createPortal } from 'react-dom';
import documentCSS from '../../src/renderer/style.css?inline';
import React, { useMemo, useState } from 'react';
import { ShellLayout, ShellSidebar, ShellWorkspace } from '../../src/renderer/shell/ShellLayout';
import { WindowTitlebar } from '../../src/renderer/shell/WindowTitlebar';
import { WorkspaceTabs } from '../../src/renderer/shell/WorkspaceTabs';
import { ProjectTree } from '../../src/renderer/shell/ProjectTree';
import { SessionHome } from '../../src/renderer/shell/SessionHome';
import { Welcome } from '../../src/renderer/shell/Welcome';
import { PlanToolbar } from '../../src/renderer/shell/PlanToolbar';
import { BrowserToolbar } from '../../src/renderer/shell/BrowserToolbar';
import { ProjectDashboard } from '../../src/renderer/ProjectDashboard';
import { WorkspaceSplit } from '../../src/renderer/WorkspaceSplit';
import { TerminalPane } from '../../src/renderer/TerminalPane';
import { DocumentContent, DocumentArticle } from '../../src/renderer/document/DocumentContent';
import { AnnotationList } from '../../src/renderer/document/AnnotationList';
import { SaveApproval } from '../../src/renderer/shell/SaveApproval';
import { Icon } from '../../src/renderer/Icon';
import { DEFAULT_SETTINGS } from '../../src/shared/application-workspace';
import { shellSession } from './shell';
import { documentBlocks, documentWidgets } from './document';
import { terminal } from './components';
import { terminalAdapter } from './components-terminal';
/** Same iframe/CSS/article presentation as the app, without the projector document bridge. */
function CatalogDocumentFrame({ children }: { children: React.ReactNode }) {
  const [mount, setMount] = useState<HTMLElement | null>(null);
  return (
    <>
      <iframe
        className="document-frame"
        title="Projector document"
        sandbox="allow-scripts allow-same-origin"
        srcDoc={`<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>${documentCSS}</style></head><body><div id="root"></div></body></html>`}
        onLoad={(event) =>
          setMount(event.currentTarget.contentDocument?.getElementById('root') ?? null)
        }
      />
      {mount && createPortal(children, mount)}
    </>
  );
}
export function ShellScreen({
  screen,
  onAction,
}: {
  screen: string;
  onAction: (name: string) => void;
}) {
  const [current, setCurrent] = useState(screen),
    [collapsed, setCollapsed] = useState(new Set<string>()),
    [left, setLeft] = useState(true),
    [right, setRight] = useState(true),
    [splitSource, setSplitSource] = useState<'document' | 'terminal'>('document'),
    [splitDocumentActive, setSplitDocumentActive] = useState(true),
    [address, setAddress] = useState('https://example.invalid/'),
    [annotating, setAnnotating] = useState(false),
    [values, setValues] = useState<Record<string, string | string[]>>({}),
    [details, setDetails] = useState<Record<string, boolean>>({}),
    [status, setStatus] = useState<'running' | 'exited'>('running'),
    [splitStatus, setSplitStatus] = useState<'running' | 'exited'>('running');
  const adapter = useMemo(() => terminalAdapter(terminal.id, false, setStatus), []);
  const splitTerminalId = 'catalog-split-terminal';
  const splitAdapter = useMemo(() => terminalAdapter(splitTerminalId, false, setSplitStatus), []);
  const feedbackAvailable =
    current === 'document' || current === 'browser' || (current === 'split' && splitDocumentActive);
  const rightVisible = feedbackAvailable && right;
  const appMode = current !== 'welcome';
  const projectOverview = current === 'project';
  const documentSelected = current === 'document' || (current === 'split' && splitDocumentActive);
  const hasActivePane = appMode && !projectOverview;
  const go = (next: string) => {
    if (next === 'split') {
      setSplitSource(current === 'document' ? 'document' : 'terminal');
      setSplitDocumentActive(false);
    }
    setCurrent(next);
    onAction(next);
  };
  const plan = {
    id: 'catalog-plan',
    projectId: 'example-project',
    title: 'Interface review',
    latestRevision: 'v1',
    originSession: null,
  };
  const document = (
    <CatalogDocumentFrame>
      <div className="surface">
        <DocumentArticle>
          <DocumentContent
            blocks={documentBlocks}
            widgets={documentWidgets}
            values={values}
            details={details}
            update={(id, value) => setValues((previous) => ({ ...previous, [id]: value }))}
            onDetailsChange={(id, open) => setDetails((previous) => ({ ...previous, [id]: open }))}
          />
        </DocumentArticle>
      </div>
    </CatalogDocumentFrame>
  );
  const terminalPane = (
    <TerminalPane
      record={{ ...terminal, projectId: 'example-project', cwd: '/example/project', status }}
      viewId="catalog-screen-terminal"
      active={false}
      settings={DEFAULT_SETTINGS}
      bridge={adapter.bridge}
      onFocus={() => onAction('focus')}
      onChange={() => onAction('terminal-change')}
    />
  );
  let content: React.ReactNode;
  if (current === 'welcome') content = <Welcome onChooseProject={() => go('project')} />;
  else if (current === 'project')
    content = (
      <ProjectDashboard
        project={{ id: 'example-project', path: '/example/project' }}
        plans={[plan]}
        sessions={[shellSession]}
        terminals={[]}
        busy={false}
        showArchived={false}
        onShowArchived={() => onAction('show-archived')}
        onOpenPlan={() => go('document')}
        onPlanMenu={() => onAction('plan-menu')}
        onArchive={() => onAction('archive')}
        onSession={() => go('session')}
        onTerminal={() => go('terminal')}
        onNewTerminal={() => go('terminal')}
        onWorkspace={() => go('session')}
      />
    );
  else if (current === 'session')
    content = (
      <SessionHome
        session={shellSession}
        busy={false}
        onCopy={() => onAction('copy')}
        onOpenTerminal={() => go('terminal')}
        onResume={() => onAction('resume')}
      />
    );
  else if (current === 'document') content = document;
  else if (current === 'browser') content = <div className="browser-area" />;
  else if (current === 'split')
    content = (
      <WorkspaceSplit
        node={{
          kind: 'split',
          id: 'split-1',
          axis: 'horizontal',
          ratio: 0.5,
          first: {
            kind: 'pane',
            id: 'document-pane',
            content:
              splitSource === 'document'
                ? {
                    kind: 'plan',
                    artifactId: plan.id,
                    tab: { id: 'document', kind: 'document', revisionId: 'v1' },
                  }
                : { kind: 'terminal', terminalId: terminal.id },
          },
          second: {
            kind: 'pane',
            id: 'terminal-pane',
            content: { kind: 'terminal', terminalId: splitTerminalId },
          },
        }}
        activePaneId={splitDocumentActive ? 'document-pane' : 'terminal-pane'}
        renderPane={(pane) =>
          pane.id === 'document-pane' ? (
            splitSource === 'document' ? (
              document
            ) : (
              terminalPane
            )
          ) : (
            <TerminalPane
              record={{
                ...terminal,
                projectId: 'example-project',
                cwd: '/example/project',
                id: splitTerminalId,
                title: 'Split terminal',
                status: splitStatus,
              }}
              viewId="catalog-screen-split-terminal"
              active={false}
              settings={DEFAULT_SETTINGS}
              bridge={splitAdapter.bridge}
              onFocus={() => onAction('focus')}
              onChange={() => onAction('terminal-change')}
            />
          )
        }
        onRatio={async () => {
          onAction('resize');
        }}
        onResizeMode={() => onAction('resize-mode')}
      />
    );
  else content = terminalPane;
  return (
    <ShellLayout
      leftVisible={left}
      rightVisible={rightVisible}
      style={
        {
          height: 720,
          width: '100%',
          '--left-sidebar-width': '260px',
          '--right-sidebar-width': rightVisible ? '310px' : '0px',
          '--left-sidebar-content-width': '260px',
          '--right-sidebar-content-width': '310px',
        } as React.CSSProperties
      }
    >
      <WindowTitlebar
        leftSidebarVisible={left}
        rightSidebarVisible={rightVisible}
        sidebarToggle={(side) => (
          <SidebarToggle
            side={side}
            visible={side === 'left' ? left : rightVisible}
            disabled={side === 'right' && !feedbackAvailable}
            onToggle={() => (side === 'left' ? setLeft(!left) : setRight(!right))}
          />
        )}
        tabs={
          <>
            <WorkspaceTabs
              label="Workspace tabs"
              busy={false}
              visible={appMode}
              items={
                projectOverview || !appMode
                  ? []
                  : [
                      {
                        id: 'session',
                        title: 'Codex',
                        glyph: '›_',
                        pinned: true,
                        active: current === 'session',
                        closeLabel: 'Close codex tab',
                      },
                      {
                        id: 'document',
                        title: 'Plan',
                        glyph: '▤',
                        pinned: false,
                        active: documentSelected,
                        count: current === 'split' && splitDocumentActive ? 2 : 1,
                        closeLabel: 'Close plan tab',
                      },
                      {
                        id: 'browser',
                        title: 'Browser',
                        glyph: '◎',
                        pinned: false,
                        active: current === 'browser',
                        closeLabel: 'Close browser tab',
                      },
                      {
                        id: 'terminal',
                        title: 'Terminal',
                        glyph: '›_',
                        pinned: false,
                        active:
                          current === 'terminal' || (current === 'split' && !splitDocumentActive),
                        count: current === 'split' && !splitDocumentActive ? 2 : 1,
                        closeLabel: 'Close terminal tab',
                      },
                    ]
              }
              onSelect={go}
              onClose={() => onAction('close-tab')}
            />
            {appMode ? (
              <WorkspaceMenu
                label="New tab"
                icon="plus"
                items={[
                  { label: 'New terminal', action: () => go('terminal') },
                  { label: 'New browser tab', action: () => go('browser') },
                ]}
              />
            ) : (
              <button className="new-tab" title="New tab" aria-label="New tab" disabled>
                <Icon name="plus" />
              </button>
            )}
          </>
        }
        actions={
          appMode && (
            <div
              className="titlebar-workspace-actions"
              role="toolbar"
              aria-label="Workspace controls"
            >
              <button
                aria-label="Toggle project terminals"
                title="Project terminals"
                onClick={() => onAction('bottom-panel')}
              >
                <Icon name="terminal" />
              </button>
              <WorkspaceMenu
                label="Workspace actions"
                icon="more"
                items={[
                  { label: 'Split right', disabled: !hasActivePane, action: () => go('split') },
                  { label: 'Split down', disabled: !hasActivePane, action: () => go('split') },
                  ...(hasActivePane && current !== 'session'
                    ? [{ label: 'Close panel', action: () => onAction('close-panel') }]
                    : []),
                  {
                    label: 'All terminals',
                    children: projectOverview
                      ? []
                      : [{ label: 'Project terminal · running', action: () => go('terminal') }],
                  },
                ]}
              />
            </div>
          )
        }
      />
      <ShellSidebar side="left">
        <ProjectTree
          projects={appMode ? [{ id: 'example-project', path: '/example/project' }] : []}
          sessions={appMode ? [shellSession] : []}
          projectId="example-project"
          activeProjectId="example-project"
          activeSessionId={appMode && !projectOverview ? shellSession.id : undefined}
          collapsed={collapsed}
          pinnedSessions={[]}
          busy={false}
          onCollapsed={setCollapsed}
          pinOrder={() => 0}
          sessionActions={(session) => (
            <SessionActions
              title={session.title}
              pinned={false}
              pending={false}
              onPin={() => onAction('pin')}
              onArchive={() => onAction('archive')}
            />
          )}
          onProject={() => go('project')}
          onProjectMenu={() => onAction('project-menu')}
          onNewSession={() => go('session')}
          onSession={() => go('session')}
          onMetadata={() => onAction('metadata')}
          onChooseProject={() => onAction('choose-project')}
        />
        <SidebarUtilities
          onSettings={() => onAction('settings')}
          onGuide={() => onAction('guide')}
          onMcp={() => onAction('mcp')}
        />
      </ShellSidebar>
      <ShellWorkspace>
        {documentSelected && (
          <header className="plan-header">
            <PlanToolbar
              revisionId="v1"
              revisions={['v1']}
              approved={false}
              draft={false}
              busy={false}
              documentActive
              saveStatus="Saved privately"
              areaMode={annotating}
              canAnnotate
              onVersion={() => onAction('version')}
              onAnnotate={() => setAnnotating(!annotating)}
            />
          </header>
        )}
        {current === 'browser' && (
          <header className="plan-header browser-plan-header">
            <PlanToolbar
              revisionId="v1"
              revisions={['v1']}
              approved={false}
              draft={false}
              busy={false}
              documentActive={false}
              saveStatus="Saved privately"
              areaMode={false}
              canAnnotate={false}
              onVersion={() => onAction('version')}
              onAnnotate={() => {}}
            />
            <span className="toolbar-divider" aria-hidden="true" />
            <BrowserToolbar
              activeBrowser={{
                loading: false,
                canGoBack: false,
                canGoForward: false,
                zoomFactor: 1,
              }}
              url={address}
              annotating={annotating}
              onAddress={setAddress}
              onCommand={() => onAction('navigate')}
            />
          </header>
        )}
        {appMode && !projectOverview ? (
          <div className="session-workspace-content">
            {current === 'split' ? (
              content
            ) : (
              <WorkspaceSplit
                node={{
                  kind: 'pane',
                  id: 'catalog-single-pane',
                  content:
                    documentSelected || current === 'browser'
                      ? {
                          kind: 'plan',
                          artifactId: plan.id,
                          tab:
                            current === 'browser'
                              ? { id: 'browser', kind: 'browser', url: address, title: 'Browser' }
                              : { id: 'document', kind: 'document', revisionId: 'v1' },
                        }
                      : current === 'session'
                        ? { kind: 'session', sessionId: shellSession.id }
                        : { kind: 'terminal', terminalId: terminal.id },
                }}
                activePaneId="catalog-single-pane"
                renderPane={() => content}
                onRatio={async () => {}}
              />
            )}
          </div>
        ) : (
          content
        )}
      </ShellWorkspace>
      <ShellSidebar side="right">
        <h2>Feedback</h2>
        <p className="muted">Working changes stay private until Save.</p>
        <AnnotationList
          annotations={[]}
          disabled={false}
          onJump={() => {}}
          onEdit={() => {}}
          onDelete={() => {}}
          renderEditor={() => null}
        />
        <SaveApproval
          busy={false}
          autosaving={false}
          retry={false}
          saveDisabled={!feedbackAvailable}
          approvalDisabled={!feedbackAvailable}
          projectOverview={current === 'project'}
          unpublished={false}
          dirty={false}
          approved={false}
          hasRevision={feedbackAvailable}
          onSave={() => onAction('save')}
          onApproval={() => onAction('approve')}
        />
      </ShellSidebar>
    </ShellLayout>
  );
}
