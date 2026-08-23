import type { Card } from '@antbot/shared';
import { useStore } from '../store/useStore.js';
import { ApprovalCard } from './ApprovalCard.js';
import { api } from '../api/client.js';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

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
      {card.result && (
        <pre className="mt-2 max-h-48 overflow-auto rounded border border-(--color-border) bg-(--color-bg) p-2 font-mono text-xs">
          {card.result}
        </pre>
      )}
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
    default: {
      const _exhaustive: never = card;
      void _exhaustive;
      return null;
    }
  }
}

export function CardList({ cards }: { cards: Card[] }) {
  if (cards.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-2">
      {cards.map((card, i) => (
        // Cards are append-only and the server addresses updates by position
        // (`message.card` carries `cardIndex`), so the index IS the stable identity.
        // eslint-disable-next-line react/no-array-index-key
        <CardView key={i} card={card} />
      ))}
    </div>
  );
}
