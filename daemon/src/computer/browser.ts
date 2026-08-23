import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import type { BrowserContext, CDPSession, Page } from 'playwright';
import type { EventBus } from '../util/bus.js';
import { logger } from '../util/log.js';

const log = logger('browser');

/* ------------------------------------------------------------------------------------------- *
 * Errors
 * ------------------------------------------------------------------------------------------- */

/** Thrown when the browser cannot be launched (e.g. Chromium isn't installed). */
export class BrowserUnavailableError extends Error {
  constructor(public readonly reason: string) {
    super(`Browser is unavailable: ${reason}. Try: npx playwright install chromium`);
    this.name = 'BrowserUnavailableError';
  }
}

/** Thrown by ScreenLock when a bot's screen already has a computer-use task in flight. */
export class ScreenBusyError extends Error {
  constructor(public readonly botId: string) {
    super(`That bot's screen is already busy with another computer-use task. Wait for it to finish before starting another.`);
    this.name = 'ScreenBusyError';
  }
}

/** Thrown by normalizeUrl for disallowed / malformed URLs. */
export class InvalidUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidUrlError';
  }
}

/** Thrown when an action targets a bot screen the human currently has taken over. */
export class ScreenTakenOverError extends Error {
  constructor() {
    super('The human has taken control of this screen; wait until they return it.');
    this.name = 'ScreenTakenOverError';
  }
}

/* ------------------------------------------------------------------------------------------- *
 * Pure helpers (no browser required) — exported for unit testing.
 * ------------------------------------------------------------------------------------------- */

/**
 * Adds `https://` to bare domains/paths, rejects `javascript:` and `file:` URLs outright, and
 * otherwise passes the input through unchanged. Deliberately permissive about other schemes
 * (e.g. `data:`, `about:`) — computer-use tasks legitimately need to load those in tests and
 * sandboxes; the block list is specifically the two schemes that are dangerous or meaningless
 * for a screen-driving agent.
 */
export function normalizeUrl(input: string): string {
  const trimmed = (input ?? '').trim();
  if (!trimmed) throw new InvalidUrlError('URL is empty.');
  const schemeMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (!schemeMatch) return `https://${trimmed}`;
  const scheme = schemeMatch[1]!.toLowerCase();
  if (scheme === 'javascript') throw new InvalidUrlError('javascript: URLs are not allowed.');
  if (scheme === 'file') throw new InvalidUrlError('file: URLs are not allowed.');
  return trimmed;
}

export interface BlockSignals {
  hasPasswordInput: boolean;
  iframeSrcs: string[];
  bodyText: string;
}

export interface BlockDetection {
  kind: 'login' | 'captcha' | '2fa';
  message: string;
}

/**
 * Heuristic login-wall / CAPTCHA / 2FA detector over already-extracted page signals. Kept pure
 * (no Page dependency) so it can run without a browser in unit tests; `BrowserService.detectBlock`
 * gathers the signals from a live Page and delegates here.
 */
export function detectBlockFromSignals(signals: BlockSignals): BlockDetection | null {
  const iframeBlob = (signals.iframeSrcs ?? []).join(' ').toLowerCase();
  const body = signals.bodyText ?? '';

  if (/recaptcha/i.test(iframeBlob) || /hcaptcha/i.test(iframeBlob)) {
    return { kind: 'captcha', message: 'A CAPTCHA challenge (reCAPTCHA/hCaptcha) is present on this page.' };
  }
  if (/challenges\.cloudflare\.com|cf-challenge|turnstile/i.test(iframeBlob) || /checking your browser|cloudflare/i.test(body)) {
    return { kind: 'captcha', message: 'A Cloudflare browser challenge is present on this page.' };
  }
  if (/verify (your \w+|it'?s you)|two-factor|one-time code/i.test(body)) {
    return { kind: '2fa', message: "This page is asking for two-factor / one-time-code verification." };
  }
  if (signals.hasPasswordInput) {
    return { kind: 'login', message: 'This page has a password field — it looks like a login wall.' };
  }
  return null;
}

/**
 * Per-key mutex: `run` executes `fn` immediately if the key is free, otherwise rejects with
 * `ScreenBusyError` rather than queueing — mirrors "one computer-use task per Bot screen at a
 * time" (outline §13): a second concurrent call is a caller bug, not something to serialize.
 */
export class ScreenLock {
  private busy = new Set<string>();

  isBusy(key: string): boolean {
    return this.busy.has(key);
  }

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (this.busy.has(key)) throw new ScreenBusyError(key);
    this.busy.add(key);
    try {
      return await fn();
    } finally {
      this.busy.delete(key);
    }
  }
}

/**
 * Frame-rate limiter for the screencast. `shouldEmit()` returns true at most once per
 * `1000/fps` ms according to the injected clock (defaults to `Date.now`), so tests can drive it
 * deterministically without real timers.
 */
export class FrameThrottle {
  private lastEmit = -Infinity;

  constructor(
    private readonly fps: number,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  get intervalMs(): number {
    return 1000 / this.fps;
  }

  shouldEmit(): boolean {
    const now = this.clock();
    if (now - this.lastEmit >= this.intervalMs) {
      this.lastEmit = now;
      return true;
    }
    return false;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ------------------------------------------------------------------------------------------- *
 * BrowserService
 * ------------------------------------------------------------------------------------------- */

export interface BrowserServiceDeps {
  profileDir: string;
  bus: EventBus;
  headless?: boolean;
}

export interface ComputerPageStatus {
  botId: string;
  url: string;
  title: string;
}

export interface BrowserStatus {
  available: boolean;
  reason?: string;
  mode: 'host';
  headless: boolean;
  pages: ComputerPageStatus[];
}

export interface TakeOverResult {
  ok: boolean;
  mode: 'screencast-only' | 'window';
  message: string;
}

type FrameListener = (jpegBase64: string, w: number, h: number) => void;

/**
 * One Playwright persistent browser context shared by every Bot ("the computer"), with a
 * dedicated Page ("screen") per botId. Because all pages share one persistent context, cookies
 * and logins are shared across bots by design (outline §5: "one computer, shared by all your
 * Bots") — this is intentional, not a bug.
 */
export class BrowserService {
  private context: BrowserContext | null = null;
  private launchPromise: Promise<BrowserContext> | null = null;
  private unavailableReason: string | undefined;

  private readonly headlessMode: boolean;
  private readonly pages = new Map<string, Page>();
  private readonly titleCache = new Map<string, string>();
  private readonly takenOver = new Set<string>();
  private readonly lock = new ScreenLock();

  private readonly screencastSessions = new Map<string, CDPSession>();
  private readonly screencastListeners = new Map<string, Set<FrameListener>>();
  private readonly screencastThrottles = new Map<string, FrameThrottle>();
  private readonly viewerCounts = new Map<string, number>();

  constructor(private readonly deps: BrowserServiceDeps) {
    this.headlessMode = deps.headless ?? true;
  }

  get isHeadless(): boolean {
    return this.headlessMode;
  }

  /** Lazily launches the shared persistent context. Concurrent callers share one launch. */
  private async ensureContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    if (this.launchPromise) return this.launchPromise;

    this.launchPromise = (async () => {
      try {
        fs.mkdirSync(this.deps.profileDir, { recursive: true });
        const ctx = await chromium.launchPersistentContext(this.deps.profileDir, {
          headless: this.headlessMode,
          viewport: { width: 1280, height: 800 },
        });
        this.context = ctx;
        ctx.on('close', () => {
          this.context = null;
          this.launchPromise = null;
          this.pages.clear();
        });
        return ctx;
      } catch (err) {
        this.unavailableReason = errMsg(err);
        this.launchPromise = null;
        throw new BrowserUnavailableError(this.unavailableReason);
      }
    })();
    return this.launchPromise;
  }

  /** Returns this bot's dedicated page, creating it lazily. Pages persist across turns. */
  async getPage(botId: string): Promise<Page> {
    const existing = this.pages.get(botId);
    if (existing && !existing.isClosed()) return existing;
    const ctx = await this.ensureContext();
    const page = await ctx.newPage();
    this.pages.set(botId, page);
    page.on('close', () => {
      if (this.pages.get(botId) === page) this.pages.delete(botId);
    });
    return page;
  }

  async closePage(botId: string): Promise<void> {
    const page = this.pages.get(botId);
    if (page) {
      await page.close().catch(() => {});
      this.pages.delete(botId);
    }
    this.titleCache.delete(botId);
    this.takenOver.delete(botId);
  }

  /** Serializes computer-use tasks per bot screen; a concurrent second call is rejected. */
  async withScreen<T>(botId: string, fn: (page: Page) => Promise<T>): Promise<T> {
    return this.lock.run(botId, async () => {
      if (this.takenOver.has(botId)) throw new ScreenTakenOverError();
      const page = await this.getPage(botId);
      return fn(page);
    });
  }

  private async orient(botId: string, page: Page): Promise<{ url: string; title: string }> {
    const url = page.url();
    let title = this.titleCache.get(botId) ?? '';
    try {
      title = await page.title();
      this.titleCache.set(botId, title);
    } catch {
      // page may be mid-navigation or closed; fall back to the cached title.
    }
    return { url, title };
  }

  private orientLine(o: { url: string; title: string }): string {
    return `URL: ${o.url}\nTitle: ${o.title}`;
  }

  /** Gathers page signals and runs them through the pure detector. Never throws. */
  async detectBlock(page: Page): Promise<BlockDetection | null> {
    try {
      const hasPasswordInput = (await page.$$('input[type="password"]').catch(() => [])).length > 0;
      const iframeSrcs = await page
        .$$eval('iframe', (els) => els.map((e) => e.getAttribute('src') ?? ''))
        .catch(() => [] as string[]);
      const bodyText = await page
        .evaluate(() => document.body?.innerText ?? '')
        .catch(() => '');
      return detectBlockFromSignals({ hasPasswordInput, iframeSrcs, bodyText: bodyText.slice(0, 4000) });
    } catch {
      return null;
    }
  }

  /** If a block is detected, publishes a warn notification and returns the STOP text to prepend. */
  private async checkBlock(botId: string, page: Page): Promise<string | null> {
    const block = await this.detectBlock(page);
    if (!block) return null;
    this.deps.bus.publish({
      type: 'notify',
      botId,
      threadId: null,
      level: 'warn',
      title: 'Browser needs a human',
      body: block.message,
    });
    return (
      `${block.message} STOP: do not attempt to solve or bypass this yourself — ` +
      `ask the human to take over the computer and wait for them to return control.`
    );
  }

  /* ---------------------------------------------------------------------------------------- *
   * Actions — each returns a short result string including the resulting URL + title, and is
   * safe to call even if the page has navigated away, closed, or errored mid-action.
   * ---------------------------------------------------------------------------------------- */

  async navigate(botId: string, url: string): Promise<string> {
    const target = normalizeUrl(url);
    return this.withScreen(botId, async (page) => {
      try {
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch (err) {
        return `Navigation to ${target} failed: ${errMsg(err)}\n${this.orientLine(await this.orient(botId, page))}`;
      }
      const block = await this.checkBlock(botId, page);
      const o = await this.orient(botId, page);
      return block ? `${block}\n${this.orientLine(o)}` : `Navigated.\n${this.orientLine(o)}`;
    });
  }

  async click(botId: string, selector: string): Promise<string> {
    return this.withScreen(botId, async (page) => {
      try {
        await page.click(selector, { timeout: 10000 });
      } catch (err) {
        return `Click on "${selector}" failed: ${errMsg(err)}\n${this.orientLine(await this.orient(botId, page))}`;
      }
      const block = await this.checkBlock(botId, page);
      const o = await this.orient(botId, page);
      return block ? `${block}\n${this.orientLine(o)}` : `Clicked "${selector}".\n${this.orientLine(o)}`;
    });
  }

  async type(botId: string, selector: string, text: string, opts?: { submit?: boolean }): Promise<string> {
    return this.withScreen(botId, async (page) => {
      try {
        const isPassword = await page
          .$eval(selector, (el) => (el as HTMLInputElement).type === 'password')
          .catch(() => false);
        if (isPassword) {
          return (
            `Refused: "${selector}" looks like a password field. Never type credentials into the browser — ` +
            `ask the human to take over the computer instead.\n${this.orientLine(await this.orient(botId, page))}`
          );
        }
        await page.fill(selector, text, { timeout: 10000 });
        if (opts?.submit) await page.press(selector, 'Enter');
      } catch (err) {
        return `Type into "${selector}" failed: ${errMsg(err)}\n${this.orientLine(await this.orient(botId, page))}`;
      }
      const block = await this.checkBlock(botId, page);
      const o = await this.orient(botId, page);
      return block ? `${block}\n${this.orientLine(o)}` : `Typed into "${selector}".\n${this.orientLine(o)}`;
    });
  }

  async pressKey(botId: string, key: string): Promise<string> {
    return this.withScreen(botId, async (page) => {
      try {
        await page.keyboard.press(key);
      } catch (err) {
        return `Key press "${key}" failed: ${errMsg(err)}\n${this.orientLine(await this.orient(botId, page))}`;
      }
      return `Pressed "${key}".\n${this.orientLine(await this.orient(botId, page))}`;
    });
  }

  /** Returns visible text (page body, or a selector's text), capped at ~8000 characters. */
  async readText(botId: string, selector?: string): Promise<string> {
    return this.withScreen(botId, async (page) => {
      let text: string;
      try {
        text = selector
          ? ((await page.$eval(selector, (el) => (el as HTMLElement).innerText ?? '')) ?? '')
          : await page.evaluate(() => document.body?.innerText ?? '');
      } catch (err) {
        return `Read${selector ? ` of "${selector}"` : ''} failed: ${errMsg(err)}\n${this.orientLine(await this.orient(botId, page))}`;
      }
      const capped = text.length > 8000 ? `${text.slice(0, 8000)}\n…(truncated)` : text;
      return `${this.orientLine(await this.orient(botId, page))}\n---\n${capped}`;
    });
  }

  async readLinks(botId: string): Promise<string> {
    return this.withScreen(botId, async (page) => {
      let links: Array<{ text: string; href: string }>;
      try {
        links = await page.$$eval('a[href]', (els) =>
          els
            .slice(0, 200)
            .map((e) => ({ text: (e as HTMLElement).innerText.trim().slice(0, 120), href: (e as HTMLAnchorElement).href })),
        );
      } catch (err) {
        return `Reading links failed: ${errMsg(err)}\n${this.orientLine(await this.orient(botId, page))}`;
      }
      const body = links.map((l) => `- ${l.text || '(no text)'} -> ${l.href}`).join('\n') || '(no links found)';
      return `${this.orientLine(await this.orient(botId, page))}\n---\n${body}`;
    });
  }

  /** Saves a PNG screenshot (to `filePath`, or a temp file if omitted) and returns its path. */
  async screenshot(botId: string, filePath?: string): Promise<string> {
    return this.withScreen(botId, async (page) => {
      const target = filePath ?? path.join(os.tmpdir(), `antbot-screenshot-${botId}-${Date.now()}.png`);
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        await page.screenshot({ path: target });
      } catch (err) {
        return `Screenshot failed: ${errMsg(err)}\n${this.orientLine(await this.orient(botId, page))}`;
      }
      return `Screenshot saved to ${target}\n${this.orientLine(await this.orient(botId, page))}`;
    });
  }

  async currentUrl(botId: string): Promise<string> {
    return this.withScreen(botId, async (page) => this.orientLine(await this.orient(botId, page)));
  }

  async waitFor(botId: string, selector: string, timeoutMs: number): Promise<string> {
    return this.withScreen(botId, async (page) => {
      try {
        await page.waitForSelector(selector, { timeout: timeoutMs });
      } catch (err) {
        return `Waiting for "${selector}" timed out: ${errMsg(err)}\n${this.orientLine(await this.orient(botId, page))}`;
      }
      return `Found "${selector}".\n${this.orientLine(await this.orient(botId, page))}`;
    });
  }

  async scroll(botId: string, dy: number): Promise<string> {
    return this.withScreen(botId, async (page) => {
      try {
        await page.mouse.wheel(0, dy);
      } catch (err) {
        return `Scroll failed: ${errMsg(err)}\n${this.orientLine(await this.orient(botId, page))}`;
      }
      return `Scrolled by ${dy}px.\n${this.orientLine(await this.orient(botId, page))}`;
    });
  }

  async goBack(botId: string): Promise<string> {
    return this.withScreen(botId, async (page) => {
      try {
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 });
      } catch (err) {
        return `Go back failed: ${errMsg(err)}\n${this.orientLine(await this.orient(botId, page))}`;
      }
      const block = await this.checkBlock(botId, page);
      const o = await this.orient(botId, page);
      return block ? `${block}\n${this.orientLine(o)}` : `Went back.\n${this.orientLine(o)}`;
    });
  }

  /* ---------------------------------------------------------------------------------------- *
   * Screencast — CDP-driven JPEG frames, throttled to ~4fps, reference-counted per bot so it
   * auto-stops once the last viewer detaches.
   * ---------------------------------------------------------------------------------------- */

  async startScreencast(botId: string, onFrame: FrameListener): Promise<() => void> {
    const page = await this.getPage(botId);

    let listeners = this.screencastListeners.get(botId);
    if (!listeners) {
      listeners = new Set();
      this.screencastListeners.set(botId, listeners);
    }
    listeners.add(onFrame);
    this.viewerCounts.set(botId, (this.viewerCounts.get(botId) ?? 0) + 1);

    if (!this.screencastSessions.has(botId)) {
      const ctx = await this.ensureContext();
      const session = await ctx.newCDPSession(page);
      const throttle = new FrameThrottle(4);
      this.screencastSessions.set(botId, session);
      this.screencastThrottles.set(botId, throttle);

      session.on('Page.screencastFrame', (evt) => {
        void session.send('Page.screencastFrameAck', { sessionId: evt.sessionId }).catch(() => {});
        if (!throttle.shouldEmit()) return;
        const w = evt.metadata?.deviceWidth ?? 0;
        const h = evt.metadata?.deviceHeight ?? 0;
        for (const l of listeners!) {
          try {
            l(evt.data, w, h);
          } catch (err) {
            log.warn('screencast frame listener threw', err);
          }
        }
      });

      await session.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 1280, everyNthFrame: 2 });
    }

    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      listeners!.delete(onFrame);
      const remaining = Math.max(0, (this.viewerCounts.get(botId) ?? 1) - 1);
      this.viewerCounts.set(botId, remaining);
      if (remaining > 0) return;

      const session = this.screencastSessions.get(botId);
      this.screencastSessions.delete(botId);
      this.screencastThrottles.delete(botId);
      this.screencastListeners.delete(botId);
      if (session) {
        void session
          .send('Page.stopScreencast')
          .catch(() => {})
          .then(() => session.detach().catch(() => {}));
      }
    };
  }

  /* ---------------------------------------------------------------------------------------- *
   * Takeover — pauses agent-driven actions on a bot's screen for the human.
   * ---------------------------------------------------------------------------------------- */

  isTakenOver(botId: string): boolean {
    return this.takenOver.has(botId);
  }

  /**
   * Marks the screen as human-controlled. When headless, there is no window to bring forward
   * (and launching a second headed context on the same profile dir isn't possible — Chromium
   * locks the profile), so the human acts through the screencast view instead; interactive input
   * forwarding through that view is out of scope here. When headed, brings the real window to
   * the front for the human to drive directly.
   */
  async takeOver(botId: string): Promise<TakeOverResult> {
    this.takenOver.add(botId);
    if (this.headlessMode) {
      return {
        ok: true,
        mode: 'screencast-only',
        message:
          'This computer is running headless, so there is no window to bring to the front. ' +
          'Act through the screencast view for the blocked step (password, 2FA, CAPTCHA), then return control. ' +
          'Never paste secrets into chat.',
      };
    }
    try {
      const page = await this.getPage(botId);
      await page.bringToFront();
    } catch (err) {
      log.warn('failed to bring page to front for takeover', err);
    }
    return {
      ok: true,
      mode: 'window',
      message: 'The browser window for this bot has been brought to the front. Complete the blocked step, then return control.',
    };
  }

  returnControl(botId: string): void {
    this.takenOver.delete(botId);
  }

  /* ---------------------------------------------------------------------------------------- */

  /** Never launches the browser. Reports optimistically until a launch attempt has failed. */
  status(): BrowserStatus {
    if (this.unavailableReason) {
      return { available: false, reason: this.unavailableReason, mode: 'host', headless: this.headlessMode, pages: [] };
    }
    const pages: ComputerPageStatus[] = [];
    if (this.context) {
      for (const [botId, page] of this.pages) {
        if (page.isClosed()) continue;
        pages.push({ botId, url: page.url(), title: this.titleCache.get(botId) ?? '' });
      }
    }
    return { available: true, mode: 'host', headless: this.headlessMode, pages };
  }

  async shutdown(): Promise<void> {
    for (const session of this.screencastSessions.values()) {
      await session
        .send('Page.stopScreencast')
        .catch(() => {})
        .then(() => session.detach().catch(() => {}));
    }
    this.screencastSessions.clear();
    this.screencastListeners.clear();
    this.screencastThrottles.clear();
    this.viewerCounts.clear();

    for (const page of this.pages.values()) {
      await page.close().catch(() => {});
    }
    this.pages.clear();
    this.titleCache.clear();
    this.takenOver.clear();

    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
    }
    this.launchPromise = null;
  }
}
