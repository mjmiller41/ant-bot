const BASE='http://127.0.0.1:4780';
const j=async(m,p,b)=>{const r=await fetch(BASE+p,{method:m,headers:{'content-type':'application/json'},body:b?JSON.stringify(b):undefined});
  const t=await r.text(); if(!r.ok) throw new Error(`${m} ${p} -> ${r.status} ${t}`); return t?JSON.parse(t):null;};
const bots=[
 {name:'Scout',title:'Research',avatarEmoji:'🔭',description:'Investigate questions and report with evidence. Separate facts from hypotheses. Never change production settings.'},
 {name:'Account Health',title:'Customer success',avatarEmoji:'💗',description:'Rank accounts by churn and expansion signals. Never contact a customer or edit the CRM without approval.'},
 {name:'Expense Manager',title:'Finance ops',avatarEmoji:'🧾',description:'Weekly expense reconciliation. Cite the policy section for every exception. Never send messages or change reimbursements.'},
];
const made=[];
for(const b of bots) made.push(await j('POST','/api/bots',b));
console.log('bots:', made.map(b=>b.slug).join(', '));
const grp = await j('POST','/api/threads',{kind:'group',title:'Weekly Review',memberBotIds:made.map(b=>b.id)});
console.log('group:', grp.id);
// a routine so the panel has content
await j('POST','/api/routines',{botId:made[1].id,name:'Monday watch list',cronExpr:'0 8 * * 1',instructionMd:'Rank the portfolio by risk and post a linked watch list. Do not contact customers.'});
// a real turn so the thread has messages + a tool card
const fs=await import('node:fs'); const path=await import('node:path');
const d=process.env.ANTBOT_HOME+'/workspace/projects'; fs.mkdirSync(d,{recursive:true});
fs.writeFileSync(path.join(d,'q3.md'),'# Q3\n- Ship date: Oct 1\n- Owner: Dana\n- Risk: pricing tier undecided\n');
await j('POST',`/api/threads/${made[0].threadId}/messages`,{contentMd:'Read projects/q3.md and summarize it in two bullets, then name the owner.'});
console.log('SCOUT_THREAD='+made[0].threadId);
console.log('GROUP_THREAD='+grp.id);
