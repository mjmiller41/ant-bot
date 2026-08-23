import { chromium } from 'playwright';
const B='http://127.0.0.1:4780';
const br = await chromium.launch();
const ctx = await br.newContext({ viewport:{width:1440,height:900}, colorScheme:'dark' });
const p = await ctx.newPage();
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
await p.goto(B,{waitUntil:'networkidle'}); await p.waitForTimeout(2000);
await p.getByText('Scout',{exact:false}).first().click({timeout:5000}).catch(()=>{});
await p.waitForTimeout(1500);
await p.screenshot({path:'/tmp/antbot-shots/03-dark.png'});
for (const [name,label] of [['04-rules','Rules'],['05-usage','Usage'],['06-settings','Settings'],['07-workspace','Workspace'],['08-computer','Computer']]) {
  try { await p.getByRole('button',{name:label}).first().click({timeout:3000}); }
  catch { try { await p.getByText(label,{exact:true}).first().click({timeout:3000}); } catch {} }
  await p.waitForTimeout(1200);
  await p.screenshot({path:`/tmp/antbot-shots/${name}.png`});
}
console.log('ERRORS:', errs.length?errs.join('|'):'none');
await br.close();
