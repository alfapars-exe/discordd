// Run with NODE_PATH pointing at the installed Playwright package. Synthetic/local only.
const {chromium,devices}=require('playwright');
const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
(async()=>{
  const local=path.resolve(__dirname,'../.local');
  const qa=JSON.parse(await fs.readFile(path.join(local,'qa.json'),'utf8'));
  const browser=await chromium.launch({executablePath:process.env.HICHAT_CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});
  const results=[];
  try{
    for(const [name,width,device] of [['desktop',1280,null],['android-chrome-emulated',390,'Pixel 7'],['ios-ua-chromium-emulated',320,'iPhone SE']]){
      const context=await browser.newContext({...device?devices[device]:{},viewport:{width,height:900},permissions:['microphone','camera']});
      const page=await context.newPage();const failures=[];
      page.on('pageerror',e=>failures.push(e.message));
      page.on('console',m=>{if(m.text().startsWith('history_restore_failure:'))console.log(m.text())});
      try{
        await page.goto('http://127.0.0.1:18080');
        await page.locator('input').first().waitFor({timeout:60000});
        const fields=page.locator('input');
        await fields.nth(0).fill('http://127.0.0.1:18080');
        await fields.nth(1).fill(qa.username);await fields.nth(2).fill(qa.password);
        await page.getByRole('button',{name:'Giriş yap',exact:true}).click();
        await page.getByRole('button',{name:'Çıkış yap'}).waitFor({timeout:30000});
        await page.getByRole('tab',{name:'Geçmiş',exact:true}).click();
        const downloaded = page.waitForResponse(r => r.url().endsWith('/api/e2ee/key-backup'));
        await page.getByRole('button',{name:'Hesabımdaki şifreli yedeği al'}).click();
        await downloaded;
        await page.locator('textarea').waitFor();
        await page.waitForFunction(() => Array.from(document.querySelectorAll('textarea')).some(e => !e.disabled));
        await page.locator('textarea').click();
        await page.waitForFunction(() => Array.from(document.querySelectorAll('textarea')).some(e => e.value.includes('encrypted_data')));
        await page.locator('input[type=password]').fill(qa.recovery);
        await page.getByRole('button',{name:'Geçmişi aç ve şifreli yedeği sakla'}).click();
        await page.getByText('1 geçmiş mesajı',{exact:true}).waitFor({timeout:60000});
        await page.mouse.wheel(0,600);
        await page.getByText('Geçmiş mesaj: şğıöçü 👋',{exact:false}).waitFor({timeout:10000});
        await page.screenshot({path:path.join(local,`browser-${name}.png`)});
        await page.getByRole('button',{name:'Çıkış yap'}).click();
        await page.getByText('HiChat’e giriş',{exact:true}).waitFor();
        assert.equal(await page.getByText('Geçmiş mesaj: şğıöçü 👋',{exact:false}).count(),0);
        assert.deepEqual(failures,[]);
        results.push({name,engine:'Chromium',login:true,historyWebCryptoRust:true,logoutClearsHistory:true,physicalDevice:false});
      }catch(error){
        await page.screenshot({path:path.join(local,`browser-${name}-failure.png`)});
        console.error(name,error.message);console.error((await page.locator('body').innerText()).slice(0,1800));throw error;
      }finally{await context.close();}
    }
  }finally{await browser.close();}
  await fs.writeFile(path.join(local,'browser-results.json'),JSON.stringify(results,null,2));
  console.log(JSON.stringify(results));
})().catch(()=>{process.exitCode=1;});
