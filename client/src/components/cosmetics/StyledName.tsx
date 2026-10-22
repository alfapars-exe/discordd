/**
 * StyledName — a display name with an optional name style (Faz G, G-10/G-11).
 *
 * Font class from the enum allowlist (bundled Manrope 600 / 800, Source Code
 * Pro 500 — no remote fonts), colours as validated CSS custom properties,
 * gradient via `background-clip: text`. The style is only applied when every
 * sample is readable (WCAG ≥ 4.5) on the ACTIVE theme's `--bg-1`; otherwise
 * (e.g. the light theme) the name falls back to `fallbackColor` / default.
 * The name itself is always a plain React text node.
 */

import type { CSSProperties } from "react";
import { useThemeBackground } from "../../hooks/useThemeBackground";
import { cssVarsForNameStyle, nameStyleOf } from "../../utils/cosmetics";
import { nameStyleReadable } from "../../utils/cosmeticContrast";
import type { EquippedCosmetic } from "../../types/cosmetics";
import "../../styles/cosmetics.css";

type Props = {
  name: string;
  style?: EquippedCosmetic;
  fallbackColor?: string | null;
};

function StyledName({ name, style, fallbackColor }: Props) {
  const bg = useThemeBackground();
  const asset = nameStyleOf(style);

  if (!asset || !nameStyleReadable(asset.stops, bg)) {
    return (
      <span className="cos-name-plain" style={fallbackColor ? { color: fallbackColor } : undefined}>
        {name}
      </span>
    );
  }

  const gradient = asset.stops.length > 1 ? " cos-name--gradient" : "";
  return (
    <span
      className={`cos-name cos-font-${asset.font}${gradient}`}
      style={cssVarsForNameStyle(asset) as CSSProperties}
      data-testid="cos-name"
    >
      {name}
    </span>
  );
}

export default StyledName;
