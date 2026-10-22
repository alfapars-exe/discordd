/**
 * MessageCustomEmoji — a custom emoji inside message content, wrapped in an
 * inline button that opens ExpressionInfoPopover (Faz D2, D2-22).
 *
 * Same props as CustomEmoji (jumbo/inline sizing is preserved). Inside a
 * closed spoiler the button lives in an `inert` subtree (MarkdownSpoiler),
 * so it can't be focused or clicked until the spoiler is revealed.
 */

import { memo, useState } from "react";
import CustomEmoji, { type CustomEmojiSize } from "../shared/CustomEmoji";
import ExpressionInfoPopover from "./ExpressionInfoPopover";
import type { PopoverAnchor } from "../inbox/PopoverShell";

type MessageCustomEmojiProps = {
  id: string;
  name: string;
  animated: boolean;
  size?: CustomEmojiSize;
};

function MessageCustomEmoji({ id, name, animated, size = "inline" }: MessageCustomEmojiProps) {
  const [anchor, setAnchor] = useState<PopoverAnchor | null>(null);

  return (
    <>
      <button
        type="button"
        className="msg-custom-emoji-btn"
        aria-haspopup="dialog"
        aria-expanded={anchor !== null}
        onClick={(e) => {
          e.stopPropagation();
          const rect = e.currentTarget.getBoundingClientRect();
          setAnchor((prev) => (prev ? null : { rect, placement: "below" }));
        }}
      >
        <CustomEmoji id={id} name={name} animated={animated} size={size} />
      </button>
      {anchor && (
        <ExpressionInfoPopover
          kind="emoji"
          id={id}
          name={name}
          animated={animated}
          anchor={anchor}
          onClose={() => setAnchor(null)}
        />
      )}
    </>
  );
}

export default memo(MessageCustomEmoji);
