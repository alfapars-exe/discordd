import type { EncryptedFileMeta } from "../../crypto/fileEncryption";

export type ChannelSendIntent = {
  id: string;
  content: string;
  reply?: string;
  files: File[];
  encrypted?: { ciphertext: string; device: string; metadata: string; files?: File[]; metas?: EncryptedFileMeta[] };
};

// One unresolved composer send per account/session/destination. Failure keeps
// the identity and encrypted bytes; a changed draft starts a new logical send.
const pending = new Map<string, ChannelSendIntent>();
let durableChannelSends = false;
export function setDurableChannelSends(supported: boolean) { durableChannelSends = supported; }
export function supportsDurableChannelSends() { return durableChannelSends; }
export function channelSendIntent(key: string, content: string, files: File[] = [], reply?: string): ChannelSendIntent {
  const old = pending.get(key);
  if (old && old.content === content && old.reply === reply && old.files.length === files.length && old.files.every((f, i) => f === files[i])) return old;
  const intent = { id: crypto.randomUUID(), content, files: [...files], reply };
  pending.set(key, intent);
  return intent;
}
export function completeChannelSendIntent(key: string, intent: ChannelSendIntent) {
  if (pending.get(key) === intent) pending.delete(key);
}
export function clearChannelSendIntents() { pending.clear(); durableChannelSends = false; }
