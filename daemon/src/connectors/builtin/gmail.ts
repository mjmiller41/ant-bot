// Gmail as an ant-bot built-in connector: six tools, each a thin call to Gmail's REST API.
//
// Narrow on purpose. The goal is a bot that can read a mailbox and draft a reply, not a complete
// Gmail client; every tool here maps to one documented REST call, and `fetch` is injected so the
// whole file is testable against a fake server.
import { z } from 'zod';
import { toolError, toolText, type BuiltinTool, type ToolContext, type ToolResult } from './mcpServer.js';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** One Gmail REST call with the bearer applied; a non-2xx becomes a readable tool error. */
async function gmail(
  fetchFn: FetchLike,
  ctx: ToolContext,
  path: string,
  init: RequestInit = {},
): Promise<{ ok: true; body: any } | { ok: false; error: string }> {
  const res = await fetchFn(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${ctx.accessToken}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
  if (!res.ok) {
    const msg = body?.error?.message ?? `HTTP ${res.status}`;
    // 401/403 nearly always mean the sign-in is gone or lacks a scope; say what to do.
    const hint = res.status === 401 || res.status === 403 ? ' — sign in to the gmail connector again' : '';
    return { ok: false, error: `Gmail: ${msg}${hint}` };
  }
  return { ok: true, body };
}

/** Pull the readable headers and a plain-text body out of a Gmail message resource. */
export function summarizeMessage(m: any): Record<string, unknown> {
  const headers: Record<string, string> = {};
  for (const h of m?.payload?.headers ?? []) {
    const k = String(h.name).toLowerCase();
    if (['from', 'to', 'cc', 'subject', 'date'].includes(k)) headers[k] = String(h.value);
  }
  return {
    id: m?.id,
    threadId: m?.threadId,
    labelIds: m?.labelIds ?? [],
    snippet: m?.snippet ?? '',
    ...headers,
    body: extractText(m?.payload) ?? '',
  };
}

/** Prefer text/plain; fall back to stripping tags from text/html. Walks multipart recursively. */
export function extractText(payload: any): string | null {
  if (!payload) return null;
  const decode = (data: string): string => Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  if (payload.mimeType === 'text/plain' && payload.body?.data) return decode(payload.body.data);
  if (Array.isArray(payload.parts)) {
    for (const p of payload.parts) {
      const t = extractText(p);
      if (t) return t;
    }
  }
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return decode(payload.body.data).replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  return null;
}

/** RFC 822 message, base64url-encoded the way the API wants `raw`. */
export function buildRawMessage(m: { to: string; subject: string; body: string; cc?: string; inReplyTo?: string }): string {
  const lines = [
    `To: ${m.to}`,
    ...(m.cc ? [`Cc: ${m.cc}`] : []),
    `Subject: ${m.subject}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo}`, `References: ${m.inReplyTo}`] : []),
    'Content-Type: text/plain; charset=utf-8',
    'MIME-Version: 1.0',
    '',
    m.body,
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

const json = (v: unknown): ToolResult => toolText(JSON.stringify(v, null, 2));

export function gmailTools(fetchFn: FetchLike = fetch): BuiltinTool<any>[] {
  return [
    {
      name: 'search_threads',
      description:
        'Search the mailbox with Gmail query syntax (e.g. "is:unread", "from:alice newer_than:7d"). Returns thread ids with a snippet of the latest message.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' }, maxResults: { type: 'integer', minimum: 1, maximum: 50 } },
        required: ['query'],
      },
      parse: z.object({ query: z.string().min(1), maxResults: z.number().int().min(1).max(50).default(10) }),
      handler: async (a, ctx) => {
        const r = await gmail(fetchFn, ctx, `/threads?q=${encodeURIComponent(a.query)}&maxResults=${a.maxResults}`);
        if (!r.ok) return toolError(r.error);
        return json({ threads: (r.body.threads ?? []).map((t: any) => ({ id: t.id, snippet: t.snippet })), estimate: r.body.resultSizeEstimate });
      },
    },
    {
      name: 'get_thread',
      description: 'Read every message in a thread: from, to, subject, date and a plain-text body.',
      inputSchema: { type: 'object', properties: { threadId: { type: 'string' } }, required: ['threadId'] },
      parse: z.object({ threadId: z.string().min(1) }),
      handler: async (a, ctx) => {
        const r = await gmail(fetchFn, ctx, `/threads/${encodeURIComponent(a.threadId)}?format=full`);
        if (!r.ok) return toolError(r.error);
        return json({ id: r.body.id, messages: (r.body.messages ?? []).map(summarizeMessage) });
      },
    },
    {
      name: 'get_message',
      description: 'Read one message by id.',
      inputSchema: { type: 'object', properties: { messageId: { type: 'string' } }, required: ['messageId'] },
      parse: z.object({ messageId: z.string().min(1) }),
      handler: async (a, ctx) => {
        const r = await gmail(fetchFn, ctx, `/messages/${encodeURIComponent(a.messageId)}?format=full`);
        if (!r.ok) return toolError(r.error);
        return json(summarizeMessage(r.body));
      },
    },
    {
      name: 'list_labels',
      description: 'List the mailbox labels (INBOX, SENT, user labels…) with their ids.',
      inputSchema: { type: 'object', properties: {} },
      parse: z.object({}),
      handler: async (_a, ctx) => {
        const r = await gmail(fetchFn, ctx, '/labels');
        if (!r.ok) return toolError(r.error);
        return json({ labels: (r.body.labels ?? []).map((l: any) => ({ id: l.id, name: l.name, type: l.type })) });
      },
    },
    {
      name: 'create_draft',
      description: 'Create a draft email. Nothing is sent. Set inReplyTo to a message id to draft a reply in that thread.',
      inputSchema: {
        type: 'object',
        properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, cc: { type: 'string' }, inReplyTo: { type: 'string' } },
        required: ['to', 'subject', 'body'],
      },
      parse: z.object({ to: z.string().min(1), subject: z.string(), body: z.string(), cc: z.string().optional(), inReplyTo: z.string().optional() }),
      handler: async (a, ctx) => {
        const r = await gmail(fetchFn, ctx, '/drafts', { method: 'POST', body: JSON.stringify({ message: { raw: buildRawMessage(a) } }) });
        if (!r.ok) return toolError(r.error);
        return json({ draftId: r.body.id, messageId: r.body.message?.id });
      },
    },
    {
      name: 'send_message',
      description: 'Send an email immediately. This is consequential and asks the human for approval.',
      inputSchema: {
        type: 'object',
        properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, cc: { type: 'string' }, inReplyTo: { type: 'string' } },
        required: ['to', 'subject', 'body'],
      },
      parse: z.object({ to: z.string().min(1), subject: z.string(), body: z.string(), cc: z.string().optional(), inReplyTo: z.string().optional() }),
      handler: async (a, ctx) => {
        const r = await gmail(fetchFn, ctx, '/messages/send', { method: 'POST', body: JSON.stringify({ raw: buildRawMessage(a) }) });
        if (!r.ok) return toolError(r.error);
        return json({ sent: true, messageId: r.body.id, threadId: r.body.threadId });
      },
    },
  ];
}
