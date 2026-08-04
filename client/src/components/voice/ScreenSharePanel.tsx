/**
 * ScreenSharePanel — Single screen share video panel.
 *
 * Renders a LiveKit VideoTrack with hover overlay (user name + fullscreen button),
 * Browser Fullscreen API support, and right-click context menu for independent
 * screen share audio volume control.
 */

import { useRef, useState, useEffect, useCallback } from "react";
import { VideoTrack } from "@livekit/components-react";
import type { TrackReferenceOrPlaceholder, TrackReference } from "@livekit/components-react";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "../../stores/authStore";
import { useVoiceStore } from "../../stores/voiceStore";
import { resolveUserId } from "../../utils/constants";
import { requestFullscreenCompat, exitFullscreenCompat, getFullscreenElement } from "../../utils/fullscreenCompat";
import { logToServer } from "../../api/clientLog";
import ScreenShareContextMenu from "./ScreenShareContextMenu";
import ScreenShareViewerChip from "./ScreenShareViewerChip";
import ScreenShareQualityBadge from "./ScreenShareQualityBadge";
import ScreenSharePublisherWarning from "./ScreenSharePublisherWarning";

type ScreenSharePanelProps = {
  trackRef: TrackReferenceOrPlaceholder;
};

function ScreenSharePanel({ trackRef }: ScreenSharePanelProps) {
  const { t } = useTranslation("voice");

  const containerRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // ─── Focus (double-click) ───
  const focusScreenShare = useVoiceStore((s) => s.focusScreenShare);
  const watchingCount = useVoiceStore(
    (s) => Object.keys(s.watchingScreenShares).length
  );

  // ─── Context Menu State ───
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const currentUser = useAuthStore((s) => s.user);
  const realUserId = resolveUserId(trackRef.participant.identity);
  const isLocalUser = realUserId === currentUser?.id;

  useEffect(() => {
    function handleFullscreenChange() {
      setIsFullscreen(document.fullscreenElement === containerRef.current);
    }

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
    };
  }, []);

  // Diagnostic: report when this viewer's panel actually has a track with
  // non-zero dimensions (real frames are arriving), or when it stays at
  // 0×0 by the timeout (publisher is sending, SFU forwarded, we subscribed
  // — but the frames are empty). Skipped for the local user's panel because
  // we deliberately don't render our own video back into the capture.
  useEffect(() => {
    if (isLocalUser) return;
    const sourceTrack = trackRef.publication?.track;
    if (!sourceTrack) return;

    // `dimensions` lives on RemoteVideoTrack / LocalVideoTrack but not on
    // the base Track. The cast is safe here: we only mount this panel for
    // ScreenShare sources, which are always video. Returns undefined on a
    // mismatched track to keep the diagnostic from throwing.
    const readDims = (): { width: number; height: number } | undefined => {
      const d = (sourceTrack as unknown as { dimensions?: { width: number; height: number } }).dimensions;
      if (!d || typeof d.width !== "number" || typeof d.height !== "number") {
        return undefined;
      }
      return d;
    };

    const mountedAt = Date.now();
    let reported = false;
    let cancelled = false;

    function check(): boolean {
      if (cancelled || reported) return true;
      const dims = readDims();
      const w = dims?.width ?? 0;
      const h = dims?.height ?? 0;
      if (w > 0 && h > 0) {
        reported = true;
        logToServer("info", "screen_share_view_first_frame", {
          publisherIdentity: trackRef.participant.identity,
          publisherUserId: realUserId,
          trackSid: trackRef.publication?.trackSid ?? "",
          width: w,
          height: h,
          msSinceMount: Date.now() - mountedAt,
        });
        return true;
      }
      return false;
    }

    if (check()) return;

    const interval = window.setInterval(check, 500);
    // 5 s budget — typical first frame on Windows GDI capture is <500 ms;
    // a 5 s ceiling reliably distinguishes "slow path" from "stuck capture".
    const timeout = window.setTimeout(() => {
      if (!reported) {
        const dims = readDims();
        logToServer("warn", "screen_share_view_no_frames", {
          publisherIdentity: trackRef.participant.identity,
          publisherUserId: realUserId,
          trackSid: trackRef.publication?.trackSid ?? "",
          muted: sourceTrack?.isMuted ?? null,
          width: dims?.width ?? 0,
          height: dims?.height ?? 0,
          msSinceMount: Date.now() - mountedAt,
        });
      }
      window.clearInterval(interval);
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.clearTimeout(timeout);
    };
    // We intentionally re-run when the underlying track identity changes
    // (different publisher or new publication after a restart). publication
    // and track are object refs, so React's referential equality is the
    // right trigger here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackRef.publication, trackRef.publication?.track, isLocalUser]);

  const handleFullscreenToggle = useCallback(() => {
    if (!containerRef.current) return;

    if (getFullscreenElement()) {
      exitFullscreenCompat().catch((err: unknown) => {
        console.error("[ScreenSharePanel] Failed to exit fullscreen:", err);
      });
    } else {
      requestFullscreenCompat(containerRef.current).catch((err: unknown) => {
        console.error("[ScreenSharePanel] Failed to enter fullscreen:", err);
      });
    }
  }, []);

  const displayName = trackRef.participant.name || realUserId;

  // Double-click to focus a single stream when multiple are visible
  const handleDoubleClick = useCallback(() => {
    if (watchingCount > 1) {
      focusScreenShare(realUserId);
    }
  }, [watchingCount, focusScreenShare, realUserId]);

  // Skip context menu for own screen share
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (isLocalUser) return;
      e.preventDefault();
      setCtxMenu({ x: e.clientX, y: e.clientY });
    },
    [isLocalUser]
  );

  return (
    <div ref={containerRef} className="screen-share-panel" onContextMenu={handleContextMenu} onDoubleClick={handleDoubleClick}>
      {/* Broadcaster self-view: showing the video here would feed it back
          into the capture, creating an infinite mirror tunnel. Discord
          (and Zoom, Teams, etc.) substitute a "preview paused, your
          stream is still live" card. The actual video track keeps
          publishing — we just refuse to render it on the publisher's
          own screen. Everyone else still sees the live stream. */}
      {trackRef.publication && !isLocalUser && (
        <VideoTrack trackRef={trackRef as TrackReference} />
      )}
      {isLocalUser && trackRef.publication && (
        <div className="screen-share-self-pause">
          <div className="screen-share-self-pause-card">
            <div className="screen-share-self-pause-title">
              {t("selfPauseTitle", { defaultValue: "Yayının halen devam ediyor" })}
            </div>
            <div className="screen-share-self-pause-desc">
              {t("selfPauseDesc", {
                defaultValue:
                  "Kaynaklarından tasarruf etmek için bu önizlemeyi duraklattık.",
              })}
            </div>
          </div>
        </div>
      )}

      {/* Viewer chip — only on the broadcaster's own panel. Persistent
          (no hover gate) so the broadcaster sees "N watching" at a glance
          even when the hover overlay is hidden. */}
      {isLocalUser && (
        <>
          <ScreenShareViewerChip
            broadcasterUserId={realUserId}
            fullscreenContainerRef={containerRef}
          />
          {/* Encoder limitation banner — only the local broadcaster sees
              this; remote viewers get the quality grade dot instead. The
              component renders nothing when no sustained warning is active. */}
          <ScreenSharePublisherWarning />
        </>
      )}

      {/* Hover overlay with CSS opacity transition */}
      <div className="screen-share-panel-overlay">
        <span className="screen-share-panel-label">{displayName}</span>
        {/* Receiver-side quality grade. Only renders when the remote
            stream has been sampled at least once (~10 s after we start
            watching). Local broadcaster panel shows nothing because we
            don't measure our own outbound here. */}
        {!isLocalUser && <ScreenShareQualityBadge publisherId={realUserId} />}

        <button
          onClick={handleFullscreenToggle}
          className="screen-share-panel-btn"
          title={isFullscreen ? t("exitFullscreen") : t("fullscreen")}
        >
          {isFullscreen ? (
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5l5.25 5.25" />
            </svg>
          ) : (
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
            </svg>
          )}
        </button>
      </div>

      {ctxMenu && (
        <ScreenShareContextMenu
          userId={realUserId}
          displayName={displayName}
          position={ctxMenu}
          onClose={() => setCtxMenu(null)}
          // When this panel is the current fullscreen element, the menu's
          // portal renders inside the panel instead of document.body so it
          // stays visible (Browser Fullscreen API hides everything outside
          // the fullscreen subtree).
          fullscreenContainerRef={containerRef}
        />
      )}
    </div>
  );
}

export default ScreenSharePanel;
