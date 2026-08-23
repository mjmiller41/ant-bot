const B='http://127.0.0.1:4780';
const j=async(m,p,b)=>{const r=await fetch(B+p,{method:m,headers:{'content-type':'application/json'},body:b?JSON.stringify(b):undefined});
  const t=await r.text(); if(!r.ok) throw new Error(`${m} ${p} -> ${r.status} ${t}`); return t?JSON.parse(t):null;};
const routines=await j('GET','/api/routines');
console.log('routines:', routines.map(r=>`${r.name} [${r.cronExpr} ${r.timezone}] next=${r.nextRunAt?new Date(r.nextRunAt).toISOString():'—'}`).join(' ; '));
const r0=routines[0];
console.log('test-running:', r0.name);
const {runId}=await j('POST',`/api/routines/${r0.id}/test-run`);
console.log('runId:', runId);
const t0=Date.now(); let runs=[];
while(Date.now()-t0<200000){ await new Promise(x=>setTimeout(x,3000));
  runs=await j('GET',`/api/routines/${r0.id}/runs`);
  const cur=runs.find(x=>x.id===runId);
  if(cur && cur.status!=='running'){ break; } }
const cur=runs.find(x=>x.id===runId);
console.log('run status:', cur?.status, '| isTest:', cur?.isTest);
console.log('summary:', JSON.stringify((cur?.summary||'').slice(0,240)));
console.log('total run records:', runs.length);
process.exit(0);
