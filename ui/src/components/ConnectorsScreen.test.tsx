import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ConnectorsScreen } from './ConnectorsScreen.js';

const list = vi.fn();
const create = vi.fn();
const update = vi.fn();
const remove = vi.fn();
const test_ = vi.fn();
const login = vi.fn();
const logout = vi.fn();
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
      login: (id: string, b: unknown) => login(id, b),
      logout: (id: string) => logout(id),
    },
    secrets: { list: () => secretsList() },
  },
}));

const row = (over: Record<string, unknown> = {}) => ({
  id: 'c1', name: 'github', description: 'issues and PRs', enabled: true, createdAt: 0,
  config: { transport: 'stdio', command: 'npx', args: [], env: {} },
  missingSecrets: [] as string[], signedIn: false, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue([row()]);
  create.mockResolvedValue(row());
  update.mockResolvedValue(row());
  remove.mockResolvedValue({ ok: true });
  secretsList.mockResolvedValue({ backend: 'file', names: ['GH_TOKEN'] });
  login.mockResolvedValue({ authorizeUrl: 'https://accounts.example.com/auth?x=1' });
  logout.mockResolvedValue({ ok: true });
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

describe('ConnectorsScreen — interactive sign-in', () => {
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

  // Providers without dynamic registration need a client ID from the human. Surfacing a field
  // beats making them read the error and work out what to paste where.
  it('asks for a client ID when the provider will not register ant-bot itself', async () => {
    const { ApiError } = await import('../api/client.js');
    login.mockRejectedValue(new ApiError('accounts.google.com does not support automatic app registration, so it needs a client ID you create yourself.', 400));
    list.mockResolvedValue([httpRow()]);
    render(<ConnectorsScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(await screen.findByPlaceholderText(/client ID/)).toBeInTheDocument();

    login.mockResolvedValue({ authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' });
    vi.stubGlobal('open', vi.fn());
    fireEvent.change(screen.getByPlaceholderText(/client ID/), { target: { value: 'abc.apps.googleusercontent.com' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Sign in' })[1]!);
    await waitFor(() => expect(login).toHaveBeenLastCalledWith('c1', { clientId: 'abc.apps.googleusercontent.com' }));
  });

  // Google's "Web application" clients authenticate at the token endpoint, so the id alone gets
  // as far as the callback and then fails with "client_secret is missing".
  it('offers a secret field too, and sends it', async () => {
    const { ApiError } = await import('../api/client.js');
    login.mockRejectedValue(new ApiError('This provider requires a client secret as well as a client ID.', 400));
    list.mockResolvedValue([httpRow()]);
    render(<ConnectorsScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));

    const secret = await screen.findByPlaceholderText(/client secret/);
    // Not readable over a shoulder, and never echoed back from the daemon.
    expect(secret).toHaveAttribute('type', 'password');

    login.mockResolvedValue({ authorizeUrl: 'https://accounts.google.com/auth' });
    vi.stubGlobal('open', vi.fn());
    fireEvent.change(screen.getByPlaceholderText(/client ID/), { target: { value: 'cid' } });
    fireEvent.change(secret, { target: { value: 'shh' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Sign in' })[1]!);
    await waitFor(() => expect(login).toHaveBeenLastCalledWith('c1', { clientId: 'cid', clientSecret: 'shh' }));
  });

  it('names the redirect URI to authorise', async () => {
    const { ApiError } = await import('../api/client.js');
    login.mockRejectedValue(new ApiError('needs a client ID you create yourself', 400));
    list.mockResolvedValue([httpRow()]);
    render(<ConnectorsScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText(/api\/connectors\/oauth\/callback/)).toBeInTheDocument();
  });

  // stdio servers take credentials in env; there is nothing to sign in to.
  it('offers no sign-in for a stdio connector', async () => {
    list.mockResolvedValue([row()]);
    render(<ConnectorsScreen />);
    await screen.findByText('github');
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument();
  });
});
