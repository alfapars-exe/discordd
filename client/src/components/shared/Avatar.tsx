/** Avatar — Role-based gradient avatar with image or initial fallback. */

import { useState } from "react";
import { resolveAssetUrl } from "../../utils/constants";
import { useSettingsStore } from "../../stores/settingsStore";
import { useReducedMotion } from "../../hooks/useReducedMotion";

type AvatarProps = {
  name: string;
  role?: "admin" | "mod" | null;
  avatarUrl?: string | null;
  /** Optional animated GIF. `avatarUrl` is always the static poster; the
   *  animated file is only requested while the avatar is playing. */
  animatedUrl?: string | null;
  /** Parent-driven play signal (e.g. the whole member row is hovered, or the
   *  profile card is open). Plays regardless of the viewer's mode. */
  animate?: boolean;
  size?: number;
  isCircle?: boolean;
  /** True when the consumer renders the name next to the avatar. Lighthouse
   * audit (Mayıs 28 2026) flagged `alt={name}` as "redundant alt text" in the
   * member list and user bar — screen readers read the name twice. Default
   * true matches the common case (lists, headers, user bar). Set false for
   * standalone avatars where the alt is the only label. */
  hasAdjacentLabel?: boolean;
};

function getGradientClass(role?: "admin" | "mod" | null): string {
  switch (role) {
    case "admin":
      return "av-admin";
    case "mod":
      return "av-mod";
    default:
      return "av-default";
  }
}

function Avatar({
  name,
  role,
  avatarUrl,
  animatedUrl,
  animate = false,
  size = 30,
  isCircle = true,
  hasAdjacentLabel = true,
}: AvatarProps) {
  const roundClass = isCircle ? "avatar avatar-round" : "avatar";
  const fontSize = size * 0.37;
  const mode = useSettingsStore((s) => s.avatarAnimation);
  const reduceMotion = useReducedMotion();
  const [hovered, setHovered] = useState(false);

  if (avatarUrl) {
    // Autoplay ("always") is suppressed under Reduce Motion; hover and the
    // parent `animate` signal are treated as user intent and still play
    // (callers that open a context on their own gate `animate` themselves).
    const autoplay = mode === "always" && !reduceMotion;
    const playing = !!animatedUrl && (animate || hovered || autoplay);
    const src = playing && animatedUrl ? animatedUrl : avatarUrl;
    return (
      <img
        src={resolveAssetUrl(src)}
        alt={hasAdjacentLabel ? "" : name}
        // role="presentation" reinforces empty alt for older assistive tech
        // when the adjacent label is the canonical announcement.
        {...(hasAdjacentLabel ? { role: "presentation" } : {})}
        loading="lazy"
        decoding="async"
        className={roundClass}
        style={{ width: size, height: size, objectFit: "cover" }}
        {...(animatedUrl
          ? { onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false) }
          : {})}
      />
    );
  }

  return (
    <div
      className={`${roundClass} ${getGradientClass(role)}`}
      style={{ width: size, height: size, fontSize }}
    >
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

export default Avatar;
