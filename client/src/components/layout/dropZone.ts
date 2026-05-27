/**
 * dropZone — Drop-zone geometry helpers, split out of
 * DropZoneOverlay.tsx so that file stays component-only (required by
 * react-refresh/only-export-components for HMR boundaries).
 */

export type DropZone = "left" | "right" | "top" | "bottom" | "center";

/**
 * Determines which zone the cursor is in based on relative distance
 * to each edge. Closest edge within 25% threshold wins; otherwise center.
 */
export function calculateZone(
  clientX: number,
  clientY: number,
  rect: DOMRect,
): DropZone {
  const relX = (clientX - rect.left) / rect.width;
  const relY = (clientY - rect.top) / rect.height;

  const distLeft = relX;
  const distRight = 1 - relX;
  const distTop = relY;
  const distBottom = 1 - relY;

  const minDist = Math.min(distLeft, distRight, distTop, distBottom);
  const threshold = 0.25;

  if (minDist >= threshold) return "center";
  if (minDist === distLeft) return "left";
  if (minDist === distRight) return "right";
  if (minDist === distTop) return "top";
  return "bottom";
}
