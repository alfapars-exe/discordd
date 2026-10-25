import { useTranslation } from "react-i18next";
import type { GroupDMMessage } from "../../types/groupDM";
import type { PublicUser } from "../../types/user";
import { KLIPY_REGEX, renderMessageContent } from "../../utils/messageParsers";
import { CUSTOM_EMOJI_TOKEN, emojiAnimatedUrl, emojiStaticUrl, parseCustomEmojiToken } from "../../utils/expressionTokens";
import { parseStickerToken, stickerAnimatedUrl, stickerStaticUrl } from "../../utils/stickerTokens";
import type { LocalMediaInput } from "../../hooks/useLocalMediaAnalysis";
import { scanCodeSegments } from "../../utils/markdownLite";
import UnclassifiedMediaGate from "../chat/UnclassifiedMediaGate";

/** Group expressions use the shared renderer, inside the same private-media policy as attachments. */
export default function GroupDMMessageBody({ message, members }: { message: GroupDMMessage; members: PublicUser[] }) {
  const { t } = useTranslation("common");
  if (message.content === null || message.decryption_error) {
    return <p>{t(message.decryption_error === "version_unavailable" ? "encryptedMessageVersionUnavailable" : "encryptedMessageUnavailable")}</p>;
  }
  const content = message.content;
  const trimmed = content.trim();
  const media = new Map<string, LocalMediaInput>();
  const add = (url: string, mimeType: string) => media.set(url, { url, mimeType });
  if (KLIPY_REGEX.test(trimmed)) add(trimmed, "image/gif");
  const sticker = parseStickerToken(trimmed);
  if (sticker) add(sticker.animated ? stickerAnimatedUrl(sticker.id) : stickerStaticUrl(sticker.id), sticker.animated ? "image/gif" : "image/png");
  for (const segment of scanCodeSegments(content)) {
    if (segment.kind !== "text") continue;
    for (const match of segment.raw.matchAll(CUSTOM_EMOJI_TOKEN)) {
      const emoji = parseCustomEmojiToken(match[0]);
      if (emoji) add(emoji.animated ? emojiAnimatedUrl(emoji.id) : emojiStaticUrl(emoji.id), emoji.animated ? "image/gif" : "image/png");
    }
  }
  const body = <div className="msg-text">{renderMessageContent(content, [], members)}</div>;
  return media.size ? <UnclassifiedMediaGate privateConversation sourceKind="group" sourceChannelId={message.group_id}
    authorId={message.user_id} messageId={message.id} revision={message.edited_at ?? "original"}
    identity={`${message.group_id}:${message.id}:body`} mediaInputs={[...media.values()]}>{body}</UnclassifiedMediaGate> : body;
}
