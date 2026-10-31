// Execute the existing TypeScript implementation with in-memory storage and
// synthetic keys. No production store, user account or browser profile is read.
import {readFile,writeFile,access} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {webcrypto,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {resolve,sep} from 'node:path';
const root=new URL('../../',import.meta.url);
const source=await readFile(new URL('client/src/crypto/signalProtocol.ts',root),'utf8');
const types=await readFile(new URL('client/src/crypto/types.ts',root),'utf8');
const moduleFlag=process.argv.indexOf('--node-modules');
let noble=moduleFlag>=0?pathToFileURL(resolve(process.argv[moduleFlag+1])+sep):new URL('client/node_modules/',root);
if(moduleFlag<0){try{await access(new URL('@noble/curves/ed25519.js',noble))}catch{noble=new URL('../../../discordd/client/node_modules/',import.meta.url)}}
const typesSha256=createHash('sha256').update(types.replaceAll('\r\n','\n')).digest('hex');
const data=s=>'data:text/javascript;base64,'+Buffer.from(s).toString('base64');
const storage=new Map(),metadata=new Map();
globalThis.__qaStorage={
 async getSenderKey(){return structuredClone(globalThis.__qaSenderKey)},async saveSenderKey(k){globalThis.__qaSenderKey=structuredClone(k)},
 async getSession(u,d){return structuredClone(storage.get(u+':'+d)??null)},
 async saveSession(s){storage.set(s.userId+':'+s.deviceId,structuredClone(s))},
 async getMetadata(k){return metadata.get(k)??null},async setMetadata(k,v){metadata.set(k,v)},
 async getIdentityKeyPair(){return globalThis.__qaIdentity},async getRegistrationData(){return {registrationId:44}},
 async getTrustedIdentity(){return null},async saveTrustedIdentity(){},
 async getSignedPreKey(){return globalThis.__qaSigned},async getPreKey(){return globalThis.__qaOTP},
};
let program=stripTypeScriptTypes(source);
program=program.replaceAll('"@noble/curves/ed25519.js"',JSON.stringify(new URL('@noble/curves/ed25519.js',noble).href))
 .replaceAll('"@noble/hashes/hkdf.js"',JSON.stringify(new URL('@noble/hashes/hkdf.js',noble).href))
 .replaceAll('"@noble/hashes/sha2.js"',JSON.stringify(new URL('@noble/hashes/sha2.js',noble).href))
 .replaceAll('"@noble/hashes/hmac.js"',JSON.stringify(new URL('@noble/hashes/hmac.js',noble).href))
 .replaceAll('"../api/authSessionEvents"',JSON.stringify(data('export function getAuthSessionSnapshot(){return {ownerId:null,generation:1}}')))
 .replaceAll('"./keyStorage"',JSON.stringify(data('export const {getSenderKey,saveSenderKey,getSession,saveSession,getMetadata,setMetadata,getIdentityKeyPair,getRegistrationData,getTrustedIdentity,saveTrustedIdentity,getSignedPreKey,getPreKey}=globalThis.__qaStorage;')))
 .replaceAll('"./types"',JSON.stringify(data(stripTypeScriptTypes(types))));
const js=await import(data(program));
const {x25519,ed25519}=await import(new URL('@noble/curves/ed25519.js',noble));
const {hkdf}=await import(new URL('@noble/hashes/hkdf.js',noble));
const {sha256}=await import(new URL('@noble/hashes/sha2.js',noble));
const bytes=n=>new Uint8Array(32).fill(n),pair=n=>({privateKey:bytes(n),publicKey:x25519.getPublicKey(bytes(n))});
const A=pair(1),B=pair(2);
let alice={rootKey:bytes(3),sendingChainKey:bytes(4),receivingChainKey:bytes(5),sendingRatchetKeyPair:A,receivingRatchetKey:B.publicKey,sendMessageNumber:0,receiveMessageNumber:0,previousSendChainLength:0,skippedMessageKeys:[]};
let bob={...structuredClone(alice),sendingChainKey:bytes(5),receivingChainKey:bytes(4),sendingRatchetKeyPair:B,receivingRatchetKey:A.publicKey};
const encode=v=>v instanceof Uint8Array?{__b64:Buffer.from(v).toString('base64')}:Array.isArray(v)?v.map(encode):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,val])=>[k,encode(val)])):v;
const cases=[];
async function encrypt(state,plaintext){
 const before=structuredClone(state);storage.set('peer:device',{userId:'peer',deviceId:'device',state:structuredClone(state),createdAt:0,updatedAt:0});
 const wire=await js.encryptMessage('peer','device',plaintext);const after=storage.get('peer:device').state;
 cases.push({operation:'encrypt',state:encode(before),next:encode(after),plaintext,wire});return {state:after,wire};
}
async function decrypt(state,wire){
 const before=structuredClone(state);storage.set('peer:device',{userId:'peer',deviceId:'device',state:structuredClone(state),createdAt:0,updatedAt:0});
 const plaintext=await js.decryptMessage('peer','device',wire);const after=storage.get('peer:device').state;
 cases.push({operation:'decrypt',state:encode(before),next:encode(after),plaintext,wire});return after;
}
const messages=[];
for(const plain of ['İlk mesaj 👋','İkinci: şğıöçü','Üçüncü — out of order']){const r=await encrypt(alice,plain);alice=r.state;messages.push(r.wire)}
for(const index of [2,0,1])bob=await decrypt(bob,messages[index]);
// An independently initiated DH turn, then let the original implementation
// generate the following fresh ratchet keys itself.
const fresh=pair(7),derived=hkdf(sha256,x25519.getSharedSecret(fresh.privateKey,A.publicKey),bob.rootKey,new TextEncoder().encode('mqvi-e2ee-rk'),64);
bob.rootKey=derived.slice(0,32);bob.sendingChainKey=derived.slice(32);bob.sendingRatchetKeyPair=fresh;bob.previousSendChainLength=bob.sendMessageNumber;bob.sendMessageNumber=0;
const turn=await encrypt(bob,'DH turn from Bob');bob=turn.state;alice=await decrypt(alice,turn.wire);
const response=await encrypt(alice,'DH turn reply from Alice');alice=response.state;bob=await decrypt(bob,response.wire);
// Exercise the original X3DH entry points, both 3-DH and 4-DH.
const x3dhCases=[];
for(const withOTP of [false,true]) {
 const identity=pair(10),receiver=pair(11),signed=pair(12),otp=pair(13),seed=bytes(14);
 const bundle={identityKey:Buffer.from(receiver.publicKey).toString('base64'),signingKey:Buffer.from(ed25519.getPublicKey(seed)).toString('base64'),signedPrekeyId:77,signedPrekey:Buffer.from(signed.publicKey).toString('base64'),signedPrekeySignature:Buffer.from(ed25519.sign(signed.publicKey,seed)).toString('base64'),registrationId:55,...withOTP?{oneTimePrekeyId:88,oneTimePrekey:Buffer.from(otp.publicKey).toString('base64')}:{} };
 globalThis.__qaIdentity=identity;
 await js.processPreKeyBundle('peer','device',bundle);
 const next=storage.get('peer:device').state,info=metadata.get('prekey_info:peer:device');
 x3dhCases.push({operation:'initiate',identity:encode(identity),registrationId:44,bundle,next:encode(next),prekeyInfo:info});
 globalThis.__qaIdentity=receiver;globalThis.__qaSigned={...signed,id:77};globalThis.__qaOTP=withOTP?{...otp,id:88}:null;
 const received=await js.processPreKeyMessage('peer','device',info);
 x3dhCases.push({operation:'receive',identity:encode(receiver),signed:encode(signed),otp:withOTP?encode(otp):null,prekeyInfo:info,next:encode(received)});
  globalThis.__qaIdentity=identity;storage.set('peer:device',{userId:'peer',deviceId:'device',state:structuredClone(next),createdAt:0,updatedAt:0});metadata.set('prekey_info:peer:device',info);
 const plaintext='İlk X3DH mesajı 👋',wire=await js.encryptMessage('peer','device',plaintext);
 x3dhCases.push({operation:'seal',identity:encode(identity),registrationId:44,bundle,plaintext,wire,next:encode(storage.get('peer:device').state)});
 globalThis.__qaIdentity=receiver;
 const opened=await js.decryptMessage('peer','device',wire);
 x3dhCases.push({operation:'open',identity:encode(receiver),signed:encode(signed),otp:withOTP?encode(otp):null,plaintext:opened,wire,next:encode(storage.get('peer:device').state)});
 metadata.clear();
}
// Historical JSON-AAD message made with WebCrypto, then read by the reference.
const decode=v=>v&&typeof v==='object'&&'__b64' in v?new Uint8Array(Buffer.from(v.__b64,'base64')):Array.isArray(v)?v.map(decode):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,val])=>[k,decode(val)])):v;
const legacyState=decode(cases[3].state),legacyHeader={ratchetKey:Buffer.from(A.publicKey).toString('base64'),previousChainLength:0,messageNumber:0};
const {hmac}=await import(new URL('@noble/hashes/hmac.js',noble));
const legacyKey=hmac(sha256,legacyState.receivingChainKey,new Uint8Array([1]));
const nonce=new Uint8Array(12).fill(9),legacyPlaintext='Eski JSON AAD mesajı';
const aesKey=await webcrypto.subtle.importKey('raw',legacyKey,'AES-GCM',false,['encrypt']);
const encrypted=new Uint8Array(await webcrypto.subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:new TextEncoder().encode(JSON.stringify(legacyHeader))},aesKey,new TextEncoder().encode(legacyPlaintext)));
await decrypt(legacyState,{type:2,header:legacyHeader,ciphertext:Buffer.concat([nonce,encrypted]).toString('base64')});
const senderSource=await readFile(new URL('client/src/crypto/senderKeyProtocol.ts',root),'utf8');
let senderProgram=stripTypeScriptTypes(senderSource);
for(const module of ['curves/ed25519','hashes/hmac','hashes/sha2','hashes/utils'])senderProgram=senderProgram.replaceAll(JSON.stringify('@noble/'+module+'.js'),JSON.stringify(new URL('@noble/'+module+'.js',noble).href));
senderProgram=senderProgram.replaceAll('"../api/authSessionEvents"',JSON.stringify(data('export function getAuthSessionSnapshot(){return {ownerId:null,generation:1}}')))
 .replaceAll('"./keyStorage"',JSON.stringify(data('export const {getSenderKey,saveSenderKey,getMetadata,setMetadata}=globalThis.__qaStorage;')))
 .replaceAll('"./signalProtocol"',JSON.stringify(data(program)))
 .replaceAll('"./types"',JSON.stringify(data(stripTypeScriptTypes(types))));
const sk=await import(data(senderProgram));
const senderCases=[],seed=bytes(21),initial={channelId:'channel',senderUserId:'owner',senderDeviceId:'device',distributionId:'11111111111111111111111111111111',chainKey:bytes(22),initialChainKey:bytes(22),publicSigningKey:ed25519.getPublicKey(seed),iteration:0,createdAt:Date.now(),protocolVersion:2,recipientFingerprint:'1'.repeat(64),seenIterations:[],replayFloor:0};
let outbound=structuredClone(initial),inbound=structuredClone(initial);const groupMessages=[];
metadata.set('sk_signing:channel:owner:device',seed);
for(const plaintext of ['Kanal mesajı 👋','İkinci grup mesajı','Üçüncü sırasız mesaj']){
 globalThis.__qaSenderKey=structuredClone(outbound);const wire=await sk.encryptGroupMessage('channel','owner','device',plaintext);
 senderCases.push({operation:'encrypt',state:encode(outbound),next:encode(globalThis.__qaSenderKey),plaintext,seed:encode(seed),wire});outbound=structuredClone(globalThis.__qaSenderKey);groupMessages.push(wire);
}
inbound.protocolVersion=1; // Receive compatibility must not force a v1 rotation.
for(const index of [2,0,1]){
 globalThis.__qaSenderKey=structuredClone(inbound);const plaintext=await sk.decryptGroupMessage('channel','owner','device',groupMessages[index]);
 senderCases.push({operation:'decrypt',state:encode(inbound),next:encode(globalThis.__qaSenderKey),plaintext,wire:groupMessages[index]});inbound=structuredClone(globalThis.__qaSenderKey);
}
await writeFile(new URL('../crates/protocol/fixtures/sender-key.json',import.meta.url),JSON.stringify({typesSha256,sourceSha256:createHash('sha256').update(senderSource.replaceAll('\r\n','\n')).digest('hex'),cases:senderCases},null,2)+'\n');
await writeFile(new URL('../crates/protocol/fixtures/x3dh.json',import.meta.url),JSON.stringify({typesSha256,sourceSha256:createHash('sha256').update(source.replaceAll('\r\n','\n')).digest('hex'),cases:x3dhCases},null,2)+'\n');
await writeFile(new URL('../crates/protocol/fixtures/ratchet.json',import.meta.url),JSON.stringify({typesSha256,sourceSha256:createHash('sha256').update(source.replaceAll('\r\n','\n')).digest('hex'),cases},null,2)+'\n');
console.log(`Generated ${cases.length} synthetic cases by executing the existing TypeScript ratchet`);
