/**
 * Nameplate — decorative background layer for a member / DM row (Faz G).
 * Render as the row's first child; the host row needs the `cos-np-host`
 * class (position + stacking context). Colours / angle arrive only as
 * validated CSS custom properties; the pattern class comes from the enum
 * allowlist. Fixed 0.35 opacity + scrim live in styles/cosmetics.css.
 */

import { cssVarsForNameplate, nameplateOf } from "../../utils/cosmetics";
import type { EquippedCosmetic } from "../../types/cosmetics";
import "../../styles/cosmetics.css";

type Props = { nameplate?: EquippedCosmetic };

function Nameplate({ nameplate }: Props) {
  const asset = nameplateOf(nameplate);
  if (!asset) return null;
  const stops = asset.stops.length === 3 ? " cos-np--3" : "";
  return (
    <span
      className={`cos-nameplate cos-np-pattern-${asset.pattern}${stops}`}
      style={cssVarsForNameplate(asset)}
      aria-hidden="true"
      data-testid="cos-nameplate"
    />
  );
}

export default Nameplate;
