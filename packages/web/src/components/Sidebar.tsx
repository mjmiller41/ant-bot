import { useState, type ReactNode } from 'react';
import clsx from 'clsx';
import type { RosterEntry, Thread, BotState, Attention } from '@antbot/shared';

export interface SidebarProps {
  entries: RosterEntry[];
  groupThreads: Thread[];
  botsById: Record<string, RosterEntry>;
  activeThreadId: string | null;
  onSelectThread: (threadId: string) => void;
  onNewBot: () => void;
}

const STATE_DOT: Record<BotState, string> = {
  idle: 'bg-(--color-text-faint)',
  queued: 'bg-(--color-blue)',
  running: 'bg-(--color-blue)',
  waiting_approval: 'bg-(--color-amber)',
  waiting_input: 'bg-(--color-amber)',
  interrupted: 'bg-(--color-red)',
};

const ACTIVE_STATES: BotState[] = ['queued', 'running'];

function StateDot({ state }: { state: BotState }) {
  const pulsing = ACTIVE_STATES.includes(state);
  return (
    <span className="relative flex h-2 w-2 shrink-0">
      {pulsing && (
        <span className={clsx('absolute inline-flex h-full w-full animate-ping rounded-full opacity-60', STATE_DOT[state])} />
      )}
      <span className={clsx('relative inline-flex h-2 w-2 rounded-full', STATE_DOT[state])} />
    </span>
  );
}

function AttentionBadge({ attention }: { attention: Attention }) {
  if (attention === 'needs_attention') {
    return (
      <span className="flex items-center gap-1 text-[11px] font-medium text-(--color-amber)">
        <span className="h-1.5 w-1.5 rounded-full bg-(--color-amber)" />
        Needs attention
      </span>
    );
  }
  if (attention === 'unread') {
    return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--color-blue)" aria-label="Unread" />;
  }
  return null;
}

function BotRow({
  entry,
  active,
  onSelect,
}: {
  entry: RosterEntry;
  active: boolean;
  onSelect: () => void;
}) {
  const { bot } = entry;
  return (
    <button
      type="button"
      data-testid="bot-row"
      onClick={onSelect}
      className={clsx(
        'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors',
        active ? 'bg-(--color-accent)/15' : 'hover:bg-(--color-bg-hover)',
      )}
    >
      <span className="text-lg leading-none">{bot.avatarEmoji}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{bot.name}</span>
          <StateDot state={bot.state} />
        </span>
        {bot.title && <span className="block truncate text-xs text-(--color-text-muted)">{bot.title}</span>}
      </span>
      <AttentionBadge attention={bot.attention} />
    </button>
  );
}

function GroupRow({
  thread,
  botsById,
  active,
  onSelect,
}: {
  thread: Thread;
  botsById: Record<string, RosterEntry>;
  active: boolean;
  onSelect: () => void;
}) {
  const memberNames = thread.memberBotIds.map((id) => botsById[id]?.bot.name ?? id).join(', ');
  return (
    <button
      type="button"
      data-testid="bot-row"
      onClick={onSelect}
      className={clsx(
        'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors',
        active ? 'bg-(--color-accent)/15' : 'hover:bg-(--color-bg-hover)',
      )}
    >
      <span className="text-lg leading-none">#</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{thread.title || memberNames}</span>
        <span className="block truncate text-xs text-(--color-text-muted)">{memberNames}</span>
      </span>
    </button>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-3">
      <div className="mb-1 px-2.5 text-[11px] font-semibold uppercase tracking-wide text-(--color-text-faint)">{label}</div>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

export function Sidebar({ entries, groupThreads, botsById, activeThreadId, onSelectThread, onNewBot }: SidebarProps) {
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const visible = entries.filter((e) => !e.bot.hidden);
  const pinned = visible.filter((e) => e.bot.pinned);
  const normal = visible.filter((e) => !e.bot.pinned);
  const hidden = entries.filter((e) => e.bot.hidden);

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-(--color-border) bg-(--color-bg) p-3">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm font-semibold">ant-bot</span>
        <button
          type="button"
          onClick={onNewBot}
          title="New bot (Ctrl/Cmd+N)"
          className="rounded border border-(--color-border) px-2 py-1 text-xs font-medium hover:bg-(--color-bg-hover)"
        >
          New
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {entries.length === 0 && groupThreads.length === 0 ? (
          <p className="px-2.5 py-6 text-center text-sm text-(--color-text-muted)">
            No bots yet — create one and give it a job.
          </p>
        ) : (
          <>
            {pinned.length > 0 && (
              <Section label="Pinned">
                {pinned.map((e) => (
                  <BotRow
                    key={e.bot.id}
                    entry={e}
                    active={e.thread?.id === activeThreadId}
                    onSelect={() => e.thread && onSelectThread(e.thread.id)}
                  />
                ))}
              </Section>
            )}

            {normal.length > 0 && (
              <Section label="Bots">
                {normal.map((e) => (
                  <BotRow
                    key={e.bot.id}
                    entry={e}
                    active={e.thread?.id === activeThreadId}
                    onSelect={() => e.thread && onSelectThread(e.thread.id)}
                  />
                ))}
              </Section>
            )}

            {groupThreads.length > 0 && (
              <Section label="Groups">
                {groupThreads.map((t) => (
                  <GroupRow key={t.id} thread={t} botsById={botsById} active={t.id === activeThreadId} onSelect={() => onSelectThread(t.id)} />
                ))}
              </Section>
            )}

            {hidden.length > 0 && (
              <div className="mb-3">
                <button
                  type="button"
                  onClick={() => setHiddenOpen((v) => !v)}
                  className="mb-1 flex w-full items-center gap-1 px-2.5 text-[11px] font-semibold uppercase tracking-wide text-(--color-text-faint) hover:text-(--color-text-muted)"
                >
                  <span>{hiddenOpen ? '▾' : '▸'}</span>
                  Hidden ({hidden.length})
                </button>
                {hiddenOpen && (
                  <div className="flex flex-col gap-0.5">
                    {hidden.map((e) => (
                      <BotRow
                        key={e.bot.id}
                        entry={e}
                        active={e.thread?.id === activeThreadId}
                        onSelect={() => e.thread && onSelectThread(e.thread.id)}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
