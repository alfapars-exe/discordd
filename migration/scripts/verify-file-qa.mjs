// Only the fixed disposable fixture produced by the Windows integration is read.
import {readFile} from 'node:fs/promises';
import {webcrypto,createHash} from 'node:crypto';
const input=JSON.parse(await readFile(new URL('../.local/file-verify-private.json',import.meta.url),'utf8'));
if(input.metadata.length!==2)throw new Error('FILE_COUNT_MISMATCH');
await Promise.all(input.metadata.map(async(meta,i)=>{
 const key=await webcrypto.subtle.importKey('raw',Buffer.from(meta.key,'base64'),'AES-GCM',false,['decrypt']);
 const plain=Buffer.from(await webcrypto.subtle.decrypt({name:'AES-GCM',iv:Buffer.from(meta.iv,'base64')},key,Buffer.from(input.encrypted[i],'base64')));
 if(plain.toString('utf8')!==input.expected[i] || plain.length!==meta.originalSize || createHash('sha256').update(plain).digest('hex')!==meta.digest)throw new Error('FILE_INTEGRITY_MISMATCH');
}));
console.log('Independent WebCrypto file validation passed.');
