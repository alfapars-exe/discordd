/**
 * ScreenShareQualityBadge — small dot + tooltip that surfaces the
 * receiver-side quality grade for a given screen-share publisher.
 *
 * Drives the colour from useVoiceStore.screenShareQualityGradeByPublisher,
 * which the useScreenShareReceiverStats hook writes every 10 s. When
 * the store has no entry yet (first ~10 s after subscribe, or the
 * publisher isn't streaming), the component renders nothing instead
 * of guessing.
 *
 * Hover reveals a small "last 60 s" history strip + kbps sparkline so
 * the viewer can tell "was the stream always poor, or did it just dip?"
 * without leaving the panel.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useVoiceStore } from "../../stores/voiceStore";
import type {
  ScreenShareQualityGrade,
  ScreenShareQualityHistoryPoint,
} from "../../stores/slices/voiceScreenShareSlice";

type Props = {
  /** Publisher user ID (after resolveUserId — same key the store uses). */
  publisherId: string;
};

const COLOR: Record<ScreenShareQualityGrade, string> = {
  good: "#22c55e", // green-500
  fair: "#f59e0b", // amber-500
  poor: "#ef4444", // red-500
};

/**
 * Build a polyline path for the kbps mini-sparkline. Range is the
 * window's min..max so a steady stream with small variance still shows
 * a readable line instead of a flat horizontal.
 */
function sparklinePath(
  history: ScreenShareQualityHistoryPoint[],
  width: number,
  height: number,
): string {
  if (history.length < 2) return "";
  const kbpsValues = history.map((p) => p.kbps);
  const min = Math.min(...kbpsValues);
  const max = Math.max(...kbpsValues);
  const span = Math.max(1, max - min); // avoid div-by-zero on flat lines
  const stepX = width / Math.max(1, history.length - 1);

  return history
    .map((p, i) => {
      const x = i * stepX;
      // Invert Y because SVG y grows downward but higher kbps should sit up.
      const y = height - ((p.kbps - min) / span) * height;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function ScreenShareQualityBadge({ publisherId }: Props) {
  const { t } = useTranslation("voice");
  const quality = useVoiceStore(
    (s) => s.screenShareQualityGradeByPublisher[publisherId],
  );
  const history = useVoiceStore(
    (s) => s.screenShareQualityHistoryByPublisher[publisherId],
  );
  const [hovered, setHovered] = useState(false);

  if (!quality) return null;

  const label = t(
    quality === "good"
      ? "screenShareQualityGood"
      : quality === "fair"
        ? "screenShareQualityFair"
        : "screenShareQualityPoor",
    {
      defaultValue:
        quality === "good"
          ? "Kalite: iyi"
          : quality === "fair"
            ? "Kalite: orta"
            : "Kalite: düşük",
    },
  );

  // Tooltip math: keep it tightly scoped so a flat history doesn't try
  // to render a 0-width sparkline. History is guaranteed to exist when
  // quality does, because the receiver hook writes both together — but
  // the optional chain is defensive against a rare ordering race.
  const points = history ?? [];
  const lastSec =
    points.length > 0 ? Math.round((points[points.length - 1].t - points[0].t) / 1000) : 0;
  const kbpsValues = points.map((p) => p.kbps);
  const avgKbps =
    kbpsValues.length > 0
      ? Math.round(kbpsValues.reduce((a, b) => a + b, 0) / kbpsValues.length)
      : 0;
  const stripWidth = 160;
  const stripHeight = 22;
  const sparkW = 160;
  const sparkH = 28;

  return (
    <span
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ position: "relative", display: "inline-flex" }}
    >
      <span
        title={label}
        aria-label={label}
        role="status"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "2px 8px 2px 6px",
          borderRadius: 999,
          background: "rgba(0,0,0,0.45)",
          backdropFilter: "blur(4px)",
          color: "#fff",
          fontSize: 11,
          fontWeight: 600,
          lineHeight: 1,
          cursor: "default",
          transition: "background-color .25s ease",
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: COLOR[quality],
            boxShadow: `0 0 6px ${COLOR[quality]}80`,
            transition: "background-color .25s ease, box-shadow .25s ease",
          }}
        />
        {label}
      </span>

      {hovered && points.length >= 2 && (
        <div
          role="tooltip"
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            marginTop: 6,
            zIndex: 6,
            padding: "10px 12px",
            borderRadius: 10,
            background: "rgba(10,10,12,0.92)",
            backdropFilter: "blur(8px)",
            color: "#fff",
            boxShadow: "0 4px 14px rgba(0,0,0,0.45)",
            fontSize: 11,
            fontWeight: 500,
            lineHeight: 1.4,
            pointerEvents: "none",
            // Constrain so an over-long publisher name in another popup
            // doesn't bleed; the strip + sparkline have fixed widths.
            width: stripWidth + 24,
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 6, fontSize: 11 }}>
            {t("screenShareQualityHistoryTitle", {
              seconds: lastSec,
              defaultValue: "Son {{seconds}}s kalite",
            })}
          </div>

          {/* Color-strip: one cell per history sample (left = oldest) */}
          <div
            aria-hidden="true"
            style={{
              display: "flex",
              gap: 2,
              width: stripWidth,
              height: stripHeight,
              borderRadius: 4,
              overflow: "hidden",
              marginBottom: 8,
            }}
          >
            {points.map((p, i) => (
              <span
                key={i}
                title={`${new Date(p.t).toLocaleTimeString()} — ${p.kbps} kbps`}
                style={{
                  flex: 1,
                  background: COLOR[p.grade],
                  boxShadow: "inset 0 -2px 0 rgba(0,0,0,0.15)",
                }}
              />
            ))}
          </div>

          {/* kbps sparkline — emphasises trend over absolute value */}
          <svg
            width={sparkW}
            height={sparkH}
            aria-hidden="true"
            style={{ display: "block", marginBottom: 4 }}
          >
            <path
              d={sparklinePath(points, sparkW, sparkH)}
              stroke="#ffffff"
              strokeWidth="1.6"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <div style={{ opacity: 0.75 }}>
            {t("screenShareQualityHistoryAvg", {
              kbps: avgKbps,
              defaultValue: "Ortalama: {{kbps}} kbps",
            })}
          </div>
        </div>
      )}
    </span>
  );
}

export default ScreenShareQualityBadge;
