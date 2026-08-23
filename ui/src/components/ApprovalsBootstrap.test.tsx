import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import type { Approval } from '@antbot/contract';
import { useStore } from '../store/useStore.js';

const listApprovals = vi.fn();

vi.mock('../api/client.js', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    bots: { list: () => Promise.resolve([]) },
    threads: { list: () => Promise.resolve([]), get: () => Promise.resolve({ messages: [] }), markRead: () => Promise.resolve({}) },
    skills: { list: () => Promise.resolve([]) },
    approvals: { list: () => listApprovals() },
  },
}));

vi.mock('../api/ws.js', () => ({ createEventSocket: () => ({ close: vi.fn() }) }));

function makeApproval(id: string): Approval {
  return {
    id, botId: 'b1', threadId: 't1', toolName: 'Bash', inputSummary: 'Run: x',
    rawInput: { command: 'x' }, status: 'pending', decidedBy: null, reason: '',
    ruleId: null, createdAt: 0, decidedAt: null,
  };
}

describe('pending approvals survive a page reload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStore.setState({ pendingApprovals: [], lastSeq: -1 });
    // jsdom ships no matchMedia; App's theme effect needs one.
    vi.stubGlobal('matchMedia', () => ({
      matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }));
  });

  it('loads approvals that were already pending before the page opened', async () => {
    // A fresh load has lastSeq === -1, so the socket sends no resume frame and the
    // server's replay never happens. Without an explicit fetch the approval is
    // invisible and its inline card renders "Approval resolved." while the turn is
    // still blocked server-side.
    listApprovals.mockResolvedValue([makeApproval('a1'), makeApproval('a2')]);
    const { default: App } = await import('../App.js');
    render(<App />);
    await waitFor(() => {
      expect(useStore.getState().pendingApprovals.map((a) => a.id)).toEqual(['a1', 'a2']);
    });
  });

  it('tolerates the approvals endpoint failing without breaking the app', async () => {
    listApprovals.mockRejectedValue(new Error('offline'));
    const { default: App } = await import('../App.js');
    expect(() => render(<App />)).not.toThrow();
    await waitFor(() => expect(listApprovals).toHaveBeenCalled());
  });
});
