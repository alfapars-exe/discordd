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
 * Hand-tuned lightning paths in a 0–100 viewBox. Each path is a single
 * SVG `d` string with multiple M-L subpaths — the first subpath is the
 * main jagged trunk (many short segments at sharp alternating angles,
 * like real lightning, not a soft sine wave), and the trailing M
 * subpaths are side branches that fork off mid-trunk. Stroke-dashoffset
 * animates the whole concatenated length, so the trunk draws first and
 * the branches "spawn" a moment later — exactly the strike rhythm.
 *
 * The viewBox parent uses `preserveAspectRatio="none"` so each bolt
 * stretches to the container's full height regardless of width.
 */
const PATHS = [
  // Bolt A — main trunk + right fork mid-way + left tail fork
  "M50 0 L44 7 L56 12 L42 19 L58 25 L46 32 L60 39 L48 46 L62 54 L50 61 L66 68 L52 75 L60 83 L46 90 L58 100 M62 54 L78 58 L70 64 L82 70 M52 75 L36 79 L42 86",
  // Bolt B — left-leaning, two right branches
  "M50 0 L54 8 L40 15 L52 23 L38 31 L50 39 L34 47 L46 55 L32 63 L44 71 L30 79 L42 87 L36 95 L48 100 M50 23 L66 27 L58 33 M44 55 L62 60 L54 66 L70 70",
  // Bolt C — heavy zig-zag, no large bends, branch near top
  "M50 0 L46 5 L54 9 L44 14 L56 19 L42 25 L58 31 L46 37 L60 43 L48 49 L62 56 L50 62 L64 69 L52 76 L60 84 L48 91 L54 100 M58 31 L74 35 L66 40 L80 44",
  // Bolt D — twin-trunk look (main + heavy secondary that mirrors)
  "M50 0 L52 8 L42 14 L56 20 L44 28 L58 34 L46 42 L60 50 L48 58 L62 66 L50 74 L64 82 L52 90 L60 100 M44 28 L30 32 L38 38 L26 44 L34 50 M62 66 L78 70 L70 76",
  // Bolt E — sharp angular, branches on both sides
  "M50 0 L55 6 L45 11 L57 17 L43 23 L55 29 L41 35 L53 42 L39 49 L51 56 L37 63 L49 70 L35 77 L47 84 L41 92 L51 100 M53 42 L68 46 L60 52 M47 70 L31 74 L39 80",
  // Bolt F — narrow channel, dense zig-zags, small forks
  "M50 0 L47 5 L53 9 L46 13 L54 18 L47 22 L55 28 L46 33 L54 39 L47 44 L55 50 L46 56 L54 62 L47 68 L55 75 L46 82 L54 88 L48 94 L52 100 M53 28 L62 31 L57 36 M54 62 L65 66 L58 71",
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
    // Per-bolt cycle 2.5–5 s. With BOLT_COUNT=7 staggered desyncs that
    // averages ~one strike every 0.5 s across the overlay — dense
    // "thunderstorm" feel without being a single epileptic strobe
    // (multiple desynced bolts read as a storm, not a flicker).
    const cycle = 2.5 + Math.random() * 2.5;
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

const BOLT_COUNT = 7;

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
