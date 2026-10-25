import type {DMMessage} from "../types/dm";
import type {E2EEPayload} from "./e2eePayload";
import * as storage from "./keyStorage";
import {groupAttachmentKeyIndex} from "../utils/groupAttachmentKeys";

/** Source identity for local cache reuse, not a sender-authentication claim. */
export async function dmMessageCacheTag(message:DMMessage):Promise<string>{
  const source=JSON.stringify([message.dm_channel_id,message.id,message.user_id,message.sender_device_id,message.ciphertext,message.e2ee_metadata??null]);
  const hash=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(source));
  return `dm-v1:${Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,"0")).join("")}`;
}

export async function cacheDMMessage(message:DMMessage,payload:E2EEPayload,isCurrent:()=>boolean):Promise<void>{
  if(!isCurrent())return;const tag=await dmMessageCacheTag(message);if(!isCurrent())return;
  await storage.cacheDecryptedMessage({messageId:message.id,channelId:"",dmChannelId:message.dm_channel_id,content:payload.content,fileKeys:payload.file_keys,encryptedSourceTag:tag,timestamp:new Date(message.created_at).getTime()},isCurrent);
}

export async function readDMMessageCache(message:DMMessage,isCurrent:()=>boolean):Promise<E2EEPayload|null>{
  if(!isCurrent())return null;const cached=await storage.getCachedDecryptedMessage(message.id);if(!isCurrent()||!cached)return null;
  if(cached.messageId!==message.id||cached.dmChannelId!==message.dm_channel_id||cached.channelId!==""||typeof cached.content!=="string")return null;
  const tag=await dmMessageCacheTag(message);if(!isCurrent())return null;
  // Preserve old unedited text-only history without silently trusting it for
  // a later edit or attachment-key lookup. Old records are never deleted here.
  const legacy=!cached.encryptedSourceTag&&!message.edited_at&&!message.attachments?.length;
  if(cached.encryptedSourceTag!==tag&&!legacy)return null;
  for(const [position,attachment]of (message.attachments??[]).entries()){
    const index=groupAttachmentKeyIndex(attachment,position);if(index===undefined||!Array.isArray(cached.fileKeys)||!cached.fileKeys[index])return null;
  }
  return {content:cached.content,file_keys:cached.fileKeys};
}
