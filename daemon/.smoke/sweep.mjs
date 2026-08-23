import { chromium } from 'playwright';
const B='http://127.0.0.1:4780';
const br=await chromium.launch();
const ctx=await br.newContext({viewport:{width:1440,height:900},colorScheme:'dark'});
const p=await ctx.newPage();
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
p.on('console',m=>{if(m.type()==='error')errs.push('console: '+m.text())});
await p.goto(B,{waitUntil:'networkidle'}); await p.waitForTimeout(1500);

const views=[['Rules','20-rules'],['Usage','21-usage'],['Settings','22-settings'],['Workspace','23-workspace'],['Computer','24-computer']];
for(const [label,file] of views){
  await p.getByRole('button',{name:label}).first().click({timeout:4000}).catch(async()=>{
    await p.getByText(label,{exact:true}).first().click({timeout:4000}).catch(()=>{});
  });
  await p.waitForTimeout(1400);
  await p.screenshot({path:`/tmp/antbot-shots/${file}.png`});
  const t=await p.locator('main').innerText().catch(()=>'');
  console.log(`${label}: ${t.replace(/\n+/g,' | ').slice(0,150)}`);
}
// group chat + bot settings
await p.getByRole('button',{name:'Chats'}).first().click().catch(()=>{});
await p.waitForTimeout(600);
await p.getByText('Weekly Review').first().click().catch(()=>{});
await p.waitForTimeout(1000);
await p.screenshot({path:'/tmp/antbot-shots/25-group.png'});
await p.getByText('Account Health').first().click().catch(()=>{});
await p.waitForTimeout(800);
await p.getByText(/Bot settings/i).first().click().catch(()=>{});
await p.waitForTimeout(1200);
await p.screenshot({path:'/tmp/antbot-shots/26-botsettings.png'});
console.log('ERRORS:', errs.length?errs.slice(0,5).join(' || '):'none');
await br.close();
