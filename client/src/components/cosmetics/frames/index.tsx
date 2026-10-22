/**
 * First-party avatar frames (Faz G, Karar G-3).
 *
 * Pure JSX — no innerHTML, no external references, no <image>, <use>,
 * <foreignObject> or SMIL. `viewBox` is 120×120 with a transparent centre:
 * the avatar fills the inner 96 px circle (1 / COSMETIC_FRAME_SCALE) and the
 * frame lives in the outer ring. Gradient ids come from `useId()` so several
 * frames on one page never collide. Animated frames (aurora, ember, circuit)
 * only move while the wrapper carries `.cos-frame--animate`; the motion is a
 * CSS keyframe in styles/cosmetics.css, also disabled by
 * `prefers-reduced-motion`.
 */

import { useId, type ComponentType } from "react";
import type { FrameKey } from "../../../types/cosmetics";

/** `useId()` output may contain ":" / "«»" — keep url(#…) references plain. */
function useSvgId(prefix: string): string {
  return `${prefix}${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

const C = 60;

function polar(r: number, deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [C + r * Math.cos(rad), C + r * Math.sin(rad)];
}

const svgProps = {
  viewBox: "0 0 120 120",
  xmlns: "http://www.w3.org/2000/svg",
  focusable: "false" as const,
  "aria-hidden": true as const,
};

function AuroraFrame() {
  const g = useSvgId("cosAurora");
  return (
    <svg {...svgProps} className="cos-frame-svg">
      <defs>
        <linearGradient id={g} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3ee6c4" />
          <stop offset="0.5" stopColor="#7c5cff" />
          <stop offset="1" stopColor="#ff6bb5" />
        </linearGradient>
      </defs>
      <g className="cos-anim-spin">
        <circle cx={C} cy={C} r={54} fill="none" stroke={`url(#${g})`} strokeWidth={6} />
        <circle cx={C} cy={C} r={58} fill="none" stroke={`url(#${g})`} strokeWidth={1.5} strokeDasharray="10 8" opacity={0.7} />
      </g>
    </svg>
  );
}

function EmberFrame() {
  const g = useSvgId("cosEmber");
  const flames = Array.from({ length: 10 }, (_, i) => i * 36);
  return (
    <svg {...svgProps} className="cos-frame-svg">
      <defs>
        <linearGradient id={g} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="#ff3d00" />
          <stop offset="1" stopColor="#ffc400" />
        </linearGradient>
      </defs>
      <circle cx={C} cy={C} r={53} fill="none" stroke={`url(#${g})`} strokeWidth={5} />
      <g className="cos-anim-flicker">
        {flames.map((deg) => {
          const [bx1, by1] = polar(52, deg - 6);
          const [bx2, by2] = polar(52, deg + 6);
          const [tx, ty] = polar(60, deg);
          return <path key={deg} d={`M${bx1} ${by1} Q${tx} ${ty} ${bx2} ${by2} Z`} fill={`url(#${g})`} />;
        })}
      </g>
    </svg>
  );
}

function FrostFrame() {
  const g = useSvgId("cosFrost");
  const spikes = Array.from({ length: 12 }, (_, i) => i * 30);
  return (
    <svg {...svgProps} className="cos-frame-svg">
      <defs>
        <linearGradient id={g} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#e0f7ff" />
          <stop offset="1" stopColor="#5ab8ff" />
        </linearGradient>
      </defs>
      <circle cx={C} cy={C} r={53} fill="none" stroke={`url(#${g})`} strokeWidth={4} />
      {spikes.map((deg) => {
        const [x1, y1] = polar(50, deg);
        const [x2, y2] = polar(59, deg);
        const [lx, ly] = polar(56, deg - 5);
        const [rx, ry] = polar(56, deg + 5);
        const [mx, my] = polar(54, deg);
        return (
          <g key={deg} stroke="#e0f7ff" strokeWidth={1.6} strokeLinecap="round">
            <line x1={x1} y1={y1} x2={x2} y2={y2} />
            <line x1={mx} y1={my} x2={lx} y2={ly} />
            <line x1={mx} y1={my} x2={rx} y2={ry} />
          </g>
        );
      })}
    </svg>
  );
}

function SakuraFrame() {
  const petals = [20, 92, 164, 236, 308];
  return (
    <svg {...svgProps} className="cos-frame-svg">
      <circle cx={C} cy={C} r={53} fill="none" stroke="#ffb3c6" strokeWidth={4} />
      {petals.map((deg) => {
        const [x, y] = polar(54, deg);
        return (
          <g key={deg} transform={`translate(${x} ${y}) rotate(${deg})`}>
            {[0, 72, 144, 216, 288].map((r) => (
              <ellipse key={r} cx={0} cy={-3.2} rx={2.4} ry={3.6} fill="#ffd6e0" transform={`rotate(${r})`} />
            ))}
            <circle cx={0} cy={0} r={1.4} fill="#ff6b9a" />
          </g>
        );
      })}
    </svg>
  );
}

function CircuitFrame() {
  const g = useSvgId("cosCircuit");
  const nodes = Array.from({ length: 8 }, (_, i) => i * 45 + 22.5);
  return (
    <svg {...svgProps} className="cos-frame-svg">
      <defs>
        <linearGradient id={g} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#00f5d4" />
          <stop offset="1" stopColor="#00bbf9" />
        </linearGradient>
      </defs>
      <circle cx={C} cy={C} r={52} fill="none" stroke="#0b3d5c" strokeWidth={5} />
      <circle
        className="cos-anim-dash"
        cx={C}
        cy={C}
        r={52}
        fill="none"
        stroke={`url(#${g})`}
        strokeWidth={2}
        strokeDasharray="14 10"
      />
      {nodes.map((deg) => {
        const [x1, y1] = polar(52, deg);
        const [x2, y2] = polar(58, deg);
        return (
          <g key={deg}>
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#00f5d4" strokeWidth={1.5} />
            <circle cx={x2} cy={y2} r={2} fill="#00f5d4" />
          </g>
        );
      })}
    </svg>
  );
}

function LaurelFrame() {
  const leaves = [100, 118, 136, 154, 172, 190, 208, 226, 244];
  const side = (mirror: boolean) =>
    leaves.map((deg) => {
      const d = mirror ? 180 - deg : deg;
      const [x, y] = polar(54, d);
      return (
        <ellipse
          key={`${mirror ? "r" : "l"}${deg}`}
          cx={x}
          cy={y}
          rx={2.6}
          ry={6}
          fill="#c9a227"
          stroke="#7a5c00"
          strokeWidth={0.6}
          transform={`rotate(${d + (mirror ? -30 : 30)} ${x} ${y})`}
        />
      );
    });
  return (
    <svg {...svgProps} className="cos-frame-svg">
      <path d={`M${polar(54, 96).join(" ")} A54 54 0 0 1 ${polar(54, 250).join(" ")}`} fill="none" stroke="#7a5c00" strokeWidth={1.4} />
      <path d={`M${polar(54, 84).join(" ")} A54 54 0 0 0 ${polar(54, -70).join(" ")}`} fill="none" stroke="#7a5c00" strokeWidth={1.4} />
      {side(false)}
      {side(true)}
    </svg>
  );
}

const FRAME_COMPONENTS: Readonly<Record<FrameKey, ComponentType>> = {
  aurora: AuroraFrame,
  ember: EmberFrame,
  frost: FrostFrame,
  sakura: SakuraFrame,
  circuit: CircuitFrame,
  laurel: LaurelFrame,
};

/** Renders the built-in frame for an allowlisted key (FRAME_COMPONENTS lookup). */
export function FrameArt({ frame }: { frame: FrameKey }) {
  const Frame = FRAME_COMPONENTS[frame];
  return <Frame />;
}
