import { describe, it, expect } from 'vitest';
import { resolveModel, buildEnv } from './session.js';
import { SettingsSchema } from '@antbot/contract';

describe('resolveModel', () => {
  it('returns the alias unchanged for sonnet, opus and haiku', () => {
    expect(resolveModel('sonnet')).toBe('sonnet');
    expect(resolveModel('opus')).toBe('opus');
    expect(resolveModel('haiku')).toBe('haiku');
  });
});

describe('buildEnv', () => {
  const baseWithCreds = (): NodeJS.ProcessEnv => ({
    PATH: '/usr/bin', HOME: '/home/user', CUSTOM_VAR: 'keep-me',
    ANTHROPIC_API_KEY: 'sk-secret', ANTHROPIC_AUTH_TOKEN: 'token-secret',
  });

  it('subscription billing mode deletes ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN', () => {
    const settings = SettingsSchema.parse({ billingMode: 'subscription' });
    const base = baseWithCreds();
    const env = buildEnv(settings, base);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect('ANTHROPIC_API_KEY' in env).toBe(false);
    expect('ANTHROPIC_AUTH_TOKEN' in env).toBe(false);
  });

  it('api billing mode preserves ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN', () => {
    const settings = SettingsSchema.parse({ billingMode: 'api' });
    const base = baseWithCreds();
    const env = buildEnv(settings, base);
    expect(env.ANTHROPIC_API_KEY).toBe('sk-secret');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('token-secret');
  });

  it('does not mutate the passed-in base env object', () => {
    const settings = SettingsSchema.parse({ billingMode: 'subscription' });
    const base = baseWithCreds();
    const snapshot = { ...base };
    buildEnv(settings, base);
    expect(base).toEqual(snapshot);
    expect(base.ANTHROPIC_API_KEY).toBe('sk-secret');
    expect(base.ANTHROPIC_AUTH_TOKEN).toBe('token-secret');
  });

  it('passes other env vars through untouched', () => {
    const settings = SettingsSchema.parse({ billingMode: 'subscription' });
    const base = baseWithCreds();
    const env = buildEnv(settings, base);
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/user');
    expect(env.CUSTOM_VAR).toBe('keep-me');
  });
});
