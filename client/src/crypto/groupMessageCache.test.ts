import { expect,it } from "vitest";
import { groupMessageCacheTag,restoreGroupSourceSequence } from "./groupMessageCache";
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
it("keeps lossless source metadata separate from the ciphertext cache tag and preserves server authority",async()=>{
  expect(restoreGroupSourceSequence(message,"9007199254740993").source_sequence).toBe("9007199254740993");
  expect(restoreGroupSourceSequence({...message,source_sequence:"17"},"9007199254740993").source_sequence).toBe("17");
  expect(restoreGroupSourceSequence(message,Number.MAX_SAFE_INTEGER+2).source_sequence).toBeUndefined();
  expect(restoreGroupSourceSequence(message,"01").source_sequence).toBeUndefined();
  expect(await groupMessageCacheTag({...message,source_sequence:"9007199254740993"})).toBe(await groupMessageCacheTag(message));
});
