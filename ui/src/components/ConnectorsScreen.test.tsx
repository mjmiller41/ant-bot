import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ConnectorsScreen } from './ConnectorsScreen.js';

const list = vi.fn();
const create = vi.fn();
const update = vi.fn();
const remove = vi.fn();
const test_ = vi.fn();
const secretsList = vi.fn();

vi.mock('../api/client.js', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    connectors: {
      list: () => list(),
      create: (b: unknown) => create(b),
      update: (id: string, b: unknown) => update(id, b),
      remove: (id: string) => remove(id),
      test: (id: string) => test_(id),
    },
    secrets: { list: () => secretsList() },
  },
}));

const row = (over: Record<string, unknown> = {}) => ({
  id: 'c1', name: 'github', description: 'issues and PRs', enabled: true, createdAt: 0,
  config: { transport: 'stdio', command: 'npx', args: [], env: {} },
  missingSecrets: [] as string[], ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue([row()]);
  create.mockResolvedValue(row());
  update.mockResolvedValue(row());
  remove.mockResolvedValue({ ok: true });
  secretsList.mockResolvedValue({ backend: 'file', names: ['GH_TOKEN'] });
});

describe('ConnectorsScreen', () => {
  it('lists connectors with their transport', async () => {
    render(<ConnectorsScreen />);
    expect(await screen.findByText('github')).toBeInTheDocument();
    expect(await screen.findByText('issues and PRs')).toBeInTheDocument();
    // The transport badge on the row, not the <option> of the same name in the add form.
    const badge = (await screen.findByText('github')).parentElement!.querySelector('span.rounded');
    expect(badge).toHaveTextContent('stdio');
  });

  // A connector that will not start must say so here, before someone assigns it and wonders
  // why the bot never uses it.
  it('warns when a referenced secret does not exist', async () => {
    list.mockResolvedValue([row({ missingSecrets: ['GH_TOKEN'] })]);
    render(<ConnectorsScreen />);
    expect(await screen.findByText(/missing secret: GH_TOKEN/)).toBeInTheDocument();
  });

  it('creates a stdio connector, splitting the command into command and args', async () => {
    render(<ConnectorsScreen />);
    fireEvent.change(await screen.findByPlaceholderText('github'), { target: { value: 'fs' } });
    fireEvent.change(screen.getByPlaceholderText(/server-filesystem/), { target: { value: 'npx -y srv /tmp' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add connector' }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        name: 'fs', description: '',
        config: { transport: 'stdio', command: 'npx', args: ['-y', 'srv', '/tmp'], env: {} },
      }),
    );
  });

  // The daemon spawns the command directly, so a quoted path is the one thing the split must
  // preserve — there is no shell to do it later.
  it('keeps a quoted path with a space in one piece', async () => {
    render(<ConnectorsScreen />);
    fireEvent.change(await screen.findByPlaceholderText('github'), { target: { value: 'fs' } });
    fireEvent.change(screen.getByPlaceholderText(/server-filesystem/), { target: { value: 'node "/my dir/s.mjs"' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add connector' }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(expect.objectContaining({
        config: expect.objectContaining({ command: 'node', args: ['/my dir/s.mjs'] }),
      })),
    );
  });

  it('sends env pairs, keeping a secret reference verbatim for the daemon', async () => {
    render(<ConnectorsScreen />);
    fireEvent.change(await screen.findByPlaceholderText('github'), { target: { value: 'gh' } });
    fireEvent.change(screen.getByPlaceholderText(/server-filesystem/), { target: { value: 'srv' } });
    fireEvent.click(screen.getByRole('button', { name: /add var/i }));
    fireEvent.change(screen.getByPlaceholderText('VAR'), { target: { value: 'TOKEN' } });
    fireEvent.change(screen.getByPlaceholderText(/secret:NAME/), { target: { value: '{{secret:GH_TOKEN}}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add connector' }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(expect.objectContaining({
        config: expect.objectContaining({ env: { TOKEN: '{{secret:GH_TOKEN}}' } }),
      })),
    );
  });

  it('switches the form to url and headers for http', async () => {
    render(<ConnectorsScreen />);
    fireEvent.change(await screen.findByDisplayValue('stdio'), { target: { value: 'http' } });
    expect(screen.getByPlaceholderText('https://example.com/mcp')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/server-filesystem/)).not.toBeInTheDocument();
  });

  it('shows the tools a successful test reports, fully qualified', async () => {
    test_.mockResolvedValue({ ok: true, tools: [{ name: 'create_issue', description: 'opens one' }] });
    render(<ConnectorsScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'Test' }));
    expect(await screen.findByText('mcp__github__create_issue')).toBeInTheDocument();
  });

  it('shows why a test failed rather than going quiet', async () => {
    test_.mockResolvedValue({ ok: false, tools: [], error: 'missing secret(s): GH_TOKEN' });
    render(<ConnectorsScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'Test' }));
    expect(await screen.findByText(/missing secret\(s\): GH_TOKEN/)).toBeInTheDocument();
  });

  it('toggles enabled and reloads', async () => {
    render(<ConnectorsScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith('c1', { enabled: false }));
  });

  it('deletes a connector', async () => {
    render(<ConnectorsScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('c1'));
  });

  it('offers stored secret names as completions, and only names', async () => {
    render(<ConnectorsScreen />);
    fireEvent.click(await screen.findByRole('button', { name: /add var/i }));
    await waitFor(() => expect(secretsList).toHaveBeenCalled());
    const opts = document.querySelectorAll('#antbot-secret-names option');
    expect([...opts].map((o) => o.getAttribute('value'))).toEqual(['{{secret:GH_TOKEN}}']);
  });

  it('survives a secrets backend that is unavailable', async () => {
    secretsList.mockRejectedValue(new Error('no backend'));
    render(<ConnectorsScreen />);
    expect(await screen.findByText('github')).toBeInTheDocument();
  });
});
