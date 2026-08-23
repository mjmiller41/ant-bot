import { chromium } from 'playwright';
const B='http://127.0.0.1:4780';
const br = await chromium.launch();
const ctx = await br.newContext({ viewport:{width:1440,height:900}, deviceScaleFactor:1 });
const p = await ctx.newPage();
const errs=[];
p.on('console', m=>{ if(m.type()==='error') errs.push(m.text()); });
p.on('pageerror', e=>errs.push('PAGEERROR: '+e.message));

await p.goto(B, { waitUntil:'networkidle' });
await p.waitForTimeout(2500);
await p.screenshot({ path:'/tmp/antbot-shots/01-main.png', fullPage:false });
console.log('TITLE:', await p.title());
console.log('BODY_TEXT_SAMPLE:', (await p.locator('body').innerText()).slice(0,600).replace(/\n+/g,' | '));

// click the first bot in the sidebar
const rows = p.locator('aside button, aside [role=button], nav button');
console.log('sidebar clickable count:', await rows.count());
try {
  await p.getByText('Scout', { exact:false }).first().click({ timeout:5000 });
  await p.waitForTimeout(2000);
  await p.screenshot({ path:'/tmp/antbot-shots/02-thread.png' });
} catch(e){ console.log('thread click failed:', e.message.slice(0,120)); }

console.log('CONSOLE_ERRORS:', errs.length ? errs.slice(0,8).join(' || ') : 'none');
await br.close();
