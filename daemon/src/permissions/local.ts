import path from 'node:path';

/**
 * Decide whether a proposed tool call reaches OUTSIDE the shared workspace — i.e.
 * touches the user's own machine rather than the bots' computer.
 *
 * ant-bot has no separate cloud VM, so Grok Bot's "execution on local computer"
 * control maps onto this boundary: the workspace is the bots' computer, and
 * everything else is your machine.
 */
export type LocalReach = { reaches: boolean; evidence: string };

const HOME_ISH = /(^|[\s"'=:])(~|\$HOME)\//;

/** Anything scheme://... — a URL's path is not a filesystem path. */
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;

/**
 * Filesystem path candidates in a command string: absolute (`/etc`), home-relative
 * (`~/.ssh`), and dot-relative (`./src`, `../..`). Dot-relative forms are kept rather
 * than dropped because they resolve against the workspace, so `./src` reads as inside
 * while `../../.ssh` correctly reads as an escape.
 */
export function extractPaths(text: string): string[] {
  const out: string[] = [];
  const cleaned = text.replace(URL_RE, ' ');
  for (const m of cleaned.matchAll(/(?<![\w\-.:/])((?:~|\.{1,2}\/|\.\.(?=\s|$)|\/)[^\s"';|&)]*)/g)) {
    const p = m[1];
    if (p && p.length > 1) out.push(p);
  }
  return out;
}

/**
 * @param allowedRoots Directories that count as inside even though they are not the workspace.
 *   ant-bot's own attachments directory is one: a file the human attached to the message they
 *   are sending is theirs, already handed over deliberately, and making the bot ask permission
 *   to open the image you just gave it stalls the turn on a question with one sensible answer.
 */
export function assessLocalReach(
  toolName: string,
  input: unknown,
  workspace: string,
  allowedRoots: string[] = [],
): LocalReach {
  const o = (input ?? {}) as Record<string, unknown>;
  const str = (k: string): string => (typeof o[k] === 'string' ? (o[k] as string) : '');
  const ws = path.resolve(workspace);
  const roots = [ws, ...allowedRoots.map((r) => path.resolve(r))];

  const insideWorkspace = (p: string): boolean => {
    if (p.startsWith('~')) return false;
    const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(ws, p);
    return roots.some((root) => {
      const rel = path.relative(root, abs);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });
  };

  // File tools carry an explicit path.
  if (toolName === 'Read' || toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') {
    const p = str('file_path') || str('notebook_path');
    if (p && !insideWorkspace(p)) return { reaches: true, evidence: p };
    return { reaches: false, evidence: '' };
  }

  if (toolName === 'Bash') {
    const cmd = str('command');
    if (HOME_ISH.test(cmd)) {
      const m = cmd.match(HOME_ISH);
      return { reaches: true, evidence: m ? cmd.slice(Math.max(0, (m.index ?? 0)), (m.index ?? 0) + 60).trim() : '~' };
    }
    for (const p of extractPaths(cmd)) {
      if (!insideWorkspace(p)) return { reaches: true, evidence: p };
    }
    return { reaches: false, evidence: '' };
  }

  return { reaches: false, evidence: '' };
}

export type LocalPolicy = 'ask' | 'always' | 'never';

export function localDecision(policy: LocalPolicy, reach: LocalReach):
  | { action: 'ignore' }
  | { action: 'require'; reason: string }
  | { action: 'deny'; reason: string } {
  if (!reach.reaches) return { action: 'ignore' };
  if (policy === 'always') return { action: 'ignore' };
  if (policy === 'never')
    return {
      action: 'deny',
      reason: `Blocked: this touches ${reach.evidence}, which is outside the shared workspace. "Execution on local computer" is set to Never in Settings.`,
    };
  return { action: 'require', reason: `Touches ${reach.evidence}, outside the shared workspace (your own machine)` };
}
