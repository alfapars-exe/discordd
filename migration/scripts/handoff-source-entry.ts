// Local disposable acceptance harness: invokes the real legacy exporter and API.
import {x25519,ed25519} from '@noble/curves/ed25519.js';
import {openDB} from 'idb';
import * as storage from '../../client/src/crypto/keyStorage';
import {savePendingGroupSend} from '../../client/src/crypto/pendingGroupSendStorage';
import {publishAuthOwnerChange,publishAuthGenerationChange} from '../../client/src/api/authSessionEvents';
import {setTokens} from '../../client/src/api/client';
import {registerDevice} from '../../client/src/api/e2ee';
import {exportDeviceHandoff} from '../../client/src/crypto/deviceHandoff';
import fixture from '../crates/protocol/fixtures/ratchet.json';
const decode=(v:any):any=>v&&typeof v==='object'&&'__b64' in v?Uint8Array.from(atob(v.__b64),(c:string)=>c.charCodeAt(0)):Array.isArray(v)?v.map(decode):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,val])=>[k,decode(val)])):v;
const b64=(a:Uint8Array)=>btoa(String.fromCharCode(...a));
async function receipt(capsule:string,owner:string,backend:string){
 let fenced=false;try{await storage.getRegistrationData()}catch(e){fenced=(e as DOMException).name==='VersionError'}
 const db=await openDB(await storage.getAccountDatabaseName(owner,backend),2),marker=await db.get('metadata','device-handoff:v1');
 const retired=marker.phase==='retired',preserved=!!await db.get('identity','primary'),device=(await db.get('registration','primary')).deviceId;db.close();
 if(!fenced||!retired||!preserved)throw Error('SOURCE_FENCE_FAILED');
 if(await exportDeviceHandoff(JSON.stringify(marker.intent))!==capsule)throw Error('CAPSULE_RESUME_CHANGED');
 return {capsule,sourceFenced:fenced,sourceRetired:retired,sourcePreserved:preserved,device};
}
(globalThis as any).HichatSourceFixture={
 async create(intent:string,accessToken:string){
  const target=JSON.parse(intent);if(!target.backend.startsWith('http://127.0.0.1:18080'))throw Error('LOCAL_FIXTURE_ONLY');
  const owner=target.owner,device=crypto.randomUUID();publishAuthOwnerChange(owner);publishAuthGenerationChange(500);setTokens(accessToken,'',owner);
  try{await storage.getRegistrationData()}catch(e){if((e as DOMException).name!=='VersionError')throw e;return receipt(await exportDeviceHandoff(intent),owner,target.backend)}
  const privateKey=crypto.getRandomValues(new Uint8Array(32)),publicKey=x25519.getPublicKey(privateKey),signingSeed=crypto.getRandomValues(new Uint8Array(32)),signingPub=ed25519.getPublicKey(signingSeed),prePrivate=crypto.getRandomValues(new Uint8Array(32)),prePublic=x25519.getPublicKey(prePrivate),signature=ed25519.sign(prePublic,signingSeed);
  await storage.saveIdentityKeyPair({publicKey,privateKey});await storage.saveSigningKeyPair({publicKey:signingPub,privateKey:signingSeed});await storage.saveRegistrationData({userId:owner,deviceId:device,registrationId:44,createdAt:Date.now()});
  await storage.saveSignedPreKey({id:1,publicKey:prePublic,privateKey:prePrivate,signature,createdAt:Date.now()});
  await storage.saveSession({userId:'handoff-peer',deviceId:'peer-device',state:decode(fixture.cases[0].state),createdAt:1,updatedAt:1});
  const result=await registerDevice({device_id:device,display_name:'Synthetic handoff source',identity_key:b64(publicKey),signing_key:b64(signingPub),signed_prekey:b64(prePublic),signed_prekey_id:1,signed_prekey_signature:b64(signature),registration_id:44,one_time_prekeys:[]});if(!result.success)throw Error('FIXTURE_DEVICE_REGISTRATION_FAILED');
  await storage.cacheDecryptedMessage({messageId:'fixture-history',channelId:'fixture-channel',dmChannelId:null,content:'Taşınan geçmiş: şğıöçü 👋',timestamp:1700000000000});
  await savePendingGroupSend({accountId:owner,deviceId:device,groupId:'fixture-group',id:'request-00000001',createdAt:1,content:'Bekleyen mesaj',payload:{client_request_id:'request-00000001',sender_device_id:device,ciphertext:'UNCHANGED_CIPHERTEXT',e2ee_metadata:'UNCHANGED_METADATA',key_epoch:1},files:[],encryptedFiles:[]},()=>true);
  const capsule=await exportDeviceHandoff(intent,{theme:'dark',locale:{locale:'tr'}});
  return receipt(capsule,owner,target.backend);
 }
};
