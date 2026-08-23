import { query } from '@anthropic-ai/claude-agent-sdk';
const env = { ...process.env };
delete env.ANTHROPIC_API_KEY;
const q = query({
  prompt: 'Reply with exactly: ANTBOT_OK',
  options: { model: 'haiku', cwd: process.cwd(), settingSources: [], env, includePartialMessages: true, maxTurns: 2 },
});
let sid=null, text='', usage=null;
for await (const m of q) {
  if (m.type==='system'&&m.subtype==='init') sid=m.session_id;
  if (m.type==='stream_event'&&m.event?.delta?.text) text+=m.event.delta.text;
  if (m.type==='result') { usage=m.usage; console.log('RESULT:', JSON.stringify(m.result)); }
}
console.log('SESSION:', sid);
console.log('STREAMED:', JSON.stringify(text));
console.log('USAGE:', JSON.stringify(usage));
