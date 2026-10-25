import type {ChatMessage} from "../../hooks/useChatContext";
import type {Channel} from "../../types/channel";
import {Permissions} from "../../utils/permissions";

export type ForwardableMessage=Pick<ChatMessage,"id"|"user_id"|"content"|"encryption_version"|"e2ee_file_keys">&{
  author?:Pick<ChatMessage["author"],"username"|"display_name">;
  attachments:Array<ChatMessage["attachments"][number]&{file_key_index?:number|null}>;
};

export function canForwardToChannel(channel:Pick<Channel,"type"|"effective_permissions">):boolean{
  const bits=channel.effective_permissions;
  if(channel.type!=="text"||typeof bits!=="number"||!Number.isSafeInteger(bits)||bits<0||bits>8388607)return false;
  if((bits&Permissions.Admin)!==0)return true;
  const required=Permissions.ViewChannel|Permissions.ReadMessages|Permissions.SendMessages;
  return (bits&required)===required;
}

export function buildForwardContent(message:ForwardableMessage,translatedLabel:string):string{
  const author=message.author?.display_name??message.author?.username??translatedLabel;
  const body=message.content?.trim()??"";
  return body?`${translatedLabel} ${author}:\n${body}`:`${translatedLabel} ${author}`;
}
