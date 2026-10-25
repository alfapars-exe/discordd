/** MessageReactions — Renders emoji reaction buttons and add-reaction picker. */

import { Fragment,useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "../../stores/authStore";
import { useEmojiStore } from "../../stores/emojiStore";
import { parseReactionKey, toReactionKey } from "../../utils/expressionTokens";
import ReactionMediaGate from "./ReactionMediaGate";
import CustomEmoji from "../shared/CustomEmoji";
import EmojiPicker from "../shared/EmojiPicker";
import type { ChatMessage } from "../../hooks/useChatContext";

type MessageReactionsProps = {
  message: ChatMessage;
  sourceKind:"channel"|"dm";
  sourceChannelId:string;
  pickerSource: "bar" | "hover" | null;
  onPickerOpen: () => void;
  onPickerClose: () => void;
  onReaction: (emoji: string) => void;
};

function MessageReactions({
  message,
  sourceKind,sourceChannelId,
  pickerSource,
  onPickerOpen,
  onPickerClose,
  onReaction,
}: MessageReactionsProps) {
  const { t } = useTranslation("chat");
  const { t: tExpr } = useTranslation("expressions");
  const currentUser = useAuthStore((s) => s.user);
  const emojiById = useEmojiStore((s) => s.byId);

  // Picker hands back `<:name:id>` for custom emojis; reactions key on id only.
  const handlePick = useCallback(
    (emoji: string) => onReaction(toReactionKey(emoji)),
    [onReaction],
  );

  const hasReactions = message.reactions && message.reactions.length > 0;
  if (!hasReactions && pickerSource !== "bar") return null;

  return (
    <div className="msg-reactions">
      {message.reactions?.map((reaction) => {
        const reactionUsers=Array.isArray(reaction.users)?reaction.users:[];
        const isActive = currentUser
          ? reactionUsers.includes(currentUser.id)
          : false;

        const parsed=parseReactionKey(reaction.emoji);
        const reactionButton=(visible:boolean)=><button
          className={`msg-reaction-btn${isActive ? " active" : ""}`}
          onClick={()=>onReaction(reaction.emoji)}
          title={reactionUsers.length.toString()}
          aria-pressed={isActive}
          aria-label={`${parsed.custom?emojiById[parsed.id]?.name??tExpr("unknownEmoji"):parsed.emoji} ${reaction.count}`}
        >
          <span className="msg-reaction-emoji">{!parsed.custom?parsed.emoji:visible?
            <CustomEmoji id={parsed.id} name={emojiById[parsed.id]?.name??tExpr("unknownEmoji")} animated={parsed.animated} size="reaction"/>:
            <span>{`:${emojiById[parsed.id]?.name??tExpr("unknownEmoji")}:`}</span>}
          </span>
          <span className="msg-reaction-count">{reaction.count}</span>
        </button>;
        return parsed.custom?<div key={reaction.emoji} className="msg-reaction-media">
          <ReactionMediaGate reaction={reaction} sourceKind={sourceKind} sourceChannelId={sourceChannelId} messageId={message.id} revision={message.edited_at??"original"} messageAuthorId={message.user_id} render={reactionButton}/>
        </div>:<Fragment key={reaction.emoji}>{reactionButton(true)}</Fragment>;
      })}

      <div className="msg-reaction-add-wrap">
        <button
          className="msg-reaction-add"
          onClick={onPickerOpen}
          title={t("addReaction")}
        >
          +
        </button>
        {pickerSource === "bar" && (
          <EmojiPicker
            onSelect={handlePick}
            onClose={onPickerClose}
            customEmojis
          />
        )}
      </div>
    </div>
  );
}

export default MessageReactions;
