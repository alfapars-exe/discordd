/**
 * CustomEmoji — renders one server custom emoji from its deterministic URL
 * (Faz D1, Karar D-5 / D-22).
 *
 * - The URL is built only from a regex-validated 16-hex id; `name` is used
 *   for alt/title text only.
 * - Animated emojis play by default; with reduced motion the static PNG is
 *   shown and the GIF plays on hover. `still` forces the PNG (pickers).
 * - A failed load (deleted/unknown emoji) falls back ONCE to `:name:` text —
 *   no retry loop.
 */

import { memo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useReducedMotion } from "../../hooks/useReducedMotion";
import { resolveAssetUrl } from "../../utils/constants";
import { EMOJI_ID, emojiAnimatedUrl, emojiStaticUrl } from "../../utils/expressionTokens";

export type CustomEmojiSize = "inline" | "jumbo" | "reaction";

type CustomEmojiProps = {
  id: string;
  name: string;
  animated: boolean;
  size?: CustomEmojiSize;
  /** Always show the static PNG (picker / autocomplete). */
  still?: boolean;
};

function CustomEmoji({ id, name, animated, size = "inline", still = false }: CustomEmojiProps) {
  const { t } = useTranslation("expressions");
  const reducedMotion = useReducedMotion();
  const [failed, setFailed] = useState(false);
  const [hovered, setHovered] = useState(false);

  if (failed || !EMOJI_ID.test(id)) {
    return <span className="msg-custom-emoji-fallback">{`:${name}:`}</span>;
  }

  const hoverToPlay = animated && !still && reducedMotion;
  const playing = animated && !still && (!reducedMotion || hovered);
  const src = resolveAssetUrl(playing ? emojiAnimatedUrl(id) : emojiStaticUrl(id));

  return (
    <img
      className={`msg-custom-emoji msg-custom-emoji-${size}`}
      src={src}
      alt={t("customEmojiAlt", { name })}
      title={`:${name}:`}
      draggable={false}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      onMouseEnter={hoverToPlay ? () => setHovered(true) : undefined}
      onMouseLeave={hoverToPlay ? () => setHovered(false) : undefined}
    />
  );
}

export default memo(CustomEmoji);
