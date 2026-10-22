/** ProfileHero — top of the profile card: banner image, else the user's
 *  accent colour, else the default gradient, with the avatar overlapping
 *  its bottom edge. Presentational; shared by MemberCardIdentity and the
 *  Settings → Profile preview.
 *
 *  Cosmetics (Faz G, Karar G-12), all optional — without them the output is
 *  unchanged: banner image > profile-theme gradient > accent colour >
 *  default; the theme's accent feeds `--mc-accent` when the user set none;
 *  an avatar frame wraps the avatar; a profile effect overlays the hero. */

import type { CSSProperties } from "react";
import Avatar from "../../shared/Avatar";
import DecoratedAvatar from "../../cosmetics/DecoratedAvatar";
import ProfileEffectLayer from "../../cosmetics/ProfileEffectLayer";
import { resolveAssetUrl } from "../../../utils/constants";
import { cssVarsForTheme, themeOf } from "../../../utils/cosmetics";
import { useReducedMotion } from "../../../hooks/useReducedMotion";
import type { EquippedCosmetic } from "../../../types/cosmetics";
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
  frame?: EquippedCosmetic;
  theme?: EquippedCosmetic;
  effect?: EquippedCosmetic;
  effectActive?: boolean;
};

function ProfileHero({
  name,
  avatarUrl,
  animatedUrl,
  bannerUrl,
  accentColor,
  animate,
  size = 80,
  frame,
  theme,
  effect,
  effectActive = false,
}: Props) {
  // An open card autoplays its animated avatar, but under Reduce Motion it
  // only plays on hover (the Avatar's own hover handling).
  const reduceMotion = useReducedMotion();
  const accent = accentColor && ACCENT_RE.test(accentColor) ? accentColor : null;
  const themeAsset = themeOf(theme);
  const heroStyle = {
    "--mc-avatar-size": `${size}px`,
    ...(themeAsset && !accent ? { "--mc-accent": themeAsset.accent } : {}),
  } as CSSProperties;

  const avatarProps = {
    name,
    avatarUrl,
    animatedUrl,
    animate: !!animate && !reduceMotion,
    size,
    isCircle: true,
  };

  return (
    <div className={`mc-hero${themeAsset ? " cos-hero--themed" : ""}`} style={heroStyle} data-testid="mc-hero">
      {bannerUrl ? (
        <img className="mc-hero-banner" src={resolveAssetUrl(bannerUrl)} alt="" />
      ) : themeAsset ? (
        <div className="mc-hero-banner cos-hero-theme" style={cssVarsForTheme(themeAsset)} />
      ) : accent ? (
        <div
          className="mc-hero-banner mc-hero-accent"
          style={{ "--mc-accent": accent } as CSSProperties}
        />
      ) : (
        <div className="mc-hero-banner" />
      )}
      <ProfileEffectLayer effect={effect} active={effectActive} />
      <div className="mc-avatar-ring">
        {frame ? (
          <DecoratedAvatar {...avatarProps} frame={frame} animateFrame={!!animate && !reduceMotion} />
        ) : (
          <Avatar {...avatarProps} />
        )}
      </div>
    </div>
  );
}

export default ProfileHero;
