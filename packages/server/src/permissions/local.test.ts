import { describe, expect, it } from 'vitest';
import { assessLocalReach, extractPaths, localDecision } from './local.js';

const WS = '/home/u/antbot/workspace';

const reaches = (tool: string, input: unknown): boolean =>
  assessLocalReach(tool, input, WS).reaches;

describe('extractPaths', () => {
  it('pulls absolute and home-relative paths out of a command', () => {
    expect(extractPaths('cat /etc/passwd')).toContain('/etc/passwd');
    expect(extractPaths('cp ~/.ssh/id_rsa /tmp/x')).toEqual(
      expect.arrayContaining(['~/.ssh/id_rsa', '/tmp/x']),
    );
  });

  it('ignores bare flags', () => {
    expect(extractPaths('ls -la')).toEqual([]);
    expect(extractPaths('npm test')).toEqual([]);
  });

  it('keeps dot-relative paths so they can be resolved against the workspace', () => {
    expect(extractPaths('ls -la ./src')).toEqual(['./src']);
    expect(extractPaths('cat ../../.ssh/id_rsa')).toEqual(['../../.ssh/id_rsa']);
  });

  it('does not mistake a URL path for a filesystem path', () => {
    expect(extractPaths('curl https://example.com/foo')).toEqual([]);
    expect(extractPaths('git clone git+ssh://host/repo /srv/x')).toEqual(['/srv/x']);
  });

  it('stops at shell metacharacters', () => {
    expect(extractPaths('cat /etc/hosts|wc -l')).toEqual(['/etc/hosts']);
  });
});

describe('assessLocalReach', () => {
  describe('file tools', () => {
    it('treats a path inside the workspace as local-safe', () => {
      expect(reaches('Read', { file_path: `${WS}/notes.md` })).toBe(false);
      expect(reaches('Write', { file_path: `${WS}/deep/nested/a.txt` })).toBe(false);
    });

    it('flags a path outside the workspace', () => {
      expect(reaches('Read', { file_path: '/etc/passwd' })).toBe(true);
      expect(reaches('Edit', { file_path: '/home/u/.bashrc' })).toBe(true);
    });

    it('flags traversal that escapes the workspace', () => {
      expect(reaches('Read', { file_path: `${WS}/../../.ssh/id_rsa` })).toBe(true);
    });

    it('flags a tilde path, which never resolves inside the workspace', () => {
      expect(reaches('Read', { file_path: '~/.ssh/id_rsa' })).toBe(true);
    });

    it('does not flag a sibling directory that merely shares a name prefix', () => {
      expect(reaches('Read', { file_path: `${WS}-backup/secrets` })).toBe(true);
    });

    it('reports the offending path as evidence', () => {
      expect(assessLocalReach('Read', { file_path: '/etc/passwd' }, WS).evidence).toBe('/etc/passwd');
    });

    it('is inert when no path is present', () => {
      expect(reaches('Read', {})).toBe(false);
      expect(reaches('Read', { file_path: 123 })).toBe(false);
    });

    it('covers notebook_path', () => {
      expect(reaches('NotebookEdit', { notebook_path: '/home/u/a.ipynb' })).toBe(true);
      expect(reaches('NotebookEdit', { notebook_path: `${WS}/a.ipynb` })).toBe(false);
    });
  });

  describe('Bash', () => {
    it('allows commands confined to the workspace', () => {
      expect(reaches('Bash', { command: 'ls -la' })).toBe(false);
      expect(reaches('Bash', { command: `cat ${WS}/README.md` })).toBe(false);
      expect(reaches('Bash', { command: 'npm test' })).toBe(false);
    });

    it('flags an absolute path outside the workspace', () => {
      expect(reaches('Bash', { command: 'cat /etc/shadow' })).toBe(true);
    });

    it('flags $HOME and ~ expansion', () => {
      expect(reaches('Bash', { command: 'cat ~/.aws/credentials' })).toBe(true);
      expect(reaches('Bash', { command: 'cat $HOME/.aws/credentials' })).toBe(true);
    });

    it('flags an out-of-workspace path buried after a safe prefix', () => {
      expect(reaches('Bash', { command: `cd ${WS} && cp x /home/u/Desktop/x` })).toBe(true);
    });

    it('allows dot-relative paths that stay inside the workspace', () => {
      expect(reaches('Bash', { command: 'ls -la ./src' })).toBe(false);
      expect(reaches('Bash', { command: 'cat ./a/../b' })).toBe(false);
    });

    it('flags dot-relative traversal that escapes the workspace', () => {
      expect(reaches('Bash', { command: 'cat ../../.ssh/id_rsa' })).toBe(true);
    });

    it('does not flag a command whose only paths are inside a URL', () => {
      expect(reaches('Bash', { command: 'curl -sS https://example.com/etc/passwd' })).toBe(false);
    });

    it('is inert when the command is missing', () => {
      expect(reaches('Bash', {})).toBe(false);
    });
  });

  it('ignores tools that carry no filesystem reach', () => {
    expect(reaches('WebFetch', { url: 'https://example.com' })).toBe(false);
    expect(reaches('mcp__antbot__send_to_bot', { botId: 'b1' })).toBe(false);
  });

  it('tolerates non-object input', () => {
    expect(reaches('Bash', null)).toBe(false);
    expect(reaches('Read', 'string')).toBe(false);
  });
});

describe('localDecision', () => {
  const out = { reaches: true, evidence: '/etc/passwd' };
  const inside = { reaches: false, evidence: '' };

  it('ignores anything that stays inside the workspace, whatever the policy', () => {
    for (const p of ['ask', 'always', 'never'] as const) {
      expect(localDecision(p, inside)).toEqual({ action: 'ignore' });
    }
  });

  it('always: lets local reach through untouched', () => {
    expect(localDecision('always', out)).toEqual({ action: 'ignore' });
  });

  it('never: denies and names the setting', () => {
    const d = localDecision('never', out);
    expect(d.action).toBe('deny');
    expect(d.action === 'deny' && d.reason).toContain('/etc/passwd');
    expect(d.action === 'deny' && d.reason).toContain('Never');
  });

  it('ask: requires human approval and names the path', () => {
    const d = localDecision('ask', out);
    expect(d.action).toBe('require');
    expect(d.action === 'require' && d.reason).toContain('/etc/passwd');
  });
});
