import type { EncryptedFileMeta } from "../crypto/fileEncryption";
import type { GroupDMAttachment } from "../types/groupDM";

/** Legacy encrypted_N.bin names preserve original key positions even after
 * a middle upload failed or same-timestamp database rows changed order. */
export function groupAttachmentKeyIndex(attachment:Pick<GroupDMAttachment,"filename"|"file_key_index">,position:number):number|undefined {
  const legacy=/^encrypted_(\d+)\.bin$/.exec(attachment.filename);
  const index=attachment.file_key_index??(legacy?Number(legacy[1]):position);
  return Number.isSafeInteger(index)&&index>=0&&index<10?index:undefined;
}
export function groupAttachmentKey(keys:EncryptedFileMeta[]|undefined,attachment:GroupDMAttachment,position:number):EncryptedFileMeta|undefined {
  const index=groupAttachmentKeyIndex(attachment,position);
  return index===undefined?undefined:keys?.[index];
}
