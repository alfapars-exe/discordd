import type { GroupDMMessage } from "../types/groupDM";
import type { E2EEPayload } from "./e2eePayload";
import * as keyStorage from "./keyStorage";
import {dmSourceSequence} from "../utils/dmSourceOrder";

/** Call only after ciphertext/group cache affinity passed; never replace server metadata. */
export function restoreGroupSourceSequence(message:GroupDMMessage,cachedSequence:unknown):GroupDMMessage{
  const sequence=dmSourceSequence(cachedSequence);
  return message.source_sequence===undefined&&sequence!==null?{...message,source_sequence:sequence.toString()}:message;
}

/** Cache identity, not a sender-authentication claim. Ciphertext changes even
 * when two edits share the same server timestamp or encoded length. */
export async function groupMessageCacheTag(message:GroupDMMessage):Promise<string> {
  const source=JSON.stringify([message.group_id,message.id,message.user_id,message.sender_device_id,message.key_epoch,message.ciphertext]);
  const hash=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(source));
  return `group-v1:${Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,"0")).join("")}`;
}

export async function cacheGroupMessage(message:GroupDMMessage,payload:E2EEPayload,isCurrent:()=>boolean,tag?:string):Promise<void> {
  if(!isCurrent())return;
  const sourceTag=tag??await groupMessageCacheTag(message);
  if(!isCurrent())return;
  await keyStorage.cacheDecryptedMessage({messageId:message.id,channelId:"",dmChannelId:`group:${message.group_id}`,sourceSequence:dmSourceSequence(message.source_sequence)?.toString(),content:payload.content,timestamp:new Date(message.created_at).getTime(),encryptedSourceTag:sourceTag,fileKeys:payload.file_keys},isCurrent);
}
