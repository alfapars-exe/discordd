/**
 * ConnectionQualityIndicator — 3-bar network signal badge for one voice
 * participant.
 *
 * Reads voiceStore.connectionQuality (written by useConnectionQualitySync
 * from the room-level ConnectionQualityChanged event). When the store has
 * no entry for this identity — the normal state for the first seconds of
 * every call — the component renders NOTHING rather than an empty meter.
 * An always-visible indicator that starts out blank reads as "your
 * connection is broken" on a call that is perfectly fine.
 *
 * Bar mapping: excellent = 3, good = 2, poor = 1, lost = 0 + red.
 * All three slots are always drawn (unlit ones dimmed) so the badge keeps
 * a constant width and the tile doesn't reflow as quality fluctuates.
 *
 * Layout follows the .voice-participant-overlay convention — an absolutely
 * positioned pill on the avatar, with a compact variant driven by the
 * parent tile's class. It sits top-right instead of bottom-right so it
 * never collides with the mute/deafen overlay, which owns that corner.
 */

import { useTranslation } from "react-i18next";
import { useVoiceStore, type ConnectionQualityLevel } from "../../stores/voiceStore";

type Props = {
  /** LiveKit participant identity — same key the store is keyed by. */
  identity: string;
};

const FILLED_BARS: Record<ConnectionQualityLevel, number> = {
  excellent: 3,
  good: 2,
  poor: 1,
  lost: 0,
};

const LABEL_KEY: Record<ConnectionQualityLevel, string> = {
  excellent: "connectionQualityExcellent",
  good: "connectionQualityGood",
  poor: "connectionQualityPoor",
  lost: "connectionQualityLost",
};

// TR defaults inline so the badge still reads correctly if a locale bundle
// fails to load — same pattern as ScreenShareQualityBadge.
const LABEL_FALLBACK: Record<ConnectionQualityLevel, string> = {
  excellent: "Bağlantı: mükemmel",
  good: "Bağlantı: iyi",
  poor: "Bağlantı: zayıf",
  lost: "Bağlantı: koptu",
};

const BAR_HEIGHTS = [5, 8, 11];

function ConnectionQualityIndicator({ identity }: Readonly<Props>) {
  const { t } = useTranslation("voice");
  const quality = useVoiceStore((s) => s.connectionQuality[identity]);

  // No measurement yet (or participant already gone) — draw nothing.
  if (!quality) return null;

  const filled = FILLED_BARS[quality];
  const label = t(LABEL_KEY[quality], { defaultValue: LABEL_FALLBACK[quality] });
  const isLost = quality === "lost";

  return (
    <span
      className={`voice-participant-quality${isLost ? " lost" : ""}`}
      role="img"
      aria-label={label}
      title={label}
    >
      {BAR_HEIGHTS.map((height, i) => (
        <span
          key={height}
          data-cq-bar={i < filled ? "filled" : "empty"}
          className={i < filled ? "cq-bar filled" : "cq-bar"}
          style={{ height }}
        />
      ))}
    </span>
  );
}

export default ConnectionQualityIndicator;
