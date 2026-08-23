import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Card, Approval, RosterEntry } from '@antbot/contract';
import { CardView } from './Cards.js';
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
