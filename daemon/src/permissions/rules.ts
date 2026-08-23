import type { Rule } from '@antbot/contract';
import type { Store } from '../db/store.js';
import { logger } from '../util/log.js';

const log = logger('rules');

/** Convert a glob (only `*` is special) to an anchored, case-insensitive regex. */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

/** Flatten a tool input into one searchable string so input patterns can match anywhere. */
export function serializeInput(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

/**
 * Build the text a rule's `inputPattern` is tested against.
 *
 * Every string value in the input gets its own line, and the serialized form is
 * appended last. Patterns are matched multiline, so `^` anchors to the start of an
 * actual argument value (e.g. the Bash `command`) rather than to the start of a JSON
 * blob — without that, an anchored allow-rule can never fire and the action falls
 * through to a human prompt.
 */
export function buildMatchText(input: unknown): string {
  const lines: string[] = [];
  const walk = (v: unknown, depth: number): void => {
    if (depth > 6) return;
    if (typeof v === 'string') lines.push(v);
    else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
    else if (v && typeof v === 'object') Object.values(v).forEach((x) => walk(x, depth + 1));
    else if (typeof v === 'number' || typeof v === 'boolean') lines.push(String(v));
  };
  walk(input, 0);
  const serialized = serializeInput(input);
  if (serialized && !lines.includes(serialized)) lines.push(serialized);
  return lines.join('\n');
}

export interface RuleMatch {
  rule: Rule;
  matched: true;
}

/**
 * Names a tool call can be matched against.
 *
 * Tools served over MCP arrive at the permission boundary fully namespaced as
 * `mcp__<server>__<tool>` — a live turn records the browser tools as
 * `mcp__browser__browser_navigate`. Rule tool patterns are anchored, so a rule written
 * against the bare name (`browser_click`, `send_to_bot`) could never match, silently
 * killing the consequential-click, credential-typing and handoff require-rules.
 *
 * Matching against both forms keeps rules authored either way working. Both `require`
 * and `allow` rules get the same treatment, so this cannot flip a blocked action into
 * an allowed one — `require` still wins (see `evaluateRules`).
 */
export function toolNameAliases(toolName: string): string[] {
  const m = /^mcp__.+?__(.+)$/.exec(toolName);
  return m?.[1] ? [toolName, m[1]] : [toolName];
}

export function ruleMatches(rule: Rule, toolName: string, inputText: string): boolean {
  if (!rule.enabled) return false;
  const pattern = globToRegExp(rule.toolPattern);
  if (!toolNameAliases(toolName).some((n) => pattern.test(n))) return false;
  if (rule.inputPattern) {
    let re: RegExp;
    try {
      re = new RegExp(rule.inputPattern, 'im');
    } catch {
      return false; // an invalid stored pattern must never silently allow
    }
    if (!re.test(inputText)) return false;
  }
  return true;
}

export type RuleDecision =
  | { kind: 'require'; rule: Rule }
  | { kind: 'allow'; rule: Rule }
  | { kind: 'none' };

/**
 * Precedence, per outline §9: an enabled `require` rule always wins over any
 * `allow` rule. Only when no `require` matches can an `allow` take effect.
 */
export function evaluateRules(rules: Rule[], toolName: string, input: unknown): RuleDecision {
  const inputText = buildMatchText(input);
  const required = rules.find((r) => r.kind === 'require' && ruleMatches(r, toolName, inputText));
  if (required) return { kind: 'require', rule: required };
  const allowed = rules.find((r) => r.kind === 'allow' && ruleMatches(r, toolName, inputText));
  if (allowed) return { kind: 'allow', rule: allowed };
  return { kind: 'none' };
}

/**
 * Default require-rules (WP-2.1). These ship enabled so that sending, publishing,
 * purchasing, deleting outside the workspace, installs, sudo and git push are all
 * behind approval out of the box.
 */
export const BUILTIN_RULES: Array<Omit<Rule, 'id' | 'createdAt'>> = [
  { kind: 'require', toolPattern: 'Bash', inputPattern: '\\bsudo\\b|\\bdoas\\b|\\bsu\\s+-', scopeNote: 'Privilege escalation', builtin: true, enabled: true },
  { kind: 'require', toolPattern: 'Bash', inputPattern: 'rm\\s+(-[a-zA-Z]*\\s+)*-?[rf]|shred\\b|mkfs\\b|dd\\s+if=', scopeNote: 'Destructive filesystem command', builtin: true, enabled: true },
  { kind: 'require', toolPattern: 'Bash', inputPattern: 'curl[^|]*\\|\\s*(ba)?sh|wget[^|]*\\|\\s*(ba)?sh', scopeNote: 'Piping a download into a shell', builtin: true, enabled: true },
  { kind: 'require', toolPattern: 'Bash', inputPattern: '\\b(npm|pnpm|yarn|pip|pip3|gem|cargo|apt|apt-get|dnf|brew|go)\\s+(i|install|add|get)\\b', scopeNote: 'Package install', builtin: true, enabled: true },
  { kind: 'require', toolPattern: 'Bash', inputPattern: 'git\\s+(push|remote\\s+add)|gh\\s+(pr|release|repo)\\s+(create|merge)', scopeNote: 'Publishing to a remote', builtin: true, enabled: true },
  { kind: 'require', toolPattern: 'Bash', inputPattern: '\\b(mail|sendmail|mutt|msmtp)\\b', scopeNote: 'Sending mail', builtin: true, enabled: true },
  { kind: 'require', toolPattern: 'Bash', inputPattern: 'curl[^\\n]*(-X\\s*(POST|PUT|PATCH|DELETE)|--data|-d\\s)', scopeNote: 'Outbound write request', builtin: true, enabled: true },
  { kind: 'require', toolPattern: 'WebFetch', inputPattern: '.', scopeNote: 'Fetching an external URL', builtin: true, enabled: true },
  { kind: 'require', toolPattern: 'browser_click', inputPattern: '(buy|purchase|checkout|pay|order|subscribe|confirm|delete|send|publish)', scopeNote: 'Consequential click', builtin: true, enabled: true },
  { kind: 'require', toolPattern: 'browser_type', inputPattern: '(password|passwd|secret|token|api[_-]?key|ssn|credit\\s*card)', scopeNote: 'Typing a credential — use takeover instead', builtin: true, enabled: true },
  { kind: 'require', toolPattern: 'send_to_bot', inputPattern: '', scopeNote: 'Handing work to another bot', builtin: false, enabled: false },
  { kind: 'require', toolPattern: 'install_skill', inputPattern: '', scopeNote: 'Installing a skill from an external source', builtin: true, enabled: true },
  { kind: 'require', toolPattern: 'remove_skill', inputPattern: '', scopeNote: 'Uninstalling a skill', builtin: true, enabled: true },
  { kind: 'allow', toolPattern: 'Read', inputPattern: '', scopeNote: 'Reading files is safe', builtin: true, enabled: true },
  { kind: 'allow', toolPattern: 'Glob', inputPattern: '', scopeNote: 'Listing files is safe', builtin: true, enabled: true },
  { kind: 'allow', toolPattern: 'Grep', inputPattern: '', scopeNote: 'Searching files is safe', builtin: true, enabled: true },
  { kind: 'allow', toolPattern: 'TodoWrite', inputPattern: '', scopeNote: 'Planning scratchpad', builtin: true, enabled: true },
  { kind: 'allow', toolPattern: 'Bash', inputPattern: '^\\s*(git\\s+(status|diff|log|show|branch)|ls|pwd|cat|head|tail|wc|echo|date|which|grep|find|rg)\\b', scopeNote: 'Read-only shell inspection', builtin: true, enabled: true },
];

/**
 * Ensure every builtin rule exists, adding only the ones that don't.
 *
 * Seeding all-or-nothing would mean a rule added in a later version never reaches an
 * existing database — the new gate would silently not apply to exactly the installs that
 * have been running longest. Rules already present are left alone, so a builtin the user
 * has disabled stays disabled.
 */
export function seedBuiltinRules(store: Store): void {
  // Match across every rule, not just `builtin` ones: one seeded entry (send_to_bot) is
  // deliberately created as a user rule, and filtering to builtins would re-add it each boot.
  const key = (r: { kind: string; toolPattern: string; inputPattern: string }): string =>
    `${r.kind}\u0000${r.toolPattern}\u0000${r.inputPattern}`;
  const existing = new Set(store.listRules().map(key));
  const added: string[] = [];
  for (const r of BUILTIN_RULES) {
    if (existing.has(key(r))) continue;
    const rule = store.createRule(r);
    if (!r.enabled) store.setRuleEnabled(rule.id, false);
    added.push(r.toolPattern);
  }
  if (added.length) log.info(`seeded ${added.length} builtin permission rule(s): ${added.join(', ')}`);
}
