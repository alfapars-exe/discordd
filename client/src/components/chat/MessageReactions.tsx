/** MessageReactions — Renders emoji reaction buttons and add-reaction picker. */

import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "../../stores/authStore";
import { useEmojiStore } from "../../stores/emojiStore";
import { parseReactionKey, toReactionKey } from "../../utils/expressionTokens";
import CustomEmoji from "../shared/CustomEmoji";
import EmojiPicker from "../shared/EmojiPicker";
import type { ChatMessage } from "../../hooks/useChatContext";

type MessageReactionsProps = {
  message: ChatMessage;
  pickerSource: "bar" | "hover" | null;
  onPickerOpen: () => void;
  onPickerClose: () => void;
  onReaction: (emoji: string) => void;
};

function MessageReactions({
  message,
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
        const isActive = currentUser
          ? reaction.users.includes(currentUser.id)
          : false;

        return (
          <button
            key={reaction.emoji}
            className={`msg-reaction-btn${isActive ? " active" : ""}`}
            onClick={() => onReaction(reaction.emoji)}
            title={reaction.users.length.toString()}
          >
            <span className="msg-reaction-emoji">
              {(() => {
                const parsed = parseReactionKey(reaction.emoji);
                if (!parsed.custom) return parsed.emoji;
                return (
                  <CustomEmoji
                    id={parsed.id}
                    name={emojiById[parsed.id]?.name ?? tExpr("unknownEmoji")}
                    animated={parsed.animated}
                    size="reaction"
                  />
                );
              })()}
            </span>
            <span className="msg-reaction-count">{reaction.count}</span>
          </button>
        );
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
