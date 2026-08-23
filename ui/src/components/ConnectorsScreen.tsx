import { useEffect, useState } from 'react';
import clsx from 'clsx';
import type { ApiConnector, ConnectorConfig, ConnectorProbeResult } from '@antbot/contract';
import { api, ApiError } from '../api/client.js';

const input = 'w-full rounded border border-(--color-border) bg-(--color-bg) px-2 py-1 text-xs';
const label = 'mb-1 block text-xs text-(--color-text-muted)';

/**
 * Repeatable key/value rows, for a stdio connector's env or an http connector's headers.
 *
 * Each row carries an id rather than being keyed by position: deleting a middle row would
 * otherwise make React reuse the wrong input and shuffle what the user typed.
 */
export interface Pair { id: number; k: string; v: string }

let nextPairId = 0;
export const newPair = (): Pair => ({ id: nextPairId++, k: '', v: '' });

function PairEditor({
  pairs,
  onChange,
  keyLabel,
  secretNames,
}: {
  pairs: Pair[];
  onChange: (next: Pair[]) => void;
  keyLabel: string;
  secretNames: string[];
}) {
  const set = (id: number, patch: Partial<Pair>) =>
    onChange(pairs.map((p) => (p.id === id ? { ...p, ...patch } : p)));

  return (
    <div className="space-y-1">
      {pairs.map((p) => (
        <div key={p.id} className="flex gap-1">
          <input
            className={clsx(input, 'w-2/5')}
            placeholder={keyLabel}
            value={p.k}
            onChange={(e) => set(p.id, { k: e.target.value })}
          />
          <input
            className={input}
            placeholder="value, or {{secret:NAME}}"
            list="antbot-secret-names"
            value={p.v}
            onChange={(e) => set(p.id, { v: e.target.value })}
          />
          <button
            type="button"
            onClick={() => onChange(pairs.filter((x) => x.id !== p.id))}
            className="rounded border border-(--color-border) px-2 text-xs text-(--color-text-muted)"
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...pairs, newPair()])}
        className="rounded border border-(--color-border) px-2 py-1 text-xs text-(--color-text-muted)"
      >
        + add {keyLabel.toLowerCase()}
      </button>
      {/* Names only — the UI never sees a secret's value, and neither does a bot. */}
      <datalist id="antbot-secret-names">
        {secretNames.map((n) => (
          <option key={n} value={`{{secret:${n}}}`} />
        ))}
      </datalist>
    </div>
  );
}

function AddConnectorForm({ onCreated, secretNames }: { onCreated: () => void; secretNames: string[] }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [transport, setTransport] = useState<ConnectorConfig['transport']>('stdio');
  const [command, setCommand] = useState('');
  const [url, setUrl] = useState('');
  const [tools, setTools] = useState('');
  const [pairs, setPairs] = useState<Pair[]>([]);
  const [error, setError] = useState<string | null>(null);

  const asRecord = (): Record<string, string> =>
    Object.fromEntries(pairs.filter((p) => p.k.trim()).map((p) => [p.k.trim(), p.v]));

  async function submit() {
    setError(null);
    // The daemon spawns the command directly rather than through a shell, so this split is the
    // whole of the parsing — quotes for a path with a space, nothing else.
    const parts = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    const clean = parts.map((p) => (/^["'].*["']$/.test(p) ? p.slice(1, -1) : p));
    const config: ConnectorConfig =
      transport === 'stdio'
        ? { transport: 'stdio', command: clean[0] ?? '', args: clean.slice(1), env: asRecord() }
        : {
            transport,
            url: url.trim(),
            headers: asRecord(),
            ...(tools.trim() ? { tools: tools.split(',').map((t) => t.trim()).filter(Boolean) } : {}),
          };

    try {
      await api.connectors.create({ name: name.trim(), description: description.trim(), config });
      setName('');
      setDescription('');
      setCommand('');
      setUrl('');
      setTools('');
      setPairs([]);
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to add connector');
    }
  }

  return (
    <div className="mb-6 space-y-2 rounded border border-(--color-border) p-3">
      <div className="flex gap-2">
        <div className="w-1/3">
          <span className={label}>Name</span>
          <input className={input} placeholder="github" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="flex-1">
          <span className={label}>Description</span>
          <input className={input} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div>
          <span className={label}>Transport</span>
          <select
            className={input}
            value={transport}
            onChange={(e) => setTransport(e.target.value as ConnectorConfig['transport'])}
          >
            <option value="stdio">stdio</option>
            <option value="http">http</option>
            <option value="sse">sse</option>
          </select>
        </div>
      </div>

      {transport === 'stdio' ? (
        <div>
          <span className={label}>Command</span>
          <input
            className={input}
            placeholder="npx -y @modelcontextprotocol/server-filesystem /tmp"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
          />
        </div>
      ) : (
        <div className="flex gap-2">
          <div className="flex-1">
            <span className={label}>URL</span>
            <input className={input} placeholder="https://example.com/mcp" value={url} onChange={(e) => setUrl(e.target.value)} />
          </div>
          <div className="w-1/3">
            <span className={label}>Tools (optional allowlist)</span>
            <input className={input} placeholder="a, b" value={tools} onChange={(e) => setTools(e.target.value)} />
          </div>
        </div>
      )}

      <div>
        <span className={label}>{transport === 'stdio' ? 'Environment' : 'Headers'}</span>
        <PairEditor
          pairs={pairs}
          onChange={setPairs}
          keyLabel={transport === 'stdio' ? 'VAR' : 'Header'}
          secretNames={secretNames}
        />
        <p className="mt-1 text-[11px] text-(--color-text-muted)">
          Reference a stored secret as <code>{'{{secret:NAME}}'}</code>. The daemon substitutes it when the
          connector starts — the value is never stored here, and a bot never sees it.
        </p>
      </div>

      {error && <p className="text-xs text-(--color-red)">{error}</p>}
      <button
        type="button"
        onClick={submit}
        disabled={!name.trim()}
        className="rounded bg-(--color-accent) px-3 py-1.5 text-xs font-medium text-(--color-accent-fg) disabled:opacity-40"
      >
        Add connector
      </button>
    </div>
  );
}

function ConnectorRow({ connector, onChanged }: { connector: ApiConnector; onChanged: () => void }) {
  const [probe, setProbe] = useState<ConnectorProbeResult | null>(null);
  const [testing, setTesting] = useState(false);

  async function test() {
    setTesting(true);
    try {
      setProbe(await api.connectors.test(connector.id));
    } catch (err) {
      setProbe({ ok: false, tools: [], error: err instanceof ApiError ? err.message : 'Test failed' });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="border-b border-(--color-border) py-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <span className="text-sm font-medium">{connector.name}</span>
          <span className="ml-2 rounded bg-(--color-bg-elevated) px-1.5 py-0.5 text-[11px] text-(--color-text-muted)">
            {connector.config.transport}
          </span>
          {!connector.enabled && <span className="ml-2 text-xs text-(--color-text-muted)">disabled</span>}
          {connector.description && (
            <p className="truncate text-xs text-(--color-text-muted)" title={connector.description}>
              {connector.description}
            </p>
          )}
          {connector.missingSecrets.length > 0 && (
            <p className="text-xs text-(--color-amber)">
              missing secret: {connector.missingSecrets.join(', ')} — this connector will not start
            </p>
          )}
        </div>
        <button type="button" onClick={test} disabled={testing} className="rounded border border-(--color-border) px-2 py-1 text-xs disabled:opacity-40">
          {testing ? 'Testing…' : 'Test'}
        </button>
        <button
          type="button"
          onClick={async () => {
            await api.connectors.update(connector.id, { enabled: !connector.enabled });
            onChanged();
          }}
          className="rounded border border-(--color-border) px-2 py-1 text-xs"
        >
          {connector.enabled ? 'Disable' : 'Enable'}
        </button>
        <button
          type="button"
          onClick={async () => {
            await api.connectors.remove(connector.id);
            onChanged();
          }}
          className="rounded border border-(--color-border) px-2 py-1 text-xs text-(--color-red)"
        >
          Delete
        </button>
      </div>

      {probe && (
        <div className="mt-2 rounded bg-(--color-bg-elevated) p-2 text-xs">
          {probe.ok ? (
            <>
              <p className="text-(--color-green)">Connected — {probe.tools.length} tool(s)</p>
              <ul className="mt-1 space-y-0.5">
                {probe.tools.map((t) => (
                  <li key={t.name} className="truncate" title={t.description}>
                    <code>{`mcp__${connector.name}__${t.name}`}</code>
                    {t.description && <span className="ml-2 text-(--color-text-muted)">{t.description}</span>}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-(--color-red)">{probe.error ?? 'Could not connect'}</p>
          )}
        </div>
      )}
    </div>
  );
}

export function ConnectorsScreen() {
  const [connectors, setConnectors] = useState<ApiConnector[]>([]);
  const [secretNames, setSecretNames] = useState<string[]>([]);

  const reload = () => {
    void api.connectors.list().then(setConnectors);
  };

  useEffect(() => {
    reload();
    // Names only. Offering them as completions is the whole point — a typo in a secret
    // reference otherwise shows up as a connector that silently never starts.
    void api.secrets
      .list()
      .then((r) => setSecretNames(r.names))
      .catch(() => setSecretNames([]));
  }, []);

  return (
    <div className="mx-auto max-w-4xl p-6">
      <h2 className="mb-1 text-lg font-semibold">Connectors</h2>
      <p className="mb-4 text-xs text-(--color-text-muted)">
        MCP servers your Bots can use. A connector is registered here once, then assigned to individual Bots in
        Bot settings — a Bot without an assignment cannot see its tools at all. Its tools reach Bots as{' '}
        <code>mcp__&lt;name&gt;__&lt;tool&gt;</code> and still pass the permission gateway, so the first call asks
        you to approve it.
      </p>

      <AddConnectorForm onCreated={reload} secretNames={secretNames} />

      {connectors.length === 0 ? (
        <p className="text-sm text-(--color-text-muted)">No connectors yet.</p>
      ) : (
        connectors.map((c) => <ConnectorRow key={c.id} connector={c} onChanged={reload} />)
      )}
    </div>
  );
}
