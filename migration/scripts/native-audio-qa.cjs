const {chromium}=require('playwright');
const fs=require('node:fs/promises');const path=require('node:path');
(async()=>{
 const local=path.resolve(__dirname,'../.local'),qa=JSON.parse(await fs.readFile(path.join(local,'qa.json'),'utf8'));
 for(const name of ['native-audio-source-ready','native-audio-published','native-audio-stop','native-audio-receipt.json'])await fs.unlink(path.join(local,name)).catch(()=>{});
 const options={executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--autoplay-policy=no-user-gesture-required']};
 const sourceBrowser=await chromium.launch({...options,headless:false});
 const receiverBrowser=await chromium.launch({...options,headless:true});
 try {
  const source=await sourceBrowser.newPage();
  await source.setContent('<title>HiChat Synthetic Tone QA</title><body style="background:#224;color:white;font:30px sans-serif">HiChat synthetic tone capture. This window belongs to the local QA process.</body>');
  await source.evaluate(async()=>{const a=new AudioContext();const tone=a.createOscillator(),gain=a.createGain();gain.gain.value=0.04;tone.frequency.value=523.25;tone.connect(gain).connect(a.destination);tone.start();await a.resume();window.qaAudio=a;});
  const context=await receiverBrowser.newContext({viewport:{width:1280,height:900}});
  await context.addInitScript(()=>{window.qaPeers=[];const C=window.RTCPeerConnection;window.RTCPeerConnection=new Proxy(C,{construct(t,args){const pc=new t(...args);window.qaPeers.push(pc);return pc;}});});
  const page=await context.newPage();await page.goto('http://127.0.0.1:18080');
  const fields=page.locator('input');await fields.first().waitFor({timeout:60000});
  await fields.nth(0).click();await fields.nth(0).fill('http://127.0.0.1:18080');await fields.nth(1).click();await fields.nth(1).pressSequentially(qa.peer.username);await fields.nth(2).click();await fields.nth(2).pressSequentially(qa.peer.password);
  await page.getByRole('button',{name:'Giriş yap',exact:true}).click();await page.getByRole('button',{name:'Sunucu',exact:true}).click();
  await page.getByRole('menuitem',{name:qa.serverName,exact:true}).click();await page.getByRole('button',{name:'Ses kanalı',exact:true}).click();await page.getByRole('menuitem',{name:qa.voiceChannelName,exact:true}).click();
  await page.getByRole('button',{name:'Şifreli odaya katıl',exact:true}).click();await page.getByText(/connected •/).waitFor({timeout:30000});
  await fs.writeFile(path.join(local,'native-audio-source-ready'),'synthetic-owned-window');console.log('Owned synthetic tone window and encrypted browser receiver ready');
  for(let i=0;i<240;i++) {
   const energy=await page.evaluate(async()=>{let energy=0;for(const pc of window.qaPeers){for(const s of (await pc.getStats()).values()){if(s.type==='inbound-rtp'&&s.kind==='audio')energy+=s.totalAudioEnergy||0;}}return energy;});
   if(energy>0){const receipt={date:new Date().toISOString(),audioEnergy:energy,encryptedRoom:true,source:'owned synthetic Chrome window only',receiver:'isolated Chromium',physicalDevices:false};await fs.writeFile(path.join(local,'native-audio-receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));break;}
   await page.waitForTimeout(500);
  }
  for(let i=0;i<60;i++){try{await fs.access(path.join(local,'native-audio-stop'));break;}catch{}await page.waitForTimeout(500);}
  await page.getByRole('button',{name:'Ayrıl',exact:true}).click();
 } finally {await receiverBrowser.close();await sourceBrowser.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
