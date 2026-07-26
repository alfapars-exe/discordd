/**
 * AppLayout — Main layout with sidebar, split panes, and member list.
 *
 * Desktop:
 * ┌─────────┬──────────────────────┬─────────┐
 * │ Sidebar │ SplitPaneContainer   │ Members │
 * │ (240px) │ (flex-1, recursive)  │ (240px) │
 * └─────────┴──────────────────────┴─────────┘
 *
 * Mobile (<768px): MobileAppLayout with drawer sidebar/members.
 *
 * Single WS hook here — routes all events to stores.
 * Voice orchestration props passed down to Sidebar/UserBar.
 * Cascade refetch on server switch (channels, members, roles, readState).
 */

import { useEffect, useMemo, useRef, useCallback, lazy, Suspense } from "react";
import { useIsMobile } from "../../hooks/useMediaQuery";
import SplitPaneContainer from "./SplitPaneContainer";
import MobileAppLayout from "./MobileAppLayout";
import MemberList from "./MemberList";
import Sidebar from "./Sidebar";
import ToastContainer from "../shared/ToastContainer";
import ConfirmDialog from "../shared/ConfirmDialog";
import ImageLightbox from "../shared/ImageLightbox";
import DownloadPromptModal from "../shared/DownloadPromptModal";
import WelcomeModal from "../shared/WelcomeModal";
import SettingsModal from "../settings/SettingsModal";
// VoiceProvider is lazy + conditionally mounted so the ~528 KiB livekit chunk
// stays off /channels' initial load (Mayıs 28 2026 Lighthouse audit). The
// component itself short-circuits when !isInVoice (see VoiceProvider.tsx:217),
// so a non-voice mount would be cheap — but the *module load* still pulled in
// `@livekit/components-react` statically. Gating on `isInVoiceActive` here
// means the chunk is fetched only when the user actually joins a voice
// channel; the brief Suspense fallback during that fetch is hidden behind the
// existing "Connecting..." UX from useVoice's join flow.
const VoiceProvider = lazy(() => import("../voice/VoiceProvider"));
import { useWebSocket } from "../../hooks/useWebSocket";
import { useVoice } from "../../hooks/useVoice";
import { useIdleDetection } from "../../hooks/useIdleDetection";
import { useVoiceActivityReporter } from "../../hooks/useVoiceActivityReporter";
import { useKeyboardShortcuts } from "../../hooks/useKeyboardShortcuts";
import { useP2PCall } from "../../hooks/useP2PCall";
import { useE2EE } from "../../hooks/useE2EE";
import { useE2EEStore } from "../../stores/e2eeStore";
import RecoveryPasswordPrompt from "../shared/RecoveryPasswordPrompt";
import IncomingCallOverlay from "../p2p/IncomingCallOverlay";
import P2PAudioSink from "../p2p/P2PAudioSink";
import QuickSwitcher from "../shared/QuickSwitcher";
import ScreenPicker from "../voice/ScreenPicker";
import AFKKickPopup from "../voice/AFKKickPopup";
import ConnectionBanner from "../shared/ConnectionBanner";
import SectionErrorBoundary from "../shared/SectionErrorBoundary";
import LightningOverlay from "../shared/LightningOverlay";
import { useAuthStore } from "../../stores/authStore";
import { resolveAssetUrl } from "../../utils/constants";
import { resolveWallpaperBlobUrl } from "../../utils/wallpaperCache";
import { useServerStore } from "../../stores/serverStore";
import { useChannelStore } from "../../stores/channelStore";
import { useMemberStore } from "../../stores/memberStore";
import { useRoleStore } from "../../stores/roleStore";
import { useUIStore, type TabServerInfo } from "../../stores/uiStore";
import { useVoiceStore } from "../../stores/voiceStore";
import { useMessageStore } from "../../stores/messageStore";
import { useReadStateStore } from "../../stores/readStateStore";
import { useInviteStore } from "../../stores/inviteStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useSoundboardStore } from "../../stores/soundboardStore";
import { useNotificationBadge } from "../../hooks/useNotificationBadge";
import { ensureNotificationPermission } from "../../utils/notifications";

function AppLayout() {
  const { sendTyping, sendDMTyping, sendPresenceUpdate, sendVoiceJoin, sendVoiceLeave, sendVoiceStateUpdate, sendWS, connectionStatus, reconnectAttempt } =
    useWebSocket();

  // Idle detection — auto-set "idle" after 5min inactivity
  useIdleDetection({ sendPresenceUpdate });

  // Voice AFK activity reporter — sends voice_activity ping while in voice
  useVoiceActivityReporter({ sendWS });

  // Electron taskbar badge for unread count
  useNotificationBadge();

  // Ask the OS for notification permission once after the user reaches
  // the main app. We do this here (post-auth) instead of at App.tsx so
  // anonymous landing visitors never see the prompt — they have no
  // notifications to receive anyway. ensureNotificationPermission()
  // is idempotent + non-blocking; the toast for new messages is fired
  // from channelEventHandlers / dmEventHandlers if permission ends up
  // granted, and silently dropped otherwise.
  useEffect(() => {
    ensureNotificationPermission().catch(() => {
      /* notifications-disabled WebView — no-op */
    });
  }, []);

  // E2EE device identity check + key init
  useE2EE();
  const showRecoveryPrompt = useE2EEStore((s) => s.showRecoveryPrompt);

  // Blur + transparent classes are applied at App root level so they also
  // affect pre-auth pages. Wallpaper stays here because it depends on auth
  // (user.wallpaper_url) and must not leak to login screens.
  const wallpaperUrl = useAuthStore((s) => s.user?.wallpaper_url ?? null);
  const wallpaperEnabled = useSettingsStore((s) => s.wallpaperEnabled);
  const pendingWallpaperPreviewUrl = useSettingsStore((s) => s.pendingWallpaperPreviewUrl);
  const lightningEnabled = useSettingsStore((s) => s.lightningEnabled);
  useEffect(() => {
    if (pendingWallpaperPreviewUrl) {
      document.documentElement.style.setProperty("--wallpaper", `url(${pendingWallpaperPreviewUrl})`);
      return;
    }

    const remoteUrl = wallpaperEnabled && wallpaperUrl ? resolveAssetUrl(wallpaperUrl) : null;

    // Clear immediately (sync) when nothing to show — avoids stale frame during async fetch
    if (!remoteUrl) {
      document.documentElement.style.setProperty("--wallpaper", "none");
      return;
    }

    let previousObjectUrl: string | null = null;
    let cancelled = false;

    resolveWallpaperBlobUrl(remoteUrl).then((blobUrl) => {
      if (cancelled) {
        if (blobUrl) URL.revokeObjectURL(blobUrl);
        return;
      }
      previousObjectUrl = blobUrl;
      document.documentElement.style.setProperty("--wallpaper", blobUrl ? `url(${blobUrl})` : "none");
    });

    return () => {
      cancelled = true;
      if (previousObjectUrl) URL.revokeObjectURL(previousObjectUrl);
    };
  }, [wallpaperUrl, wallpaperEnabled, pendingWallpaperPreviewUrl]);

  const activeServerId = useServerStore((s) => s.activeServerId);
  const servers = useServerStore((s) => s.servers);
  const fetchActiveServer = useServerStore((s) => s.fetchActiveServer);
  const fetchChannels = useChannelStore((s) => s.fetchChannels);
  const fetchMembers = useMemberStore((s) => s.fetchMembers);
  const fetchRoles = useRoleStore((s) => s.fetchRoles);
  const fetchUnreadCounts = useReadStateStore((s) => s.fetchUnreadCounts);
  const selectedChannelId = useChannelStore((s) => s.selectedChannelId);
  const categories = useChannelStore((s) => s.categories);
  const layout = useUIStore((s) => s.layout);
  const openTab = useUIStore((s) => s.openTab);

  // Prevents duplicate auto-tab-open; reset on server switch
  const autoOpenedRef = useRef(false);

  // Clear and refetch all server-scoped stores
  const cascadeRefetch = useCallback(() => {
    const serverId = useServerStore.getState().activeServerId;

    // Channel tree: hydrate from per-server cache instead of wiping. This
    // effect fires AFTER setActiveServer's switchToServer already painted
    // the cached tree — a full clear here would blank the sidebar for a
    // frame before fetchChannels revalidates. hydrateFromCache is a no-op
    // when the cache is empty (new server), which matches the old behavior.
    // Invite / soundboard stores stay stale-clear for now — their data is
    // rarely visited so the paint-flash cost is negligible.
    useChannelStore.getState().hydrateFromCache();
    useInviteStore.getState().clearForServerSwitch();
    useSoundboardStore.getState().clearForServerSwitch();

    // Reset auto-open flag for new server
    autoOpenedRef.current = false;

    // Fetch new server data
    fetchActiveServer();
    fetchChannels();
    if (serverId) {
      fetchMembers(serverId);
      fetchRoles(serverId);
      fetchUnreadCounts(serverId);
    }
  }, [fetchActiveServer, fetchChannels, fetchMembers, fetchRoles, fetchUnreadCounts]);

  // Cascade refetch on server change (deduplicated via prevServerRef)
  const prevServerRef = useRef<string | null>(null);
  useEffect(() => {
    if (activeServerId === prevServerRef.current) return;
    prevServerRef.current = activeServerId;
    if (activeServerId) {
      cascadeRefetch();
    }
  }, [activeServerId, cascadeRefetch]);

  // Auto-open the first selected channel as a UI tab after channels load
  useEffect(() => {
    if (!selectedChannelId || autoOpenedRef.current) return;
    if (categories.length === 0) return;

    const channel = categories
      .flatMap((cg) => cg.channels)
      .find((ch) => ch.id === selectedChannelId);

    if (channel) {
      // Attach server info to tab for multi-server context
      let serverInfo: TabServerInfo | undefined;
      if (activeServerId) {
        const srv = servers.find((s) => s.id === activeServerId);
        if (srv) {
          serverInfo = { serverId: srv.id, serverName: srv.name, serverIconUrl: srv.icon_url };
        }
      }
      const tabType =
        channel.type === "text" ? "text" :
        channel.type === "voice" ? "voice" : "audit";
      openTab(channel.id, tabType, channel.name, serverInfo);
      autoOpenedRef.current = true;
    }
  }, [selectedChannelId, categories, openTab, activeServerId, servers]);

  // Auto-mark-read when switching channels
  useEffect(() => {
    if (!selectedChannelId) return;

    const messages = useMessageStore.getState().messagesByChannel[selectedChannelId];
    if (messages && messages.length > 0) {
      const lastMessage = messages[messages.length - 1];
      useReadStateStore.getState().markAsRead(selectedChannelId, lastMessage.id);
    } else {
      // Messages not loaded yet — still clear local badge
      useReadStateStore.getState().clearUnread(selectedChannelId);
    }
  }, [selectedChannelId]);

  const { joinVoice, leaveVoice, toggleMute, toggleDeafen, toggleScreenShare } = useVoice({
    sendVoiceJoin,
    sendVoiceLeave,
    sendVoiceStateUpdate,
  });

  // Global keyboard shortcuts
  useKeyboardShortcuts({ toggleMute, toggleDeafen });

  // P2P call lifecycle
  useP2PCall();

  // ─── Voice ↔ Tab sync ───

  // Register leaveVoice so uiStore.closeTab can trigger voice disconnect
  useEffect(() => {
    useVoiceStore.getState().registerOnLeave(leaveVoice);
    return () => {
      useVoiceStore.getState().registerOnLeave(null);
    };
  }, [leaveVoice]);

  // Register sendWS for deep components (e.g. VoiceUserContextMenu) to avoid prop drilling
  useEffect(() => {
    useVoiceStore.getState().registerWsSend(sendWS);
    return () => {
      useVoiceStore.getState().registerWsSend(null);
    };
  }, [sendWS]);

  // Voice channel change -> close stale voice tabs + refetch channel list
  // (hidden channels may become visible via voice-connected override, or vice versa)
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const prevVoiceChannelRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const prev = prevVoiceChannelRef.current;
    prevVoiceChannelRef.current = currentVoiceChannelId;

    // Skip initial mount — cascadeRefetch handles it
    if (prev === undefined) return;

    // Left voice channel — close related tabs
    if (prev && !currentVoiceChannelId) {
      useUIStore.getState().closeVoiceTabs(prev);
    }

    // Refetch channels on voice channel change
    if (prev !== currentVoiceChannelId) {
      fetchChannels();
    }
  }, [currentVoiceChannelId, fetchChannels]);

  // ─── Responsive layout ───
  const isMobile = useIsMobile();

  // Stable sidebar props shared by desktop and mobile layouts
  const sidebarProps = useMemo(
    () => ({
      onJoinVoice: joinVoice,
      onToggleMute: toggleMute,
      onToggleDeafen: toggleDeafen,
      onToggleScreenShare: toggleScreenShare,
      onDisconnect: leaveVoice,
    }),
    [joinVoice, toggleMute, toggleDeafen, toggleScreenShare, leaveVoice]
  );

  // Shared overlays rendered in both mobile and desktop layouts.
  // Note: UpdateBanner now lives at App-root so it shows on login/landing
  // pages too (not only after auth) — no duplicate render here.
  const overlays = (
    <>
      {/* Connection status banner */}
      <ConnectionBanner status={connectionStatus} reconnectAttempt={reconnectAttempt} />

      {/* Settings modal */}
      <SettingsModal />

      {/* Confirm dialog */}
      <ConfirmDialog />

      {/* Fullscreen image preview (attachment/link images) */}
      <ImageLightbox />

      {/* Toast notifications */}
      <ToastContainer />

      {/* One-time welcome modal for new users */}
      <WelcomeModal />

      {/* One-time download prompt for web users */}
      <DownloadPromptModal />

      {/* Quick Switcher (Ctrl+K) */}
      <QuickSwitcher />

      {/* P2P incoming call overlay */}
      <IncomingCallOverlay />

      {/* Remote-call audio sink — lives here so it survives tab switches.
          If it moved back into P2PCallScreen, opening any non-p2p tab would
          unmount the <audio> and cut the caller off mid-sentence. */}
      <P2PAudioSink />

      {/* Electron screen picker */}
      <ScreenPicker />

      {/* AFK kick popup — manual dismiss only */}
      <AFKKickPopup />

      {/* E2EE recovery password prompt (non-blocking — shown when E2EE is active) */}
      {showRecoveryPrompt && <RecoveryPasswordPrompt />}
    </>
  );

  // VoiceProvider only mounts when the user is (or is rejoining) a voice
  // channel. Outside of voice the lazy chunk + livekit bundle (~528 KiB) stays
  // off the wire entirely — measured on Lighthouse 13 (Mayıs 28 2026).
  // Suspense fallback returns the same body so the screen never blanks during
  // the chunk fetch on first voice join; the existing "Connecting..." toast
  // covers the perceived gap.
  const isVoiceSessionActive = !!currentVoiceChannelId;

  // Mobile layout
  if (isMobile) {
    const mobileBody = (
      <>
        <MobileAppLayout
          sidebarProps={sidebarProps}
          sendTyping={sendTyping}
          sendDMTyping={sendDMTyping}
        />
        {overlays}
      </>
    );

    const mobileContent = isVoiceSessionActive ? (
      <Suspense fallback={mobileBody}>
        {/* Voice-stack crashes recover via inline retry instead of taking the
            whole app down to the reload pump in the root ErrorBoundary. */}
        <SectionErrorBoundary section="voice">
          <VoiceProvider>{mobileBody}</VoiceProvider>
        </SectionErrorBoundary>
      </Suspense>
    ) : (
      mobileBody
    );

    return mobileContent;
  }

  // Desktop layout
  const desktopBody = (
    <div className="app-body">
      {/* <main> landmark — Lighthouse (Mayıs 28 2026) flagged the missing
          landmark on /channels. Sidebar stays outside <main> because it's
          a navigation region, not main content. */}
      <main className="main-area">
        {/* Decorative neon lightning bolts — purely visual, pointer-events
            none, drawn behind content via z-index. See globals.css for
            timing + LightningOverlay.tsx for path/colour config.
            Opt-in (Track X): default OFF — toggled via Settings → Appearance. */}
        {lightningEnabled && <LightningOverlay />}

        {/* Split pane container */}
        <SplitPaneContainer node={layout} sendTyping={sendTyping} sendDMTyping={sendDMTyping} />

        {/* Member list panel */}
        <MemberList />
      </main>
    </div>
  );

  const desktopContent = (
    <div className="mqvi-app">
      {/* Sidebar */}
      <Sidebar {...sidebarProps} />

      {isVoiceSessionActive ? (
        <Suspense fallback={desktopBody}>
          {/* Same voice-crash isolation as the mobile branch above. */}
          <SectionErrorBoundary section="voice">
            <VoiceProvider>{desktopBody}</VoiceProvider>
          </SectionErrorBoundary>
        </Suspense>
      ) : (
        desktopBody
      )}

      {overlays}
    </div>
  );

  return desktopContent;
}

export default AppLayout;
