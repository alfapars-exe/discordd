/**
 * StickerImage — renders one server sticker from its deterministic URL
 * (Faz D2, Karar D2-20; CustomEmoji pattern).
 *
 * - The URL is built only from a regex-validated 16-hex id; `name` is used
 *   for alt/title/fallback text only.
 * - Animated stickers play by default; with reduced motion the static PNG is
 *   shown and the GIF plays on hover. `still` forces the PNG (picker).
 * - A failed load (deleted/unknown sticker) falls back ONCE to `[name]`
 *   text — no retry loop.
 */

import { memo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useReducedMotion } from "../../hooks/useReducedMotion";
import { resolveAssetUrl } from "../../utils/constants";
import { STICKER_ID, stickerAnimatedUrl, stickerStaticUrl } from "../../utils/stickerTokens";
import "../../styles/expressions.css";

export type StickerImageSize = "message" | "picker" | "settings";

type StickerImageProps = {
  id: string;
  name: string;
  animated: boolean;
  /** Always show the static PNG (picker / settings). */
  still?: boolean;
  size?: StickerImageSize;
};

function StickerImage({ id, name, animated, still = false, size = "message" }: StickerImageProps) {
  const { t } = useTranslation("expressions");
  const reducedMotion = useReducedMotion();
  const [failed, setFailed] = useState(false);
  const [hovered, setHovered] = useState(false);

  if (failed || !STICKER_ID.test(id)) {
    return <span className="msg-sticker-fallback">{t("stickerFallback", { name })}</span>;
  }

  const hoverToPlay = animated && !still && reducedMotion;
  const playing = animated && !still && (!reducedMotion || hovered);
  const src = resolveAssetUrl(playing ? stickerAnimatedUrl(id) : stickerStaticUrl(id));

  return (
    <img
      className={`msg-sticker msg-sticker-${size}`}
      src={src}
      alt={t("stickerAlt", { name })}
      title={name}
      draggable={false}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      onMouseEnter={hoverToPlay ? () => setHovered(true) : undefined}
      onMouseLeave={hoverToPlay ? () => setHovered(false) : undefined}
    />
  );
}

export default memo(StickerImage);
