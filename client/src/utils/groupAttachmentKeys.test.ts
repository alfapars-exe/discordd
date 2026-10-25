import { expect,it } from "vitest";
import { groupAttachmentKeyIndex,groupAttachmentKey } from "./groupAttachmentKeys";
import type { GroupDMAttachment } from "../types/groupDM";
it("uses the original explicit or legacy encrypted filename index instead of compacted list position",()=>{
  expect(groupAttachmentKeyIndex({filename:"opaque.bin",file_key_index:2},0)).toBe(2);
  expect(groupAttachmentKeyIndex({filename:"encrypted_2.bin"},0)).toBe(2);
  expect(groupAttachmentKeyIndex({filename:"old-name.bin"},1)).toBe(1);
});
it.each([-1,10,1.2,NaN])("does not fall back from an invalid explicit key index %s",index=>{
  expect(groupAttachmentKeyIndex({filename:"encrypted_0.bin",file_key_index:index},0)).toBeUndefined();
});
it("fails closed when the encrypted payload has no corresponding key",()=>{
  expect(groupAttachmentKey([], {filename:"encrypted_2.bin"} as GroupDMAttachment,0)).toBeUndefined();
});
