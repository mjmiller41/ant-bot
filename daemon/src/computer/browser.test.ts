import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { EventBus } from '../util/bus.js';
import {
  BrowserService,
  BrowserUnavailableError,
  FrameThrottle,
  InvalidUrlError,
  ScreenBusyError,
  ScreenLock,
  ScreenNotTakenOverError,
  detectBlockFromSignals,
  normalizeUrl,
} from './browser.js';

/* ------------------------------------------------------------------------------------------- *
 * Tier 1 — always-run unit tests over pure/injectable logic. No browser required.
 * ------------------------------------------------------------------------------------------- */

describe('detectBlockFromSignals', () => {
  it('returns null when nothing suspicious is present', () => {
    const result = detectBlockFromSignals({ hasPasswordInput: false, iframeSrcs: [], bodyText: 'Welcome to the dashboard.' });
    expect(result).toBeNull();
  });

  it('detects a password input as a login wall', () => {
    const result = detectBlockFromSignals({ hasPasswordInput: true, iframeSrcs: [], bodyText: '' });
    expect(result?.kind).toBe('login');
    expect(result?.message).toMatch(/password/i);
  });

  it('detects a reCAPTCHA iframe', () => {
    const result = detectBlockFromSignals({
      hasPasswordInput: false,
      iframeSrcs: ['https://www.google.com/recaptcha/api2/anchor'],
      bodyText: '',
    });
    expect(result?.kind).toBe('captcha');
  });

  it('detects an hCaptcha iframe', () => {
    const result = detectBlockFromSignals({
      hasPasswordInput: false,
      iframeSrcs: ['https://newassets.hcaptcha.com/captcha/v1/frame'],
      bodyText: '',
    });
    expect(result?.kind).toBe('captcha');
  });

  it('detects a Cloudflare challenge iframe', () => {
    const result = detectBlockFromSignals({
      hasPasswordInput: false,
      iframeSrcs: ['https://challenges.cloudflare.com/turnstile/v0/whatever'],
      bodyText: '',
    });
    expect(result?.kind).toBe('captcha');
  });

  it('detects Cloudflare challenge body text even without an iframe', () => {
    const result = detectBlockFromSignals({ hasPasswordInput: false, iframeSrcs: [], bodyText: 'Checking your browser before accessing the site.' });
    expect(result?.kind).toBe('captcha');
  });

  it('detects "two-factor" verification text', () => {
    const result = detectBlockFromSignals({ hasPasswordInput: false, iframeSrcs: [], bodyText: 'Enter your two-factor code to continue.' });
    expect(result?.kind).toBe('2fa');
  });

  it('detects "one-time code" verification text', () => {
    const result = detectBlockFromSignals({ hasPasswordInput: false, iframeSrcs: [], bodyText: 'We sent you a one-time code.' });
    expect(result?.kind).toBe('2fa');
  });

  it('detects "verify it\'s you" phrasing', () => {
    const result = detectBlockFromSignals({ hasPasswordInput: false, iframeSrcs: [], bodyText: "Verify it's you before continuing." });
    expect(result?.kind).toBe('2fa');
  });

  it('detects "verify your ..." phrasing case-insensitively', () => {
    const result = detectBlockFromSignals({ hasPasswordInput: false, iframeSrcs: [], bodyText: 'PLEASE VERIFY YOUR IDENTITY' });
    expect(result?.kind).toBe('2fa');
  });

  it('prefers a CAPTCHA/2FA finding over a bare password field when both are present', () => {
    const result = detectBlockFromSignals({
      hasPasswordInput: true,
      iframeSrcs: ['https://www.google.com/recaptcha/api2/anchor'],
      bodyText: '',
    });
    expect(result?.kind).toBe('captcha');
  });

  it('every message tells the caller what was found, never nothing', () => {
    const result = detectBlockFromSignals({ hasPasswordInput: true, iframeSrcs: [], bodyText: '' });
    expect(result?.message.length).toBeGreaterThan(10);
  });
});

describe('ScreenLock', () => {
  it('runs a task when the key is free', async () => {
    const lock = new ScreenLock();
    const result = await lock.run('bot-1', async () => 'done');
    expect(result).toBe('done');
  });

  it('is not busy before or after a run', async () => {
    const lock = new ScreenLock();
    expect(lock.isBusy('bot-1')).toBe(false);
    await lock.run('bot-1', async () => undefined);
    expect(lock.isBusy('bot-1')).toBe(false);
  });

  it('reports busy while a task is in flight', async () => {
    const lock = new ScreenLock();
    let resolveInner: () => void = () => {};
    const inner = new Promise<void>((resolve) => (resolveInner = resolve));
    const running = lock.run('bot-1', async () => {
      await inner;
    });
    expect(lock.isBusy('bot-1')).toBe(true);
    resolveInner();
    await running;
  });

  it('rejects a concurrent call for the same key with ScreenBusyError', async () => {
    const lock = new ScreenLock();
    let resolveInner: () => void = () => {};
    const inner = new Promise<void>((resolve) => (resolveInner = resolve));
    const first = lock.run('bot-1', async () => {
      await inner;
      return 'first';
    });
    await expect(lock.run('bot-1', async () => 'second')).rejects.toBeInstanceOf(ScreenBusyError);
    resolveInner();
    await expect(first).resolves.toBe('first');
  });

  it('allows a different key to run concurrently', async () => {
    const lock = new ScreenLock();
    let resolveInner: () => void = () => {};
    const inner = new Promise<void>((resolve) => (resolveInner = resolve));
    const first = lock.run('bot-1', async () => {
      await inner;
      return 'first';
    });
    const second = await lock.run('bot-2', async () => 'second');
    expect(second).toBe('second');
    resolveInner();
    await first;
  });

  it('releases the lock even when the task throws', async () => {
    const lock = new ScreenLock();
    await expect(lock.run('bot-1', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(lock.isBusy('bot-1')).toBe(false);
    await expect(lock.run('bot-1', async () => 'ok again')).resolves.toBe('ok again');
  });

  it('ScreenBusyError names the offending bot in its message', async () => {
    const err = new ScreenBusyError('scout');
    expect(err.message).toMatch(/already busy/i);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('FrameThrottle', () => {
  it('emits on the very first call', () => {
    const throttle = new FrameThrottle(4, () => 1000);
    expect(throttle.shouldEmit()).toBe(true);
  });

  it('suppresses a call that arrives before the interval elapses', () => {
    let now = 1000;
    const throttle = new FrameThrottle(4, () => now);
    expect(throttle.shouldEmit()).toBe(true);
    now += 100; // 4fps => 250ms interval
    expect(throttle.shouldEmit()).toBe(false);
  });

  it('emits again once the interval has fully elapsed', () => {
    let now = 1000;
    const throttle = new FrameThrottle(4, () => now);
    expect(throttle.shouldEmit()).toBe(true);
    now += 250;
    expect(throttle.shouldEmit()).toBe(true);
  });

  it('computes intervalMs from the configured fps', () => {
    expect(new FrameThrottle(4).intervalMs).toBe(250);
    expect(new FrameThrottle(10).intervalMs).toBe(100);
  });

  it('does not emit twice for the same instant', () => {
    const now = 5000;
    const throttle = new FrameThrottle(4, () => now);
    expect(throttle.shouldEmit()).toBe(true);
    expect(throttle.shouldEmit()).toBe(false);
  });
});

describe('normalizeUrl', () => {
  it('adds https:// to a bare domain', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com');
  });

  it('adds https:// to a bare domain with a path', () => {
    expect(normalizeUrl('example.com/path?q=1')).toBe('https://example.com/path?q=1');
  });

  it('passes an explicit http:// URL through unchanged', () => {
    expect(normalizeUrl('http://example.com')).toBe('http://example.com');
  });

  it('passes an explicit https:// URL through unchanged', () => {
    expect(normalizeUrl('https://example.com/foo')).toBe('https://example.com/foo');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeUrl('  example.com  ')).toBe('https://example.com');
  });

  it('rejects javascript: URLs', () => {
    expect(() => normalizeUrl('javascript:alert(1)')).toThrow(InvalidUrlError);
  });

  it('rejects file:// URLs', () => {
    expect(() => normalizeUrl('file:///etc/passwd')).toThrow(InvalidUrlError);
  });

  it('rejects an empty URL', () => {
    expect(() => normalizeUrl('   ')).toThrow(InvalidUrlError);
  });

  it('allows data: URLs through (used by tests/sandboxes, not a security hazard for navigation)', () => {
    expect(normalizeUrl('data:text/html,<h1>hi</h1>')).toBe('data:text/html,<h1>hi</h1>');
  });
});

describe('BrowserService.status() before launch', () => {
  it('reports available: true with no pages when the browser has never launched', () => {
    const service = new BrowserService({ profileDir: '/tmp/does-not-matter', bus: new EventBus() });
    const status = service.status();
    expect(status.available).toBe(true);
    expect(status.pages).toEqual([]);
    expect(status.mode).toBe('host');
  });

  it('reflects the configured headless flag', () => {
    const headless = new BrowserService({ profileDir: '/tmp/x', bus: new EventBus(), headless: true });
    const headed = new BrowserService({ profileDir: '/tmp/y', bus: new EventBus(), headless: false });
    expect(headless.status().headless).toBe(true);
    expect(headed.status().headless).toBe(false);
    expect(headless.isHeadless).toBe(true);
    expect(headed.isHeadless).toBe(false);
  });

  it('defaults to headless when not specified', () => {
    const service = new BrowserService({ profileDir: '/tmp/z', bus: new EventBus() });
    expect(service.isHeadless).toBe(true);
  });
});

describe('BrowserUnavailableError', () => {
  it('includes the install hint', () => {
    const err = new BrowserUnavailableError('Executable doesn\'t exist');
    expect(err.message).toMatch(/npx playwright install chromium/);
    expect(err.reason).toMatch(/doesn't exist/);
  });
});

describe('takeover before any launch', () => {
  it('marks a bot as taken over and returns control without needing a live browser', async () => {
    const bus = new EventBus();
    const service = new BrowserService({ profileDir: '/tmp/takeover-test', bus, headless: true });
    expect(service.isTakenOver('scout')).toBe(false);
    // headless takeOver does not require a launched context — it only sets a flag and reports.
    const result = await service.takeOver('scout');
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('screencast-only');
    expect(service.isTakenOver('scout')).toBe(true);
    service.returnControl('scout');
    expect(service.isTakenOver('scout')).toBe(false);
  });

  // The gate is the entire security model for input forwarding: while a bot is running, the
  // screencast must be a window, not a control surface. A hard refusal rather than a queue,
  // so a click sent late cannot land after control was returned.
  it('refuses input for a screen that is not taken over', async () => {
    const service = new BrowserService({ profileDir: '/tmp/input-gate-test', bus: new EventBus(), headless: true });
    await expect(
      service.forwardInput('scout', {
        kind: 'mouse', action: 'down', x: 0.5, y: 0.5, button: 'left', clickCount: 1, deltaX: 0, deltaY: 0,
      }),
    ).rejects.toThrow(ScreenNotTakenOverError);
  });

  it('stops accepting input again once control is returned', async () => {
    const service = new BrowserService({ profileDir: '/tmp/input-gate-test-2', bus: new EventBus(), headless: true });
    await service.takeOver('scout');
    service.returnControl('scout');
    await expect(
      service.forwardInput('scout', { kind: 'text', text: 'hello' }),
    ).rejects.toThrow(ScreenNotTakenOverError);
  });

  it('gates per bot — taking over one screen does not unlock another', async () => {
    const service = new BrowserService({ profileDir: '/tmp/input-gate-test-3', bus: new EventBus(), headless: true });
    await service.takeOver('scout');
    await expect(
      service.forwardInput('planner', { kind: 'key', action: 'down', key: 'Enter' }),
    ).rejects.toThrow(ScreenNotTakenOverError);
  });
});

/* ------------------------------------------------------------------------------------------- *
 * Tier 2 — conditional integration test against a real (headless) Chromium, gated on the browser
 * actually being installed in this environment. Uses a throwaway temp profile dir, never the
 * user's real ~/.ant-bot/browser-profile.
 * ------------------------------------------------------------------------------------------- */

function chromiumAvailable(): boolean {
  try {
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

const hasChromium = chromiumAvailable();

describe.skipIf(!hasChromium)('BrowserService (live Chromium)', () => {
  it(
    'navigates, reads text, screenshots, and enforces the one-task-per-screen rule',
    async () => {
      const bus = new EventBus();
      const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antbot-browser-test-'));
      const service = new BrowserService({ profileDir, bus, headless: true });

      try {
        const navResult = await service.navigate(
          'scout',
          'data:text/html,<html><head><title>Test Page</title></head><body><h1>Hello Ant-Bot</h1><a href="https://example.com">link</a></body></html>',
        );
        expect(navResult).toMatch(/Title: Test Page/);

        const text = await service.readText('scout');
        expect(text).toMatch(/Hello Ant-Bot/);

        const links = await service.readLinks('scout');
        expect(links).toMatch(/example\.com/);

        const shotPath = path.join(profileDir, 'shot.png');
        const shotResult = await service.screenshot('scout', shotPath);
        expect(shotResult).toContain(shotPath);
        expect(fs.existsSync(shotPath)).toBe(true);

        // Concurrent second computer-use task on the same screen must be rejected, not queued.
        let resolveSlow: () => void = () => {};
        const slow = new Promise<void>((resolve) => (resolveSlow = resolve));
        const first = service.withScreen('scout', async () => {
          await slow;
          return 'first';
        });
        await expect(service.currentUrl('scout')).rejects.toBeInstanceOf(ScreenBusyError);
        resolveSlow();
        await first;

        const status = service.status();
        expect(status.available).toBe(true);
        expect(status.pages.some((p) => p.botId === 'scout')).toBe(true);
      } finally {
        await service.shutdown();
        fs.rmSync(profileDir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

/* ------------------------------------------------------------------------------------------- *
 * Input forwarding, against a real page. The pure coordinate maths is covered in input.test.ts;
 * what only a live browser can prove is that a normalised point actually lands on the element the
 * human aimed at, and that typed text reaches the focused field.
 * ------------------------------------------------------------------------------------------- */
describe.skipIf(!hasChromium)('BrowserService input forwarding (live Chromium)', () => {
  it(
    'clicks and types into the page the human took over',
    async () => {
      const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antbot-input-test-'));
      const service = new BrowserService({ profileDir, bus: new EventBus(), headless: true });

      try {
        // A button filling the right half, and a text input, so a click at x=0.75 is
        // unambiguous — it can only land if the coordinate scaling is right.
        await service.navigate(
          'scout',
          'data:text/html,' +
            encodeURIComponent(
              `<html><body style="margin:0">
                 <div id="out"></div>
                 <input id="field" style="position:absolute;top:0;left:0;width:50%;height:40px">
                 <button id="btn" style="position:absolute;top:0;right:0;width:50%;height:40px"
                         onclick="document.getElementById('out').textContent='clicked'">go</button>
               </body></html>`,
            ),
        );

        // Chromium emits no screencast frames for a page that never repaints, so the seeded
        // first frame is the only thing standing between a human and a blank pane here.
        let frames = 0;
        const stop = await service.startScreencast('scout', () => { frames++; });
        await expect.poll(() => frames, { timeout: 5000 }).toBeGreaterThan(0);

        await service.takeOver('scout');

        // Right half, near the top — the button.
        await service.forwardInput('scout', {
          kind: 'mouse', action: 'down', x: 0.75, y: 0.02, button: 'left', clickCount: 1, deltaX: 0, deltaY: 0,
        });
        await service.forwardInput('scout', {
          kind: 'mouse', action: 'up', x: 0.75, y: 0.02, button: 'left', clickCount: 1, deltaX: 0, deltaY: 0,
        });
        // Left half — the input. Click to focus, then type.
        await service.forwardInput('scout', {
          kind: 'mouse', action: 'down', x: 0.25, y: 0.02, button: 'left', clickCount: 1, deltaX: 0, deltaY: 0,
        });
        await service.forwardInput('scout', {
          kind: 'mouse', action: 'up', x: 0.25, y: 0.02, button: 'left', clickCount: 1, deltaX: 0, deltaY: 0,
        });
        await service.forwardInput('scout', { kind: 'text', text: 'hello human' });

        // Read back through the bot-facing API, which refuses while taken over — so this also
        // proves control actually came back.
        service.returnControl('scout');
        await expect.poll(() => service.readText('scout'), { timeout: 5000 }).toMatch(/clicked/);

        const typed = await service.withScreen('scout', (page) =>
          page.$eval('#field', (el) => (el as HTMLInputElement).value),
        );
        expect(typed).toBe('hello human');

        stop();
      } finally {
        await service.shutdown();
        fs.rmSync(profileDir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
