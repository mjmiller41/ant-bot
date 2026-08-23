import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SecretsService, type SecretBackend } from './secrets.js';

/** Records every backend read, so "scoped" can be asserted rather than assumed. */
function fakeBackend(values: Record<string, string>) {
  const reads: string[] = [];
  const store = new Map(Object.entries(values));
  const backend: SecretBackend = {
    name: 'fake',
    async set(k, v) { store.set(k, v); },
    async get(k) { reads.push(k); return store.get(k) ?? null; },
    async delete(k) { store.delete(k); },
    async list() { return [...store.keys()]; },
  };
  return { backend, reads };
}

function service(values: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antbot-secrets-'));
  const { backend, reads } = fakeBackend(values);
  const svc = new SecretsService(backend, path.join(dir, 'index'));
  return { svc, reads, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe('SecretsService.resolve', () => {
  it('returns the values for the names it was asked for', async () => {
    const { svc, cleanup } = service({});
    await svc.set('TOKEN_A', 'aaa');
    await svc.set('TOKEN_B', 'bbb');
    expect(await svc.resolve(['TOKEN_A'])).toEqual(new Map([['TOKEN_A', 'aaa']]));
    cleanup();
  });

  // The whole point of the scoped variant: a connector must not be able to pull credentials it
  // never referenced just by being mounted.
  it('never reads a secret it was not asked for', async () => {
    const { svc, reads, cleanup } = service({});
    await svc.set('WANTED', 'x');
    await svc.set('UNRELATED', 'y');
    await svc.resolve(['WANTED']);
    expect(reads).toEqual(['WANTED']);
    cleanup();
  });

  // null, not absent: the caller has to be able to tell a missing secret from an empty one so it
  // can skip the connector rather than mount it half-configured.
  it('maps an unknown name to null without touching the backend', async () => {
    const { svc, reads, cleanup } = service({});
    await svc.set('KNOWN', 'v');
    expect(await svc.resolve(['KNOWN', 'GHOST'])).toEqual(new Map([['KNOWN', 'v'], ['GHOST', null]]));
    expect(reads).toEqual(['KNOWN']);
    cleanup();
  });

  it('maps a name the backend has lost to null', async () => {
    const { svc, cleanup } = service({});
    await svc.set('VANISHED', 'v');
    await (svc as unknown as { backend: SecretBackend }).backend.delete('VANISHED');
    expect(await svc.resolve(['VANISHED'])).toEqual(new Map([['VANISHED', null]]));
    cleanup();
  });

  it('deduplicates repeated names', async () => {
    const { svc, reads, cleanup } = service({});
    await svc.set('T', 'v');
    await svc.resolve(['T', 'T', 'T']);
    expect(reads).toEqual(['T']);
    cleanup();
  });

  it('is empty for an empty request', async () => {
    const { svc, cleanup } = service({});
    expect(await svc.resolve([])).toEqual(new Map());
    cleanup();
  });
});
