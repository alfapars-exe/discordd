// Disposable loopback users only. No production endpoint override is accepted.
import {randomBytes} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {apiPath} from './qa-http.mjs';
const base='http://127.0.0.1:19090';
// Simulate a distinct documentation-range client behind the fixture's trusted
// loopback proxy; repeated fixture runs must not consume each other's quota.
const fixtureClient=`192.0.2.${1+randomBytes(1)[0]%250}`;
async function api(path,body,token,method='POST') {
  const response=await fetch(base+apiPath('/api'+path),{method,headers:{'Content-Type':'application/json','X-Forwarded-For':fixtureClient,...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const result=await response.json();
  if(!response.ok||!result.success) throw Error(`CHAT_FIXTURE_API_${response.status}_${result.code??'FAILED'}`);
  return result.data;
}
const users=[];
for(const label of ['alice','bob']) {
  const username=`chat${label}${Date.now()}`,password=`Aa1!${randomBytes(18).toString('hex')}`;
  const auth=await api('/auth/register',{username,password,email:`${username}@example.test`,display_name:`Chat QA ${label}`});
  users.push({username,password,userId:auth.user.id,token:auth.access_token});
}
const request=await api('/friends/requests',{username:users[1].username},users[0].token);
await api(`/friends/requests/${request.id}/accept`,{},users[1].token);
const channel=await api('/dms',{user_id:users[1].userId},users[0].token);
await api(`/dms/channels/${channel.id}/e2ee`,{enabled:true},users[0].token,'PATCH');
const dir=new URL('../.local/',import.meta.url);
await mkdir(dir,{recursive:true});
const output=process.argv.includes('--web-handoff')?'chat-web-handoff-qa.json':process.argv.includes('--web')?'chat-web-qa.json':process.argv.includes('--interop')?'chat-interop-qa.json':'chat-qa.json';
await writeFile(new URL(output,dir),JSON.stringify({users:users.map(({token,...u})=>u),channelId:channel.id}),{mode:0o600});
console.log('Two disposable friends and an encrypted DM prepared; credentials stay in ignored .local.');
