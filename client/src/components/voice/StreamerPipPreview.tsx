/**
 * StreamerPipPreview — floating mini-window the broadcaster sees while
 * their screen share is live.
 *
 * Mirrors the Discord pattern (the user's reference screenshots): a small
 * draggable card pinned to the bottom-left of the viewport showing
 *   • voice channel header with a back arrow (returns to the channel)
 *   • the broadcaster's live screen-share thumbnail
 *   • their own display name
 *   • a viewer count chip
 *   • a gear button that opens "Stop Stream / Change Stream / Report"
 *   • a close (×) button that stops the stream and dismisses the widget
 *
 * Rendered globally (mounted once in AppLayout) so it persists even when
 * the broadcaster navigates away from the voice channel — that's the
 * whole point of a PiP. Hides itself the moment isStreaming flips to
 * false. The actual track keeps publishing through LiveKit; this is
 * purely a UI mirror.
 */

import { Component, useEffect, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { useVoiceStore } from "../../stores/voiceStore";
import { useChannelStore } from "../../stores/channelStore";
import { useUIStore } from "../../stores/uiStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useAuthStore } from "../../stores/authStore";
import { useServerStore } from "../../stores/serverStore";

/**
 * PipErrorBoundary — isolates render errors from this floating widget so a
 * regression here can't trigger the app-wide ErrorBoundary (which reloads
 * the whole renderer after 2s). The pip is non-essential; if it crashes we
 * just hide it.
 */
class PipErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[StreamerPipPreview] crashed:", error, info);
  }
  render() {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}

function StreamerPipPreviewInner() {
  const { t } = useTranslation("voice");

  const setStreaming = useVoiceStore((s) => s.setStreaming);
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const viewers = useVoiceStore((s) => {
    const me = useAuthStore.getState().user?.id;
    if (!me) return [];
    return s.screenShareViewers[me] ?? [];
  });
  const user = useAuthStore((s) => s.user);
  const channelName = useChannelStore((s) => {
    if (!currentVoiceChannelId) return null;
    for (const cg of s.categories) {
      const found = cg.channels.find((c) => c.id === currentVoiceChannelId);
      if (found) return found.name;
    }
    return null;
  });

  const [gearOpen, setGearOpen] = useState(false);
  // Callback-ref stored in state so the JSX can read the live DOM node
  // (for getBoundingClientRect → menu positioning) without touching
  // a useRef.current during render. useRef + .current access at render
  // time trips react-hooks/refs because refs aren't reactive — the
  // first paint after mount wouldn't see the assignment otherwise.
  const [gearEl, setGearEl] = useState<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!gearOpen) return;
    function handleOutside(e: MouseEvent) {
      const target = e.target as Node;
      if (gearEl?.contains(target)) return;
      // Close on any other click — the gear button itself toggles.
      const menu = document.querySelector(".pip-gear-menu");
      if (menu && menu.contains(target)) return;
      setGearOpen(false);
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [gearOpen, gearEl]);

  // Outer <StreamerPipPreview> already gates on isStreaming +
  // currentVoiceChannelId, so no redundant check needed here.

  function goBackToChannel() {
    // Navigate the active panel to the voice-channel tab so the broadcaster
    // returns to the room view (where the full panel lives). The opener
    // already created a tab for this channel when they joined — we just
    // find it and activate.
    if (!currentVoiceChannelId) return;
    const ui = useUIStore.getState();
    for (const panelId of Object.keys(ui.panels)) {
      const panel = ui.panels[panelId];
      const tab = panel.tabs.find((tt) => tt.channelId === currentVoiceChannelId);
      if (tab) {
        ui.setActiveTab(panelId, tab.id);
        return;
      }
    }
    // No tab yet — open one. uiStore.openTab handles dedup if it raced.
    const activeServerId = useServerStore.getState().activeServerId;
    if (activeServerId) {
      const serverItem = useServerStore
        .getState()
        .servers.find((sv) => sv.id === activeServerId);
      ui.openTab(currentVoiceChannelId, "voice", channelName ?? "", serverItem
        ? { serverId: serverItem.id, serverName: serverItem.name, serverIconUrl: serverItem.icon_url ?? null }
        : undefined);
    }
  }

  function stopStream() {
    setGearOpen(false);
    setStreaming(false);
  }

  function changeStream() {
    setGearOpen(false);
    // Cycle: toggle off then back on. The screen picker will reopen
    // automatically because setStreaming(true) re-enters useScreenShareToggle.
    setStreaming(false);
    setTimeout(() => setStreaming(true), 250);
  }

  function reportIssue() {
    setGearOpen(false);
    // Hand off to the existing feedback panel — same place the user
    // would report any other bug. Pre-filling the form to "bug" is a
    // follow-up; for now we just take them to the tab.
    useSettingsStore.getState().openSettings("feedback");
  }

  const gearRect = gearEl?.getBoundingClientRect();

  return (
    <>
      <div className="streamer-pip">
        <button className="pip-back" onClick={goBackToChannel} title={t("backToChannel", { defaultValue: "Kanala dön" })}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          <span className="pip-channel-name">{channelName ?? ""}</span>
        </button>

        <div className="pip-thumb" onClick={goBackToChannel} role="button" tabIndex={0}>
          {/* Why no <VideoTrack> here: rendering the broadcaster's own
              screen-share track inside their own UI creates a frame-by-frame
              capture/display feedback loop. Same trap the self-pause card in
              ScreenSharePanel already documents. Discord uses a static badge
              for the PiP thumb for exactly this reason — and crucially,
              <VideoTrack> mounting with an in-flight LocalTrackPublication
              has been observed to crash the renderer (caught by ErrorBoundary,
              shows "Reloading..."). A static placeholder eliminates both
              the visual tunnel and the crash risk. */}
          <div className="pip-thumb-placeholder">{t("streaming", { defaultValue: "Yayındasın!" })}</div>
          <div className="pip-thumb-badge">{t("streaming", { defaultValue: "Yayındasın!" })}</div>
        </div>

        <div className="pip-footer">
          <span className="pip-username">{user?.display_name ?? user?.username ?? ""}</span>
          <span className="pip-viewer-chip" title={t("viewers", { defaultValue: "İzleyiciler" })}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            <span>{viewers.length}</span>
          </span>
          <button
            ref={setGearEl}
            className="pip-gear"
            onClick={() => setGearOpen((p) => !p)}
            title={t("streamSettings", { defaultValue: "Yayın ayarları" })}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
          <button className="pip-close" onClick={stopStream} title={t("stopStream", { defaultValue: "Yayını durdur" })}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      {/* Gear popup menu — same three actions Discord uses */}
      {gearOpen && gearRect &&
        createPortal(
          <div
            className="pip-gear-menu"
            style={{
              position: "fixed",
              left: gearRect.right + 8,
              top: gearRect.top - 4,
              zIndex: 10000,
            }}
          >
            <button className="pip-gear-item pip-gear-item-danger" onClick={stopStream}>
              <span>{t("stopStream", { defaultValue: "Yayını Durdur" })}</span>
              <span className="pip-gear-icon">⏹</span>
            </button>
            <button className="pip-gear-item" onClick={changeStream}>
              <span>{t("changeStream", { defaultValue: "Yayını değiştir" })}</span>
              <span className="pip-gear-icon">⇄</span>
            </button>
            <button className="pip-gear-item pip-gear-item-danger" onClick={reportIssue}>
              <span>{t("reportIssue", { defaultValue: "Sorun Bildir" })}</span>
              <span className="pip-gear-icon">⚠</span>
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * Outer guard + error boundary: the inner component reads from voiceStore,
 * channelStore, and (when re-enabled in the future) LiveKit hooks. Any
 * regression here is contained by PipErrorBoundary so it never reaches the
 * app-wide ErrorBoundary, which would reload the whole renderer.
 */
function StreamerPipPreview() {
  const isStreaming = useVoiceStore((s) => s.isStreaming);
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  if (!isStreaming || !currentVoiceChannelId) return null;
  return (
    <PipErrorBoundary>
      <StreamerPipPreviewInner />
    </PipErrorBoundary>
  );
}

export default StreamerPipPreview;
