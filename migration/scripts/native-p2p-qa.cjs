const {chromium}=require('playwright');const fs=require('node:fs/promises');const path=require('node:path');
(async()=>{
 const local=path.resolve(__dirname,'../.local'),qa=JSON.parse(await fs.readFile(path.join(local,'qa.json'),'utf8'));
 for(const n of ['native-p2p-ready','native-p2p-stop','native-p2p-browser.json','native-p2p-receipt.json'])await fs.unlink(path.join(local,n)).catch(()=>{});
 const options={executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--autoplay-policy=no-user-gesture-required','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']};
 const sourceBrowser=await chromium.launch({...options,headless:false});const browser=await chromium.launch({...options,headless:true});
 try{
  const source=await sourceBrowser.newPage();await source.setContent('<title>HiChat Synthetic P2P QA</title><body style="background:#224;color:white;font:30px sans-serif">Owned synthetic P2P video and tone source <span id="tick"></span><script>setInterval(()=>document.querySelector("#tick").textContent=Date.now(),100)</script>');
  await source.evaluate(async()=>{const a=new AudioContext(),o=a.createOscillator(),g=a.createGain();o.frequency.value=523.25;g.gain.value=0.04;o.connect(g).connect(a.destination);o.start();await a.resume();window.qaAudio=a;});
  const context=await browser.newContext({viewport:{width:1200,height:900},permissions:['camera','microphone']});
  await context.addInitScript(()=>{
   window.qaPeers=[];const C=window.RTCPeerConnection;window.RTCPeerConnection=new Proxy(C,{construct(t,args){const pc=new t(...args);window.qaPeers.push(pc);return pc;}});
   const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
   navigator.mediaDevices.getUserMedia=async constraints=>{
    const stream=await original(constraints);
    if(constraints.audio){for(const t of stream.getAudioTracks()){stream.removeTrack(t);t.stop();}const a=new AudioContext(),o=a.createOscillator(),g=a.createGain(),d=a.createMediaStreamDestination();o.frequency.value=440;g.gain.value=0.08;o.connect(g).connect(d);o.start();await a.resume();stream.addTrack(d.stream.getAudioTracks()[0]);}return stream;
   };
  });
  const page=await context.newPage();await page.goto('http://127.0.0.1:18080');const fields=page.locator('input');await fields.first().waitFor({timeout:60000});
  await fields.nth(0).click();await fields.nth(0).fill('http://127.0.0.1:18080');await fields.nth(1).click();await fields.nth(1).pressSequentially(qa.peer.username);await fields.nth(2).click();await fields.nth(2).pressSequentially(qa.peer.password);
  await page.getByRole('button',{name:'Giriş yap',exact:true}).click();await page.getByRole('tab',{name:'Doğrudan ara',exact:true}).click();await page.getByRole('button',{name:'Aramalara bağlan',exact:true}).click();await page.getByRole('button',{name:'Görüntülü ara',exact:true}).waitFor();
  await fs.writeFile(path.join(local,'native-p2p-ready'),'ready');console.log('Native P2P synthetic source and browser callee ready');
  await page.getByRole('button',{name:'Yanıtla',exact:true}).waitFor({timeout:180000});await page.getByRole('button',{name:'Yanıtla',exact:true}).click();await source.bringToFront();
  let result;
  for(let i=0;i<180;i++){
   result=await page.evaluate(async()=>{const pc=window.qaPeers[0];if(!pc)return {};const stats=Array.from((await pc.getStats()).values());return {state:pc.connectionState,frames:stats.filter(s=>s.type==='inbound-rtp'&&s.kind==='video').reduce((n,s)=>n+(s.framesDecoded||0),0),audioEnergy:stats.filter(s=>s.type==='inbound-rtp'&&s.kind==='audio').reduce((n,s)=>n+(s.totalAudioEnergy||0),0),dtlsConnected:stats.some(s=>s.type==='transport'&&s.dtlsState==='connected')};});
   if(i===20)console.log('browser progress '+JSON.stringify(result));if(result.audioEnergy>0&&result.dtlsConnected){await fs.writeFile(path.join(local,'native-p2p-browser.json'),JSON.stringify(result));console.log(JSON.stringify(result));break;}await page.waitForTimeout(250);
  }
  if(!(result.audioEnergy>0&&result.dtlsConnected))throw Error(JSON.stringify(result));
  for(let i=0;i<120;i++){try{await fs.access(path.join(local,'native-p2p-stop'));break;}catch{}await page.waitForTimeout(250);}
 }finally{await browser.close();await sourceBrowser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
