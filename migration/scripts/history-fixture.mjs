// Synthetic WebCrypto reference, same AES-GCM/PBKDF2 wire format as keyBackup.ts.
import {webcrypto} from 'node:crypto';
import {writeFile, mkdir} from 'node:fs/promises';
const salt = new Uint8Array(32).fill(7);
const nonce = new Uint8Array(12).fill(3);
const password = new TextEncoder().encode('test-recovery-İstanbul');
const material = await webcrypto.subtle.importKey('raw', password, 'PBKDF2', false, ['deriveKey']);
const key = await webcrypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:600000,hash:'SHA-256'}, material, {name:'AES-GCM',length:256}, false, ['encrypt']);
const payload = {version:1,registration:{userId:'fixture-user',deviceId:'old-device',registrationId:1},identity:{privateKey:'synthetic-private-material'},messageCache:[{messageId:'message-1',channelId:'channel-1',dmChannelId:null,content:'Geçmiş mesaj: şğıöçü 👋',timestamp:1700000000000}]};
const ciphertext = await webcrypto.subtle.encrypt({name:'AES-GCM',iv:nonce},key,new TextEncoder().encode(JSON.stringify(payload)));
const fixture = {version:1,algorithm:'aes-256-gcm+pbkdf2-600000',salt:Buffer.from(salt).toString('base64'),nonce:Buffer.from(nonce).toString('base64'),encrypted_data:Buffer.from(ciphertext).toString('base64')};
const target = new URL('../crates/protocol/fixtures/',import.meta.url);
await mkdir(target,{recursive:true});
await writeFile(new URL('history-backup.json',target), JSON.stringify(fixture,null,2)+'\n');
for (const [iterations, algorithm, filename] of [[1000000,'aes-256-gcm','history-legacy.json'],[2000000,'aes-256-gcm+pbkdf2-2000000','history-current.json']]) {
  const nextKey=await webcrypto.subtle.deriveKey({name:'PBKDF2',salt,iterations,hash:'SHA-256'},material,{name:'AES-GCM',length:256},false,['encrypt']);
  const encrypted=await webcrypto.subtle.encrypt({name:'AES-GCM',iv:nonce},nextKey,new TextEncoder().encode(JSON.stringify(payload)));
  await writeFile(new URL(filename,target),JSON.stringify({...fixture,algorithm,encrypted_data:Buffer.from(encrypted).toString('base64')},null,2)+'\n');
}
