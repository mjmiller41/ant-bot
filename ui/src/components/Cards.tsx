import type { Card } from '@antbot/contract';
import { useStore } from '../store/useStore.js';
import { ApprovalCard } from './ApprovalCard.js';
import { api } from '../api/client.js';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * What a tool returned, in a line a person can read.
 *
 * A tool result is often a page of JSON — a mail search returns fifty threads with snippets and
 * label ids. Rendering it verbatim buries the bot's own reply, which is the part worth reading,
 * so a JSON result is described here and the text itself goes behind a disclosure.
 */
export function describeResult(result: string): { label: string; json: boolean } {
  const trimmed = result.trim();
  const looksJson = trimmed.startsWith('{') || trimmed.startsWith('[');
  let parsed: unknown;
  if (looksJson) {
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parsed = undefined;
    }
  }
  const size = formatBytes(trimmed.length);

  if (parsed !== undefined && parsed !== null && typeof parsed === 'object') {
    if (Array.isArray(parsed)) return { label: `${count(parsed.length, 'item')} · ${size}`, json: true };
    const entries = Object.entries(parsed as Record<string, unknown>);
    // "threads": [ … ] is the shape almost every list-ish tool returns; naming the key beats
    // "1 field" because it says what came back.
    const firstList = entries.find(([, v]) => Array.isArray(v));
    if (firstList) {
      const [key, value] = firstList as [string, unknown[]];
      return { label: `${value.length} ${key} · ${size}`, json: true };
    }
    const keys = entries.map(([k]) => k);
    const shown = keys.slice(0, 4).join(', ');
    return { label: `${shown}${keys.length > 4 ? `, +${keys.length - 4}` : ''} · ${size}`, json: true };
  }

  const lines = trimmed ? trimmed.split('\n') : [];
  const first = (lines[0] ?? '').slice(0, 80);
  return { label: lines.length > 1 ? `${first} · ${count(lines.length, 'line')}` : first, json: false };
}

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

const STATUS_STYLES: Record<string, string> = {
  running: 'bg-(--color-blue)/15 text-(--color-blue)',
  ok: 'bg-(--color-green)/15 text-(--color-green)',
  error: 'bg-(--color-red)/15 text-(--color-red)',
  denied: 'bg-(--color-amber)/15 text-(--color-amber)',
};

function ToolCard({ card }: { card: Extract<Card, { type: 'tool' }> }) {
  return (
    <div className="rounded-md border border-(--color-border) bg-(--color-bg-elevated) p-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 font-mono text-xs font-semibold text-(--color-text-muted)">{card.toolName}</span>
          <span className="truncate font-mono text-xs text-(--color-text)">{card.summary}</span>
        </div>
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide ${STATUS_STYLES[card.status] ?? ''}`}
        >
          {card.status}
        </span>
      </div>
      {card.result && <ToolResult result={card.result} />}
      {card.input !== undefined && (
        <details className="mt-1.5 text-xs">
          <summary className="cursor-pointer text-(--color-text-muted) select-none">Raw input</summary>
          <pre className="mt-1 max-h-48 overflow-auto rounded border border-(--color-border) bg-(--color-bg) p-2 font-mono">
            {JSON.stringify(card.input, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}

/**
 * A JSON result collapses to one described line; anything else stays visible, because plain text
 * — a command's output, an error — is usually the thing you wanted to see.
 */
function ToolResult({ result }: { result: string }) {
  const { label, json } = describeResult(result);
  if (!json) {
    return (
      <pre className="mt-2 max-h-48 overflow-auto rounded border border-(--color-border) bg-(--color-bg) p-2 font-mono text-xs">
        {result}
      </pre>
    );
  }
  return (
    <details className="mt-1.5 text-xs">
      <summary className="cursor-pointer text-(--color-text-muted) select-none">Result — {label}</summary>
      <pre className="mt-1 max-h-48 overflow-auto rounded border border-(--color-border) bg-(--color-bg) p-2 font-mono">
        {result}
      </pre>
    </details>
  );
}

function FileCard({ card }: { card: Extract<Card, { type: 'file' }> }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-(--color-border) bg-(--color-bg-elevated) p-2.5">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{card.name}</div>
        <div className="text-xs text-(--color-text-muted)">
          {card.action === 'created' ? 'Created' : 'Modified'} · {formatBytes(card.bytes)}
        </div>
      </div>
      <a
        className="shrink-0 rounded border border-(--color-border) px-2.5 py-1 text-xs font-medium hover:bg-(--color-bg-hover)"
        href={api.workspace.fileUrl(card.path)}
        download={card.name}
      >
        Download
      </a>
    </div>
  );
}

function ApprovalCardSlot({ card }: { card: Extract<Card, { type: 'approval' }> }) {
  const approval = useStore((s) => s.pendingApprovals.find((a) => a.id === card.approvalId));
  const decide = useStore((s) => s.decideApproval);
  if (!approval) {
    return (
      <div className="rounded-md border border-(--color-border) bg-(--color-bg-elevated) p-2.5 text-xs text-(--color-text-muted)">
        Approval resolved.
      </div>
    );
  }
  return (
    <ApprovalCard
      approval={approval}
      onAllow={() => decide?.(approval.id, { decision: 'allow' })}
      onDeny={() => decide?.(approval.id, { decision: 'deny' })}
      onAlwaysAllow={(scope) => decide?.(approval.id, { decision: 'allow', alwaysRule: scope })}
    />
  );
}

function HandoffCard({ card }: { card: Extract<Card, { type: 'handoff' }> }) {
  const bots = useStore((s) => s.bots);
  const from = bots.find((b) => b.bot.id === card.fromBotId)?.bot.name ?? card.fromBotId;
  const to = bots.find((b) => b.bot.id === card.toBotId)?.bot.name ?? card.toBotId;
  return (
    <div className="rounded-md border border-(--color-border) bg-(--color-bg-elevated) p-2.5 text-sm">
      <div className="flex items-center gap-2 font-medium">
        <span>{from}</span>
        <span className="text-(--color-text-muted)" aria-hidden>
          &rarr;
        </span>
        <span>{to}</span>
      </div>
      {card.note && <p className="mt-1 text-xs text-(--color-text-muted)">{card.note}</p>}
    </div>
  );
}

function ErrorCard({ card }: { card: Extract<Card, { type: 'error' }> }) {
  return (
    <div className="rounded-md border border-(--color-red)/40 bg-(--color-red)/10 p-2.5 text-sm text-(--color-red)">
      {card.message}
    </div>
  );
}

function SignInCard({ card }: { card: Extract<Card, { type: 'signin' }> }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-(--color-amber)/40 bg-(--color-amber)/10 p-2.5 text-sm">
      <span className="flex-1">
        <span className="font-medium">{card.serverName}</span> needs you to sign in before its tools work.
      </span>
      {/* A new tab: the provider returns to the daemon's callback, and this thread stays put. */}
      <a href={card.url} target="_blank" rel="noopener noreferrer" className="rounded border border-(--color-border) px-2 py-1 text-xs">
        Open
      </a>
    </div>
  );
}

export function CardView({ card }: { card: Card }) {
  switch (card.type) {
    case 'tool':
      return <ToolCard card={card} />;
    case 'file':
      return <FileCard card={card} />;
    case 'approval':
      return <ApprovalCardSlot card={card} />;
    case 'handoff':
      return <HandoffCard card={card} />;
    case 'error':
      return <ErrorCard card={card} />;
    case 'signin':
      return <SignInCard card={card} />;
    default: {
      const _exhaustive: never = card;
      void _exhaustive;
      return null;
    }
  }
}

/**
 * How a bot's tool calls got there, in one line.
 *
 * A reply worth reading arrives after a dozen searches and fetches, and a box per call pushes the
 * answer off the screen — the work is not the point, the answer is. Everything a person must act
 * on (an approval, a sign-in, an error, a file) still renders in full; only the steps fold away,
 * and clicking opens all of them, in order, exactly as before.
 */
export function ActivitySummary({ cards }: { cards: Extract<Card, { type: 'tool' }>[] }) {
  const running = cards.some((c) => c.status === 'running');
  const failed = cards.filter((c) => c.status === 'error' || c.status === 'denied').length;
  const label = running
    ? `Working… ${describeStep(cards[cards.length - 1])}`
    : `${cards.length} step${cards.length === 1 ? '' : 's'}${failed ? ` · ${failed} failed` : ''}`;

  return (
    <details className="text-xs">
      <summary
        className={`cursor-pointer select-none ${failed && !running ? 'text-(--color-amber)' : 'text-(--color-text-muted)'}`}
      >
        {label}
      </summary>
      <div className="mt-2 flex flex-col gap-2">
        {cards.map((card, i) => (
          // eslint-disable-next-line react/no-array-index-key
          <ToolCard key={i} card={card} />
        ))}
      </div>
    </details>
  );
}

/** The tool being run right now, named — so a long turn shows progress rather than a spinner. */
function describeStep(card: Extract<Card, { type: 'tool' }> | undefined): string {
  if (!card) return '';
  const mcp = /^mcp__[^_]+(?:_[^_]+)*__(.+)$/.exec(card.toolName);
  return mcp ? mcp[1]! : card.toolName;
}

export function CardList({ cards }: { cards: Card[] }) {
  if (cards.length === 0) return null;

  // Tool calls fold into one line, placed where the first of them appeared so the order of
  // everything else is untouched.
  const steps = cards.filter((c): c is Extract<Card, { type: 'tool' }> => c.type === 'tool');
  const firstStep = cards.findIndex((c) => c.type === 'tool');

  return (
    <div className="mt-2 flex flex-col gap-2">
      {cards.map((card, i) => {
        if (card.type === 'tool') {
          return i === firstStep ? <ActivitySummary key="steps" cards={steps} /> : null;
        }
        // Cards are append-only and the server addresses updates by position
        // (`message.card` carries `cardIndex`), so the index IS the stable identity.
        // eslint-disable-next-line react/no-array-index-key
        return <CardView key={i} card={card} />;
      })}
    </div>
  );
}
