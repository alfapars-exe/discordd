/**
 * LightningOverlay — animated neon lightning bolts that flicker across
 * the central content area for the "havalı uygulama" vibe the user asked
 * for. Pure SVG + CSS, no canvas, no images. Reads the user's
 * reduce-motion accessibility preference and disables itself when set.
 *
 * Tunable knobs at the top of the file:
 *   - BOLTS: how many strikes
 *   - COLORS: cycle palette
 *   - PATHS: SVG path data for the jagged bolt shapes
 *
 * Each bolt picks a random color/path/delay/x-position at mount so the
 * effect doesn't look mechanical. The strike animation is a 700ms flash:
 * the path "draws" from top to tail via stroke-dashoffset, holds for a
 * frame, then fades out. Between strikes the bolt is fully transparent
 * for 11–22 seconds so the central area stays readable.
 *
 * Lives inside .main-area (position: relative already), inset:0,
 * pointer-events: none, z-index just above content but below modals.
 */

import { useMemo } from "react";

const COLORS = ["#3b82f6", "#a855f7", "#22d3ee", "#ec4899"];

/**
 * Hand-tuned jagged paths in a 0–100 viewBox. The viewBox uses
 * `preserveAspectRatio="none"` on the parent so paths stretch to fill
 * the container regardless of aspect ratio — bolts always traverse the
 * full visible height.
 */
const PATHS = [
  "M50 0 L46 18 L54 22 L42 42 L52 48 L38 70 L48 75 L34 100",
  "M50 0 L55 14 L43 24 L58 38 L40 52 L60 66 L42 82 L56 100",
  "M50 0 L48 12 L62 20 L46 36 L60 50 L44 66 L58 80 L40 100",
  "M50 0 L52 16 L40 28 L56 44 L38 60 L54 76 L40 92 L50 100",
];

type BoltConfig = {
  id: number;
  path: string;
  color: string;
  xPercent: number;
  delaySeconds: number;
  cycleSeconds: number;
};

function pickBolts(count: number): BoltConfig[] {
  const bolts: BoltConfig[] = [];
  for (let i = 0; i < count; i++) {
    const cycle = 14 + Math.random() * 10; // 14–24 s per strike cycle
    bolts.push({
      id: i,
      path: PATHS[Math.floor(Math.random() * PATHS.length)],
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      xPercent: 8 + Math.random() * 84, // 8–92 %
      delaySeconds: Math.random() * cycle, // desync starts
      cycleSeconds: cycle,
    });
  }
  return bolts;
}

const BOLT_COUNT = 5;

function LightningOverlay() {
  // Bolts are randomised once per mount — re-rolling on every render
  // would cause the entire SVG to flicker on any state change anywhere
  // in the parent tree.
  const bolts = useMemo(() => pickBolts(BOLT_COUNT), []);

  return (
    <div className="lightning-overlay" aria-hidden="true">
      {bolts.map((b) => (
        <svg
          key={b.id}
          className="lightning-bolt"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          style={{
            left: `${b.xPercent}%`,
            color: b.color,
            animationDelay: `${b.delaySeconds}s`,
            animationDuration: `${b.cycleSeconds}s`,
          }}
        >
          {/* Outer wide stroke gives the diffuse halo, inner stroke is
              the bright core. Both share the same path so they always
              animate in sync. */}
          <path
            className="bolt-glow"
            d={b.path}
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
          <path
            className="bolt-core"
            d={b.path}
            stroke="currentColor"
            strokeWidth="0.45"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      ))}
    </div>
  );
}

export default LightningOverlay;
