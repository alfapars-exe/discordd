import type { PublicUser } from "./user";
import type { ReactionGroup } from "./common";
import type { EncryptedFileMeta } from "../crypto/fileEncryption";

export type GroupDM = {
  is_muted?: boolean;
  settings_revision?: number;
  id: string;
  owner_id: string;
  name: string;
  icon_url: string | null;
  key_epoch: number;
  call_room_key: string;
  created_at: string;
  updated_at: string;
  members: PublicUser[];
  unread_count: number;
  oldest_unread_message_id?: string;
  read_revision?: number;
};

export type GroupDMReadState = { group_id: string; last_read_message_id: string | null; unread_count: number; revision?: number; is_muted?: boolean; settings_revision?: number };

export type GroupDMMessagesAroundPage = {
  messages: GroupDMMessage[];
  has_more: boolean;
  has_more_after: boolean;
};

export type GroupDMMessage = {
  id: string;
  group_id: string;
  user_id: string;
  content: string | null;
  encryption_version: 1;
  ciphertext: string | null;
  sender_device_id: string | null;
  e2ee_metadata: string | null;
  key_epoch: number;
  reply_to_id: string | null;
  edited_at: string | null;
  created_at: string;
  user?: PublicUser;
  reactions: ReactionGroup[];
  attachments: GroupDMAttachment[];
  e2ee_file_keys?: EncryptedFileMeta[];
  decryption_error?:"version_unavailable";
};

export type GroupDMAttachment = { id:string; group_message_id:string; filename:string; file_url:string; file_size:number|null; mime_type:string|null; created_at:string;file_key_index?:number|null };
export type GroupUploadFailure={filename:string;error:string;file_key_index?:number};
export type GroupSendOutcome={operation:{group_id:string;request_id:string;message_id:string;file_count:number;phase:"prepared"|"committed"|"completed"|"deleted"|"cancelled";failed_indices:number[];created_at:string;updated_at:string};message?:GroupDMMessage};
export type GroupSendResponse=GroupDMMessage|{message:GroupDMMessage;upload_failures:GroupUploadFailure[]}|GroupSendOutcome;
