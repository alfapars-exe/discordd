// Real Go call authorization + two isolated Chromium peers, synthetic devices only.
const {chromium}=require('playwright');
const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
(async()=>{
 const local=path.resolve(__dirname,'../.local');
 const qa=JSON.parse(await fs.readFile(path.join(local,'qa.json'),'utf8'));
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--autoplay-policy=no-user-gesture-required']});
 const contexts=[];
 try {
  const pages=[];
  for(const account of [qa,qa.peer]) {
   const context=await browser.newContext({viewport:{width:1200,height:900},permissions:['camera','microphone']});contexts.push(context);
   await context.addInitScript(()=>{
    window.__qaPeers=[];
    const originalMedia=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia=async constraints=>{
     const stream=await originalMedia(constraints);
     if(constraints.audio){
      for(const track of stream.getAudioTracks()){stream.removeTrack(track);track.stop();}
      const audio=new AudioContext();const tone=audio.createOscillator();const gain=audio.createGain();const output=audio.createMediaStreamDestination();
      tone.frequency.value=523.25;gain.gain.value=0.08;tone.connect(gain).connect(output);tone.start();await audio.resume();
      const track=output.stream.getAudioTracks()[0],stop=track.stop.bind(track);track.stop=()=>{stop();tone.stop();void audio.close();};stream.addTrack(track);
     }return stream;
    };
    const Original=window.RTCPeerConnection;
    window.RTCPeerConnection=new Proxy(Original,{construct(target,args){const pc=new target(...args);window.__qaPeers.push(pc);return pc;}});
   });
   const page=await context.newPage();pages.push(page);
   page.on('pageerror',e=>console.log('page error: '+e.message)); page.on('response',r=>{if(r.url().endsWith('/api/auth/login'))console.log('login HTTP '+r.status());});
   await page.goto('http://127.0.0.1:18080');
   const fields=page.locator('input');await fields.first().waitFor({timeout:60000});
   await fields.nth(0).click();await fields.nth(0).fill('http://127.0.0.1:18080');await fields.nth(1).click();await fields.nth(1).pressSequentially(account.username);await fields.nth(2).click();await fields.nth(2).pressSequentially(account.password);
   await page.getByRole('button',{name:'Giriş yap',exact:true}).click();await page.getByRole('button',{name:'Çıkış yap'}).waitFor({timeout:30000});
   await page.getByRole('tab',{name:'Doğrudan ara',exact:true}).click();
   await page.getByRole('button',{name:'Aramalara bağlan',exact:true}).click();
   await page.getByRole('button',{name:'Görüntülü ara',exact:true}).waitFor();
  }
  await pages[0].locator('input').click();await pages[0].locator('input').pressSequentially(qa.peer.userId);
  await pages[0].getByRole('button',{name:'Görüntülü ara',exact:true}).click();
  await pages[1].getByRole('button',{name:'Yanıtla',exact:true}).waitFor({timeout:15000});
  // No tracks may be captured while merely ringing.
  assert.equal(await pages[1].evaluate(()=>window.__qaPeers.length),0);
  await pages[1].getByRole('button',{name:'Yanıtla',exact:true}).click();
  const stats=[];
  for(const page of pages) {
   let sample;
   for(let attempt=0;attempt<180;attempt++) {
    sample=await page.evaluate(async()=>{
     const pc=window.__qaPeers[0];if(!pc)return {state:'absent'};
     const reports=await pc.getStats();const all=Array.from(reports.values());
     return {state:pc.connectionState,videoFrames:all.filter(s=>s.type==='inbound-rtp'&&s.kind==='video').reduce((n,s)=>n+(s.framesDecoded||0),0),audioEnergy:all.filter(s=>s.type==='inbound-rtp'&&s.kind==='audio').reduce((n,s)=>n+(s.totalAudioEnergy||0),0),dtlsConnected:all.some(s=>s.type==='transport'&&s.dtlsState==='connected')};
    });
    if(sample.state==='connected'&&sample.videoFrames>10&&sample.audioEnergy>0&&sample.dtlsConnected)break;
    await page.waitForTimeout(250);
   }
   assert.equal(sample.state,'connected',JSON.stringify(sample));assert.ok(sample.videoFrames>10,JSON.stringify(sample));assert.ok(sample.audioEnergy>0,JSON.stringify(sample));assert.ok(sample.dtlsConnected);
   stats.push(sample);
  }
  await pages[0].getByRole('button',{name:'Aramayı bitir',exact:true}).click();
  for(const page of pages) await page.waitForFunction(()=>window.__qaPeers.every(pc=>pc.connectionState==='closed'),null,{timeout:15000});
  const receipt={date:new Date().toISOString(),server:'isolated-existing-go',platform:'two Chromium contexts',physicalDevices:false,syntheticDevices:true,ringingDidNotCapture:true,peers:stats,hangupClosedBothPeers:true};
  await fs.writeFile(path.join(local,'p2p-receipt.json'),JSON.stringify(receipt,null,2)+'\n');
  console.log(JSON.stringify(receipt));
 }catch(e){for(const [i,c] of contexts.entries()){const p=c.pages()[0];if(p){await p.screenshot({path:path.join(local,'p2p-failure-'+i+'.png')});console.log((await p.locator('body').innerText()).slice(-1500));}}throw e;}finally{for(const c of contexts)await c.close();await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
