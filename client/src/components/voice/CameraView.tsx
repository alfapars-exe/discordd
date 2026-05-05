/**
 * CameraView — Renders all active camera tracks in the voice room's central
 * featured area. Mirrors ScreenShareView's layout logic (1=full, 2=split with
 * resize, 3+=2-column grid) but auto-shows every published camera (no opt-in).
 *
 * Priority: when any screen share is being watched, this component returns
 * null so ScreenShareView keeps the central area to itself.
 *
 * CSS classes are reused from screen-share styling — the rendered video tile
 * is identical, only the source state differs.
 */
import { useState, useRef, useCallback, useEffect } from "react";
import { useTracks, VideoTrack } from "@livekit/components-react";
import type { TrackReferenceOrPlaceholder, TrackReference } from "@livekit/components-react";
import { Track } from "livekit-client";
import { useTranslation } from "react-i18next";
import { useVoiceStore } from "../../stores/voiceStore";
import ScreenShareResizeHandle from "./ScreenShareResizeHandle";

type LayoutMode = "vertical" | "horizontal";

const MIN_RATIO = 20;
const MAX_RATIO = 80;
const DEFAULT_RATIO = 50;

function CameraPanel({ trackRef }: Readonly<{ trackRef: TrackReferenceOrPlaceholder }>) {
  const { t } = useTranslation("voice");
  const containerRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    function handleFullscreenChange() {
      setIsFullscreen(document.fullscreenElement === containerRef.current);
    }
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  const handleFullscreenToggle = useCallback(() => {
    if (!containerRef.current) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch((err: unknown) => {
        console.error("[CameraPanel] exit fullscreen failed:", err);
      });
    } else {
      containerRef.current.requestFullscreen().catch((err: unknown) => {
        console.error("[CameraPanel] enter fullscreen failed:", err);
      });
    }
  }, []);

  const displayName = trackRef.participant.name || trackRef.participant.identity;

  return (
    <div ref={containerRef} className="screen-share-panel">
      {trackRef.publication && <VideoTrack trackRef={trackRef as TrackReference} />}

      <div className="screen-share-panel-overlay">
        <span className="screen-share-panel-label">{displayName}</span>

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
    </div>
  );
}

function CameraView() {
  const { t } = useTranslation("voice");

  // Screen share priority — yield central area to ScreenShareView when active.
  const watchingScreenShares = useVoiceStore((s) => s.watchingScreenShares);
  const hasScreenShare = Object.values(watchingScreenShares).some(Boolean);

  const cameraTracks = useTracks(
    [{ source: Track.Source.Camera, withPlaceholder: false }],
    { onlySubscribed: false },
  );

  const [layoutMode, setLayoutMode] = useState<LayoutMode>("vertical");
  const [splitRatio, setSplitRatio] = useState(DEFAULT_RATIO);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (cameraTracks.length < 2) {
      setSplitRatio(DEFAULT_RATIO);
    }
  }, [cameraTracks.length]);

  const handleResize = useCallback(
    (delta: number) => {
      if (!containerRef.current) return;
      const containerSize =
        layoutMode === "vertical"
          ? containerRef.current.clientHeight
          : containerRef.current.clientWidth;
      if (containerSize === 0) return;
      const deltaPercent = (delta / containerSize) * 100;
      setSplitRatio((prev) => Math.max(MIN_RATIO, Math.min(MAX_RATIO, prev + deltaPercent)));
    },
    [layoutMode],
  );

  const handleToggleLayout = useCallback(() => {
    setLayoutMode((prev) => (prev === "vertical" ? "horizontal" : "vertical"));
  }, []);

  if (hasScreenShare) return null;
  if (cameraTracks.length === 0) return null;

  if (cameraTracks.length === 1) {
    return (
      <div className="screen-share-view">
        <CameraPanel trackRef={cameraTracks[0]} />
      </div>
    );
  }

  if (cameraTracks.length === 2) {
    const isVertical = layoutMode === "vertical";
    const splitClass = `screen-share-split ${isVertical ? "vertical" : "horizontal"}`;

    return (
      <div className="screen-share-view">
        <button
          onClick={handleToggleLayout}
          className="screen-share-toggle"
          title={t("toggleLayout")}
        >
          {isVertical ? (
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v18M3.75 3h16.5a.75.75 0 01.75.75v16.5a.75.75 0 01-.75.75H3.75a.75.75 0 01-.75-.75V3.75A.75.75 0 013.75 3z" />
            </svg>
          ) : (
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 12h18M3.75 3h16.5a.75.75 0 01.75.75v16.5a.75.75 0 01-.75.75H3.75a.75.75 0 01-.75-.75V3.75A.75.75 0 013.75 3z" />
            </svg>
          )}
        </button>

        <div ref={containerRef} className={splitClass}>
          <div style={{ flex: splitRatio }} className="screen-share-pane">
            <CameraPanel trackRef={cameraTracks[0]} />
          </div>

          <ScreenShareResizeHandle direction={layoutMode} onResize={handleResize} />

          <div style={{ flex: 100 - splitRatio }} className="screen-share-pane">
            <CameraPanel trackRef={cameraTracks[1]} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="screen-share-view">
      <div className="screen-share-grid">
        {cameraTracks.map((trackRef) => (
          <div key={trackRef.participant.identity} className="screen-share-pane">
            <CameraPanel trackRef={trackRef} />
          </div>
        ))}
      </div>
    </div>
  );
}

export default CameraView;
