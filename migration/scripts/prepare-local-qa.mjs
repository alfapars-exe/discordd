import {apiPath} from './qa-http.mjs';
import {randomBytes,webcrypto} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
const base='http://127.0.0.1:19090';
const username=`rustproof${Date.now()}`;
const password=`Aa1!${randomBytes(18).toString('hex')}`;
async function api(path,body,token,method='POST'){
  const response=await fetch(base+apiPath('/api'+path),{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const result=await response.json();
  if(!response.ok||!result.success)throw Error(`${path}: ${response.status} ${result.code??result.error}`);
  return result.data;
}
const auth=await api('/auth/register',{username,password,email:`${username}@example.test`,display_name:'Rust QA'});
let servers=(await api('/servers',null,auth.access_token,'GET'))??[];
if(!servers.length){await api('/servers',{name:'Rust proof QA',host_type:'mqvi_hosted'},auth.access_token);servers=await api('/servers',null,auth.access_token,'GET');}
const groups=await api(`/servers/${servers[0].id}/channels`,null,auth.access_token,'GET');
const channels=(groups??[]).flatMap(group=>group.channels??[]);
let voice=channels.find(c=>c.type==='voice');
if(!voice)voice=await api(`/servers/${servers[0].id}/channels`,{name:'Rust proof voice',type:'voice'},auth.access_token);
await api(`/servers/${servers[0].id}`,{e2ee_enabled:true},auth.access_token,'PATCH');
const salt=new Uint8Array(32).fill(7),nonce=new Uint8Array(12).fill(3);
const recovery='test-recovery-İstanbul';
const material=await webcrypto.subtle.importKey('raw',new TextEncoder().encode(recovery),'PBKDF2',false,['deriveKey']);
const key=await webcrypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:600000,hash:'SHA-256'},material,{name:'AES-GCM',length:256},false,['encrypt']);
const contents={version:1,registration:{userId:auth.user.id,deviceId:'synthetic-old-device'},messageCache:[{messageId:'qa-history-1',channelId:'qa-channel',dmChannelId:null,content:'Geçmiş mesaj: şğıöçü 👋',timestamp:1700000000000}]};
const ciphertext=await webcrypto.subtle.encrypt({name:'AES-GCM',iv:nonce},key,new TextEncoder().encode(JSON.stringify(contents)));
const backup={version:1,algorithm:'aes-256-gcm+pbkdf2-600000',salt:Buffer.from(salt).toString('base64'),nonce:Buffer.from(nonce).toString('base64'),encrypted_data:Buffer.from(ciphertext).toString('base64')};
await api('/e2ee/key-backup',backup,auth.access_token,'PUT');
const directory=new URL('../.local/',import.meta.url);await mkdir(directory,{recursive:true});
await writeFile(new URL('qa.json',directory),JSON.stringify({username,password,recovery,userId:auth.user.id,serverId:servers[0].id,serverName:servers[0].name,voiceChannelId:voice?.id,voiceChannelName:voice?.name,backup}),{mode:0o600});
console.log('Local synthetic account, server and WebCrypto history backup prepared. Credentials are in ignored .local/qa.json.');
