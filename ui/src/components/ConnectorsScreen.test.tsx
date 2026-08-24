import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ConnectorsScreen, suggestName, splitCommand, verdictText } from './ConnectorsScreen.js';

const list = vi.fn();
const catalog = vi.fn();
const create = vi.fn();
const update = vi.fn();
const remove = vi.fn();
const check = vi.fn();
const login = vi.fn();
const logout = vi.fn();
const secretSet = vi.fn();
const botsList = vi.fn();
const botConnectors = vi.fn();

vi.mock('../api/client.js', () => ({
  ApiError: class ApiError extends Error { constructor(m: string, public status = 400) { super(m); } },
  api: {
    connectors: {
      list: () => list(),
      catalog: () => catalog(),
      create: (b: unknown) => create(b),
      update: (id: string, b: unknown) => update(id, b),
      remove: (id: string) => remove(id),
      check: (id: string) => check(id),
      login: (id: string, b: unknown) => login(id, b),
      logout: (id: string) => logout(id),
    },
    secrets: { set: (n: string, v: string) => secretSet(n, v) },
    bots: { list: () => botsList(), connectors: { get: (id: string) => botConnectors(id) } },
  },
}));

const row = (over: Record<string, unknown> = {}) => ({
  id: 'c1', name: 'github', description: 'issues and PRs', enabled: true, createdAt: 0, kind: 'custom',
  config: { transport: 'stdio', command: 'npx', args: [], env: {} },
  missingSecrets: [] as string[], signedIn: false, lastStatus: null, lastError: null, checkedAt: null, ...over,
});
const ready = { status: 'ready', tools: [{ name: 'create_issue', description: 'opens one' }] };
const gmailEntry = {
  name: 'gmail', displayName: 'Gmail', description: 'Read, search, draft and send mail.', provider: 'Google',
  needsClientCredentials: true, setupSteps: ['Create an OAuth client', 'Add the redirect URI http://127.0.0.1:4780/api/connectors/oauth/callback'],
};

beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue([row()]);
  catalog.mockResolvedValue([gmailEntry]);
  create.mockResolvedValue({ ...row(), check: ready });
  update.mockResolvedValue(row());
  remove.mockResolvedValue({ ok: true });
  check.mockResolvedValue(ready);
  login.mockResolvedValue({ authorizeUrl: 'https://accounts.example.com/auth?x=1' });
  logout.mockResolvedValue({ ok: true });
  secretSet.mockResolvedValue({ ok: true, names: [] });
  botsList.mockResolvedValue([{ bot: { id: 'b1', name: 'Scout', slug: 'scout' } }]);
  botConnectors.mockResolvedValue([]);
});

const addField = () => screen.findByPlaceholderText(/a built-in/);

describe('helpers', () => {
  it('suggests a name from a URL host or a package name', () => {
    expect(suggestName('https://mcp.vercel.com')).toBe('vercel');
    expect(suggestName('npx -y @modelcontextprotocol/server-github')).toBe('github');
    expect(suggestName('node ./my-mcp-server')).toBe('my');
    expect(suggestName('')).toBe('');
  });
  it('keeps a quoted path in one piece', () => {
    expect(splitCommand('node "/my dir/s.mjs"')).toEqual({ command: 'node', args: ['/my dir/s.mjs'] });
  });
  it('phrases every verdict', () => {
    expect(verdictText({ status: 'ready', tools: [{ name: 'a', description: '' }] }).text).toBe('ready — 1 tool');
    expect(verdictText({ status: 'needs-sign-in', provider: 'Google', tools: [] }).text).toMatch(/Google/);
    expect(verdictText({ status: 'unreachable', tools: [], detail: 'refused' }).tone).toBe('bad');
  });
});

describe('ConnectorsScreen', () => {
  it('lists connectors with kind, persisted state and assigned bots', async () => {
    list.mockResolvedValue([row({ lastStatus: 'ready' })]);
    botConnectors.mockResolvedValue([{ id: 'c1', name: 'github' }]);
    render(<ConnectorsScreen />);
    expect(await screen.findByText('github')).toBeInTheDocument();
    expect(await screen.findByText('issues and PRs')).toBeInTheDocument();
    expect(screen.getByTestId('connector-state')).toHaveTextContent('ready');
    expect(await screen.findByText(/→ Scout/)).toBeInTheDocument();
  });

  it('labels a built-in row as such and shows the Sign in it needs', async () => {
    list.mockResolvedValue([row({ id: 'g', name: 'gmail', kind: 'builtin', lastStatus: 'needs-sign-in', config: { transport: 'http', url: 'http://127.0.0.1:4780/mcp/gmail', headers: {} } })]);
    render(<ConnectorsScreen />);
    expect(await screen.findByText('built-in')).toBeInTheDocument();
    expect(screen.getByTestId('connector-state')).toHaveTextContent('needs sign in');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  // A connector that will not start must say so here, before someone assigns it and wonders
  // why the bot never uses it.
  it('warns when a referenced secret does not exist', async () => {
    list.mockResolvedValue([row({ missingSecrets: ['mcp/github/TOKEN'] })]);
    render(<ConnectorsScreen />);
    expect(await screen.findByText(/missing secret: mcp\/github\/TOKEN/)).toBeInTheDocument();
  });

  it('adds a command as stdio, prefilling the name, with the bots ticked', async () => {
    render(<ConnectorsScreen />);
    fireEvent.change(await addField(), { target: { value: 'npx -y @modelcontextprotocol/server-github' } });
    expect(screen.getByPlaceholderText('github')).toHaveValue('github');
    fireEvent.click(await screen.findByLabelText('Scout'));
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        name: 'github', description: '',
        config: { transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: {} },
        botIds: ['b1'],
      }),
    );
    // The verdict that came back with the row is shown, not a vanishing toast.
    expect(await screen.findByText('ready — 1 tool')).toBeInTheDocument();
  });

  it('adds a URL as http', async () => {
    render(<ConnectorsScreen />);
    fireEvent.change(await addField(), { target: { value: 'https://mcp.vercel.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(expect.objectContaining({
        name: 'vercel', config: { transport: 'http', url: 'https://mcp.vercel.com', headers: {} },
      })),
    );
  });

  it('adds a catalog name as a built-in', async () => {
    render(<ConnectorsScreen />);
    fireEvent.change(await addField(), { target: { value: 'gmail' } });
    await waitFor(() => expect(screen.getByText(/Gmail is built into ant-bot/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: 'gmail', builtin: 'gmail' })));
  });

  // The whole point of the secret toggle: the value goes to the keychain and the config carries
  // a reference. Nobody types `{{secret:…}}`.
  it('stores a secret env value in the keychain and sends a reference', async () => {
    render(<ConnectorsScreen />);
    fireEvent.change(await addField(), { target: { value: 'npx srv' } });
    fireEvent.click(screen.getByRole('button', { name: /add var/i }));
    fireEvent.change(screen.getByPlaceholderText('VAR'), { target: { value: 'TOKEN' } });
    fireEvent.click(screen.getByLabelText('TOKEN is a secret'));
    const value = screen.getByPlaceholderText(/stored in your keychain/);
    expect(value).toHaveAttribute('type', 'password');
    fireEvent.change(value, { target: { value: 'ghp_x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(secretSet).toHaveBeenCalledWith('mcp/srv/TOKEN', 'ghp_x'));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(expect.objectContaining({
        config: expect.objectContaining({ env: { TOKEN: '{{secret:mcp/srv/TOKEN}}' } }),
      })),
    );
  });

  it('shows the client-credential box when the new row needs a sign-in Google will not self-register', async () => {
    create.mockResolvedValue({ ...row({ id: 'g', name: 'gmail', kind: 'builtin' }), check: { status: 'needs-sign-in', selfRegistration: false, provider: 'Google', tools: [] } });
    list.mockResolvedValueOnce([]).mockResolvedValue([row({ id: 'g', name: 'gmail', kind: 'builtin', config: { transport: 'http', url: 'x', headers: {} } })]);
    render(<ConnectorsScreen />);
    fireEvent.change(await addField(), { target: { value: 'gmail' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByPlaceholderText('client ID')).toBeInTheDocument();
    expect(screen.getByText(/Create an OAuth client/)).toBeInTheDocument();
    expect(screen.getByText(/oauth\/callback/)).toBeInTheDocument();

    vi.stubGlobal('open', vi.fn());
    fireEvent.change(screen.getByPlaceholderText('client ID'), { target: { value: 'cid' } });
    fireEvent.change(screen.getByPlaceholderText('client secret'), { target: { value: 'shh' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Sign in' }).at(-1)!);
    await waitFor(() => expect(login).toHaveBeenCalledWith('g', { clientId: 'cid', clientSecret: 'shh' }));
  });

  it('shows the tools a check reports, fully qualified', async () => {
    render(<ConnectorsScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'Check' }));
    fireEvent.click(await screen.findByRole('button', { name: /show 1 tools/ }));
    expect(await screen.findByText('mcp__github__create_issue')).toBeInTheDocument();
  });

  it('shows why a check failed rather than going quiet', async () => {
    check.mockResolvedValue({ status: 'needs-credential', tools: [], detail: 'missing secret mcp/github/TOKEN' });
    render(<ConnectorsScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'Check' }));
    expect(await screen.findByText(/missing secret mcp\/github\/TOKEN/)).toBeInTheDocument();
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

  it('survives a catalog or roster that is unavailable', async () => {
    catalog.mockRejectedValue(new Error('down'));
    botsList.mockRejectedValue(new Error('down'));
    render(<ConnectorsScreen />);
    expect(await screen.findByText('github')).toBeInTheDocument();
  });
});

describe('ConnectorsScreen — sign-in', () => {
  const httpRow = (over: Record<string, unknown> = {}) =>
    row({ config: { transport: 'http', url: 'https://x.dev/mcp', headers: {} }, ...over });

  it('opens the provider URL in a new tab', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    list.mockResolvedValue([httpRow()]);
    render(<ConnectorsScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(login).toHaveBeenCalledWith('c1', {}));
    await waitFor(() => expect(open).toHaveBeenCalledWith('https://accounts.example.com/auth?x=1', '_blank', 'noopener'));
  });

  it('shows a signed-in connector as such, and offers sign out', async () => {
    list.mockResolvedValue([httpRow({ signedIn: true })]);
    render(<ConnectorsScreen />);
    expect(await screen.findByText('signed in')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(logout).toHaveBeenCalledWith('c1'));
  });

  it('asks for a client when the daemon says the provider will not register ant-bot itself', async () => {
    const { ApiError } = await import('../api/client.js');
    login.mockRejectedValue(new ApiError('accounts.google.com does not support automatic app registration, so it needs a client ID you create yourself.', 400));
    list.mockResolvedValue([httpRow()]);
    render(<ConnectorsScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(await screen.findByPlaceholderText('client ID')).toBeInTheDocument();
    expect(screen.getByText(/does not support automatic app registration/)).toBeInTheDocument();
  });

  // stdio servers take credentials in env; there is nothing to sign in to.
  it('offers no sign-in for a stdio connector', async () => {
    render(<ConnectorsScreen />);
    await screen.findByText('github');
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument();
  });
});
