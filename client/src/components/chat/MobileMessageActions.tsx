/** MobileMessageActions — Bottom sheet with emoji bar + actions. Opens on long-press. */

import MobileBottomSheet from "../shared/MobileBottomSheet";
import type { ChatMessage } from "../../hooks/useChatContext";
import type { MessageAction } from "./messageActionRegistry";

type MobileMessageActionsProps = {
  isOpen: boolean;
  onClose: () => void;
  message: ChatMessage | null;
  /** Emoji reaction handler */
  onReaction: (emoji: string) => void;
  actions: MessageAction[];
};

/** Frequently used emojis for quick-react bar */
const QUICK_EMOJIS = ["\uD83D\uDC4D", "\u2764\uFE0F", "\uD83D\uDE02", "\uD83D\uDE2E", "\uD83D\uDE22", "\uD83D\uDE4F"];

function MobileMessageActions({
  isOpen,
  onClose,
  message,
  onReaction,
  actions,
}: MobileMessageActionsProps) {
  if (!message) return null;

  function handleAction(action: () => void) {
    action();
    onClose();
  }

  return (
    <MobileBottomSheet isOpen={isOpen} onClose={onClose}>
      {/* Emoji quick-react bar */}
      <div className="mobile-msg-emoji-bar">
        {QUICK_EMOJIS.map((emoji) => (
          <button
            key={emoji}
            className="mobile-msg-emoji-btn"
            onClick={() => handleAction(() => onReaction(emoji))}
          >
            {emoji}
          </button>
        ))}
      </div>

      {/* Action list */}
      <div className="mobile-bs-actions-list">
        {actions.flatMap((action) => action.children?.length ? action.children : [action]).map((action, index) => (
          <button
            key={`${action.id}:${action.label}:${index}`}
            className={`mobile-bs-action${action.danger ? " destructive" : ""}`}
            onClick={() => handleAction(action.run)}
            disabled={action.disabled}
          >
            <span className="mobile-bs-action-icon" aria-hidden="true">{action.id === "report" ? "⚑" : "◇"}</span>
            {action.label}
          </button>
        ))}
      </div>
    </MobileBottomSheet>
  );
}

export default MobileMessageActions;
