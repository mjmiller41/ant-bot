import { describe, it, expect } from 'vitest';
import type { Connector, ConnectorConfig } from '@antbot/contract';
import { summarizeTool } from './manager.js';
import {
  SECRET_REF_RE,
  extractSecretRefs,
  computeMissingSecrets,
  planConnectorMount,
  buildMcpServerConfig,
  MissingSecretError,
} from './connectors.js';

const connector = (name: string, config: ConnectorConfig): Connector =>
  ({ id: `id-${name}`, name, description: '', enabled: true, config, createdAt: 0 });

const stdio = (env: Record<string, string> = {}): ConnectorConfig =>
  ({ transport: 'stdio', command: 'npx', args: ['-y', 'srv'], env });
const http = (headers: Record<string, string> = {}, tools?: string[]): ConnectorConfig =>
  ({ transport: 'http', url: 'https://x.dev/mcp', headers, ...(tools ? { tools } : {}) });

describe('extractSecretRefs', () => {
  it('finds references in stdio env and http headers alike', () => {
    expect(extractSecretRefs(stdio({ TOKEN: '{{secret:GH}}' }))).toEqual(['GH']);
    expect(extractSecretRefs(http({ Authorization: '{{secret:GH}}' }))).toEqual(['GH']);
  });

  // The reason refs are templates and not a structured field: a real Authorization header is a
  // scheme plus a token, so the reference has to sit inside a larger string.
  it('finds a reference embedded in a composite value', () => {
    expect(extractSecretRefs(http({ Authorization: 'Bearer {{secret:GH_TOKEN}}' }))).toEqual(['GH_TOKEN']);
  });

  it('finds several references, including two in one value, and deduplicates', () => {
    const refs = extractSecretRefs(stdio({ A: '{{secret:X}}:{{secret:Y}}', B: '{{secret:X}}' }));
    expect(refs).toEqual(['X', 'Y']);
  });

  it('returns nothing for a config with no references', () => {
    expect(extractSecretRefs(stdio({ PLAIN: 'literal' }))).toEqual([]);
    expect(extractSecretRefs(http())).toEqual([]);
  });

  it('ignores text that only looks like a reference', () => {
    expect(extractSecretRefs(stdio({ A: '{secret:X}', B: '{{secret}}', C: '{{ secret:X }}' }))).toEqual([]);
  });

  it('uses a stateless regex — repeated calls agree', () => {
    // A global regex carries lastIndex; matchAll resets it, but pin the behaviour anyway.
    const cfg = stdio({ A: '{{secret:X}}' });
    expect(extractSecretRefs(cfg)).toEqual(extractSecretRefs(cfg));
    expect(SECRET_REF_RE.global).toBe(true);
  });
});

describe('computeMissingSecrets', () => {
  it('names only the references with nothing behind them', () => {
    const c = connector('gh', stdio({ A: '{{secret:HAVE}}', B: '{{secret:MISSING}}' }));
    expect(computeMissingSecrets(c, new Set(['HAVE']))).toEqual(['MISSING']);
    expect(computeMissingSecrets(c, new Set(['HAVE', 'MISSING']))).toEqual([]);
  });

  it('is empty for a connector that needs no secrets', () => {
    expect(computeMissingSecrets(connector('fs', stdio()), new Set())).toEqual([]);
  });
});

describe('planConnectorMount', () => {
  it('mounts everything when all references resolve', () => {
    const cs = [connector('a', stdio({ T: '{{secret:S}}' })), connector('b', stdio())];
    const plan = planConnectorMount(cs, new Set(['S']));
    expect(plan.mount.map((c) => c.name)).toEqual(['a', 'b']);
    expect(plan.skipped).toEqual([]);
  });

  // One broken credential must not take down the rest of the turn — the bot keeps every other
  // connector and every built-in tool.
  it('skips only the connector whose secret is missing', () => {
    const cs = [
      connector('broken', stdio({ T: '{{secret:GONE}}' })),
      connector('fine', stdio({ T: '{{secret:HAVE}}' })),
    ];
    const plan = planConnectorMount(cs, new Set(['HAVE']));
    expect(plan.mount.map((c) => c.name)).toEqual(['fine']);
    expect(plan.skipped).toEqual([{ connector: cs[0], missing: ['GONE'] }]);
  });

  it('skips every credential-bearing connector when no secrets exist at all', () => {
    const cs = [connector('a', stdio({ T: '{{secret:S}}' })), connector('b', stdio())];
    const plan = planConnectorMount(cs, new Set());
    expect(plan.mount.map((c) => c.name)).toEqual(['b']);
    expect(plan.skipped.map((s) => s.connector.name)).toEqual(['a']);
  });

  it('handles an empty assignment list', () => {
    expect(planConnectorMount([], new Set())).toEqual({ mount: [], skipped: [] });
  });
});

describe('buildMcpServerConfig', () => {
  const secrets = new Map<string, string | null>([['GH', 'ghp_real'], ['OTHER', 'zzz']]);

  it('builds a stdio config with the value substituted in', () => {
    const c = connector('gh', stdio({ GITHUB_TOKEN: '{{secret:GH}}', PLAIN: 'kept' }));
    expect(buildMcpServerConfig(c, secrets)).toEqual({
      type: 'stdio', command: 'npx', args: ['-y', 'srv'],
      env: { GITHUB_TOKEN: 'ghp_real', PLAIN: 'kept' },
    });
  });

  it('substitutes inside a composite header and keeps the tool allowlist', () => {
    const c = connector('remote', http({ Authorization: 'Bearer {{secret:GH}}' }, ['a', 'b']));
    expect(buildMcpServerConfig(c, secrets)).toEqual({
      type: 'http', url: 'https://x.dev/mcp',
      headers: { Authorization: 'Bearer ghp_real' },
      tools: ['a', 'b'],
    });
  });

  it('omits the tools key entirely when no allowlist is set', () => {
    expect(buildMcpServerConfig(connector('r', http()), secrets)).not.toHaveProperty('tools');
  });

  it('carries the sse transport through as its own type', () => {
    const c = connector('s', { transport: 'sse', url: 'https://x.dev/sse', headers: {} });
    expect(buildMcpServerConfig(c, secrets)).toMatchObject({ type: 'sse', url: 'https://x.dev/sse' });
  });

  it('substitutes several references in one value', () => {
    const c = connector('m', stdio({ PAIR: '{{secret:GH}}/{{secret:OTHER}}' }));
    expect(buildMcpServerConfig(c, secrets)).toMatchObject({ env: { PAIR: 'ghp_real/zzz' } });
  });

  // Between planning and mounting the backend can still come up empty — a locked keychain, a
  // secret deleted mid-turn. Mounting with the literal "{{secret:NAME}}" as the credential would
  // send that placeholder to a third party as if it were a token.
  it('throws rather than mounting the placeholder as a credential', () => {
    const c = connector('gh', stdio({ T: '{{secret:VANISHED}}' }));
    const empty = new Map<string, string | null>([['VANISHED', null]]);
    expect(() => buildMcpServerConfig(c, empty)).toThrow(MissingSecretError);
    try {
      buildMcpServerConfig(c, empty);
    } catch (err) {
      expect(err).toMatchObject({ connectorName: 'gh', secretName: 'VANISHED' });
      // The error is logged; it must not carry a value even when one exists.
      expect((err as Error).message).not.toContain('ghp_real');
    }
  });

  it('throws when the name is absent from the map entirely', () => {
    const c = connector('gh', stdio({ T: '{{secret:NEVER_ASKED}}' }));
    expect(() => buildMcpServerConfig(c, new Map())).toThrow(MissingSecretError);
  });
});

describe('summarizeTool for connector tools', () => {
  // Without this branch a connector approval card renders as raw JSON with no hint of which
  // server is being asked to act.
  it('names the connector and the tool', () => {
    expect(summarizeTool('mcp__github__create_issue', { title: 'Bug' }))
      .toBe('github: create_issue {"title":"Bug"}');
  });

  it('handles a hyphenated connector and an underscored tool name', () => {
    expect(summarizeTool('mcp__my-srv__do_a_thing', {})).toBe('my-srv: do_a_thing {}');
  });

  // The built-in servers keep their own hand-written summaries.
  it('leaves the built-in servers to their existing branches', () => {
    expect(summarizeTool('mcp__antbot__send_to_bot', { bot_slug: 'planner' })).toBe('→ @planner');
    expect(summarizeTool('mcp__browser__browser_click', { selector: '#go' })).toBe('#go');
  });

  it('still falls back to JSON for a non-MCP tool', () => {
    expect(summarizeTool('SomethingElse', { a: 1 })).toBe('{"a":1}');
  });

  it('truncates a long summary', () => {
    expect(summarizeTool('mcp__gh__x', { blob: 'y'.repeat(400) }).length).toBeLessThanOrEqual(160);
  });
});
