/**
 * ProfileEffectLayer — profile-card overlay effect (Faz G, Karar G-5/G-12).
 * CSS keyframes keyed by the effect enum (no Lottie, no server CSS); the
 * colour is a validated custom property. Not rendered at all under reduced
 * motion or while `active` is false. Decorative: `aria-hidden`, no pointer
 * events.
 */

import { useReducedMotion } from "../../hooks/useReducedMotion";
import { cssVarsForEffect, effectOf } from "../../utils/cosmetics";
import type { EquippedCosmetic } from "../../types/cosmetics";
import "../../styles/cosmetics.css";

type Props = { effect?: EquippedCosmetic; active: boolean };

function ProfileEffectLayer({ effect, active }: Props) {
  const reduceMotion = useReducedMotion();
  const asset = effectOf(effect);
  if (!asset || !active || reduceMotion) return null;
  return (
    <span
      className={`cos-effect cos-effect--${asset.effect}`}
      style={cssVarsForEffect(asset)}
      aria-hidden="true"
      data-testid="cos-effect"
    />
  );
}

export default ProfileEffectLayer;
