import React, { useState, useEffect, useRef } from 'react';
import { Isolated } from './components';
import { SidebarToggle } from '../../src/renderer/shell/SidebarUtilities';
import { WindowTitlebar } from '../../src/renderer/shell/WindowTitlebar';
import { WorkspaceTabs, type WorkspaceTabItem } from '../../src/renderer/shell/WorkspaceTabs';
import { ProjectTree } from '../../src/renderer/shell/ProjectTree';
import { SessionHome, SessionUnavailable } from '../../src/renderer/shell/SessionHome';
import { BrowserToolbar } from '../../src/renderer/shell/BrowserToolbar';
import { PlanToolbar } from '../../src/renderer/shell/PlanToolbar';
import {
  RenamePlanDialog,
  SessionMetadataDialog,
  McpConnectionDialog,
} from '../../src/renderer/shell/ShellDialogs';
import { SaveApproval } from '../../src/renderer/shell/SaveApproval';
import { Handoff } from '../../src/renderer/shell/Handoff';
import { FeedbackHistory } from '../../src/renderer/shell/FeedbackHistory';
import { ArtifactProperties } from '../../src/renderer/shell/ArtifactProperties';
import { Welcome } from '../../src/renderer/shell/Welcome';
import {
  NoOpenTabs,
  WaitingForAgent,
  WorkspaceUnavailable,
} from '../../src/renderer/shell/WorkspaceEmpty';
import { BottomTerminals, BottomResizer } from '../../src/renderer/shell/BottomTerminals';
import { SessionActions } from '../../src/renderer/SessionActions';
import { Icon } from '../../src/renderer/Icon';
import type { HarnessSession } from '../../src/shared/harness';
import type { TerminalRecord } from '../../src/shared/terminal';
import type { McpSetup } from '../../src/shared/protocol';
export const shellSession: HarnessSession = {
  id: 'example-session',
  harness: 'codex',
  projectId: 'example-project',
  cwd: '/example/project',
  title: 'Review the interface catalog',
  updatedAt: 0,
  status: 'idle',
  processState: 'stopped',
};
const setup: McpSetup = {
  mode: 'packaged',
  executable: '/example/Projector.app/helper',
  args: [],
  env: { PROJECTOR_RUNTIME_DESCRIPTOR: '/example/runtime.json' },
  descriptorPath: '/example/runtime.json',
  command: 'projector-mcp',
  config: '{"mcpServers":{"projector":{"command":"projector-mcp"}}}',
  prompt: 'Configure a fictional local Projector MCP connection. No real files are read.',
};
const terminals: TerminalRecord[] = ['Build', 'Review'].map((title, index) => ({
  id: `terminal-${index + 1}`,
  title,
  projectId: 'example-project',
  cwd: '/example/project',
  kind: 'shell',
  createdAt: '2026-10-13T00:00:00Z',
  status: 'running',
  exitCode: null,
}));
const tabTitles = ['Plan', 'Browser', 'New tab', 'Terminal', 'Codex'];
function ShellFixtureContent({
  surface,
  state,
  onAction,
}: {
  surface: string;
  state: string;
  onAction: (action: string) => void;
}) {
  const [current, setCurrent] = useState(state === 'failing' ? 'busy' : state),
    [closed, setClosed] = useState(false),
    [title, setTitle] = useState(
      state === 'empty'
        ? ''
        : state === 'long-title'
          ? 'A long plan title '.repeat(12)
          : 'Catalog review',
    ),
    [copied, setCopied] = useState(state === 'copied'),
    [copiedSetup, setCopiedSetup] = useState<string | null>(
      state === 'copied' ? setup.prompt : null,
    ),
    [saved, setSaved] = useState(state === 'unchanged'),
    [url, setUrl] = useState('https://example.invalid/'),
    [zoom, setZoom] = useState(state === 'zoom' ? 1.5 : 1),
    [annotating, setAnnotating] = useState(state === 'annotating'),
    [revision, setRevision] = useState(state === 'history' ? 'version-1' : 'version-2'),
    [collapsed, setCollapsed] = useState(new Set(state === 'collapsed' ? ['example-project'] : [])),
    [selected, setSelected] = useState(state === 'selected' ? 'example-project' : ''),
    [activeTab, setActiveTab] = useState(
      `tab-${Math.max(0, ['document', 'browser', 'home', 'terminal', 'session'].indexOf(state))}`,
    ),
    [tabIds, setTabIds] = useState(
      state === 'many-tabs'
        ? Array.from({ length: 12 }, (_, i) => i)
        : state === 'document-home'
          ? [0, 2]
          : [0, 1, 2, 3, 4],
    ),
    [left, setLeft] = useState(!['left-hidden', 'both-hidden'].includes(state)),
    [right, setRight] = useState(!['right-hidden', 'both-hidden'].includes(state)),
    [height, setHeight] = useState(state === 'resizing' ? 400 : 240),
    [handoff, setHandoff] = useState(
      ['running-session', 'resume-first'].includes(state) ? 'example-session' : '',
    ),
    [bottomVisible, setBottomVisible] = useState(state !== 'hidden'),
    [bottomTabs, setBottomTabs] = useState<string[]>(
      ['hidden', 'empty'].includes(state)
        ? []
        : state === 'selected'
          ? ['terminal-1']
          : ['terminal-1', 'terminal-2'],
    );
  const operationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (operationTimer.current) clearTimeout(operationTimer.current);
    },
    [],
  );
  useEffect(() => {
    if (state !== 'failing') return;
    const timer = setTimeout(() => setCurrent('error'), 200);
    return () => clearTimeout(timer);
  }, [state]);
  const action = (name: string) => {
    onAction(name);
  };
  const copy = () => {
    setCopied(true);
    action('copy');
  };
  const close = () => {
    setClosed(true);
    action('close');
  };
  const session = {
    ...shellSession,
    processState: (['running', 'running-session'].includes(current)
      ? 'running'
      : current === 'unknown'
        ? 'unknown'
        : 'stopped') as HarnessSession['processState'],
    terminalId: ['running', 'running-session'].includes(current) ? 'terminal-1' : undefined,
    title: state === 'fallback' ? '' : shellSession.title,
    cwd: state === 'long-path' ? '/example/' + 'very-long-folder/'.repeat(12) : shellSession.cwd,
  };
  const tabs: WorkspaceTabItem[] = tabIds.map((i) => ({
    id: `tab-${i}`,
    title: tabTitles[i % 5],
    tooltip: i % 5 === 4 ? 'Session tab: cannot be closed' : tabTitles[i % 5],
    glyph: i % 5 === 0 ? '▤' : i % 5 >= 3 ? '›_' : '◎',
    pinned: i % 5 === 4,
    active: activeTab === `tab-${i}`,
    count: state === 'split-count' && i === 0 ? 3 : 1,
    closeLabel: `Close ${tabTitles[i % 5].toLowerCase()} tab`,
  }));
  const workspaceTabs = (
    <WorkspaceTabs
      items={tabs}
      label="Workspace tabs"
      busy={state === 'busy'}
      onSelect={(id) => {
        setActiveTab(id);
        action('select');
      }}
      onClose={(id) => {
        setTabIds((previous) => {
          const remaining = previous.filter((i) => `tab-${i}` !== id);
          if (activeTab === id && remaining.length) setActiveTab(`tab-${remaining[0]}`);
          return remaining;
        });
        action('close');
      }}
    />
  );
  if (closed) return null;
  switch (surface) {
    case 'window-chrome':
      return (
        <div
          className={`app ${!left ? 'left-sidebar-hidden' : ''} ${!right ? 'right-sidebar-hidden' : ''}`}
          style={
            {
              height: 220,
              '--left-sidebar-width': left ? '240px' : '0px',
              '--right-sidebar-width': right ? '240px' : '0px',
            } as React.CSSProperties
          }
        >
          <WindowTitlebar
            leftSidebarVisible={left}
            rightSidebarVisible={right}
            sidebarToggle={(side) => (
              <SidebarToggle
                side={side}
                visible={side === 'left' ? left : right}
                onToggle={() => {
                  if (side === 'left') setLeft(!left);
                  else setRight(!right);
                  action(`${side}-toggle`);
                }}
              />
            )}
            tabs={
              <>
                {workspaceTabs}
                <button
                  className="new-tab"
                  aria-label="New tab"
                  disabled={state === 'busy'}
                  onClick={() => action('new-tab')}
                >
                  <Icon name="plus" />
                </button>
              </>
            }
          />
        </div>
      );
    case 'workspace-tabs':
      return (
        <div className="titlebar-section titlebar-center">
          {workspaceTabs}
          <button
            className="new-tab"
            aria-label="New tab"
            disabled={state === 'busy'}
            onClick={() => {
              setTabIds((previous) => {
                let next = Math.max(...previous) + 1;
                while (next % 5 !== 2) next++;
                setActiveTab(`tab-${next}`);
                return [...previous, next];
              });
              action('new-tab');
            }}
          >
            <Icon name="plus" />
          </button>
        </div>
      );
    case 'project-tree':
    case 'other-sessions':
      return (
        <aside className="sidebar" style={{ width: 340, minHeight: 200 }}>
          <ProjectTree
            projects={
              surface === 'other-sessions'
                ? []
                : current === 'empty'
                  ? []
                  : [
                      {
                        id: 'example-project',
                        path: '/example/project',
                        available: state !== 'unavailable',
                      },
                    ]
            }
            sessions={
              current === 'no-sessions' || current === 'empty'
                ? []
                : Array.from({ length: state === 'many-sessions' ? 15 : 1 }, (_, i) => ({
                    ...session,
                    id: `example-session-${i}`,
                    projectId: surface === 'other-sessions' ? null : 'example-project',
                    title:
                      state === 'long-title'
                        ? 'An exceptionally long session title '.repeat(5)
                        : session.title,
                  }))
            }
            projectId={selected}
            activeProjectId="example-project"
            activeSessionId={state === 'selected' ? 'example-session-0' : undefined}
            collapsed={collapsed}
            pinnedSessions={[]}
            busy={false}
            otherSessionsOpen={
              surface === 'other-sessions' &&
              ['expanded', 'long-title', 'long-path', 'metadata'].includes(state)
                ? true
                : undefined
            }
            onCollapsed={setCollapsed}
            pinOrder={() => 0}
            sessionActions={(item) => (
              <SessionActions
                title={item.title}
                pinned={false}
                pending={false}
                onPin={() => action('pin')}
                onArchive={() => action('archive')}
              />
            )}
            onProject={(item) => {
              setSelected(item.id);
              action('select');
            }}
            onProjectMenu={() => action('menu')}
            onNewSession={() => action('new')}
            onSession={() => action('session')}
            onMetadata={() => {
              action('metadata');
              setCurrent('metadata');
            }}
            onChooseProject={() => {
              setCurrent('populated');
              action('open-folder');
            }}
          />
          {current === 'metadata' && (
            <SessionMetadataDialog session={session} onClose={() => setCurrent(state)} />
          )}
        </aside>
      );
    case 'session-home':
      return current === 'unavailable' ? (
        <SessionUnavailable
          busy={false}
          onStart={() => {
            setCurrent('running');
            action('new');
          }}
        />
      ) : (
        <SessionHome
          session={session}
          busy={state === 'busy'}
          onCopy={() => action('copy')}
          onOpenTerminal={() => action('open-terminal')}
          onResume={() => {
            setCurrent('running');
            action('resume');
          }}
        />
      );
    case 'session-metadata':
      return <SessionMetadataDialog session={session} onClose={close} />;
    case 'rename-plan':
      return (
        <RenamePlanDialog
          title={title}
          busy={current === 'busy'}
          error={current === 'error' ? 'Could not rename the plan. Try again.' : null}
          onChange={(value) => {
            setTitle(value);
            action('edit');
          }}
          onSave={() => {
            action('save');
            setCurrent('busy');
            setTimeout(() => {
              if (state === 'error') setCurrent('error');
              else setClosed(true);
            }, 200);
          }}
          onClose={() => {
            action('cancel');
            close();
          }}
        />
      );
    case 'mcp-connection':
      return (
        <McpConnectionDialog
          promptOpen={state === 'prompt-expanded' ? true : undefined}
          configurationOpen={
            ['packaged', 'development', 'source', 'config-expanded'].includes(state)
              ? true
              : undefined
          }
          setup={{
            ...setup,
            mode: state.startsWith('development')
              ? 'development'
              : state === 'source'
                ? 'production-preview'
                : 'packaged',
          }}
          copied={copiedSetup}
          onCopy={(text) => {
            setCopiedSetup(text);
            action(text === setup.config ? 'copy-config' : 'copy');
          }}
          onClose={close}
        />
      );
    case 'browser-toolbar':
      return (
        <header className="plan-header browser-plan-header">
          <BrowserToolbar
            activeBrowser={{
              loading: current === 'loading',
              canGoBack: state !== 'back-disabled',
              canGoForward: state !== 'forward-disabled',
              zoomFactor: zoom,
            }}
            url={url}
            annotating={annotating}
            onAddress={(value) => {
              setUrl(value);
              action('address');
            }}
            onCommand={(command, params) => {
              action(command);
              if (command === 'stop') setCurrent('idle');
              if (command === 'reload' || command === 'navigate') setCurrent('loading');
              if (command === 'zoom') setZoom(params?.zoomFactor ?? 1);
              if (command === 'annotate') setAnnotating(!annotating);
            }}
          />
        </header>
      );
    case 'plan-toolbar':
      return (
        <header className="plan-header">
          <PlanToolbar
            revisionId={state === 'draft' ? null : revision}
            revisions={['version-1', 'version-2']}
            approved={state === 'approved'}
            draft={state === 'draft'}
            busy={false}
            documentActive
            saveStatus={
              state === 'saving'
                ? 'Autosaving…'
                : state === 'save-failed'
                  ? 'Save failed'
                  : state === 'saved'
                    ? 'Saved'
                    : 'Saved privately'
            }
            areaMode={annotating}
            canAnnotate={state !== 'annotation-disabled'}
            onVersion={(value) => {
              setRevision(value);
              action('version');
            }}
            onAnnotate={() => {
              setAnnotating(!annotating);
              action('annotate');
            }}
          />
        </header>
      );
    case 'save-approval':
      return (
        <aside className="feedback-panel" style={{ width: 330 }}>
          <SaveApproval
            busy={current === 'busy'}
            autosaving={current === 'autosaving'}
            retry={current === 'retry'}
            saveDisabled={['busy', 'autosaving', 'blocked', 'revoke-blocked'].includes(current)}
            approvalDisabled={['dirty', 'busy', 'autosaving', 'blocked', 'revoke-blocked'].includes(
              current,
            )}
            projectOverview={false}
            unpublished={false}
            dirty={current === 'dirty'}
            approved={current === 'approved' || current === 'revoke-blocked'}
            hasRevision
            handoff={
              saved ? (
                <Handoff
                  sessions={[
                    { ...shellSession, processState: 'running', terminalId: 'terminal-1' },
                  ]}
                  projectId="example-project"
                  handoffSessionId={handoff}
                  copied={copied}
                  onSelect={setHandoff}
                  onCopy={copy}
                />
              ) : undefined
            }
            onSave={() => {
              action(current === 'retry' ? 'retry' : 'save');
              setCurrent('busy');
              setSaved(false);
              operationTimer.current = setTimeout(() => {
                setCurrent('unchanged');
                setSaved(true);
                operationTimer.current = null;
              }, 200);
            }}
            onApproval={() => {
              action(current === 'approved' ? 'revoke' : 'approve');
              setCurrent(current === 'approved' ? 'unchanged' : 'approved');
            }}
          />
        </aside>
      );
    case 'handoff':
      return (
        <aside className="feedback-panel" style={{ width: 330 }}>
          <Handoff
            sessions={[
              {
                ...session,
                processState: state === 'resume-first' ? 'stopped' : 'running',
                terminalId: state === 'resume-first' ? undefined : 'terminal-1',
              },
            ]}
            projectId="example-project"
            handoffSessionId={handoff}
            copied={copied}
            onSelect={(value) => {
              setHandoff(value);
              action('select');
            }}
            onCopy={copy}
          />
        </aside>
      );
    case 'history':
      return (
        <aside className="feedback-panel" style={{ width: 330 }}>
          <FeedbackHistory
            savedStates={
              state === 'empty' || state === 'legacy-packages'
                ? []
                : [
                    {
                      id: 'state-1',
                      artifactId: 'plan-1',
                      createdAt: '2026-10-13T00:00:00Z',
                      notification: 'Fictional saved state',
                    },
                  ]
            }
            packages={
              state === 'legacy-packages'
                ? [
                    {
                      id: 'package-1',
                      createdAt: '2026-10-13T00:00:00Z',
                      notification: 'Fictional legacy package',
                    },
                  ]
                : []
            }
            onSavedCopy={() => action('copy')}
            onLegacyCopy={() => action('copy')}
          />
        </aside>
      );
    case 'feedback':
      return (
        <aside className="feedback-panel" style={{ width: 350 }}>
          <h2>Feedback</h2>
          <p className="muted">Working changes stay private until Save.</p>
          <ArtifactProperties
            propertiesOpen={['origin-present', 'origin-absent'].includes(state) ? true : undefined}
            migrationOpen={state === 'migration' ? true : undefined}
            downloadsOpen={state === 'downloads' ? true : undefined}
            artifact={{
              originSession:
                state === 'origin-present'
                  ? { harness: 'codex', sessionId: 'example-session' }
                  : null,
              revisions: ['v1', 'v2'],
            }}
            migrationSummary={
              state === 'migration'
                ? {
                    retained: ['choice'],
                    added: ['checklist'],
                    requiresResponse: ['comment'],
                    removed: ['legacy'],
                  }
                : undefined
            }
            downloads={
              state === 'downloads'
                ? [{ id: 'download-1', filename: 'example.pdf', status: 'completed' }]
                : []
            }
            onClearProfile={() => action('clear')}
            onCopyOrigin={() => action('copy-origin')}
          />
        </aside>
      );
    case 'workspace-empty':
      return state === 'welcome' ? (
        <Welcome onChooseProject={() => action('open')} />
      ) : state === 'no-tabs' ? (
        <NoOpenTabs
          application
          hasPlan
          onOpen={() => action('open')}
          onNew={() => action('new-tab')}
        />
      ) : state === 'waiting' || state === 'copied' ? (
        <WaitingForAgent copied={copied} onCopy={copy} onNew={() => action('new-tab')} />
      ) : (
        <WorkspaceUnavailable
          kind={
            state === 'terminal-unavailable'
              ? 'terminal'
              : state === 'plan-unavailable'
                ? 'plan'
                : 'project'
          }
        />
      );
    case 'bottom-terminals':
      return (
        <div>
          {!bottomVisible ? (
            <button
              aria-label="Toggle project terminals"
              onClick={() => {
                setBottomVisible(true);
                action('toggle');
              }}
            >
              Project terminals
            </button>
          ) : (
            <BottomTerminals
              height={height}
              tabs={bottomTabs}
              activeTerminalId={activeTab === 'tab-0' ? 'terminal-1' : 'terminal-2'}
              terminals={terminals}
              busy={false}
              resizer={
                <BottomResizer
                  height={height}
                  onKeyDown={(event) => {
                    if (['ArrowUp', 'ArrowDown'].includes(event.key)) {
                      event.preventDefault();
                      setHeight((previous) =>
                        Math.max(
                          120,
                          Math.min(800, previous + (event.key === 'ArrowUp' ? 20 : -20)),
                        ),
                      );
                      action('resize');
                    }
                  }}
                />
              }
              onSelect={() => {
                setActiveTab('tab-1');
                action('select');
              }}
              onClose={(id) => {
                setBottomTabs((previous) => previous.filter((item) => item !== id));
                action('close');
              }}
              onNew={() => {
                setBottomTabs((previous) => [...previous, 'terminal-1']);
                action('new');
              }}
              onHide={() => {
                setBottomVisible(false);
                action('toggle');
              }}
            >
              <div className="new-tab-home">
                {bottomTabs.length === 0 ? (
                  <button
                    onClick={() => {
                      setBottomTabs(['terminal-1']);
                      action('new');
                    }}
                  >
                    New project terminal
                  </button>
                ) : null}
              </div>
            </BottomTerminals>
          )}
        </div>
      );
    default:
      return null;
  }
}

export function ShellFixture(props: {
  surface: string;
  state: string;
  onAction: (action: string) => void;
}) {
  return (
    <Isolated showNotices={false}>
      <ShellFixtureContent {...props} />
    </Isolated>
  );
}
