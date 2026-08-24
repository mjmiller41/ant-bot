import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Card, Approval, RosterEntry } from '@antbot/contract';
import { CardView, CardList, describeResult } from './Cards.js';
import { useStore } from '../store/useStore.js';

function makeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: 'appr-1',
    botId: 'bot-1',
    threadId: 'thread-1',
    toolName: 'Bash',
    inputSummary: 'run rm -rf /tmp/x',
    rawInput: { command: 'rm -rf /tmp/x' },
    status: 'pending',
    decidedBy: null,
    reason: '',
    ruleId: null,
    createdAt: Date.now(),
    decidedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  useStore.setState({ pendingApprovals: [], bots: [] as RosterEntry[] });
});

describe('CardView', () => {
  it('renders a tool card with monospace summary, status pill, and raw input details', () => {
    const card: Card = {
      type: 'tool',
      toolName: 'Bash',
      summary: 'ls -la /workspace',
      input: { command: 'ls -la /workspace' },
      status: 'ok',
    };
    render(<CardView card={card} />);
    expect(screen.getByText('ls -la /workspace')).toBeInTheDocument();
    expect(screen.getByText(/ok/i)).toBeInTheDocument();
    expect(screen.getByText(/"command"/)).toBeInTheDocument();
  });

  // A mail search returns a page of JSON; rendering it verbatim buries the bot's actual reply.
  it('collapses a JSON result behind a line that says what came back', () => {
    const result = JSON.stringify({ threads: [{ id: '1' }, { id: '2' }, { id: '3' }] });
    const card: Card = { type: 'tool', toolName: 'mcp__gmail__search_threads', summary: 'gmail: search_threads query: is:unread', result, status: 'ok' };
    render(<CardView card={card} />);
    expect(screen.getByText(/Result — 3 threads/)).toBeInTheDocument();
    // Present, but inside a closed <details> — not on screen until asked for.
    expect(screen.getByText(new RegExp('"threads"')).closest('details')).not.toHaveAttribute('open');
  });

  it('leaves a plain-text result visible, because that is usually the point', () => {
    const card: Card = { type: 'tool', toolName: 'Bash', summary: 'ls', result: 'a.txt\nb.txt', status: 'ok' };
    render(<CardView card={card} />);
    expect(screen.getByText(/a\.txt/)).toBeInTheDocument();
    expect(screen.queryByText(/^Result —/)).not.toBeInTheDocument();
  });

  it('renders a running tool card with a running status pill', () => {
    const card: Card = { type: 'tool', toolName: 'Bash', summary: 'installing deps', status: 'running' };
    render(<CardView card={card} />);
    expect(screen.getByText(/running/i)).toBeInTheDocument();
  });

  it('renders a file card with name, size, and a download link', () => {
    const card: Card = {
      type: 'file',
      path: 'reports/summary.md',
      name: 'summary.md',
      mime: 'text/markdown',
      bytes: 2048,
      action: 'created',
    };
    render(<CardView card={card} />);
    expect(screen.getByText('summary.md')).toBeInTheDocument();
    expect(screen.getByText(/2(\.0)? ?KB|2048/i)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /download/i });
    expect(link).toHaveAttribute('href', expect.stringContaining('/api/workspace/file?path='));
    expect(link.getAttribute('href')).toContain(encodeURIComponent('reports/summary.md'));
  });

  it('renders an approval card using the pending approval looked up by id', () => {
    const approval = makeApproval();
    useStore.setState({ pendingApprovals: [approval] });
    const card: Card = { type: 'approval', approvalId: 'appr-1' };
    render(<CardView card={card} />);
    expect(screen.getByText('Bash')).toBeInTheDocument();
    expect(screen.getByText(/run rm -rf \/tmp\/x/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /allow once/i })).toBeInTheDocument();
  });

  it('renders a fallback for an approval card whose approval is no longer pending', () => {
    const card: Card = { type: 'approval', approvalId: 'gone' };
    render(<CardView card={card} />);
    expect(screen.getByText(/resolved/i)).toBeInTheDocument();
  });

  it('renders a handoff card with both bot names and an arrow', () => {
    useStore.setState({
      bots: [
        { bot: { id: 'bot-1', name: 'Scout' } as never, thread: null, lastMessageAt: 0 },
        { bot: { id: 'bot-2', name: 'Archivist' } as never, thread: null, lastMessageAt: 0 },
      ],
    });
    const card: Card = { type: 'handoff', fromBotId: 'bot-1', toBotId: 'bot-2', note: 'handing off research' };
    render(<CardView card={card} />);
    expect(screen.getByText('Scout')).toBeInTheDocument();
    expect(screen.getByText('Archivist')).toBeInTheDocument();
    expect(screen.getByText(/handing off research/)).toBeInTheDocument();
  });

  it('renders an error card with the error message', () => {
    const card: Card = { type: 'error', message: 'Tool failed: permission denied' };
    render(<CardView card={card} />);
    expect(screen.getByText('Tool failed: permission denied')).toBeInTheDocument();
  });
});

describe('describeResult', () => {
  it('names the list a result carries', () => {
    expect(describeResult(JSON.stringify({ threads: [1, 2] })).label).toMatch(/^2 threads · /);
    expect(describeResult(JSON.stringify([1, 2, 3])).label).toMatch(/^3 items · /);
    expect(describeResult(JSON.stringify({ threads: [1] })).label).toMatch(/^1 threads · /);
  });

  it('falls back to the keys when nothing is a list', () => {
    expect(describeResult(JSON.stringify({ id: 'x', subject: 's' })).label).toMatch(/^id, subject · /);
    expect(describeResult(JSON.stringify({ a: 1, b: 2, c: 3, d: 4, e: 5 })).label).toMatch(/\+1 · /);
  });

  it('treats text as text, so it is not hidden', () => {
    expect(describeResult('ok')).toEqual({ label: 'ok', json: false });
    expect(describeResult('one\ntwo').label).toBe('one · 2 lines');
  });

  // A truncated or malformed blob must not be announced as structured data.
  it('does not claim JSON it could not parse', () => {
    expect(describeResult('{"threads": [').json).toBe(false);
  });
});

describe('CardList — the work is folded away, the answer is not', () => {
  const tool = (over: Partial<Extract<Card, { type: 'tool' }>> = {}): Card =>
    ({ type: 'tool', toolName: 'Read', summary: 'a.txt', status: 'ok', ...over }) as Card;

  it('shows one line for a message full of tool calls, not a box each', () => {
    render(<CardList cards={[tool(), tool(), tool()]} />);
    expect(screen.getByText('3 steps')).toBeInTheDocument();
    // Rendered, but inside a closed <details>: nothing between you and the reply.
    expect(screen.getByText('3 steps').closest('details')).not.toHaveAttribute('open');
  });

  it('names what is running so a long turn shows progress', () => {
    render(<CardList cards={[tool(), tool({ toolName: 'mcp__gmail__search_threads', status: 'running' })]} />);
    expect(screen.getByText('Working… search_threads')).toBeInTheDocument();
  });

  it('says when a step failed rather than hiding it completely', () => {
    render(<CardList cards={[tool(), tool({ status: 'error' })]} />);
    expect(screen.getByText('2 steps · 1 failed')).toBeInTheDocument();
  });

  // An approval blocks the turn and an error is the reason there is no answer: folding those
  // away would hide the thing the person has to act on.
  it('leaves everything actionable in full view', () => {
    render(<CardList cards={[tool(), { type: 'error', message: 'it broke' } as Card]} />);
    expect(screen.getByText('it broke')).toBeInTheDocument();
    expect(screen.getByText('1 step')).toBeInTheDocument();
  });

  it('folds every step into a single line, wherever they appear', () => {
    render(<CardList cards={[tool(), { type: 'error', message: 'x' } as Card, tool()]} />);
    expect(screen.getAllByText(/step/)).toHaveLength(1);
    expect(screen.getByText('2 steps')).toBeInTheDocument();
  });
});
