import { useEffect, useRef, useState } from 'react';
import { marked } from 'marked';
import clsx from 'clsx';
import type { Message, RosterEntry, Skill, Thread } from '@antbot/shared';
import { CardList } from './Cards.js';
import { Composer } from './Composer.js';

marked.setOptions({ breaks: true });

function renderMarkdown(md: string): string {
  const html = marked.parse(md, { async: false }) as string;
  // Strip <script> tags; everything else marked emits is treated as trusted-enough
  // markdown output rendered locally from our own bots/users.
  return html.replace(/<script[\s\S]*?<\/script>/gi, '');
}

function authorLabel(message: Message, botsById: Record<string, RosterEntry>): { name: string; emoji: string } {
  if (message.authorKind === 'user') return { name: 'You', emoji: '🧑' };
  if (message.authorKind === 'system') return { name: 'System', emoji: '⚙️' };
  const bot = message.authorBotId ? botsById[message.authorBotId]?.bot : undefined;
  return { name: bot?.name ?? 'Bot', emoji: bot?.avatarEmoji ?? '🤖' };
}

function MessageRow({ message, botsById }: { message: Message; botsById: Record<string, RosterEntry> }) {
  const { name, emoji } = authorLabel(message, botsById);
  const isUser = message.authorKind === 'user';
  return (
    <div className={clsx('flex gap-3 px-4 py-2', isUser && 'flex-row-reverse')}>
      <span className="mt-0.5 text-lg leading-none">{emoji}</span>
      <div className={clsx('min-w-0 max-w-[75%]', isUser && 'items-end text-right')}>
        <div className={clsx('mb-0.5 flex items-baseline gap-2', isUser && 'flex-row-reverse')}>
          <span className="text-xs font-semibold text-(--color-text-muted)">{name}</span>
          <span className="text-[11px] text-(--color-text-faint)">
            {new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
        {message.contentMd && (
          <div
            className={clsx(
              'markdown-body inline-block rounded-lg px-3 py-2 text-sm',
              isUser ? 'bg-(--color-accent) text-(--color-accent-fg)' : 'bg-(--color-bg-elevated)',
            )}
          >
            <span dangerouslySetInnerHTML={{ __html: renderMarkdown(message.contentMd) }} />
            {message.streaming && <span className="ml-0.5 inline-block w-1.5 animate-pulse bg-current align-middle">&nbsp;</span>}
          </div>
        )}
        <CardList cards={message.cards} />
      </div>
    </div>
  );
}

export interface ThreadViewProps {
  thread: Thread | null;
  messages: Message[];
  botsById: Record<string, RosterEntry>;
  bots: RosterEntry[];
  skills: Skill[];
  running: boolean;
  onSend: (contentMd: string, attachmentIds: string[]) => void;
  onStop: () => void;
}

export function ThreadView({ thread, messages, botsById, bots, skills, running, onSend, onStop }: ThreadViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [stickToBottom, setStickToBottom] = useState(true);

  useEffect(() => {
    if (!stickToBottom) return;
    // Cards (approval prompts, tool output) can grow after the message object
    // updates, so pin to the bottom again on the next frame once layout settles.
    const pin = () => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    };
    pin();
    const raf = requestAnimationFrame(() => {
      pin();
      requestAnimationFrame(pin);
    });
    return () => cancelAnimationFrame(raf);
  }, [messages, stickToBottom]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setStickToBottom(distanceFromBottom < 80);
  }

  if (!thread) {
    return (
      <div className="flex h-full flex-1 flex-col items-center justify-center text-(--color-text-muted)">
        <p className="text-sm">Select a bot to start a conversation, or create a new one.</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* min-h-0 is what keeps the transcript inside its own scroller. Without it a long
          thread sizes this div to its content and pushes the composer past the viewport. */}
      <div ref={scrollRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-y-auto py-2">
        {messages.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-(--color-text-muted)">
            No messages yet — say hello and give this bot a job.
          </p>
        ) : (
          messages.map((m) => <MessageRow key={m.id} message={m} botsById={botsById} />)
        )}
      </div>
      <Composer onSend={onSend} bots={bots} skills={skills} running={running} onStop={onStop} />
    </div>
  );
}
