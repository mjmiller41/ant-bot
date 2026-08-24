import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Bot, RosterEntry, CreateBotRequest, Settings, Skill } from '@antbot/contract';
import clsx from 'clsx';
import { useStore, type ConnectionState } from './store/useStore.js';
import { createEventSocket } from './api/ws.js';
import { api } from './api/client.js';
import { Sidebar } from './components/Sidebar.js';
import { ThreadView } from './components/ThreadView.js';
import { NewBotDialog } from './components/NewBotDialog.js';
import { BotSettings } from './components/BotSettings.js';
import { RulesScreen } from './components/RulesScreen.js';
import { UsageScreen } from './components/UsageScreen.js';
import { SettingsScreen } from './components/SettingsScreen.js';
import { WorkspaceBrowser } from './components/WorkspaceBrowser.js';
import { ComputerView } from './components/ComputerView.js';
import { ConnectorsScreen } from './components/ConnectorsScreen.js';
import { CommandPalette, type PaletteTarget } from './components/CommandPalette.js';

type View = 'thread' | 'rules' | 'connectors' | 'usage' | 'settings' | 'workspace' | 'computer';

const NAV_ITEMS: { view: View; label: string }[] = [
  { view: 'thread', label: 'Chats' },
  { view: 'workspace', label: 'Workspace' },
  { view: 'computer', label: 'Computer' },
  { view: 'rules', label: 'Rules' },
  { view: 'connectors', label: 'Connectors' },
  { view: 'usage', label: 'Usage' },
  { view: 'settings', label: 'Settings' },
];

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connecting: 'Connecting…',
  open: 'Connected',
  closed: 'Disconnected',
};

const CONNECTION_DOT: Record<ConnectionState, string> = {
  connecting: 'bg-(--color-amber) animate-pulse',
  open: 'bg-(--color-green)',
  closed: 'bg-(--color-red)',
};

function TopBar({
  connection,
  pendingCount,
  view,
  onChangeView,
  onOpenPalette,
}: {
  connection: ConnectionState;
  pendingCount: number;
  view: View;
  onChangeView: (v: View) => void;
  onOpenPalette: () => void;
}) {
  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-(--color-border) bg-(--color-bg-elevated) px-3">
      <nav className="flex items-center gap-1">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.view}
            type="button"
            onClick={() => onChangeView(item.view)}
            className={clsx(
              'rounded px-2.5 py-1 text-xs font-medium',
              view === item.view ? 'bg-(--color-accent)/15 text-(--color-accent)' : 'text-(--color-text-muted) hover:bg-(--color-bg-hover)',
            )}
          >
            {item.label}
            {item.view === 'rules' && pendingCount > 0 && (
              <span className="ml-1.5 rounded-full bg-(--color-amber) px-1.5 py-0.5 text-[10px] font-semibold text-(--color-bg)">
                {pendingCount}
              </span>
            )}
          </button>
        ))}
      </nav>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onOpenPalette}
          className="rounded border border-(--color-border) px-2.5 py-1 text-xs text-(--color-text-muted) hover:bg-(--color-bg-hover)"
        >
          Search… <span className="ml-1 opacity-60">⌘K</span>
        </button>
        {pendingCount > 0 && (
          <span className="flex items-center gap-1 rounded-full bg-(--color-amber)/15 px-2 py-0.5 text-xs font-medium text-(--color-amber)">
            {pendingCount} pending approval{pendingCount === 1 ? '' : 's'}
          </span>
        )}
        <span className="flex items-center gap-1.5 text-xs text-(--color-text-muted)">
          <span className={clsx('h-1.5 w-1.5 rounded-full', CONNECTION_DOT[connection])} />
          {CONNECTION_LABEL[connection]}
        </span>
      </div>
    </header>
  );
}

/** A document-shaped screen: fills the main pane and scrolls as a whole. */
function ScrollPane({ children }: { children: ReactNode }) {
  return <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>;
}

/** A screen that lays out its own full-height panes and scrolls them internally. */
function FixedPane({ children }: { children: ReactNode }) {
  return <div className="min-h-0 flex-1 overflow-hidden">{children}</div>;
}

export default function App() {
  const bots = useStore((s) => s.bots);
  const threads = useStore((s) => s.threads);
  const activeThreadId = useStore((s) => s.activeThreadId);
  const messagesByThread = useStore((s) => s.messagesByThread);
  const pendingApprovals = useStore((s) => s.pendingApprovals);
  const connection = useStore((s) => s.connection);
  const notifications = useStore((s) => s.notifications);
  const setBots = useStore((s) => s.setBots);
  const setThreads = useStore((s) => s.setThreads);
  const setThreadMessages = useStore((s) => s.setThreadMessages);
  const setActiveThreadId = useStore((s) => s.setActiveThreadId);
  const appendLocalMessage = useStore((s) => s.appendLocalMessage);
  const dismissNotification = useStore((s) => s.dismissNotification);
  const setPendingApprovals = useStore((s) => s.setPendingApprovals);

  const [view, setView] = useState<View>('thread');
  const [newBotOpen, setNewBotOpen] = useState(false);
  const [newBotBusy, setNewBotBusy] = useState(false);
  const [newBotError, setNewBotError] = useState<string | null>(null);
  const [settingsBotId, setSettingsBotId] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [theme, setTheme] = useState<Settings['theme']>('system');

  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    function apply() {
      const isLight = theme === 'light' || (theme === 'system' && !media.matches);
      root.classList.toggle('light', isLight);
    }
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);

  useEffect(() => {
    api.bots.list().then(setBots);
    api.threads.list().then(setThreads);
    api.skills.list().then(setSkills);
    // Approvals raised before this page loaded arrive over no channel: a fresh load has
    // lastSeq === -1, so the socket sends no resume frame and the server never replays.
    // Without this fetch a blocked turn looks resolved in the UI while it is still waiting.
    api.approvals.list().then(setPendingApprovals).catch(() => {});
    const controller = createEventSocket();
    return () => controller.close();
  }, [setBots, setThreads, setPendingApprovals]);

  // Refetch on thread change, and again whenever the daemon says a transcript changed wholesale
  // — `thread.updated` bumps threadEpoch. Without that second trigger "Start fresh" cleared the
  // rows and the open view kept showing them, which read as the button doing nothing.
  const threadEpoch = useStore((s) => s.threadEpoch);
  useEffect(() => {
    if (!activeThreadId) return;
    api.threads.get(activeThreadId).then(({ messages }) => {
      setThreadMessages(activeThreadId, messages);
    });
    api.threads.markRead(activeThreadId).catch(() => {});
  }, [activeThreadId, threadEpoch, setThreadMessages]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        setNewBotOpen(true);
      } else if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(true);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const botsById = useMemo(() => {
    const map: Record<string, RosterEntry> = {};
    for (const e of bots) map[e.bot.id] = e;
    return map;
  }, [bots]);

  const groupThreads = useMemo(() => Object.values(threads).filter((t) => t.kind === 'group'), [threads]);

  const activeThread = activeThreadId ? (threads[activeThreadId] ?? null) : null;
  const activeMessages = activeThreadId ? (messagesByThread[activeThreadId] ?? []) : [];
  const activeBotEntry = activeThread ? bots.find((e) => e.thread?.id === activeThread.id) : undefined;
  const settingsBot: Bot | null = settingsBotId ? (botsById[settingsBotId]?.bot ?? null) : null;

  async function refreshBots() {
    setBots(await api.bots.list());
  }

  async function handleCreateBot(body: CreateBotRequest) {
    setNewBotBusy(true);
    setNewBotError(null);
    try {
      const bot = await api.bots.create(body);
      await refreshBots();
      setNewBotOpen(false);
      if (bot.threadId) {
        setThreads(await api.threads.list());
        setActiveThreadId(bot.threadId);
        setView('thread');
      }
    } catch (err) {
      setNewBotError(err instanceof Error ? err.message : 'Failed to create bot');
    } finally {
      setNewBotBusy(false);
    }
  }

  async function handleSend(contentMd: string, attachmentIds: string[]) {
    if (!activeThreadId) return;
    const message = await api.threads.postMessage(activeThreadId, { contentMd, attachmentIds });
    appendLocalMessage(activeThreadId, message);
  }

  async function handleStop() {
    if (!activeBotEntry) return;
    await api.bots.stop(activeBotEntry.bot.id);
  }

  function handleSelectThread(threadId: string) {
    setActiveThreadId(threadId);
    setSettingsBotId(null);
    setView('thread');
  }

  function handlePaletteNavigate(target: PaletteTarget) {
    if (target.kind === 'thread') {
      handleSelectThread(target.id);
    } else if (target.kind === 'newBot') {
      setNewBotOpen(true);
    } else {
      setView(target.kind);
    }
  }

  return (
    // The shell owns the viewport: nothing here may grow the document. Every flex child
    // below carries min-h-0 so an over-long list scrolls inside its own pane instead of
    // pushing the top bar and the composer off-screen.
    <div className="flex h-dvh flex-col overflow-hidden">
      <TopBar
        connection={connection}
        pendingCount={pendingApprovals.length}
        view={view}
        onChangeView={(v) => {
          setSettingsBotId(null);
          setView(v);
        }}
        onOpenPalette={() => setPaletteOpen(true)}
      />
      <div className="flex min-h-0 flex-1">
        <Sidebar
          entries={bots}
          groupThreads={groupThreads}
          botsById={botsById}
          activeThreadId={activeThreadId}
          onSelectThread={handleSelectThread}
          onNewBot={() => setNewBotOpen(true)}
        />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {view === 'thread' &&
            (settingsBot ? (
              <BotSettings
                bot={settingsBot}
                onClose={() => setSettingsBotId(null)}
                onUpdated={(bot) => setBots(bots.map((e) => (e.bot.id === bot.id ? { ...e, bot } : e)))}
                onDuplicated={(bot) => {
                  void refreshBots();
                  setSettingsBotId(bot.id);
                }}
                onDeleted={() => {
                  setSettingsBotId(null);
                  void refreshBots();
                }}
              />
            ) : (
              <div className="flex min-h-0 flex-1 flex-col">
                {activeBotEntry && (
                  <div className="flex shrink-0 items-center justify-between border-b border-(--color-border) px-4 py-2">
                    <div className="flex items-center gap-2">
                      <span className="text-lg leading-none">{activeBotEntry.bot.avatarEmoji}</span>
                      <span className="text-sm font-semibold">{activeBotEntry.bot.name}</span>
                      {activeBotEntry.bot.title && (
                        <span className="text-xs text-(--color-text-muted)">{activeBotEntry.bot.title}</span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => setSettingsBotId(activeBotEntry.bot.id)}
                      className="text-xs text-(--color-text-muted) hover:text-(--color-text)"
                    >
                      Bot settings
                    </button>
                  </div>
                )}
                <ThreadView
                  thread={activeThread}
                  messages={activeMessages}
                  botsById={botsById}
                  bots={bots}
                  skills={skills}
                  running={activeBotEntry?.bot.state === 'running' || activeBotEntry?.bot.state === 'queued'}
                  onSend={handleSend}
                  onStop={handleStop}
                />
              </div>
            ))}
          {view === 'rules' && (
            <ScrollPane>
              <RulesScreen />
            </ScrollPane>
          )}
          {view === 'connectors' && (
            <ScrollPane>
              <ConnectorsScreen />
            </ScrollPane>
          )}
          {view === 'usage' && (
            <ScrollPane>
              <UsageScreen />
            </ScrollPane>
          )}
          {view === 'settings' && (
            <ScrollPane>
              <SettingsScreen onSettingsChange={(s) => setTheme(s.theme)} />
            </ScrollPane>
          )}
          {view === 'workspace' && (
            <FixedPane>
              <WorkspaceBrowser />
            </FixedPane>
          )}
          {view === 'computer' && (
            <FixedPane>
              <ComputerView />
            </FixedPane>
          )}
        </main>
      </div>

      {notifications.length > 0 && (
        <div className="pointer-events-none fixed bottom-24 right-4 z-50 flex flex-col gap-2">
          {notifications.slice(-4).map((n) => (
            <div
              key={n.id}
              className={clsx(
                'pointer-events-auto w-72 rounded-md border p-3 text-sm shadow-lg',
                n.level === 'error' && 'border-(--color-red)/50 bg-(--color-bg-elevated)',
                n.level === 'warn' && 'border-(--color-amber)/50 bg-(--color-bg-elevated)',
                n.level === 'info' && 'border-(--color-border) bg-(--color-bg-elevated)',
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="font-medium">{n.title}</span>
                <button type="button" onClick={() => dismissNotification(n.id)} className="text-(--color-text-faint) hover:text-(--color-text)">
                  ×
                </button>
              </div>
              {n.body && <p className="mt-0.5 text-xs text-(--color-text-muted)">{n.body}</p>}
            </div>
          ))}
        </div>
      )}

      {newBotOpen && (
        <NewBotDialog onCreate={handleCreateBot} onClose={() => setNewBotOpen(false)} busy={newBotBusy} error={newBotError} />
      )}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} onNavigate={handlePaletteNavigate} />
    </div>
  );
}
