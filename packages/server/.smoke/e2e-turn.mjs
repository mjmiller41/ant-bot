const BASE='http://127.0.0.1:4780';
const j=async(m,p,b)=>{const r=await fetch(BASE+p,{method:m,headers:{'content-type':'application/json'},body:b?JSON.stringify(b):undefined});
  const t=await r.text(); if(!r.ok) throw new Error(`${m} ${p} -> ${r.status} ${t}`); return t?JSON.parse(t):null;};

const bot = await j('POST','/api/bots',{name:'Scout',title:'Research',description:'You investigate and report with evidence. Never change production settings.'});
console.log('BOT:', bot.slug, bot.id, 'thread', bot.threadId);

// watch events
const ws = new WebSocket(BASE.replace('http','ws')+'/api/events');
const seen={delta:0,cards:[],states:[],done:null,created:0};
ws.onmessage=(e)=>{const ev=JSON.parse(e.data);
  if(ev.type==='message.delta') seen.delta++;
  if(ev.type==='message.created') seen.created++;
  if(ev.type==='message.card') seen.cards.push(ev.card.toolName+':'+ev.card.status);
  if(ev.type==='bot.state') seen.states.push(ev.state);
  if(ev.type==='message.done') seen.done=ev.contentMd;
  if(ev.type==='approval.pending') console.log('  APPROVAL:', ev.approval.toolName, '|', ev.approval.inputSummary);
};
await new Promise(r=>ws.onopen=r);

// seed a workspace file for it to read
const fs=await import('node:fs'); const path=await import('node:path');
const wsdir=process.env.ANTBOT_HOME+'/workspace/projects';
fs.mkdirSync(wsdir,{recursive:true});
fs.writeFileSync(path.join(wsdir,'notes.md'),'# Q3 Notes\n- Decision: ship on Oct 1\n- Owner: Dana\n- Open question: pricing tier\n');

await j('POST',`/api/threads/${bot.threadId}/messages`,{contentMd:'Read projects/notes.md in the workspace and give me a two-line summary. Then tell me who the owner is.'});
console.log('message posted, awaiting turn...');

const t0=Date.now();
while(Date.now()-t0 < 180000){ await new Promise(r=>setTimeout(r,1500)); if(seen.done!==null) break; }

console.log('--- RESULT ---');
console.log('deltas:', seen.delta, '| messages created:', seen.created);
console.log('tool cards:', seen.cards.join(', ')||'(none)');
console.log('states:', [...new Set(seen.states)].join(' -> '));
console.log('final text:', JSON.stringify((seen.done||'').slice(0,400)));
const b2 = await j('GET',`/api/bots/${bot.id}`);
console.log('sessionId persisted:', b2.sessionId ? 'YES '+b2.sessionId.slice(0,8) : 'NO');
const usage = await j('GET','/api/usage');
console.log('usage totals:', JSON.stringify(usage.totals));
process.exit(0);
