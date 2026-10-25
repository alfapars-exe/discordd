import { expect,it } from "vitest";
import { groupMessageCacheTag } from "./groupMessageCache";
import type { GroupDMMessage } from "../types/groupDM";
const message={id:"m",group_id:"g",user_id:"u",sender_device_id:"d",key_epoch:1,ciphertext:"abcd"} as GroupDMMessage;
it("uses real SHA-256 and differentiates same-length ciphertexts",async()=>{
  const tag=await groupMessageCacheTag(message);
  expect(tag).toMatch(/^group-v1:[0-9a-f]{64}$/);
  expect(await groupMessageCacheTag({...message,ciphertext:"abce"})).not.toBe(tag);
  expect(await groupMessageCacheTag({...message,edited_at:"timestamp-only-change"})).toBe(tag);
});
it.each([{id:"other"},{group_id:"other"},{user_id:"other"},{sender_device_id:"other"},{key_epoch:2}])("includes source context %j",async change=>{
  expect(await groupMessageCacheTag({...message,...change})).not.toBe(await groupMessageCacheTag(message));
});
