import type { Store } from '../db/store.js';
import type { EventBus } from '../util/bus.js';
import { LIMITS, type Approval, type Settings } from '@antbot/contract';
import { evaluateRules, serializeInput, toolNameAliases } from './rules.js';
import { assessLocalReach, localDecision } from './local.js';
import { describeSkillSource } from '../skills/install.js';
import { logger } from '../util/log.js';

const log = logger('gateway');

export type GatewayDecision =
  | { behavior: 'allow'; reason: string; via: 'rule' | 'auto_review' | 'user' }
  | { behavior: 'deny'; message: string; via: 'rule' | 'auto_review' | 'user' | 'timeout' };

export interface AutoReviewer {
  /** Classify a proposed tool call. Never able to override a `require` rule. */
  classify(toolName: string, input: unknown, botDescription: string): Promise<{
    verdict: 'allow_ok' | 'needs_human' | 'deny_suggested';
    reason: string;
  }>;
}

export interface PendingResolver {
  approvalId: string;
  resolve: (d: GatewayDecision) => void;
  timer: NodeJS.Timeout;
}

/** Human-readable one-line summary of a proposed action for the approval card. */
export function summarize(namespacedToolName: string, input: unknown): string {
  const o = (input ?? {}) as Record<string, unknown>;
  const s = (k: string): string => (typeof o[k] === 'string' ? (o[k] as string) : '');
  // MCP tools arrive as `mcp__<server>__<tool>`; summarize on the bare name so the
  // approval card stays legible. Falls back to the full name for anything unrecognized.
  const aliases = toolNameAliases(namespacedToolName);
  const toolName = aliases[aliases.length - 1]!;
  switch (toolName) {
    case 'Bash':
      return `Run: ${s('command').slice(0, 200)}`;
    case 'Write':
      return `Write file ${s('file_path')}`;
    case 'Edit':
      return `Edit file ${s('file_path')}`;
    case 'Read':
      return `Read file ${s('file_path')}`;
    case 'WebFetch':
      return `Fetch ${s('url')}`;
    case 'send_to_bot':
      return `Hand work to @${s('bot_slug')}`;
    // Scope is the whole decision here: one named skill, or every skill in a repository.
    case 'install_skill':
      return describeSkillSource(s('source'));
    case 'remove_skill':
      return `Uninstall the skill "${s('slug')}"`;
    default: {
      if (toolName.startsWith('browser_')) {
        const bits = [s('url'), s('selector'), s('text')].filter(Boolean).join(' ');
        return `${toolName.replace('browser_', 'Browser ')}: ${bits}`.trim();
      }
      const flat = serializeInput(input);
      return `${toolName}: ${flat.slice(0, 180)}`;
    }
  }
}

export class PermissionGateway {
  private pending = new Map<string, PendingResolver>();

  constructor(
    private store: Store,
    private bus: EventBus,
    private autoReviewer?: AutoReviewer,
  ) {}

  /**
   * Decide whether a proposed tool call may run.
   * Order: deterministic rules → auto review (advisory) → human approval card.
   * A matching `require` rule can never be satisfied by auto review (outline §9).
   */
  async check(args: {
    botId: string;
    threadId: string;
    toolName: string;
    input: unknown;
    botDescription: string;
    settings: Settings;
    signal?: AbortSignal;
    /** Absolute path of the shared workspace, for the local-execution boundary. */
    workspace: string;
    /** Directories outside the workspace that still count as inside — ant-bot's attachments. */
    allowedRoots?: string[];
    /** Fired when a human approval card is created, so the caller can render it inline. */
    onPending?: (approval: Approval) => void;
  }): Promise<GatewayDecision> {
    const { toolName, input, settings } = args;
    const rules = this.store.listRules(true);
    const decision = evaluateRules(rules, toolName, input);

    // The local-execution policy is checked before any allow rule: reaching outside
    // the shared workspace means touching the user's own machine, and a broad allow
    // rule must not silently authorize that.
    const local = localDecision(
      settings.localExecution,
      assessLocalReach(toolName, input, args.workspace, args.allowedRoots ?? []),
    );
    if (local.action === 'deny') {
      return { behavior: 'deny', message: local.reason, via: 'rule' };
    }
    if (local.action === 'require' && decision.kind !== 'require') {
      return this.askHuman({ ...args, reason: local.reason });
    }

    if (decision.kind === 'allow') {
      log.debug(`allow by rule ${decision.rule.id}: ${toolName}`);
      return { behavior: 'allow', reason: decision.rule.scopeNote || 'Matched an allow rule', via: 'rule' };
    }

    const requiredBy = decision.kind === 'require' ? decision.rule : null;

    // Auto review is advisory and only consulted when no `require` rule matched.
    if (!requiredBy && settings.autoReviewEnabled && this.autoReviewer) {
      try {
        const verdict = await this.autoReviewer.classify(toolName, input, args.botDescription);
        if (verdict.verdict === 'allow_ok')
          return { behavior: 'allow', reason: verdict.reason, via: 'auto_review' };
        if (verdict.verdict === 'deny_suggested')
          return this.askHuman({ ...args, reason: `Auto review flagged this: ${verdict.reason}` });
        return this.askHuman({ ...args, reason: verdict.reason });
      } catch (err) {
        log.warn('auto review failed; falling back to human approval', err);
      }
    }

    return this.askHuman({
      ...args,
      reason: requiredBy ? requiredBy.scopeNote || 'Matched a require-approval rule' : 'No rule covers this action',
      ruleId: requiredBy?.id ?? null,
    });
  }

  private askHuman(args: {
    botId: string; threadId: string; toolName: string; input: unknown;
    reason: string; ruleId?: string | null; signal?: AbortSignal;
    onPending?: (approval: Approval) => void;
  }): Promise<GatewayDecision> {
    const approval = this.store.createApproval({
      botId: args.botId,
      threadId: args.threadId,
      toolName: args.toolName,
      inputSummary: summarize(args.toolName, args.input),
      rawInput: args.input,
      reason: args.reason,
    });
    if (args.ruleId) this.store.db.prepare(`UPDATE approvals SET rule_id=? WHERE id=?`).run(args.ruleId, approval.id);

    const fresh = this.store.getApproval(approval.id)!;
    args.onPending?.(fresh);
    this.bus.publish({
      type: 'approval.pending',
      threadId: args.threadId,
      botId: args.botId,
      approval: fresh,
    });

    return new Promise<GatewayDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(approval.id);
        this.store.resolveApproval(approval.id, 'expired', 'user', null, 'No response in time');
        this.bus.publish({
          type: 'approval.resolved', threadId: args.threadId, botId: args.botId,
          approval: this.store.getApproval(approval.id)!,
        });
        resolve({ behavior: 'deny', message: 'Approval request expired without a decision.', via: 'timeout' });
      }, LIMITS.APPROVAL_TIMEOUT_MS);

      this.pending.set(approval.id, { approvalId: approval.id, resolve, timer });

      args.signal?.addEventListener('abort', () => {
        const p = this.pending.get(approval.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(approval.id);
        this.store.resolveApproval(approval.id, 'denied', 'user', null, 'Turn interrupted');
        resolve({ behavior: 'deny', message: 'Interrupted.', via: 'user' });
      });
    });
  }

  /** Resolve a pending approval from the UI. Returns the updated row. */
  decide(approvalId: string, decision: 'allow' | 'deny', alwaysRule?: { toolPattern: string; inputPattern?: string; scopeNote?: string }): Approval | null {
    const p = this.pending.get(approvalId);
    const existing = this.store.getApproval(approvalId);
    if (!existing) return null;
    if (existing.status !== 'pending') return existing;

    let ruleId: string | null = null;
    if (decision === 'allow' && alwaysRule) {
      const rule = this.store.createRule({
        kind: 'allow',
        toolPattern: alwaysRule.toolPattern,
        inputPattern: alwaysRule.inputPattern ?? '',
        scopeNote: alwaysRule.scopeNote ?? 'Saved from an approval',
      });
      ruleId = rule.id;
    }

    const updated = this.store.resolveApproval(
      approvalId, decision === 'allow' ? 'allowed' : 'denied', 'user', ruleId,
      decision === 'allow' ? 'Approved by you' : 'Denied by you',
    );
    this.bus.publish({
      type: 'approval.resolved', threadId: existing.threadId, botId: existing.botId, approval: updated!,
    });

    if (p) {
      clearTimeout(p.timer);
      this.pending.delete(approvalId);
      p.resolve(
        decision === 'allow'
          ? { behavior: 'allow', reason: 'Approved by you', via: 'user' }
          : { behavior: 'deny', message: 'You denied this action.', via: 'user' },
      );
    }
    return updated;
  }

  hasPending(approvalId: string): boolean {
    return this.pending.has(approvalId);
  }

  /** Cancel any pending approvals for a bot (used when a turn is interrupted). */
  cancelForBot(botId: string): void {
    for (const [id, p] of [...this.pending]) {
      const a = this.store.getApproval(id);
      if (a?.botId !== botId) continue;
      clearTimeout(p.timer);
      this.pending.delete(id);
      this.store.resolveApproval(id, 'denied', 'user', null, 'Turn interrupted');
      p.resolve({ behavior: 'deny', message: 'Interrupted.', via: 'user' });
    }
  }
}
