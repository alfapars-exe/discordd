import {useComposerDraftStore} from "../stores/composerDraftStore";
import type {DMMessage} from "../types/dm";

let generation = -1;
let clock = 0;
const versions = new Map<string, {clock:number; deleted:boolean; source?:string}>();
const key = (channelId:string, id:string) => JSON.stringify([channelId,id]);
const source = (message:DMMessage) => JSON.stringify([message.dm_channel_id,message.id,message.user_id,message.sender_device_id,message.ciphertext,message.e2ee_metadata??null]);
function sync() {
  const next = useComposerDraftStore.getState().generation;
  if (generation !== next) {generation=next; versions.clear(); clock++;}
}

/** Local event order, not a server revision or sender-authentication claim. */
export function observeDMMessage(channelId:string,id:string,deleted=false,message?:DMMessage):()=>boolean {
  sync();
  const scope=generation, version={clock:++clock,deleted,source:message?source(message):undefined};
  const idKey=key(channelId,id);
  // Message IDs are not reusable: a delayed create/update cannot undo deletion.
  if (!deleted && versions.get(idKey)?.deleted) return () => false;
  versions.set(idKey,version);
  return () => {sync(); return generation===scope && versions.get(idKey)===version;};
}

/** Fence an HTTP receipt against observations made while its request was in flight.
 * The matching WS echo shares its existing token so it is not invalidated. */
export function captureDMReceipt(channelId:string):(message:DMMessage)=>(()=>boolean)|null {
  sync();
  const scope=generation, started=clock;
  return message => {
    sync();
    if (scope!==generation || message.dm_channel_id!==channelId) return null;
    const idKey=key(channelId,message.id), version=versions.get(idKey);
    if (version?.deleted) return null;
    if (version?.source===source(message)) {
      return () => {sync(); return generation===scope && versions.get(idKey)===version;};
    }
    if (version && version.clock>started) return null;
    return observeDMMessage(channelId,message.id,false,message);
  };
}

/** Capture BEFORE the history request, not when its response finishes. */
export function captureDMHistoryVersion(channelId:string) {
  sync();
  const scope=generation, started=clock;
  const current=(message:DMMessage) => {
    sync();
    const version=versions.get(key(channelId,message.id));
    return generation===scope && message.dm_channel_id===channelId && !version?.deleted && (version?.clock??0)<=started;
  };
  const deleted=(message:DMMessage) => {sync(); return versions.get(key(channelId,message.id))?.deleted===true;};
  return {current,deleted};
}
