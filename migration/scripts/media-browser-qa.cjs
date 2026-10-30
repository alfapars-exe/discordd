const {chromium}=require('playwright');
const fs=require('node:fs/promises');
const path=require('node:path');
(async()=>{
const local=path.resolve(__dirname,'../.local'),qa=JSON.parse(await fs.readFile(path.join(local,'qa.json'),'utf8'));
for(const name of ['media-peer-stop','media-peer-ready.json']){await fs.unlink(path.join(local,name)).catch(()=>{});}
const testScreen=process.env.HICHAT_TEST_SCREEN==='1';
const browser=await chromium.launch({executablePath:process.env.HICHAT_CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream',...(testScreen?['--auto-select-tab-capture-source-by-title=HiChat QA Source']:[])]});
try{
const context=await browser.newContext({permissions:['microphone','camera'],viewport:{width:1280,height:900}});
if(testScreen){const source=await context.newPage();await source.setContent('<title>HiChat QA Source</title><body style="background:#223;color:white;font:40px sans-serif">Synthetic screen share source <span id="tick"></span><script>setInterval(()=>document.querySelector("#tick").textContent=Date.now(),100)</script>');}
const page=await context.newPage();page.on('pageerror',e=>console.error('PAGEERROR',e.message));
await page.goto('http://127.0.0.1:18080');await page.locator('input').first().waitFor({timeout:60000});
const fields=page.locator('input');await fields.nth(0).fill('http://127.0.0.1:18080');await fields.nth(1).fill(qa.peer.username);await fields.nth(2).fill(qa.peer.password);
await page.getByRole('button',{name:'Giriş yap',exact:true}).click();await page.getByRole('button',{name:'Sunucu',exact:true}).click();
await page.getByRole('menuitem',{name:qa.serverName||'Rust proof QA',exact:true}).click();await page.getByRole('button',{name:'Ses kanalı',exact:true}).click();
await page.getByRole('menuitem',{name:qa.voiceChannelName||'Rust proof voice',exact:true}).click();await page.getByRole('button',{name:'Şifreli odaya katıl',exact:true}).click();
await page.getByText(/connected •/).waitFor({timeout:30000}).catch(async e=>{console.error((await page.locator('body').innerText()).slice(0,1800));await page.screenshot({path:path.join(local,'browser-media-failure.png')});throw e;});
await page.getByRole('button',{name:'Kamerayı aç',exact:true}).click();
await page.getByRole('button',{name:'Kamerayı kapat',exact:true}).waitFor({timeout:20000});
await page.getByRole('button',{name:'Mikrofonu aç',exact:true}).click();
await page.getByRole('button',{name:'Mikrofonu kapat',exact:true}).waitFor({timeout:20000});
if(testScreen){await page.getByRole('button',{name:'Ekranı paylaş',exact:true}).click();await page.getByRole('button',{name:'Paylaşımı durdur',exact:true}).waitFor({timeout:30000});}
await fs.writeFile(path.join(local,'media-peer-ready.json'),JSON.stringify({publisher:'Chrome fake camera/microphone',encrypted:true,screenPublished:testScreen,physicalDevices:false}));
console.log('Synthetic encrypted browser publisher ready');
for(let i=0;i<180;i++){try{await fs.access(path.join(local,'media-peer-stop'));break;}catch{}await page.waitForTimeout(1000);}
await page.getByRole('button',{name:'Ayrıl',exact:true}).click();
await page.screenshot({path:path.join(local,'browser-media.png')});
}finally{await browser.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
