// Real legacy protocol and IndexedDB, restricted to the disposable loopback host.
import * as signal from '../../client/src/crypto/signalProtocol';
import * as storage from '../../client/src/crypto/keyStorage';
import {publishAuthOwnerChange,publishAuthGenerationChange} from '../../client/src/api/authSessionEvents';
import {setTokens} from '../../client/src/api/client';
import {registerDevice,fetchPreKeyBundles} from '../../client/src/api/e2ee';
import {sendEncryptedDMMessage,getDMMessages} from '../../client/src/api/dm';
import {cacheDMMessage,readDMMessageCache} from '../../client/src/crypto/dmMessageCache';
import {exportDeviceHandoff} from '../../client/src/crypto/deviceHandoff';
import type {SignalWireMessage} from '../../client/src/crypto/types';
import type {EncryptedEnvelope} from '../../client/src/types/e2ee';
import type {E2EEPayload} from '../../client/src/crypto/e2eePayload';
let device='';
function localOnly(){if(location.origin!=='http://127.0.0.1:18080')throw new Error('LOCAL_FIXTURE_ONLY');}
const fixture={
 async start(owner:string,token:string){
  localOnly();device=crypto.randomUUID();
  publishAuthOwnerChange(owner);publishAuthGenerationChange(701);setTokens(token,'',owner);
  const keys=await signal.generateAllKeys();
  await storage.saveRegistrationData({userId:owner,deviceId:device,registrationId:keys.registrationId,createdAt:Date.now()});
  const result=await registerDevice({device_id:device,display_name:'Disposable legacy chat source',identity_key:keys.identityPublicKey,signing_key:keys.signingPublicKey,signed_prekey:keys.signedPreKey.publicKey,signed_prekey_id:keys.signedPreKey.id,signed_prekey_signature:keys.signedPreKey.signature,registration_id:keys.registrationId,one_time_prekeys:keys.oneTimePreKeys.map(k=>({prekey_id:k.id,public_key:k.publicKey}))});
  if(!result.success)throw new Error('LEGACY_REGISTRATION_FAILED');
  return {device};
 },
 async send(user:string,channel:string,content:string){
  localOnly();const bundles=await fetchPreKeyBundles(user);
  if(!bundles.success||!bundles.data?.length)throw new Error('PEER_KEYS_MISSING');
  const payload:E2EEPayload={content,file_keys:[]},envelopes:EncryptedEnvelope[]=[];
  for(const b of bundles.data){
   if(!b.signing_key)throw new Error('SIGNING_KEY_MISSING');
   if(!await signal.hasSessionFor(user,b.device_id))await signal.processPreKeyBundle(user,b.device_id,{identityKey:b.identity_key,signingKey:b.signing_key,signedPrekeyId:b.signed_prekey_id,signedPrekey:b.signed_prekey,signedPrekeySignature:b.signed_prekey_signature,oneTimePrekeyId:b.one_time_prekey_id??undefined,oneTimePrekey:b.one_time_prekey??undefined,registrationId:b.registration_id});
   const wire=await signal.encryptMessage(user,b.device_id,JSON.stringify(payload));
   envelopes.push({sender_device_id:device,recipient_device_id:b.device_id,message_type:wire.type,ciphertext:JSON.stringify(wire)});
  }
  const sent=await sendEncryptedDMMessage(channel,JSON.stringify(envelopes),device,JSON.stringify({client_send_id:crypto.randomUUID()}));
  if(!sent.success||!sent.data)throw new Error('LEGACY_SEND_FAILED');
  await cacheDMMessage(sent.data,payload,()=>true);
  return {id:sent.data.id};
 },
 async read(user:string,channel:string){
  localOnly();const page=await getDMMessages(channel);
  if(!page.success||!page.data)throw new Error('LEGACY_HISTORY_FAILED');
  const msg=page.data.messages.findLast(m=>m.user_id===user);
  if(!msg?.ciphertext||!msg.sender_device_id)throw new Error('LEGACY_REPLY_MISSING');
  const cached=await readDMMessageCache(msg,()=>true);if(cached)return cached.content;
  const envelopes=JSON.parse(msg.ciphertext) as EncryptedEnvelope[],e=envelopes.find(e=>e.recipient_device_id===device);
  if(!e||e.sender_device_id!==msg.sender_device_id)throw new Error('LEGACY_ENVELOPE_MISSING');
  const plaintext=await signal.decryptMessage(user,msg.sender_device_id,JSON.parse(e.ciphertext) as SignalWireMessage);
  const payload=JSON.parse(plaintext) as E2EEPayload;await cacheDMMessage(msg,payload,()=>true);
  return payload.content;
 },
 async transfer(intent:string){
  localOnly();const capsule=await exportDeviceHandoff(intent);
  let fenced=false;try{await storage.getRegistrationData()}catch(e){fenced=(e as DOMException).name==='VersionError'}
  if(!fenced)throw new Error('LEGACY_SOURCE_NOT_FENCED');
  return {capsule,sourceFenced:fenced,device};
 }
};
Object.assign(globalThis,{HichatLegacyChatFixture:fixture});
