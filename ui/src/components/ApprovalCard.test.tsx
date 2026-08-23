import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Approval } from '@antbot/contract';
import { ApprovalCard } from './ApprovalCard.js';

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

describe('ApprovalCard', () => {
  it('renders the exact raw input JSON inside a collapsible details element', () => {
    const approval = makeApproval();
    render(<ApprovalCard approval={approval} onAllow={vi.fn()} onDeny={vi.fn()} onAlwaysAllow={vi.fn()} />);
    expect(screen.getByText(/"command": "rm -rf \/tmp\/x"/)).toBeInTheDocument();
  });

  it('shows the tool name and human summary', () => {
    const approval = makeApproval();
    render(<ApprovalCard approval={approval} onAllow={vi.fn()} onDeny={vi.fn()} onAlwaysAllow={vi.fn()} />);
    expect(screen.getByText('Bash')).toBeInTheDocument();
    expect(screen.getByText('run rm -rf /tmp/x')).toBeInTheDocument();
  });

  it('fires onAllow when Allow once is clicked', () => {
    const onAllow = vi.fn();
    render(<ApprovalCard approval={makeApproval()} onAllow={onAllow} onDeny={vi.fn()} onAlwaysAllow={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /allow once/i }));
    expect(onAllow).toHaveBeenCalledTimes(1);
  });

  it('fires onDeny when Deny is clicked', () => {
    const onDeny = vi.fn();
    render(<ApprovalCard approval={makeApproval()} onAllow={vi.fn()} onDeny={onDeny} onAlwaysAllow={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^deny$/i }));
    expect(onDeny).toHaveBeenCalledTimes(1);
  });

  it('opens a scope form prefilled with the tool name and submits onAlwaysAllow', () => {
    const onAlwaysAllow = vi.fn();
    render(<ApprovalCard approval={makeApproval()} onAllow={vi.fn()} onDeny={vi.fn()} onAlwaysAllow={onAlwaysAllow} />);
    fireEvent.click(screen.getByRole('button', { name: /always allow/i }));

    const toolPatternInput = screen.getByLabelText(/tool pattern/i);
    expect(toolPatternInput).toHaveValue('Bash');

    fireEvent.change(screen.getByLabelText(/scope note/i), { target: { value: 'trusted cleanup script' } });
    fireEvent.click(screen.getByRole('button', { name: /save rule/i }));

    expect(onAlwaysAllow).toHaveBeenCalledWith({
      toolPattern: 'Bash',
      inputPattern: '',
      scopeNote: 'trusted cleanup script',
    });
  });
});
