import path from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { BrowserService } from './browser.js';

/**
 * Doctrine appended to every tool description (grok-bot-system-outline.md §5, §9, §15):
 * connectors/APIs beat computer-use when one exists; secrets never go through the browser tools;
 * verification walls are a stop-and-notify signal, never something to solve.
 */
const DOCTRINE =
  'Prefer a real API/connector for this task if one is available — it is more reliable than clicking through a site. ' +
  'Never type passwords, one-time codes, or other secrets into any field here — ask the human to take over the ' +
  "computer instead. If a login wall, CAPTCHA, or 2FA prompt appears, stop immediately and report it in your reply; " +
  'never attempt to solve or bypass a verification check.';

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function fail(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text' as const, text: `Browser action failed: ${msg}` }] };
}

/**
 * Builds the MCP tool server exposed to a single bot's turn for driving its browser "screen".
 * `botId` scopes every action to that bot's dedicated page; `workspace` anchors screenshot paths.
 */
export function createBrowserToolServer(service: BrowserService, botId: string, workspace: string) {
  return createSdkMcpServer({
    name: 'browser',
    version: '1.0.0',
    tools: [
      tool(
        'browser_navigate',
        `Navigate this bot's browser screen to a URL. ${DOCTRINE}`,
        { url: z.string().describe('URL or bare domain to open, e.g. "https://news.ycombinator.com"') },
        async (args: { url: string }) => {
          try {
            return ok(await service.navigate(botId, args.url));
          } catch (err) {
            return fail(err);
          }
        },
      ),

      tool(
        'browser_click',
        `Click an element on this bot's current browser page, identified by a CSS selector. ${DOCTRINE}`,
        { selector: z.string().describe('CSS selector of the element to click') },
        async (args: { selector: string }) => {
          try {
            return ok(await service.click(botId, args.selector));
          } catch (err) {
            return fail(err);
          }
        },
      ),

      tool(
        'browser_type',
        `Type text into a field on this bot's current browser page. ${DOCTRINE}`,
        {
          selector: z.string().describe('CSS selector of the input/textarea to type into'),
          text: z.string().describe('text to type (never a password or one-time code)'),
          submit: z.boolean().optional().describe('press Enter after typing, e.g. to submit a search box'),
        },
        async (args: { selector: string; text: string; submit?: boolean }) => {
          try {
            return ok(await service.type(botId, args.selector, args.text, { submit: args.submit }));
          } catch (err) {
            return fail(err);
          }
        },
      ),

      tool(
        'browser_read',
        `Read visible text from this bot's current browser page (whole page or one selector), or list its links. ${DOCTRINE}`,
        {
          selector: z.string().optional().describe('CSS selector to read text from; omit to read the whole page'),
          links: z.boolean().optional().describe('true to list the page\'s links instead of reading text'),
        },
        async (args: { selector?: string; links?: boolean }) => {
          try {
            const text = args.links ? await service.readLinks(botId) : await service.readText(botId, args.selector);
            return ok(text);
          } catch (err) {
            return fail(err);
          }
        },
      ),

      tool(
        'browser_screenshot',
        `Take a PNG screenshot of this bot's current browser screen and save it to the shared workspace. ${DOCTRINE}`,
        { name: z.string().optional().describe('optional file name (without extension) for the screenshot') },
        async (args: { name?: string }) => {
          try {
            const safe = (args.name ?? `shot-${Date.now()}`).replace(/[^a-zA-Z0-9._-]/g, '-');
            const file = path.join(workspace, 'bots', botId, 'screenshots', `${safe}.png`);
            return ok(await service.screenshot(botId, file));
          } catch (err) {
            return fail(err);
          }
        },
      ),

      tool(
        'browser_press',
        `Press a single keyboard key on this bot's current browser page (e.g. "Enter", "Escape", "ArrowDown"). ${DOCTRINE}`,
        { key: z.string().describe('key name, per Playwright keyboard.press conventions') },
        async (args: { key: string }) => {
          try {
            return ok(await service.pressKey(botId, args.key));
          } catch (err) {
            return fail(err);
          }
        },
      ),

      tool(
        'browser_wait_for',
        `Wait for a CSS selector to appear on this bot's current browser page before continuing. ${DOCTRINE}`,
        {
          selector: z.string().describe('CSS selector to wait for'),
          timeoutMs: z.number().optional().describe('milliseconds to wait, default 10000'),
        },
        async (args: { selector: string; timeoutMs?: number }) => {
          try {
            return ok(await service.waitFor(botId, args.selector, args.timeoutMs ?? 10000));
          } catch (err) {
            return fail(err);
          }
        },
      ),

      tool(
        'browser_scroll',
        `Scroll this bot's current browser page vertically. ${DOCTRINE}`,
        { dy: z.number().describe('pixels to scroll; positive scrolls down, negative scrolls up') },
        async (args: { dy: number }) => {
          try {
            return ok(await service.scroll(botId, args.dy));
          } catch (err) {
            return fail(err);
          }
        },
      ),

      tool(
        'browser_back',
        `Go back to the previous page on this bot's browser screen. ${DOCTRINE}`,
        {},
        async () => {
          try {
            return ok(await service.goBack(botId));
          } catch (err) {
            return fail(err);
          }
        },
      ),
    ],
  });
}
