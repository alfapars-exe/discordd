import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { visibleOverlayGameActivityNotices, type OverlayGameActivityNotice } from "../../../../electron/voice-overlay-contract";

type Props = {
  gameActivityNotices?: OverlayGameActivityNotice[];
  voiceOverlayGameActivityNotifications?: boolean;
  voiceOverlayNowPlayingNotifications?: boolean;
  height: number; bottom: number;
};
/** Passive display only: no user/source identifier, anchor, button or navigation API. */
export default function GameActivityNotices(props: Props) {
  const { t } = useTranslation("common");
  const [now, setNow] = useState(() => Date.now());
  const height = Number.isInteger(props.height) && props.height >= 0 && props.height <= 144 ? props.height : 0;
  const notices = visibleOverlayGameActivityNotices(props, now).slice(0, Math.floor(height / 48));
  useEffect(() => { queueMicrotask(() => setNow(Date.now())); }, [props.gameActivityNotices]);
  const expires = notices.length ? Math.min(...notices.map(notice => notice.expiresAt)) : 0;
  useEffect(() => {
    if (!expires) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(1, expires - Date.now()));
    return () => window.clearTimeout(timer);
  }, [expires]);
  if (!notices.length || !Number.isFinite(props.bottom) || props.bottom < 0) return null;
  return <section className="voice-overlay-game-notices" role="status" aria-live="polite"
    style={{ position: "absolute", bottom: props.bottom, left: 8, right: 8, height, maxHeight: 144, boxSizing: "border-box", overflow: "hidden", pointerEvents: "none", borderRadius: 6, background: "rgba(12,14,20,.96)", color: "#f4f6fb" }}>
    {notices.map(notice => <div key={notice.noticeId} title={t("gameActivitySelfReported")} style={{ boxSizing: "border-box", height: 48, padding: "5px 6px", overflow: "hidden", fontSize: 12, lineHeight: "18px" }}>
      <strong style={{ display: "block", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{t(notice.kind === "game_activity" ? "overlayGameActivityNotice" : "overlayNowPlayingNotice", { name: notice.label })}</strong>
      <span style={{ display: "block", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{notice.gameName}</span>
    </div>)}
  </section>;
}
