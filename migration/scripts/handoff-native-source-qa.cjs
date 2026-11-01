const {chromium}=require('playwright');const fs=require('node:fs/promises');const path=require('node:path');
(async()=>{
 const local=path.resolve(__dirname,'../.local'),qa=JSON.parse(await fs.readFile(path.join(local,'handoff-qa.json'),'utf8'));
 const intentFile=path.join(local,'handoff-native-intent.json');
 await fs.unlink(path.join(local,'handoff-native-capsule.json')).catch(()=>{});
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
  for(let n=0;n<240;n++){try{await fs.access(intentFile);break}catch{}await new Promise(r=>setTimeout(r,250));}
  const intent=JSON.parse(await fs.readFile(intentFile,'utf8'));
  const login=await fetch('http://127.0.0.1:19090/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:qa.username,password:qa.password})});const auth=await login.json();if(!auth.success)throw Error('LOCAL_LOGIN_FAILED');
  const page=await browser.newPage();await page.goto('http://127.0.0.1:18080/__qa/handoff-source.html');await page.waitForFunction(()=>!!globalThis.HichatSourceFixture);
  const result=await page.evaluate(({intent,token})=>globalThis.HichatSourceFixture.create(JSON.stringify(intent),token),{intent,token:auth.data.access_token});
  await fs.writeFile(path.join(local,'handoff-native-capsule.json'),result.capsule);
  delete result.capsule;await fs.writeFile(path.join(local,'handoff-native-source-receipt.json'),JSON.stringify({...result,physicalDevices:false}));console.log('Legacy source retired and encrypted capsule committed; source records preserved');
 }finally{await browser.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1});
