import { useTranslation } from "react-i18next";
import type { GroupDMMessage } from "../../types/groupDM";
import type { PublicUser } from "../../types/user";
import { renderMessageContent } from "../../utils/messageParsers";
import MessageBodyMediaGate from "../chat/MessageBodyMediaGate";

/** Group expressions use the shared renderer, inside the same private-media policy as attachments. */
export default function GroupDMMessageBody({ message, members }: { message: GroupDMMessage; members: PublicUser[] }) {
  const { t } = useTranslation("common");
  if (message.content === null || message.decryption_error) {
    return <p>{t(message.decryption_error === "version_unavailable" ? "encryptedMessageVersionUnavailable" : "encryptedMessageUnavailable")}</p>;
  }
  const content = message.content;
  const body = <div className="msg-text">{renderMessageContent(content, [], members)}</div>;
  return <MessageBodyMediaGate content={content} authorId={message.user_id} messageId={message.id} revision={message.edited_at??"original"} sourceKind="group" sourceChannelId={message.group_id}>{body}</MessageBodyMediaGate>;
}
