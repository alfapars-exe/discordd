import {readFile,writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
const file=new URL('../.local/qa.json',import.meta.url);
const qa=JSON.parse(await readFile(file,'utf8'));
async function api(path,body,token){const r=await fetch('http://127.0.0.1:19090/api'+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)});const j=await r.json();if(!r.ok||!j.success)throw Error(`${path}: ${r.status}`);return j.data;}
const owner=await api('/auth/login',{username:qa.username,password:qa.password});
const invite=await api(`/servers/${qa.serverId}/invites`,{channel_id:qa.voiceChannelId,max_uses:1,expires_in:60},owner.access_token);
const username=`rustpeer${Date.now()}`,password=`Aa1!${randomBytes(18).toString('hex')}`;
const peer=await api('/auth/register',{username,password,email:`${username}@example.test`,display_name:'Flutter web peer'});
await api('/servers/join',{invite_code:invite.code},peer.access_token);
const friendship=await api('/friends/requests',{username},owner.access_token);
await api(`/friends/requests/${friendship.id}/accept`,{},peer.access_token);
qa.peer={username,password,userId:peer.user.id};
await writeFile(file,JSON.stringify(qa),{mode:0o600});
console.log('Synthetic media peer prepared in local-only fixture');
