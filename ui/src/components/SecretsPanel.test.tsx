import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { SecretsPanel } from './SecretsPanel.js';

const list = vi.fn();
const set = vi.fn();
const remove = vi.fn();

vi.mock('../api/client.js', () => ({
  ApiError: class ApiError extends Error { constructor(m: string, public status = 400) { super(m); } },
  api: { secrets: { list: () => list(), set: (n: string, v: string) => set(n, v), remove: (n: string) => remove(n) } },
}));

beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue({ backend: 'keychain', names: ['mcp/github/TOKEN'] });
  set.mockResolvedValue({ ok: true, names: ['mcp/github/TOKEN', 'NEW'] });
  remove.mockResolvedValue({ ok: true, names: [] });
});

describe('SecretsPanel', () => {
  it('lists names and nothing else', async () => {
    render(<SecretsPanel />);
    expect(await screen.findByText('mcp/github/TOKEN')).toBeInTheDocument();
    expect(screen.queryByDisplayValue(/./)).not.toBeInTheDocument();
  });

  // The value field is masked: typed once, sent to the daemon, never echoed.
  it('stores a new secret from a masked field and clears it', async () => {
    render(<SecretsPanel />);
    await screen.findByText('mcp/github/TOKEN');
    fireEvent.change(screen.getByPlaceholderText('NAME'), { target: { value: 'NEW' } });
    const value = screen.getByPlaceholderText('value');
    expect(value).toHaveAttribute('type', 'password');
    fireEvent.change(value, { target: { value: 'hunter2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Store' }));
    await waitFor(() => expect(set).toHaveBeenCalledWith('NEW', 'hunter2'));
    expect(await screen.findByText('NEW')).toBeInTheDocument();
    expect(value).toHaveValue('');
  });

  it('removes one', async () => {
    render(<SecretsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('mcp/github/TOKEN'));
    expect(await screen.findByText(/No secrets stored/)).toBeInTheDocument();
  });

  it('says so when there is no backend, instead of an empty list that looks fine', async () => {
    list.mockRejectedValue(new Error('none'));
    render(<SecretsPanel />);
    expect(await screen.findByText(/No secrets backend/)).toBeInTheDocument();
  });
});
