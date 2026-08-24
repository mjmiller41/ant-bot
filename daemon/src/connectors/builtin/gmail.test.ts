import { describe, it, expect } from 'vitest';
import { gmailTools, summarizeMessage, extractText, buildRawMessage, type FetchLike } from './gmail.js';

/** A fake Gmail that records requests and answers from a table. */
function fakeGmail(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.includes(k));
    const r = key ? routes[key]! : { status: 404, body: { error: { message: 'no route' } } };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  };
  return { fetchFn, calls };
}
const ctx = { accessToken: 'ya29.test' };
const tool = (name: string, fetchFn: FetchLike) => gmailTools(fetchFn).find((t) => t.name === name)!;
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

describe('gmail tools', () => {
  it('sends the bearer on every call', async () => {
    const { fetchFn, calls } = fakeGmail({ '/labels': { body: { labels: [] } } });
    await tool('list_labels', fetchFn).handler({}, ctx);
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe('Bearer ya29.test');
  });

  it('search_threads encodes the query and returns ids with snippets', async () => {
    const { fetchFn, calls } = fakeGmail({ '/threads?': { body: { threads: [{ id: 't1', snippet: 'hello' }], resultSizeEstimate: 1 } } });
    const r = await tool('search_threads', fetchFn).handler({ query: 'is:unread from:a b', maxResults: 5 }, ctx);
    expect(calls[0]!.url).toContain('q=is%3Aunread%20from%3Aa%20b');
    expect(calls[0]!.url).toContain('maxResults=5');
    expect(JSON.parse(r.content[0]!.text)).toEqual({ threads: [{ id: 't1', snippet: 'hello' }], estimate: 1 });
  });

  it('get_thread summarises each message with headers and a plain body', async () => {
    const msg = {
      id: 'm1', threadId: 't1', labelIds: ['INBOX'], snippet: 'snip',
      payload: { mimeType: 'text/plain', body: { data: b64('the body') },
        headers: [{ name: 'From', value: 'a@x' }, { name: 'Subject', value: 'Hi' }, { name: 'X-Junk', value: 'no' }] },
    };
    const { fetchFn } = fakeGmail({ '/threads/t1': { body: { id: 't1', messages: [msg] } } });
    const r = await tool('get_thread', fetchFn).handler({ threadId: 't1' }, ctx);
    const out = JSON.parse(r.content[0]!.text);
    expect(out.messages[0]).toMatchObject({ id: 'm1', from: 'a@x', subject: 'Hi', body: 'the body' });
    expect(out.messages[0]).not.toHaveProperty('x-junk');
  });

  // A model needs a sentence, not a status code — and the likely fix named.
  it('turns a 401 into a tool error that says to sign in again', async () => {
    const { fetchFn } = fakeGmail({ '/labels': { status: 401, body: { error: { message: 'Invalid Credentials' } } } });
    const r = await tool('list_labels', fetchFn).handler({}, ctx);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/Invalid Credentials.*sign in/);
  });

  it('create_draft posts a base64url RFC 822 message and returns the draft id', async () => {
    const { fetchFn, calls } = fakeGmail({ '/drafts': { body: { id: 'd1', message: { id: 'm9' } } } });
    const r = await tool('create_draft', fetchFn).handler({ to: 'b@x', subject: 'S', body: 'B' }, ctx);
    const sent = JSON.parse(String(calls[0]!.init!.body));
    const raw = Buffer.from(sent.message.raw, 'base64url').toString('utf8');
    expect(raw).toContain('To: b@x');
    expect(raw).toContain('Subject: S');
    expect(raw.endsWith('\r\n\r\nB')).toBe(true);
    expect(JSON.parse(r.content[0]!.text)).toEqual({ draftId: 'd1', messageId: 'm9' });
  });

  it('send_message uses the send endpoint', async () => {
    const { fetchFn, calls } = fakeGmail({ '/messages/send': { body: { id: 'm2', threadId: 't2' } } });
    const r = await tool('send_message', fetchFn).handler({ to: 'b@x', subject: 'S', body: 'B' }, ctx);
    expect(calls[0]!.url).toMatch(/\/messages\/send$/);
    expect(JSON.parse(r.content[0]!.text)).toEqual({ sent: true, messageId: 'm2', threadId: 't2' });
  });
});

describe('helpers', () => {
  it('buildRawMessage threads a reply', () => {
    const raw = Buffer.from(buildRawMessage({ to: 'a', subject: 's', body: 'b', inReplyTo: '<id@x>' }), 'base64url').toString();
    expect(raw).toContain('In-Reply-To: <id@x>');
    expect(raw).toContain('References: <id@x>');
  });

  it('extractText prefers text/plain inside multipart and strips html otherwise', () => {
    const multi = { mimeType: 'multipart/alternative', parts: [
      { mimeType: 'text/html', body: { data: b64('<p>hi <b>there</b></p>') } },
      { mimeType: 'text/plain', body: { data: b64('hi there') } },
    ] };
    expect(extractText(multi)).toBe('hi there');
    expect(extractText({ mimeType: 'text/html', body: { data: b64('<style>x{}</style><p>only  html</p>') } })).toBe('only html');
    expect(extractText(null)).toBeNull();
  });

  it('summarizeMessage tolerates a message with no payload', () => {
    expect(summarizeMessage({ id: 'x' })).toMatchObject({ id: 'x', body: '', labelIds: [] });
  });
});
