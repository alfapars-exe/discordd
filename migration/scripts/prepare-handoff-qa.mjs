// Disposable loopback account only; never read production credentials or stores.
import {randomBytes} from 'node:crypto';
import {writeFile,unlink} from 'node:fs/promises';
const local=new URL('../.local/',import.meta.url),username='handoff'+Date.now();
const qa={username,password:'Aa1!'+randomBytes(32).toString('base64url'),email:username+'@example.invalid'};
const response=await fetch('http://127.0.0.1:19090/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(qa)});
const result=await response.json();if(!result.success)throw Error('LOCAL_FIXTURE_REGISTER_FAILED: '+result.code+' '+result.error);
await writeFile(new URL('handoff-qa.json',local),JSON.stringify({...qa,userId:result.data.user.id}));
for(const name of ['handoff-native-intent.json','handoff-native-capsule.json'])await unlink(new URL(name,local)).catch(e=>{if(e.code!=='ENOENT')throw e});
console.log('Fresh disposable handoff account prepared (loopback only)');
