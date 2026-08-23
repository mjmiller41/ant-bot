import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openDb } from '../db/db.js';
import { Store } from '../db/store.js';
import { EventBus } from '../util/bus.js';
import { PermissionGateway, summarize, type AutoReviewer, type GatewayDecision } from './gateway.js';
import { parseVerdict } from './autoreview.js';
import { LIMITS, SettingsSchema, type Settings, type ServerEvent } from '@antbot/shared';

/** All fixtures act inside the bots' shared workspace, not the user's machine. */
const WS = '/tmp/antbot-test-workspace';

const settings = (over: Partial<Settings> = {}): Settings => SettingsSchema.parse(over);

/** Let pending microtasks (e.g. an awaited mocked promise) flush before we inspect side effects. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

describe('PermissionGateway', () => {
  let store: Store;
  let bus: EventBus;
  let reviewer: { classify: ReturnType<typeof vi.fn> };
  let gateway: PermissionGateway;

  beforeEach(() => {
    store = new Store(openDb(':memory:'));
    bus = new EventBus();
    reviewer = { classify: vi.fn() };
    gateway = new PermissionGateway(store, bus, reviewer as unknown as AutoReviewer);
  });

  describe('check() decision order', () => {
    it('a matching allow rule allows without an approval row or auto-review', async () => {
      store.createRule({ kind: 'allow', toolPattern: 'Read', scopeNote: 'reads are safe' });
      const decision = await gateway.check({
        botId: 'b1', threadId: 't1', toolName: 'Read', input: { file_path: `${WS}/x` },
        botDescription: '', settings: settings(), workspace: WS,
      });
      expect(decision).toEqual({ behavior: 'allow', reason: 'reads are safe', via: 'rule' });
      expect(store.listPendingApprovals().length).toBe(0);
      expect(reviewer.classify).not.toHaveBeenCalled();
    });

    it('a matching require rule creates an approval, publishes approval.pending, stays pending until decide(), and never consults auto-review (Require beats auto-review)', async () => {
      const events: ServerEvent[] = [];
      bus.subscribe((e) => events.push(e));
      store.createRule({ kind: 'require', toolPattern: 'Bash', scopeNote: 'needs a human' });

      const p = gateway.check({
        botId: 'b1', threadId: 't1', toolName: 'Bash', input: { command: 'rm -rf /' },
        botDescription: '', settings: settings({ autoReviewEnabled: true }), workspace: WS,
      });

      expect(store.listPendingApprovals().length).toBe(1);
      expect(events.some((e) => e.type === 'approval.pending')).toBe(true);
      expect(reviewer.classify).not.toHaveBeenCalled();

      let settled = false;
      p.then(() => { settled = true; });
      await flush();
      expect(settled).toBe(false);

      const approval = store.listPendingApprovals()[0];
      gateway.decide(approval.id, 'allow');
      const decision = await p;
      expect(decision.behavior).toBe('allow');
      expect(reviewer.classify).not.toHaveBeenCalled();
    });

    it('no rule + autoReview enabled + allow_ok allows via auto_review with no approval row', async () => {
      reviewer.classify.mockResolvedValueOnce({ verdict: 'allow_ok', reason: 'routine read' });
      const decision = await gateway.check({
        botId: 'b1', threadId: 't1', toolName: 'SomeTool', input: {},
        botDescription: '', settings: settings({ autoReviewEnabled: true }), workspace: WS,
      });
      expect(decision).toEqual({ behavior: 'allow', reason: 'routine read', via: 'auto_review' });
      expect(store.listPendingApprovals().length).toBe(0);
      expect(reviewer.classify).toHaveBeenCalledTimes(1);
    });

    it('no rule + autoReview enabled + needs_human creates an approval', async () => {
      reviewer.classify.mockResolvedValueOnce({ verdict: 'needs_human', reason: 'ambiguous' });
      const p = gateway.check({
        botId: 'b1', threadId: 't1', toolName: 'SomeTool', input: {},
        botDescription: '', settings: settings({ autoReviewEnabled: true }), workspace: WS,
      });
      await flush();
      expect(store.listPendingApprovals().length).toBe(1);
      const approval = store.listPendingApprovals()[0];
      expect(approval.reason).toBe('ambiguous');
      gateway.decide(approval.id, 'deny');
      const decision = await p;
      expect(decision.behavior).toBe('deny');
    });

    it('reviewer throwing falls back to a human approval and must not allow', async () => {
      reviewer.classify.mockRejectedValueOnce(new Error('boom'));
      const p = gateway.check({
        botId: 'b1', threadId: 't1', toolName: 'SomeTool', input: {},
        botDescription: '', settings: settings({ autoReviewEnabled: true }), workspace: WS,
      });
      await flush();
      expect(reviewer.classify).toHaveBeenCalledTimes(1);
      expect(store.listPendingApprovals().length).toBe(1);
      const approval = store.listPendingApprovals()[0];
      gateway.decide(approval.id, 'deny');
      const decision = await p;
      expect(decision.behavior).not.toBe('allow');
    });

    it('autoReview disabled in settings creates an approval and never calls the reviewer', async () => {
      const p = gateway.check({
        botId: 'b1', threadId: 't1', toolName: 'SomeTool', input: {},
        botDescription: '', settings: settings({ autoReviewEnabled: false }), workspace: WS,
      });
      expect(reviewer.classify).not.toHaveBeenCalled();
      expect(store.listPendingApprovals().length).toBe(1);
      const approval = store.listPendingApprovals()[0];
      gateway.decide(approval.id, 'deny');
      await p;
    });
  });

  describe('decide()', () => {
    it("decide(id,'allow') resolves the pending promise with allow, sets status allowed, publishes approval.resolved", async () => {
      const events: ServerEvent[] = [];
      bus.subscribe((e) => events.push(e));
      store.createRule({ kind: 'require', toolPattern: 'Bash' });
      const p = gateway.check({ botId: 'b1', threadId: 't1', toolName: 'Bash', input: { command: 'x' }, botDescription: '', settings: settings(), workspace: WS });
      const approval = store.listPendingApprovals()[0];

      const updated = gateway.decide(approval.id, 'allow');
      expect(updated?.status).toBe('allowed');
      expect(events.some((e) => e.type === 'approval.resolved' && e.approval.status === 'allowed')).toBe(true);

      const decision = await p;
      expect(decision).toEqual({ behavior: 'allow', reason: 'Approved by you', via: 'user' });
    });

    it("decide(id,'deny') resolves the pending promise with deny", async () => {
      store.createRule({ kind: 'require', toolPattern: 'Bash' });
      const p = gateway.check({ botId: 'b1', threadId: 't1', toolName: 'Bash', input: { command: 'x' }, botDescription: '', settings: settings(), workspace: WS });
      const approval = store.listPendingApprovals()[0];

      const updated = gateway.decide(approval.id, 'deny');
      expect(updated?.status).toBe('denied');

      const decision = await p;
      expect(decision).toEqual({ behavior: 'deny', message: 'You denied this action.', via: 'user' });
    });

    it('decide with alwaysRule creates a new allow rule and links its id on the approval', async () => {
      store.createRule({ kind: 'require', toolPattern: 'Bash' });
      const p = gateway.check({ botId: 'b1', threadId: 't1', toolName: 'Bash', input: { command: 'x' }, botDescription: '', settings: settings(), workspace: WS });
      const approval = store.listPendingApprovals()[0];

      const before = store.listRules().length;
      const updated = gateway.decide(approval.id, 'allow', { toolPattern: 'Bash', scopeNote: 'always allow bash' });
      expect(store.listRules().length).toBe(before + 1);
      expect(updated?.ruleId).toBeTruthy();
      const newRule = store.listRules().find((r) => r.id === updated!.ruleId);
      expect(newRule?.kind).toBe('allow');
      expect(newRule?.toolPattern).toBe('Bash');

      await p;
    });

    it('decide on an already-resolved approval returns it unchanged (idempotent, no double-resolve)', async () => {
      store.createRule({ kind: 'require', toolPattern: 'Bash' });
      const p = gateway.check({ botId: 'b1', threadId: 't1', toolName: 'Bash', input: { command: 'x' }, botDescription: '', settings: settings(), workspace: WS });
      const approval = store.listPendingApprovals()[0];
      const first = gateway.decide(approval.id, 'allow');
      await p;

      const events: ServerEvent[] = [];
      bus.subscribe((e) => events.push(e));
      const second = gateway.decide(approval.id, 'deny');

      expect(second).toEqual(first);
      expect(second?.status).toBe('allowed');
      expect(events.length).toBe(0);
    });

    it('decide with an unknown id returns null', () => {
      expect(gateway.decide('nonexistent', 'allow')).toBeNull();
    });
  });

  describe('cancelForBot', () => {
    it("denies that bot's pending approvals and resolves their promises, leaving another bot's pending approval alone", async () => {
      store.createRule({ kind: 'require', toolPattern: 'Bash' });
      const pA = gateway.check({ botId: 'botA', threadId: 't1', toolName: 'Bash', input: { command: 'x' }, botDescription: '', settings: settings(), workspace: WS });
      const pB = gateway.check({ botId: 'botB', threadId: 't2', toolName: 'Bash', input: { command: 'y' }, botDescription: '', settings: settings(), workspace: WS });

      const approvalA = store.listPendingApprovals().find((a) => a.botId === 'botA')!;
      const approvalB = store.listPendingApprovals().find((a) => a.botId === 'botB')!;

      gateway.cancelForBot('botA');

      const decisionA = await pA;
      expect(decisionA.behavior).toBe('deny');
      expect(store.getApproval(approvalA.id)?.status).toBe('denied');

      expect(store.getApproval(approvalB.id)?.status).toBe('pending');
      expect(gateway.hasPending(approvalB.id)).toBe(true);

      // cleanup so no dangling timer/promise remains
      gateway.decide(approvalB.id, 'deny');
      await pB;
    });
  });

  describe('AbortSignal', () => {
    it('aborting the passed signal resolves the pending check as a deny', async () => {
      store.createRule({ kind: 'require', toolPattern: 'Bash' });
      const controller = new AbortController();
      const p = gateway.check({
        botId: 'b1', threadId: 't1', toolName: 'Bash', input: { command: 'x' },
        botDescription: '', settings: settings(), signal: controller.signal, workspace: WS,
      });
      controller.abort();
      const decision: GatewayDecision = await p;
      expect(decision.behavior).toBe('deny');
    });
  });

  describe('approval timeout expiry', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('advancing past LIMITS.APPROVAL_TIMEOUT_MS marks the approval expired and resolves as deny', async () => {
      vi.useFakeTimers();
      store.createRule({ kind: 'require', toolPattern: 'Bash' });
      const events: ServerEvent[] = [];
      bus.subscribe((e) => events.push(e));

      const p = gateway.check({ botId: 'b1', threadId: 't1', toolName: 'Bash', input: { command: 'x' }, botDescription: '', settings: settings(), workspace: WS });
      const approval = store.listPendingApprovals()[0];

      await vi.advanceTimersByTimeAsync(LIMITS.APPROVAL_TIMEOUT_MS + 1);

      const decision = await p;
      expect(decision.behavior).toBe('deny');
      if (decision.behavior === 'deny') expect(decision.via).toBe('timeout');
      expect(store.getApproval(approval.id)?.status).toBe('expired');
      expect(events.some((e) => e.type === 'approval.resolved' && e.approval.status === 'expired')).toBe(true);
    });
  });
});

describe('summarize()', () => {
  it('Bash', () => {
    expect(summarize('Bash', { command: 'ls -la' })).toBe('Run: ls -la');
  });
  it('Write', () => {
    expect(summarize('Write', { file_path: '/a.txt' })).toBe('Write file /a.txt');
  });
  it('Edit', () => {
    expect(summarize('Edit', { file_path: '/a.txt' })).toBe('Edit file /a.txt');
  });
  it('Read', () => {
    expect(summarize('Read', { file_path: '/a.txt' })).toBe('Read file /a.txt');
  });
  it('WebFetch', () => {
    expect(summarize('WebFetch', { url: 'https://x.com' })).toBe('Fetch https://x.com');
  });
  it('send_to_bot', () => {
    expect(summarize('send_to_bot', { bot_slug: 'writer' })).toBe('Hand work to @writer');
  });
  it('a browser_* tool', () => {
    const s = summarize('browser_click', { selector: '#buy-now', text: '' });
    expect(s).toContain('Browser click');
    expect(s).toContain('#buy-now');
  });
  it('an unknown tool falls back to a flattened, truncated summary', () => {
    const s = summarize('WeirdTool', { foo: 'bar' });
    expect(s).toContain('WeirdTool');
    expect(s).toContain('bar');
  });
});

describe('parseVerdict (fail-closed)', () => {
  it('parses a valid JSON verdict', () => {
    expect(parseVerdict('{"verdict":"allow_ok","reason":"fine"}')).toEqual({ verdict: 'allow_ok', reason: 'fine' });
  });

  it('parses JSON embedded in prose', () => {
    const r = parseVerdict('Sure! {"verdict":"needs_human","reason":"ambiguous"} thanks.');
    expect(r.verdict).toBe('needs_human');
    expect(r.reason).toBe('ambiguous');
  });

  it('defaults to needs_human on malformed JSON', () => {
    expect(parseVerdict('{verdict: allow_ok}').verdict).toBe('needs_human');
  });

  it('defaults to needs_human on an unknown verdict string', () => {
    expect(parseVerdict('{"verdict":"maybe","reason":"?"}').verdict).toBe('needs_human');
  });

  it('defaults to needs_human on empty input', () => {
    expect(parseVerdict('').verdict).toBe('needs_human');
  });
});

describe('summarize with namespaced MCP tool names', () => {
  // The approval card's one-line summary is what a human reads before deciding, so it must
  // stay legible for MCP tools, which arrive as `mcp__<server>__<tool>`.
  it('renders a namespaced browser tool the same as a bare one', () => {
    expect(summarize('mcp__browser__browser_click', { selector: '#buy' })).toBe(
      summarize('browser_click', { selector: '#buy' }),
    );
    expect(summarize('mcp__browser__browser_click', { selector: '#buy' })).toContain('Browser click');
  });

  it('renders a namespaced handoff readably', () => {
    expect(summarize('mcp__antbot__send_to_bot', { bot_slug: 'writer' })).toBe('Hand work to @writer');
  });

  it('leaves non-MCP tools untouched', () => {
    expect(summarize('Bash', { command: 'ls' })).toBe('Run: ls');
  });
});

describe('summarize() — skill install scope', () => {
  // Scope is the whole decision: approving "acme/skills" can mean one skill or a hundred,
  // and the card is the only place the human sees which.
  it('says plainly when a whole repository would be installed', () => {
    const out = summarize('mcp__antbot__install_skill', { source: 'acme/skills', reason: 'r' });
    expect(out).toContain('EVERY skill');
    expect(out).toContain('acme/skills');
  });

  it('names the one skill when the source is scoped to a directory', () => {
    expect(summarize('mcp__antbot__install_skill', {
      source: 'https://github.com/acme/skills/tree/main/deep-research',
      reason: 'r',
    })).toBe('Install "deep-research" from github.com/acme/skills#main');
  });

  it('distinguishes the two, so the card cannot read the same either way', () => {
    const whole = summarize('mcp__antbot__install_skill', { source: 'acme/skills', reason: 'r' });
    const one = summarize('mcp__antbot__install_skill', {
      source: 'acme/skills/tree/main/deep-research', reason: 'r',
    });
    expect(whole).not.toBe(one);
  });

  it('renders a removal by slug', () => {
    expect(summarize('mcp__antbot__remove_skill', { slug: 'pdf-tools', reason: 'r' })).toBe(
      'Uninstall the skill "pdf-tools"',
    );
  });
});
