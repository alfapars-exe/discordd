import * as storage from "./keyStorage";
import type {GroupSendPayload} from "../api/groupDM";
import type {EncryptedFileMeta} from "./fileEncryption";

export type GroupFileSource={fileIndex:number;deviceId:string;id:string;sourceIndex:number};
export type PendingGroupSendSnapshot={accountId:string;deviceId:string;groupId:string;id:string;createdAt:number;content:string;payload:GroupSendPayload;replyToId?:string;files:File[];encryptedFiles:File[];fileKeys?:EncryptedFileMeta[];originRecoveryId?:string;origin?:{deviceId:string;id:string};acknowledgedIndices?:number[];fileSources?:GroupFileSource[];resultConfirmed?:true};
type FileDescriptor={name:string;type:string;size:number;lastModified:number};
type Manifest=Omit<PendingGroupSendSnapshot,"files"|"encryptedFiles">&{files:FileDescriptor[];encryptedFiles:FileDescriptor[]};
type SealedPart={iv:number[];ciphertext:ArrayBuffer};
export type PendingGroupSendEnvelope={version:1;writeToken:string;manifest:SealedPart;files:SealedPart[];encryptedFiles:SealedPart[]};
const encoder=new TextEncoder(),decoder=new TextDecoder("utf-8",{fatal:true});
const contextError=()=>new Error("pending_send_context_changed");
function current(guard:()=>boolean){if(!guard())throw contextError()}
function aad(account:string,device:string,group:string,id:string,part:string){return encoder.encode(JSON.stringify(["hichat-group-pending-v1",account,device,group,id,part]))}
function validateKey(key:CryptoKey){if(!key||key.type!=="secret"||key.extractable||key.algorithm?.name!=="AES-GCM"||(key.algorithm as AesKeyAlgorithm).length!==256||!Array.isArray(key.usages)||!key.usages.includes("encrypt")||!key.usages.includes("decrypt"))throw new Error("pending_send_invalid_key")}
function validScope(snapshot:Pick<PendingGroupSendSnapshot,"accountId"|"deviceId"|"groupId"|"id">){return [snapshot.accountId,snapshot.deviceId,snapshot.groupId].every(id=>typeof id==="string"&&id.length>0&&id.length<=256)&&/^[A-Za-z0-9_-]{16,128}$/.test(snapshot.id)}
function validateManifest(m:Manifest){
  if(m.resultConfirmed!==undefined&&m.resultConfirmed!==true)throw new Error("pending_send_invalid_confirmation");
  if(!validScope(m)||!Number.isSafeInteger(m.createdAt)||m.createdAt<0||typeof m.content!=="string"||!m.payload||m.payload.client_request_id!==m.id||m.payload.sender_device_id!==m.deviceId||typeof m.payload.ciphertext!=="string"||!m.payload.ciphertext||m.payload.ciphertext.length>2_000_000||typeof m.payload.e2ee_metadata!=="string"||m.payload.e2ee_metadata.length>1_000_000||!Number.isSafeInteger(m.payload.key_epoch)||m.payload.key_epoch<1)throw new Error("pending_send_invalid_manifest");
  if(!Array.isArray(m.files)||!Array.isArray(m.encryptedFiles)||m.files.length>10||m.encryptedFiles.length!==m.files.length||(m.files.length>0&&(!Array.isArray(m.fileKeys)||m.fileKeys.length!==m.files.length)))throw new Error("pending_send_invalid_files");
  if((m.replyToId!==undefined&&typeof m.replyToId!=="string")||m.payload.reply_to_id!==m.replyToId||(m.originRecoveryId!==undefined&&typeof m.originRecoveryId!=="string")||(m.fileKeys!==undefined&&!Array.isArray(m.fileKeys)))throw new Error("pending_send_invalid_manifest");
  if(m.origin&&(typeof m.origin.deviceId!=="string"||!m.origin.deviceId||m.origin.deviceId.length>256||typeof m.origin.id!=="string"||!/^[A-Za-z0-9_-]{16,128}$/.test(m.origin.id)||m.origin.id===m.id))throw new Error("pending_send_invalid_origin");
  if(m.acknowledgedIndices!==undefined&&(!Array.isArray(m.acknowledgedIndices)||new Set(m.acknowledgedIndices).size!==m.acknowledgedIndices.length||m.acknowledgedIndices.some(index=>!Number.isSafeInteger(index)||index<0||index>=m.files.length)))throw new Error("pending_send_invalid_acknowledgements");
  if(m.fileSources!==undefined&&(!Array.isArray(m.fileSources)||m.fileSources.length>10||new Set(m.fileSources.map(s=>s.fileIndex)).size!==m.fileSources.length||m.fileSources.some(s=>!Number.isSafeInteger(s.fileIndex)||s.fileIndex<0||s.fileIndex>=m.files.length||!Number.isSafeInteger(s.sourceIndex)||s.sourceIndex<0||s.sourceIndex>=10||typeof s.deviceId!=="string"||!s.deviceId||s.deviceId.length>256||typeof s.id!=="string"||!/^[A-Za-z0-9_-]{16,128}$/.test(s.id)||s.id===m.id)))throw new Error("pending_send_invalid_sources");
  for(const f of [...m.files,...m.encryptedFiles])if(!f||typeof f.name!=="string"||typeof f.type!=="string"||!Number.isSafeInteger(f.size)||f.size<0||!Number.isSafeInteger(f.lastModified)||f.lastModified<0)throw new Error("pending_send_invalid_file_metadata");
  for(let i=0;i<m.files.length;i++){
    const key=m.fileKeys![i],file=m.files[i];
    if(!key||typeof key.key!=="string"||atob(key.key).length!==32||typeof key.iv!=="string"||atob(key.iv).length!==12||typeof key.digest!=="string"||!/^[a-fA-F0-9]{64}$/.test(key.digest)||key.filename!==file.name||key.mimeType!==file.type||key.originalSize!==file.size)throw new Error("pending_send_invalid_file_keys");
  }
}
function bufferSize(value:unknown):number{
  // IndexedDB/WebCrypto may return a genuine ArrayBuffer from another realm.
  // Use the native brand-checking getter, not instanceof or a spoofable tag.
  try{return Reflect.apply(Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,"byteLength")!.get!,value,[]) as number}catch{return -1}
}
function validPart(part:SealedPart){return part&&Array.isArray(part.iv)&&part.iv.length===12&&part.iv.every(n=>Number.isInteger(n)&&n>=0&&n<=255)&&bufferSize(part.ciphertext)>=16}
async function seal(key:CryptoKey,bytes:ArrayBuffer,additionalData:Uint8Array<ArrayBuffer>):Promise<SealedPart>{
  const iv=crypto.getRandomValues(new Uint8Array(12));const ciphertext=await crypto.subtle.encrypt({name:"AES-GCM",iv,additionalData},key,bytes);return {iv:Array.from(iv),ciphertext};
}
async function open(key:CryptoKey,part:SealedPart,additionalData:Uint8Array<ArrayBuffer>):Promise<ArrayBuffer>{
  if(!validPart(part))throw new Error("pending_send_invalid_ciphertext");
  return crypto.subtle.decrypt({name:"AES-GCM",iv:Uint8Array.from(part.iv),additionalData},key,part.ciphertext);
}
const descriptor=(file:File):FileDescriptor=>({name:file.name,type:file.type,size:file.size,lastModified:file.lastModified});

/** Local encryption is not a defense against compromised same-origin code.
 * Non-exportable keys/records stay on this device and are wiped by E2EE logout.
 * Callers must await this write before transmitting a new operation. */
export async function savePendingGroupSend(snapshot:PendingGroupSendSnapshot,isCurrent:()=>boolean):Promise<void>{
  current(isCurrent);
  const {files,encryptedFiles,...rest}=snapshot;
  const manifest:Manifest={...rest,files:files.map(descriptor),encryptedFiles:encryptedFiles.map(descriptor)};validateManifest(manifest);
  const manifestBytes=encoder.encode(JSON.stringify(manifest));if(manifestBytes.byteLength>4_194_304)throw new Error("pending_send_manifest_too_large");
  const key=await storage.getOrCreatePendingGroupSendKey(snapshot.accountId,snapshot.deviceId,isCurrent);validateKey(key);current(isCurrent);
  const auth=(part:string)=>aad(snapshot.accountId,snapshot.deviceId,snapshot.groupId,snapshot.id,part);
  const envelope:PendingGroupSendEnvelope={version:1,writeToken:crypto.randomUUID(),manifest:await seal(key,manifestBytes.buffer,auth("manifest")),files:[],encryptedFiles:[]};
  for(const [kind,items] of [["files",files],["encryptedFiles",encryptedFiles]] as const){
    for(let index=0;index<items.length;index++){current(isCurrent);const bytes=await items[index].arrayBuffer();current(isCurrent);envelope[kind].push(await seal(key,bytes,auth(`${kind}:${index}`)))}
  }
  current(isCurrent);await storage.putPendingGroupSendRecord(snapshot.accountId,snapshot.deviceId,snapshot.groupId,snapshot.id,envelope,isCurrent);
}

export async function loadPendingGroupSends(accountId:string,deviceId:string,isCurrent:()=>boolean):Promise<{sends:PendingGroupSendSnapshot[];failed:Array<{groupId:string;id:string}>}>{
  current(isCurrent);const rows=await storage.listPendingGroupSendRecords(accountId,deviceId);current(isCurrent);
  const sends:PendingGroupSendSnapshot[]=[],failed:Array<{groupId:string;id:string}>=[];if(!rows.length)return {sends,failed};
  const key=await storage.getPendingGroupSendKey(accountId,deviceId);if(!key)throw new Error("pending_send_key_missing");validateKey(key);
  for(const row of rows){
    current(isCurrent);
    try{
      const env=row.value as PendingGroupSendEnvelope;
      if(!env||env.version!==1||!Array.isArray(env.files)||!Array.isArray(env.encryptedFiles)||env.files.length>10||env.encryptedFiles.length>10||!validPart(env.manifest)||env.manifest.ciphertext.byteLength>4_194_320)throw new Error("pending_send_invalid_envelope");
      const auth=(part:string)=>aad(accountId,deviceId,row.groupId,row.requestId,part);
      const manifest=JSON.parse(decoder.decode(await open(key,env.manifest,auth("manifest")))) as Manifest;validateManifest(manifest);
      if(manifest.accountId!==accountId||manifest.deviceId!==deviceId||manifest.groupId!==row.groupId||manifest.id!==row.requestId||env.files.length!==manifest.files.length||env.encryptedFiles.length!==manifest.encryptedFiles.length)throw new Error("pending_send_scope_mismatch");
      const files:File[]=[],encryptedFiles:File[]=[];
      for(const [kind,result] of [["files",files],["encryptedFiles",encryptedFiles]] as const){
        for(let index=0;index<env[kind].length;index++){current(isCurrent);const bytes=await open(key,env[kind][index],auth(`${kind}:${index}`));const info=manifest[kind][index];if(bytes.byteLength!==info.size)throw new Error("pending_send_file_size_mismatch");result.push(new File([bytes],info.name,{type:info.type,lastModified:info.lastModified}))}
      }
      current(isCurrent);sends.push({...manifest,files,encryptedFiles});
    }catch{current(isCurrent);failed.push({groupId:row.groupId,id:row.requestId})}
  }
  current(isCurrent);return {sends,failed};
}

export async function removePendingGroupSend(accountId:string,deviceId:string,groupId:string,requestId:string):Promise<void>{
  await storage.deletePendingGroupSendRecord(accountId,deviceId,groupId,requestId);
}

/** Storage primitive for confirmed forwarded-file receipts. Callers must
 * supply ONLY server-confirmed successful source positions. File ciphertext is retained
 * unchanged; only the authenticated manifest is resealed with a fresh IV. */
export async function acknowledgePendingGroupFiles(accountId:string,deviceId:string,groupId:string,requestId:string,indices:readonly number[],isCurrent:()=>boolean):Promise<number[]>{
  return updatePendingGroupReceipt(accountId,deviceId,groupId,requestId,indices,isCurrent);
}

/** A monotonic local receipt, set only after a validated committed response.
 * It is not a server signature or a replacement for authorized result lookup. */
export async function markPendingGroupSendConfirmed(accountId:string,deviceId:string,groupId:string,requestId:string,isCurrent:()=>boolean):Promise<void>{
  await updatePendingGroupReceipt(accountId,deviceId,groupId,requestId,[],isCurrent,true);
}

async function updatePendingGroupReceipt(accountId:string,deviceId:string,groupId:string,requestId:string,indices:readonly number[],isCurrent:()=>boolean,confirm=false):Promise<number[]>{
  current(isCurrent);const key=await storage.getPendingGroupSendKey(accountId,deviceId);if(!key)throw new Error("pending_send_key_missing");validateKey(key);
  for(let attempt=0;attempt<4;attempt++){
    current(isCurrent);const env=await storage.getPendingGroupSendRecord(accountId,deviceId,groupId,requestId) as PendingGroupSendEnvelope|null;current(isCurrent);
    if(!env)throw new Error("pending_send_not_found");
    if(env.version!==1||typeof env.writeToken!=="string"||!env.writeToken||!Array.isArray(env.files)||!Array.isArray(env.encryptedFiles)||env.files.some(part=>!validPart(part))||env.encryptedFiles.some(part=>!validPart(part))||!validPart(env.manifest)||bufferSize(env.manifest.ciphertext)>4_194_320)throw new Error("pending_send_invalid_envelope");
    const auth=aad(accountId,deviceId,groupId,requestId,"manifest");
    const manifest=JSON.parse(decoder.decode(await open(key,env.manifest,auth))) as Manifest;validateManifest(manifest);current(isCurrent);
    if(manifest.accountId!==accountId||manifest.deviceId!==deviceId||manifest.groupId!==groupId||manifest.id!==requestId||env.files.length!==manifest.files.length||env.encryptedFiles.length!==manifest.encryptedFiles.length)throw new Error("pending_send_scope_mismatch");
    if(indices.some(index=>!Number.isSafeInteger(index)||index<0||index>=manifest.files.length))throw new Error("pending_send_invalid_acknowledgements");
    const previous=manifest.acknowledgedIndices??[],merged=Array.from(new Set([...previous,...indices])).sort((a,b)=>a-b);
    if(merged.length===previous.length&&(!confirm||manifest.resultConfirmed))return merged;
    const bytes=encoder.encode(JSON.stringify({...manifest,acknowledgedIndices:merged,...(confirm?{resultConfirmed:true}:{})}));if(bytes.byteLength>4_194_304)throw new Error("pending_send_manifest_too_large");
    const next:PendingGroupSendEnvelope={...env,writeToken:crypto.randomUUID(),manifest:await seal(key,bytes.buffer,auth)};current(isCurrent);
    const updated=await storage.replacePendingGroupSendRecord(accountId,deviceId,groupId,requestId,env.writeToken,next,isCurrent);current(isCurrent);if(updated)return merged;
  }
  throw new Error("pending_send_update_conflict");
}

/** Validate the whole authenticated ancestry before writing. Ancestors are
 * acknowledged first, so interruption cannot mark a child done while leaving
 * its older source eligible for another retry. Never infer links from names. */
export async function acknowledgePendingGroupFileChain(accountId:string,deviceId:string,groupId:string,requestId:string,indices:readonly number[],isCurrent:()=>boolean):Promise<Array<{deviceId:string;id:string;acknowledgedIndices:number[]}>>{
  const manifests=new Map<string,Manifest>(),visiting=new Set<string>(),visited=new Set<string>();
  const plan:Array<{deviceId:string;id:string;index:number}>=[];
  async function visit(device:string,id:string,index:number):Promise<void>{
    current(isCurrent);const recordKey=JSON.stringify([device,id]),position=JSON.stringify([device,id,index]);
    if(visiting.has(position))throw new Error("pending_send_source_cycle");
    if(visited.has(position))return;
    if(visited.size+visiting.size>=256)throw new Error("pending_send_source_limit");
    visiting.add(position);
    let manifest=manifests.get(recordKey);
    if(!manifest){
      const key=await storage.getPendingGroupSendKey(accountId,device);current(isCurrent);if(!key)throw new Error("pending_send_key_missing");validateKey(key);
      const env=await storage.getPendingGroupSendRecord(accountId,device,groupId,id) as PendingGroupSendEnvelope|null;current(isCurrent);
      if(!env)throw new Error("pending_send_not_found");
      if(env.version!==1||!validPart(env.manifest)||bufferSize(env.manifest.ciphertext)>4_194_320)throw new Error("pending_send_invalid_envelope");
      manifest=JSON.parse(decoder.decode(await open(key,env.manifest,aad(accountId,device,groupId,id,"manifest")))) as Manifest;validateManifest(manifest);
      if(manifest.accountId!==accountId||manifest.deviceId!==device||manifest.groupId!==groupId||manifest.id!==id)throw new Error("pending_send_scope_mismatch");
      manifests.set(recordKey,manifest);
    }
    if(!Number.isSafeInteger(index)||index<0||index>=manifest.files.length)throw new Error("pending_send_invalid_acknowledgements");
    for(const source of manifest.fileSources??[])if(source.fileIndex===index)await visit(source.deviceId,source.id,source.sourceIndex);
    visiting.delete(position);visited.add(position);plan.push({deviceId:device,id,index});
  }
  for(const index of indices)await visit(deviceId,requestId,index);
  const results=new Map<string,{deviceId:string;id:string;acknowledgedIndices:number[]}>();
  for(const item of plan){
    const acknowledgedIndices=await acknowledgePendingGroupFiles(accountId,item.deviceId,groupId,item.id,[item.index],isCurrent);
    current(isCurrent);results.set(JSON.stringify([item.deviceId,item.id]),{deviceId:item.deviceId,id:item.id,acknowledgedIndices});
  }
  return Array.from(results.values());
}
