/**
 * DecoratedAvatar — wraps the shared <Avatar> (unchanged) with an optional
 * avatar frame (Faz G, Karar G-12).
 *
 * The frame is a decorative overlay: COSMETIC_FRAME_SCALE × the avatar,
 * centred, `pointer-events: none`, `aria-hidden`. Built-in frames are
 * bundled JSX (frames/index.tsx); a server-made raster frame (G2) is only
 * shown when its URL matches the exact upload shape. Motion only while
 * `animateFrame` is set and the viewer has not asked for reduced motion
 * (`hover` = animate while the hosting row is hovered, CSS-driven).
 */

import type { CSSProperties, ComponentProps, ReactNode } from "react";
import Avatar from "../shared/Avatar";
import { FrameArt } from "./frames";
import { useReducedMotion } from "../../hooks/useReducedMotion";
import { resolveAssetUrl } from "../../utils/constants";
import {
  COSMETIC_FRAME_SCALE,
  RASTER_FRAME_ANIMATED_URL,
  RASTER_FRAME_URL,
  frameOf,
} from "../../utils/cosmetics";
import type { EquippedCosmetic } from "../../types/cosmetics";
import "../../styles/cosmetics.css";

type Props = ComponentProps<typeof Avatar> & {
  frame?: EquippedCosmetic;
  /** true = play now; "hover" = play while the hosting row is hovered. */
  animateFrame?: boolean | "hover";
};

function DecoratedAvatar({ frame, animateFrame = false, ...avatarProps }: Props) {
  const reduceMotion = useReducedMotion();
  const parsed = frameOf(frame);
  const size = avatarProps.size ?? 30;

  if (!parsed) return <Avatar {...avatarProps} />;

  const frameSize = Math.round(size * COSMETIC_FRAME_SCALE);
  const offset = (frameSize - size) / 2;
  const canAnimate = !!frame?.animated && !reduceMotion;
  const motionClass =
    canAnimate && animateFrame === true ? " cos-frame--animate" : canAnimate && animateFrame === "hover" ? " cos-frame--hoverable" : "";

  const frameStyle: CSSProperties = {
    width: frameSize,
    height: frameSize,
    top: -offset,
    left: -offset,
  };

  let overlay: ReactNode = null;
  if (parsed.kind === "frame_svg") {
    overlay = <FrameArt frame={parsed.asset.frame} />;
  } else if (RASTER_FRAME_URL.test(parsed.asset.url)) {
    const animated = parsed.asset.animated_url;
    const useAnimated =
      animateFrame === true && !reduceMotion && typeof animated === "string" && RASTER_FRAME_ANIMATED_URL.test(animated);
    overlay = (
      <img
        className="cos-frame-img"
        src={resolveAssetUrl(useAnimated ? animated : parsed.asset.url)}
        alt=""
        draggable={false}
        decoding="async"
        loading="lazy"
      />
    );
  }

  return (
    <span className="cos-avatar" style={{ width: size, height: size }} data-testid="cos-avatar">
      <Avatar {...avatarProps} />
      {overlay && (
        <span className={`cos-frame${motionClass}`} style={frameStyle} aria-hidden="true" data-testid="cos-frame">
          {overlay}
        </span>
      )}
    </span>
  );
}

export default DecoratedAvatar;
