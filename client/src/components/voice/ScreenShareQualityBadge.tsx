/**
 * ScreenShareQualityGradeBadge — small dot + tooltip that surfaces the
 * receiver-side quality grade for a given screen-share publisher.
 *
 * Drives the colour from useVoiceStore.screenShareQualityByPublisher,
 * which the useScreenShareReceiverStats hook writes every 10 s. When
 * the store has no entry yet (first ~10 s after subscribe, or the
 * publisher isn't streaming), the component renders nothing instead
 * of guessing.
 *
 * Intent: answer "is the bad quality on MY side, or genuinely a bad
 * stream?" with one glance. The number-heavy log telemetry already
 * exists (Phase 2a/2b); this is the user-facing summary of it.
 */

import { useTranslation } from "react-i18next";
import { useVoiceStore } from "../../stores/voiceStore";
import type { ScreenShareQualityGrade } from "../../stores/slices/voiceScreenShareSlice";

type Props = {
  /** Publisher user ID (after resolveUserId — same key the store uses). */
  publisherId: string;
};

const COLOR: Record<ScreenShareQualityGrade, string> = {
  good: "#22c55e", // green-500
  fair: "#f59e0b", // amber-500
  poor: "#ef4444", // red-500
};

function ScreenShareQualityGradeBadge({ publisherId }: Props) {
  const { t } = useTranslation("voice");
  const quality = useVoiceStore(
    (s) => s.screenShareQualityGradeByPublisher[publisherId],
  );

  if (!quality) return null;

  // The receiver hook gives us a "good | fair | poor" string;
  // i18n keys are paired in voice.json (screenShareQualityGood etc.).
  // Tooltip carries the full label; the dot is the at-a-glance signal.
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

  return (
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
        // Subtle entry — the dot can change color mid-share, opacity
        // glide keeps the eye anchored without yanking focus.
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
          // Soft halo so the dot reads on dim screen-share thumbnails.
          boxShadow: `0 0 6px ${COLOR[quality]}80`,
          transition: "background-color .25s ease, box-shadow .25s ease",
        }}
      />
      {label}
    </span>
  );
}

export default ScreenShareQualityGradeBadge;
