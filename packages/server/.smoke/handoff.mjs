const B='http://127.0.0.1:4780';
const j=async(m,p,b)=>{const r=await fetch(B+p,{method:m,headers:{'content-type':'application/json'},body:b?JSON.stringify(b):undefined});
  const t=await r.text(); if(!r.ok) throw new Error(`${m} ${p} -> ${r.status} ${t}`); return t?JSON.parse(t):null;};
const roster=await j('GET','/api/bots');
const scout=roster.find(r=>r.bot.slug==='scout').bot;
const health=roster.find(r=>r.bot.slug==='account-health').bot;
console.log('from', scout.slug, '-> to', health.slug);

const ws=new WebSocket(B.replace('http','ws')+'/api/events');
const handoffs=[]; const doneBy=new Set();
ws.onmessage=e=>{const ev=JSON.parse(e.data);
  if(ev.type==='message.created'&&ev.message.cards?.some(c=>c.type==='handoff')){
    const c=ev.message.cards.find(c=>c.type==='handoff'); handoffs.push(c);
    console.log('  HANDOFF CARD:', c.fromBotId.slice(0,6),'->',c.toBotId.slice(0,6),'|',c.note.slice(0,70));
  }
  if(ev.type==='message.done'&&ev.botId) doneBy.add(ev.botId);
};
await new Promise(r=>ws.onopen=r);

await j('POST',`/api/threads/${scout.threadId}/messages`,
 {contentMd:'Use your send_to_bot tool right now to hand this to the teammate whose slug is "account-health": ask them to state, in one sentence, what their job is. Then just tell me you handed it off. Do not do their work yourself.'});

const t0=Date.now();
while(Date.now()-t0<230000){ await new Promise(r=>setTimeout(r,2000));
  if(handoffs.length && doneBy.has(health.id)) break; }

console.log('--- RESULT ---');
console.log('handoff cards:', handoffs.length);
console.log('bots that produced a turn:', [...doneBy].map(id=>roster.find(r=>r.bot.id===id)?.bot.slug||id.slice(0,6)).join(', '));
const hm = await j('GET',`/api/threads/${health.threadId}`);
const last = hm.messages.filter(m=>m.authorKind==='bot').pop();
console.log('recipient thread messages:', hm.messages.length);
console.log('recipient last reply:', JSON.stringify((last?.contentMd||'').slice(0,220)));
process.exit(0);
