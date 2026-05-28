/**
 * ScreenSharePublisherWarning — actionable banner shown to the local
 * broadcaster when their encoder reports a sustained limitation.
 *
 * Driven by useScreenShareStats: after two consecutive 10 s samples
 * with qualityLimitationReason ∈ {cpu, bandwidth} the hook writes the
 * reason to the store and we render. Hysteresis (2 clean cycles)
 * decides when to clear.
 *
 * The banner is intentionally small and persistent rather than a toast
 * because the situation it describes is ongoing — a 4-second toast
 * would disappear while the bottleneck is still present.
 */

import { useTranslation } from "react-i18next";
import { useVoiceStore } from "../../stores/voiceStore";

const HINT_BY_REASON: Record<"cpu" | "bandwidth", { iconColor: string }> = {
  // amber — user action is possible (switch to low-latency / H264)
  cpu: { iconColor: "#f59e0b" },
  // red — bandwidth issues usually need quality/FPS reduction
  bandwidth: { iconColor: "#ef4444" },
};

function ScreenSharePublisherWarning() {
  const { t } = useTranslation("voice");
  const reason = useVoiceStore((s) => s.screenSharePublisherWarning);

  if (!reason) return null;

  // Same defaultValue pattern as ScreenShareQualityBadge — keys ship
  // with the release, defaultValue protects against an older bundle
  // landing without them (Turkish fallback for both, since this is the
  // primary audience).
  const title = t(
    reason === "cpu"
      ? "publisherWarningCpuTitle"
      : "publisherWarningBandwidthTitle",
    {
      defaultValue:
        reason === "cpu"
          ? "Encoder CPU yetersiz"
          : "Yayın bandwidth'i düşük",
    },
  );
  const hint = t(
    reason === "cpu"
      ? "publisherWarningCpuHint"
      : "publisherWarningBandwidthHint",
    {
      defaultValue:
        reason === "cpu"
          ? "Düşük Gecikme Modu'nu aç (codec'i H264'e geçirir, donanım encode kullanır)."
          : "Çözünürlüğü veya FPS'i düşürmeyi dene.",
    },
  );

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "absolute",
        top: 8,
        left: 8,
        right: 8,
        zIndex: 5,
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        padding: "10px 12px",
        borderRadius: 10,
        background: "rgba(0,0,0,0.78)",
        backdropFilter: "blur(8px)",
        color: "#fff",
        boxShadow: "0 4px 14px rgba(0,0,0,0.35)",
        pointerEvents: "auto",
        fontSize: 12,
        lineHeight: 1.4,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 10,
          height: 10,
          borderRadius: "50%",
          background: HINT_BY_REASON[reason].iconColor,
          boxShadow: `0 0 10px ${HINT_BY_REASON[reason].iconColor}80`,
          flexShrink: 0,
          marginTop: 4,
        }}
      />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 700, marginBottom: 2 }}>{title}</div>
        <div style={{ opacity: 0.85 }}>{hint}</div>
      </div>
    </div>
  );
}

export default ScreenSharePublisherWarning;
