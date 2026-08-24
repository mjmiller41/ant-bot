import { useEffect, useState } from 'react';
import { api, ApiError } from '../api/client.js';

const input = 'rounded border border-(--color-border) bg-(--color-bg) px-2 py-1 text-sm';

/**
 * The keychain, by name. A value is typed once, masked, and never comes back: the API returns
 * names only, so there is nothing this panel could show even if it wanted to. Most people never
 * touch this — adding a connector stores what it needs — but a credential a bot's own tooling
 * will read still has to live somewhere a human can see it exists and take it away.
 */
export function SecretsPanel() {
  const [names, setNames] = useState<string[]>([]);
  const [backend, setBackend] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    api.secrets
      .list()
      .then((r) => { setNames(r.names); setBackend(r.backend); })
      .catch(() => setUnavailable(true));
  }, []);

  async function add() {
    setError(null);
    try {
      const r = await api.secrets.set(name.trim(), value);
      setNames(r.names);
      setName('');
      setValue('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not store the secret');
    }
  }

  async function remove(n: string) {
    setError(null);
    try {
      const r = await api.secrets.remove(n);
      setNames(r.names);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove the secret');
    }
  }

  if (unavailable) {
    return <p className="text-xs text-(--color-text-muted)">No secrets backend is available on this machine.</p>;
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-(--color-text-muted)">
        Stored in your {backend === 'file' ? 'ant-bot data directory' : backend ?? 'keychain'}. Names only are ever shown;
        a value cannot be read back, by you or by a bot.
      </p>
      {names.length === 0 ? (
        <p className="text-xs text-(--color-text-muted)">No secrets stored.</p>
      ) : (
        <ul className="space-y-1">
          {names.map((n) => (
            <li key={n} className="flex items-center gap-2 text-sm">
              <code className="flex-1 truncate">{n}</code>
              <button type="button" onClick={() => remove(n)} className="rounded border border-(--color-border) px-2 py-0.5 text-xs text-(--color-red)">
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-1">
        <input className={`${input} w-2/5`} placeholder="NAME" value={name} onChange={(e) => setName(e.target.value)} />
        <input type="password" className={`${input} flex-1`} placeholder="value" value={value} onChange={(e) => setValue(e.target.value)} />
        <button type="button" onClick={add} disabled={!name.trim() || !value} className="rounded border border-(--color-border) px-2 py-1 text-xs disabled:opacity-40">
          Store
        </button>
      </div>
      {error && <p className="text-xs text-(--color-red)">{error}</p>}
    </div>
  );
}
