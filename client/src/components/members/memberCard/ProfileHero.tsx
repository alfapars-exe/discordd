/** ProfileHero — top of the profile card: banner image, else the user's
 *  accent colour, else the default gradient, with the avatar overlapping
 *  its bottom edge. Presentational; shared by MemberCardIdentity and the
 *  Settings → Profile preview. */

import type { CSSProperties } from "react";
import Avatar from "../../shared/Avatar";
import { resolveAssetUrl } from "../../../utils/constants";
import { useReducedMotion } from "../../../hooks/useReducedMotion";
import "../../../styles/profile.css";

/** Only a strict `#rrggbb` ever reaches a CSS custom property — the value is
 *  user-supplied (server validates too; this is the client-side guard). */
const ACCENT_RE = /^#[0-9a-f]{6}$/i;

type Props = {
  name: string;
  avatarUrl?: string | null;
  animatedUrl?: string | null;
  bannerUrl?: string | null;
  accentColor?: string | null;
  animate?: boolean;
  size?: number;
};

function ProfileHero({
  name,
  avatarUrl,
  animatedUrl,
  bannerUrl,
  accentColor,
  animate,
  size = 80,
}: Props) {
  // An open card autoplays its animated avatar, but under Reduce Motion it
  // only plays on hover (the Avatar's own hover handling).
  const reduceMotion = useReducedMotion();
  const accent = accentColor && ACCENT_RE.test(accentColor) ? accentColor : null;

  return (
    <div
      className="mc-hero"
      style={{ "--mc-avatar-size": `${size}px` } as CSSProperties}
      data-testid="mc-hero"
    >
      {bannerUrl ? (
        <img className="mc-hero-banner" src={resolveAssetUrl(bannerUrl)} alt="" />
      ) : accent ? (
        <div
          className="mc-hero-banner mc-hero-accent"
          style={{ "--mc-accent": accent } as CSSProperties}
        />
      ) : (
        <div className="mc-hero-banner" />
      )}
      <div className="mc-avatar-ring">
        <Avatar
          name={name}
          avatarUrl={avatarUrl}
          animatedUrl={animatedUrl}
          animate={!!animate && !reduceMotion}
          size={size}
          isCircle
        />
      </div>
    </div>
  );
}

export default ProfileHero;
