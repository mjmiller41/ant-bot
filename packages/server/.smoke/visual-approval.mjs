import { chromium } from 'playwright';
const B='http://127.0.0.1:4780';
const br = await chromium.launch();
const ctx = await br.newContext({ viewport:{width:1440,height:900}, colorScheme:'dark' });
const p = await ctx.newPage();
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
await p.goto(B,{waitUntil:'networkidle'}); await p.waitForTimeout(1500);
await p.getByText('Scout',{exact:false}).first().click(); await p.waitForTimeout(800);

// Ask for something that must hit a builtin require-rule.
const box = p.getByPlaceholder(/Message/i);
await box.click();
await box.fill('Run exactly this in the workspace: npm install left-pad');
await box.press('Enter');
console.log('sent; waiting for approval card...');

let found=false;
for (let i=0;i<60;i++){
  await p.waitForTimeout(2000);
  const txt = await p.locator('body').innerText();
  if (/Allow once|Always allow/i.test(txt)) { found=true; break; }
}
await p.screenshot({path:'/tmp/antbot-shots/10-approval.png'});
console.log('APPROVAL CARD VISIBLE:', found);

if (found) {
  const pending = await (await fetch(B+'/api/approvals')).json();
  console.log('pending approvals via API:', pending.length, pending[0]?.toolName, '|', pending[0]?.inputSummary?.slice(0,80));
  console.log('reason:', pending[0]?.reason);
  await p.getByRole('button',{name:/Deny/i}).first().click();
  await p.waitForTimeout(4000);
  await p.screenshot({path:'/tmp/antbot-shots/11-denied.png'});
  const after = await (await fetch(B+'/api/approvals')).json();
  console.log('pending after deny:', after.length);
}
console.log('ERRORS:', errs.length?errs.join('|'):'none');
await br.close();
