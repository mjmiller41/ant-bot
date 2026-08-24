import { useEffect, useState } from 'react';
import clsx from 'clsx';
import type { ApiCatalogEntry, ApiConnector, ConnectorCheck } from '@antbot/contract';
import { api, ApiError } from '../api/client.js';

const input = 'w-full rounded border border-(--color-border) bg-(--color-bg) px-2 py-1 text-xs';
const label = 'mb-1 block text-xs text-(--color-text-muted)';
const btn = 'rounded border border-(--color-border) px-2 py-1 text-xs disabled:opacity-40';

/**
 * A key/value row for a stdio connector's env or an http connector's header. `secret` rows are
 * masked and stored in the keychain under `mcp/<connector>/<key>`; the row's config carries a
 * reference, never the value.
 *
 * Each row carries an id rather than being keyed by position: deleting a middle row would
 * otherwise make React reuse the wrong input and shuffle what the user typed.
 */
export interface Pair { id: number; k: string; v: string; secret: boolean }

let nextPairId = 0;
export const newPair = (): Pair => ({ id: nextPairId++, k: '', v: '', secret: false });

export const secretNameFor = (connector: string, key: string): string => `mcp/${connector}/${key}`;

/** Quote-aware split; not a shell. The daemon spawns the command directly. */
export function splitCommand(text: string): { command: string; args: string[] } {
  const parts = text.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const clean = parts.map((p) => (/^["'].*["']$/.test(p) ? p.slice(1, -1) : p));
  return { command: clean[0] ?? '', args: clean.slice(1) };
}

export const looksLikeUrl = (s: string): boolean => /^https?:\/\//i.test(s.trim());

/** A name to prefill from what was typed: the host for a URL, the package for a command. */
export function suggestName(target: string): string {
  const t = target.trim();
  if (!t) return '';
  let raw: string;
  if (looksLikeUrl(t)) {
    try {
      raw = new URL(t).hostname.replace(/^(mcp|www|api)\./, '').split('.')[0] ?? '';
    } catch {
      raw = '';
    }
  } else {
    const { command, args } = splitCommand(t);
    const pkg = args.find((a) => !a.startsWith('-')) ?? command;
    raw = pkg.split('/').pop()?.replace(/^(mcp-)?server-|-mcp(-server)?$/g, '') ?? '';
  }
  return raw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
}

export function verdictText(check: ConnectorCheck): { text: string; tone: 'ok' | 'warn' | 'bad' } {
  const n = check.tools.length;
  switch (check.status) {
    case 'ready':
      return { text: `ready — ${n} tool${n === 1 ? '' : 's'}`, tone: 'ok' };
    case 'needs-sign-in':
      if (check.alternative) return { text: check.detail ?? `use the built-in instead: ${check.alternative}`, tone: 'bad' };
      return { text: `needs sign-in${check.provider ? ` (${check.provider})` : ''}`, tone: 'warn' };
    case 'needs-credential':
      return { text: check.detail ?? 'needs a credential', tone: 'warn' };
    case 'unreachable':
      return { text: `unreachable${check.detail ? ` — ${check.detail}` : ''}`, tone: 'bad' };
  }
}

const toneClass = { ok: 'text-(--color-green)', warn: 'text-(--color-amber)', bad: 'text-(--color-red)' };

function PairEditor({ pairs, onChange, keyLabel }: { pairs: Pair[]; onChange: (next: Pair[]) => void; keyLabel: string }) {
  const set = (id: number, patch: Partial<Pair>) => onChange(pairs.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  return (
    <div className="space-y-1">
      {pairs.map((p) => (
        <div key={p.id} className="flex items-center gap-1">
          <input className={clsx(input, 'w-2/5')} placeholder={keyLabel} value={p.k} onChange={(e) => set(p.id, { k: e.target.value })} />
          {/* A secret is typed once, masked, and goes straight to the daemon's keychain. */}
          <input
            className={input}
            type={p.secret ? 'password' : 'text'}
            placeholder={p.secret ? 'value (stored in your keychain)' : 'value'}
            value={p.v}
            onChange={(e) => set(p.id, { v: e.target.value })}
          />
          <label className="flex shrink-0 items-center gap-1 text-[11px] text-(--color-text-muted)">
            <input type="checkbox" checked={p.secret} onChange={(e) => set(p.id, { secret: e.target.checked })} aria-label={`${p.k || keyLabel} is a secret`} />
            secret
          </label>
          <button type="button" onClick={() => onChange(pairs.filter((x) => x.id !== p.id))} className={clsx(btn, 'text-(--color-text-muted)')}>
            ×
          </button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...pairs, newPair()])} className={clsx(btn, 'text-(--color-text-muted)')}>
        + add {keyLabel.toLowerCase()}
      </button>
    </div>
  );
}

/** Client-credential entry for a provider that will not register apps itself (Google). */
function ClientCredentials({
  entry,
  provider,
  onSubmit,
  error,
}: {
  entry: ApiCatalogEntry | null;
  provider?: string;
  onSubmit: (creds: { clientId: string; clientSecret?: string }) => void;
  error: string | null;
}) {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  return (
    <div className="mt-2 space-y-1 rounded bg-(--color-bg-elevated) p-2">
      <p className="text-xs text-(--color-amber)">
        {provider ?? 'This provider'} needs an OAuth client you create yourself — a one-time setup that every{' '}
        {provider ?? 'provider'} connector then shares.
      </p>
      {entry && entry.setupSteps.length > 0 && (
        <ol className="list-decimal space-y-0.5 pl-5 text-[11px] text-(--color-text-muted)">
          {entry.setupSteps.map((s) => <li key={s}>{s}</li>)}
        </ol>
      )}
      <div className="flex gap-1">
        <input className={input} placeholder="client ID" value={clientId} onChange={(e) => setClientId(e.target.value)} />
        {/* Masked so a shoulder-surfer does not read it; never echoed back from the daemon. */}
        <input type="password" className={input} placeholder="client secret" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} />
        <button
          type="button"
          disabled={!clientId.trim()}
          onClick={() => onSubmit({ clientId: clientId.trim(), ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}) })}
          className={btn}
        >
          Sign in
        </button>
      </div>
      {error && <p className="text-xs text-(--color-red)">{error}</p>}
    </div>
  );
}

function AddConnectorForm({
  catalog,
  bots,
  onCreated,
}: {
  catalog: ApiCatalogEntry[];
  bots: { id: string; name: string }[];
  onCreated: (row: ApiConnector, check: ConnectorCheck) => void;
}) {
  const [target, setTarget] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [pairs, setPairs] = useState<Pair[]>([]);
  const [botIds, setBotIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const builtin = catalog.find((e) => e.name === target.trim() || e.name === name.trim() && !target.trim()) ?? null;
  const isUrl = looksLikeUrl(target);
  const effectiveName = name.trim() || (builtin ? builtin.name : suggestName(target));

  const changeTarget = (v: string) => {
    setTarget(v);
    if (!nameTouched) setName(suggestName(v));
  };

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      const n = effectiveName;
      let body: Parameters<typeof api.connectors.create>[0];
      if (builtin && !isUrl && (target.trim() === builtin.name || !target.trim())) {
        body = { name: n, description: builtin.description, builtin: builtin.name };
      } else if (isUrl) {
        body = { name: n, description: '', config: { transport: 'http', url: target.trim(), headers: await storePairs(n) } };
      } else {
        const { command, args } = splitCommand(target);
        if (!command) throw new ApiError('Type a command, a URL, or a built-in name.', 400);
        body = { name: n, description: '', config: { transport: 'stdio', command, args, env: await storePairs(n) } };
      }
      if (botIds.size) body.botIds = Array.from(botIds);
      const created = await api.connectors.create(body);
      setTarget('');
      setName('');
      setNameTouched(false);
      setPairs([]);
      setBotIds(new Set());
      onCreated(created, created.check);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to add connector');
    } finally {
      setBusy(false);
    }
  }

  /** Store secret rows in the keychain first, so the config only ever carries references. */
  async function storePairs(connector: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const p of pairs) {
      const k = p.k.trim();
      if (!k) continue;
      if (p.secret) {
        const sname = secretNameFor(connector, k);
        await api.secrets.set(sname, p.v);
        out[k] = `{{secret:${sname}}}`;
      } else out[k] = p.v;
    }
    return out;
  }

  const kindHint = builtin && (target.trim() === builtin.name || !target.trim()) && (name.trim() === builtin.name || target.trim() === builtin.name)
    ? `${builtin.displayName} is built into ant-bot. ${builtin.description}`
    : isUrl ? 'A remote server. If it needs a sign-in, that starts right after adding.'
    : target.trim() ? 'A local command ant-bot runs itself.'
    : null;

  return (
    <div className="mb-6 space-y-2 rounded border border-(--color-border) p-3">
      <div>
        <span className={label}>Add</span>
        <input
          className={input}
          list="antbot-catalog"
          placeholder={`a built-in (${catalog.map((e) => e.name).join(', ') || 'gmail'}), a command, or a URL`}
          value={target}
          onChange={(e) => changeTarget(e.target.value)}
        />
        <datalist id="antbot-catalog">
          {catalog.map((e) => <option key={e.name} value={e.name}>{e.displayName}</option>)}
        </datalist>
        {kindHint && <p className="mt-1 text-[11px] text-(--color-text-muted)">{kindHint}</p>}
      </div>

      <div className="flex gap-2">
        <div className="w-1/3">
          <span className={label}>Name</span>
          <input
            className={input}
            placeholder="github"
            value={name}
            onChange={(e) => { setName(e.target.value); setNameTouched(true); }}
          />
        </div>
      </div>

      {target.trim() && !builtin && (
        <div>
          <span className={label}>{isUrl ? 'Headers' : 'Environment'}</span>
          <PairEditor pairs={pairs} onChange={setPairs} keyLabel={isUrl ? 'Header' : 'VAR'} />
        </div>
      )}

      {bots.length > 0 && (
        <div>
          <span className={label}>Give it to</span>
          <div className="flex flex-wrap gap-3">
            {bots.map((b) => (
              <label key={b.id} className="flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  checked={botIds.has(b.id)}
                  onChange={(e) => {
                    const next = new Set(botIds);
                    if (e.target.checked) next.add(b.id); else next.delete(b.id);
                    setBotIds(next);
                  }}
                />
                {b.name}
              </label>
            ))}
          </div>
        </div>
      )}

      {error && <p className="text-xs text-(--color-red)">{error}</p>}
      <button
        type="button"
        onClick={submit}
        disabled={busy || !effectiveName || (!target.trim() && !builtin)}
        className="rounded bg-(--color-accent) px-3 py-1.5 text-xs font-medium text-(--color-accent-fg) disabled:opacity-40"
      >
        {busy ? 'Adding…' : 'Add'}
      </button>
    </div>
  );
}

function ConnectorRow({
  connector,
  catalog,
  assignedTo,
  initialCheck,
  onChanged,
}: {
  connector: ApiConnector;
  catalog: ApiCatalogEntry[];
  assignedTo: string[];
  initialCheck: ConnectorCheck | null;
  onChanged: () => void;
}) {
  const [check, setCheck] = useState<ConnectorCheck | null>(initialCheck);
  const [checking, setChecking] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [needsClient, setNeedsClient] = useState(false);
  const [showTools, setShowTools] = useState(false);
  const entry = connector.kind === 'builtin' ? (catalog.find((e) => e.name === connector.name) ?? null) : null;

  // The verdict that came back with a just-added row lands after the row is already on screen,
  // and it already says whether sign-in needs a client.
  useEffect(() => {
    if (!initialCheck) return;
    setCheck(initialCheck);
    if (initialCheck.status === 'needs-sign-in' && initialCheck.selfRegistration === false && !initialCheck.alternative) setNeedsClient(true);
  }, [initialCheck]);

  async function signIn(creds: { clientId?: string; clientSecret?: string } = {}) {
    setAuthError(null);
    try {
      const { authorizeUrl } = await api.connectors.login(connector.id, creds);
      // A new tab, not a redirect: ant-bot stays open, and the daemon's callback page says to
      // come back here.
      window.open(authorizeUrl, '_blank', 'noopener');
      setNeedsClient(false);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Could not start sign-in';
      setAuthError(message);
      if (/client ID|client secret/i.test(message)) setNeedsClient(true);
    }
  }

  async function runCheck() {
    setChecking(true);
    try {
      const c = await api.connectors.check(connector.id);
      setCheck(c);
      if (c.status === 'needs-sign-in' && c.selfRegistration === false && !c.alternative) setNeedsClient(true);
      onChanged();
    } catch (err) {
      setCheck({ status: 'unreachable', tools: [], detail: err instanceof ApiError ? err.message : 'Check failed' });
    } finally {
      setChecking(false);
    }
  }

  // State comes from the row (persisted) unless a fresher verdict is in hand.
  const state = check
    ? verdictText(check)
    : !connector.enabled ? { text: 'disabled', tone: 'warn' as const }
    : connector.missingSecrets.length ? { text: `missing secret: ${connector.missingSecrets.join(', ')}`, tone: 'warn' as const }
    : connector.signedIn ? { text: 'signed in', tone: 'ok' as const }
    : connector.lastStatus === 'ready' || connector.lastStatus === 'connected' ? { text: 'ready', tone: 'ok' as const }
    : connector.lastStatus ? { text: connector.lastStatus.replace(/-/g, ' '), tone: 'warn' as const }
    : { text: 'unchecked', tone: 'warn' as const };

  const canSignIn = connector.kind === 'builtin' || connector.config.transport !== 'stdio';

  return (
    <div className="border-b border-(--color-border) py-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <span className="text-sm font-medium">{connector.name}</span>
          <span className="ml-2 rounded bg-(--color-bg-elevated) px-1.5 py-0.5 text-[11px] text-(--color-text-muted)">
            {connector.kind === 'builtin' ? 'built-in' : connector.config.transport}
          </span>
          <span className={clsx('ml-2 text-xs', toneClass[state.tone])} data-testid="connector-state">{state.text}</span>
          {connector.description && (
            <p className="truncate text-xs text-(--color-text-muted)" title={connector.description}>{connector.description}</p>
          )}
          <p className="text-[11px] text-(--color-text-muted)">
            {assignedTo.length ? `→ ${assignedTo.join(', ')}` : '→ no bots yet — tick it in Bot settings'}
          </p>
          {connector.lastError && !check && state.tone !== 'ok' && (
            <p className="text-[11px] text-(--color-text-muted)">{connector.lastError}</p>
          )}
        </div>
        {canSignIn && (
          <button
            type="button"
            onClick={connector.signedIn ? async () => { await api.connectors.logout(connector.id); onChanged(); } : () => signIn()}
            className={btn}
          >
            {connector.signedIn ? 'Sign out' : 'Sign in'}
          </button>
        )}
        <button type="button" onClick={runCheck} disabled={checking} className={btn}>
          {checking ? 'Checking…' : 'Check'}
        </button>
        <button type="button" onClick={async () => { await api.connectors.update(connector.id, { enabled: !connector.enabled }); onChanged(); }} className={btn}>
          {connector.enabled ? 'Disable' : 'Enable'}
        </button>
        <button type="button" onClick={async () => { await api.connectors.remove(connector.id); onChanged(); }} className={clsx(btn, 'text-(--color-red)')}>
          Delete
        </button>
      </div>

      {authError && !needsClient && <p className="mt-2 text-xs text-(--color-red)">{authError}</p>}
      {needsClient && (
        <ClientCredentials entry={entry} provider={check?.provider} onSubmit={signIn} error={authError} />
      )}

      {check && check.tools.length > 0 && (
        <div className="mt-1 text-xs">
          <button type="button" onClick={() => setShowTools((s) => !s)} className="text-(--color-text-muted) underline">
            {showTools ? 'hide tools' : `show ${check.tools.length} tools`}
          </button>
          {showTools && (
            <ul className="mt-1 space-y-0.5">
              {check.tools.map((t) => (
                <li key={t.name} className="truncate" title={t.description}>
                  <code>{`mcp__${connector.name}__${t.name}`}</code>
                  {t.description && <span className="ml-2 text-(--color-text-muted)">{t.description}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export function ConnectorsScreen() {
  const [connectors, setConnectors] = useState<ApiConnector[]>([]);
  const [catalog, setCatalog] = useState<ApiCatalogEntry[]>([]);
  const [bots, setBots] = useState<{ id: string; name: string }[]>([]);
  const [assigned, setAssigned] = useState<Record<string, string[]>>({});
  const [fresh, setFresh] = useState<Record<string, ConnectorCheck>>({});

  const reload = () => {
    void api.connectors.list().then(setConnectors);
    void api.bots
      .list()
      .then(async (rows) => {
        const list = rows.map((r) => ({ id: r.bot.id, name: r.bot.name }));
        setBots(list);
        const map: Record<string, string[]> = {};
        for (const b of list) {
          const cs = await api.bots.connectors.get(b.id).catch(() => []);
          for (const c of cs) map[c.name] = [...(map[c.name] ?? []), b.name];
        }
        setAssigned(map);
      })
      .catch(() => setBots([]));
  };

  useEffect(() => {
    reload();
    void api.connectors.catalog().then(setCatalog).catch(() => setCatalog([]));
  }, []);

  return (
    <div className="mx-auto max-w-4xl p-6">
      <h2 className="mb-1 text-lg font-semibold">Connectors</h2>
      <p className="mb-4 text-xs text-(--color-text-muted)">
        MCP servers your Bots can use: a built-in like Gmail, a command ant-bot runs, or a URL. Add one here,
        tick which Bots get it — a Bot without an assignment cannot see its tools at all. Tools reach Bots as{' '}
        <code>mcp__&lt;name&gt;__&lt;tool&gt;</code> and still pass the permission gateway.
      </p>

      <AddConnectorForm
        catalog={catalog}
        bots={bots}
        onCreated={(row, check) => {
          setFresh((f) => ({ ...f, [row.id]: check }));
          reload();
        }}
      />

      {connectors.length === 0 ? (
        <p className="text-sm text-(--color-text-muted)">No connectors yet.</p>
      ) : (
        connectors.map((c) => (
          <ConnectorRow
            key={c.id}
            connector={c}
            catalog={catalog}
            assignedTo={assigned[c.name] ?? []}
            initialCheck={fresh[c.id] ?? null}
            onChanged={reload}
          />
        ))
      )}
    </div>
  );
}
