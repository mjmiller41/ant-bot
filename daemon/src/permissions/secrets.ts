import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../util/log.js';

const exec = promisify(execFile);
const log = logger('secrets');

export interface SecretBackend {
  readonly name: string;
  set(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
  list(): Promise<string[]>;
}

const SERVICE = 'ant-bot';

/** libsecret on Linux via `secret-tool`. */
class SecretToolBackend implements SecretBackend {
  readonly name = 'libsecret (secret-tool)';
  async set(key: string, value: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const p = execFile('secret-tool', ['store', '--label', `${SERVICE}: ${key}`, 'service', SERVICE, 'account', key],
        (err) => (err ? reject(err) : resolve()));
      p.stdin?.end(value);
    });
  }
  async get(key: string): Promise<string | null> {
    try {
      const { stdout } = await exec('secret-tool', ['lookup', 'service', SERVICE, 'account', key]);
      return stdout;
    } catch {
      return null;
    }
  }
  async delete(key: string): Promise<void> {
    try { await exec('secret-tool', ['clear', 'service', SERVICE, 'account', key]); } catch { /* absent */ }
  }
  async list(): Promise<string[]> { return []; } // secret-tool has no reliable enumeration
}

/** macOS Keychain via `security`. */
class MacKeychainBackend implements SecretBackend {
  readonly name = 'macOS Keychain';
  async set(key: string, value: string): Promise<void> {
    await exec('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', key, '-w', value]);
  }
  async get(key: string): Promise<string | null> {
    try {
      const { stdout } = await exec('security', ['find-generic-password', '-s', SERVICE, '-a', key, '-w']);
      return stdout.replace(/\n$/, '');
    } catch {
      return null;
    }
  }
  async delete(key: string): Promise<void> {
    try { await exec('security', ['delete-generic-password', '-s', SERVICE, '-a', key]); } catch { /* absent */ }
  }
  async list(): Promise<string[]> { return []; }
}

/**
 * Encrypted-file fallback. Explicitly weaker than an OS keychain: the key is derived
 * from a machine-local file with 0600 permissions, so anything running as this user
 * can read it. Surfaced in the UI as such.
 */
export class EncryptedFileBackend implements SecretBackend {
  readonly name = 'encrypted file (weaker than a system keychain)';
  private keyFile: string;
  constructor(private file: string) {
    this.keyFile = `${file}.key`;
  }
  private key(): Buffer {
    if (!fs.existsSync(this.keyFile)) {
      fs.mkdirSync(path.dirname(this.keyFile), { recursive: true });
      fs.writeFileSync(this.keyFile, crypto.randomBytes(32), { mode: 0o600 });
    }
    return fs.readFileSync(this.keyFile);
  }
  private read(): Record<string, string> {
    if (!fs.existsSync(this.file)) return {};
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, { iv: string; tag: string; data: string }>;
      const key = this.key();
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw)) {
        const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(v.iv, 'base64'));
        d.setAuthTag(Buffer.from(v.tag, 'base64'));
        out[k] = Buffer.concat([d.update(Buffer.from(v.data, 'base64')), d.final()]).toString('utf8');
      }
      return out;
    } catch {
      return {};
    }
  }
  private write(values: Record<string, string>): void {
    const key = this.key();
    const out: Record<string, { iv: string; tag: string; data: string }> = {};
    for (const [k, v] of Object.entries(values)) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([c.update(v, 'utf8'), c.final()]);
      out[k] = { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(out), { mode: 0o600 });
  }
  async set(key: string, value: string): Promise<void> { const v = this.read(); v[key] = value; this.write(v); }
  async get(key: string): Promise<string | null> { return this.read()[key] ?? null; }
  async delete(key: string): Promise<void> { const v = this.read(); delete v[key]; this.write(v); }
  async list(): Promise<string[]> { return Object.keys(this.read()); }
}

export async function pickBackend(fallbackFile: string): Promise<SecretBackend> {
  const has = async (bin: string, args: string[]): Promise<boolean> => {
    try { await exec(bin, args); return true; } catch (err) {
      return (err as { code?: string }).code !== 'ENOENT';
    }
  };
  if (process.platform === 'darwin' && (await has('security', ['-h']))) return new MacKeychainBackend();
  if (process.platform === 'linux' && (await has('secret-tool', ['--version']))) return new SecretToolBackend();
  log.warn('no system keychain available; using the encrypted-file fallback');
  return new EncryptedFileBackend(fallbackFile);
}

/**
 * Secrets are stored by NAME only in the index; values live in the backend and are
 * injected into tool environments. A value is never written to the transcript and is
 * never placed in the model's context (outline §5, "secure secret request").
 */
export class SecretsService {
  private names = new Set<string>();
  constructor(
    private backend: SecretBackend,
    private indexFile: string,
  ) {
    if (fs.existsSync(indexFile)) {
      try { this.names = new Set(JSON.parse(fs.readFileSync(indexFile, 'utf8')) as string[]); } catch { /* ignore */ }
    }
  }
  private persist(): void {
    fs.mkdirSync(path.dirname(this.indexFile), { recursive: true });
    fs.writeFileSync(this.indexFile, JSON.stringify([...this.names]), { mode: 0o600 });
  }
  get backendName(): string { return this.backend.name; }
  async set(name: string, value: string): Promise<void> {
    await this.backend.set(name, value);
    this.names.add(name);
    this.persist();
  }
  async remove(name: string): Promise<void> {
    await this.backend.delete(name);
    this.names.delete(name);
    this.persist();
  }
  /** Names only — values are never returned to the API surface. */
  list(): string[] { return [...this.names]; }
  /** Build an env overlay for a tool subprocess. Values never touch the transcript. */
  async envOverlay(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const n of this.names) {
      const v = await this.backend.get(n);
      if (v !== null) out[n] = v;
    }
    return out;
  }
}
