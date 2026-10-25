import {useOverlayMediaSender} from "../../hooks/useOverlayMediaSender";
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
import { useVoiceOverlayCleanup } from "../../hooks/useVoiceOverlayCleanup";
import { useOverlayShortcut } from "../../hooks/useOverlayShortcut";
import { getOverlayVoiceSession, useOverlayVoiceActions } from "../../hooks/useOverlayVoiceActions";
import { useOverlayActivity } from "../../hooks/useOverlayActivity";
import { useOverlayChat } from "../../hooks/useOverlayChat";
import { useOverlayChatActions } from "../../hooks/useOverlayChatActions";
import { useOverlayChatCompose } from "../../hooks/useOverlayChatCompose";
import { useThreadReconnectRefresh } from "../../hooks/useThreadReconnectRefresh";
import { getAuthSessionSnapshot } from "../../api/authSessionEvents";
import { formatOverlayChatComposeLabel, getLiveOverlayChatTarget } from "../../utils/overlayChatAccess";
import { useOverlayNotificationReply } from "../../hooks/useOverlayNotificationReply";
import { useOverlayNotifications } from "../../hooks/useOverlayNotifications";
import { useOverlayNotificationActions } from "../../hooks/useOverlayNotificationActions";
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
import GroupCallProvider from "../dm/GroupCallProvider";
import { useWebSocket } from "../../hooks/useWebSocket";
import { useGameActivity } from "../../hooks/useGameActivity";
import { useGameJoinStore } from "../../stores/gameJoinStore";
import { useVoice } from "../../hooks/useVoice";
import { useIdleDetection } from "../../hooks/useIdleDetection";
import { useVoiceActivityReporter } from "../../hooks/useVoiceActivityReporter";
import { useKeyboardShortcuts } from "../../hooks/useKeyboardShortcuts";
import { executeVoiceShortcut } from "../../hooks/useVoiceShortcutAction";
import { executeInboxShortcut } from "../../hooks/useInboxShortcutAction";
import { executeNavigationShortcut } from "../../utils/shortcutNavigation";
import { executeConversationShortcut } from "../../utils/conversationCommands";
import { useP2PCall } from "../../hooks/useP2PCall";
import { useE2EE } from "../../hooks/useE2EE";
import { useE2EEStore } from "../../stores/e2eeStore";
import RecoveryPasswordPrompt from "../shared/RecoveryPasswordPrompt";
import LegacyKeyRecoveryPrompt from "../shared/LegacyKeyRecoveryPrompt";
import IncomingCallOverlay from "../p2p/IncomingCallOverlay";
import GroupConversationLauncher from "../dm/GroupConversationLauncher";
import ServerCreationLauncher from "../servers/ServerCreationLauncher";
import P2PAudioSink from "../p2p/P2PAudioSink";
import QuickSwitcher from "../shared/QuickSwitcher";
import KeyboardShortcutHelp from "../shared/KeyboardShortcutHelp";
import LofiPlayer from "../shared/LofiPlayer";
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
import { useOverlayGoLiveStore } from "../../stores/overlayGoLiveStore";
import { useAccessibilityStore } from "../../stores/accessibilityStore";
import { useMessageStore } from "../../stores/messageStore";
import { useReadStateStore } from "../../stores/readStateStore";
import { useInviteStore } from "../../stores/inviteStore";
import { isWallpaperVisible, useSettingsStore } from "../../stores/settingsStore";
import { useSoundboardStore } from "../../stores/soundboardStore";
import { useNotificationBadge } from "../../hooks/useNotificationBadge";
import { useServerCosmeticsSync } from "../../hooks/useServerCosmeticsSync";
import { UI_SHELL_V2 } from "../../utils/uiShell";
import { useNavigationHistory } from "../../hooks/useNavigationHistory";
import ShellV2 from "./ShellV2";
import MessageDeepLinkHandler from "./MessageDeepLinkHandler";
import "../../styles/voice-overlay.css";

function AppLayout() {
  const { ownerId: overlayRenderOwner, generation: overlayRenderGeneration } = getAuthSessionSnapshot();
  useVoiceOverlayCleanup();
  const { sendTyping, sendDMTyping, sendPresenceUpdate, sendVoiceJoin, sendVoiceLeave, sendVoiceStateUpdate, sendWS, connectionStatus, reconnectAttempt } =
    useWebSocket();
  useThreadReconnectRefresh(connectionStatus === "connected");
  const overlayNotificationDurationMs = useAccessibilityStore(s => s.notificationDuration * 1000);
  const overlayGoLive = useVoiceStore(s => s.voiceOverlayGoLive);
  const goLiveSession = useOverlayGoLiveStore(s => s.session);
  const goLiveEligible = useOverlayGoLiveStore(s => s.eligible) && connectionStatus === "connected";
  const overlayWelcome = useVoiceStore((s) => s.voiceOverlayWelcome);
  const overlayEnabled = useVoiceStore((s) => s.voiceOverlayEnabled);
  const overlayCompatibility = useVoiceStore(s=>s.voiceOverlayCompatibility);
  const overlayChatEnabled = useVoiceStore((s) => s.voiceOverlayChat);
  const overlayChat = useOverlayChat(overlayEnabled && overlayChatEnabled, connectionStatus === "connected");
  const overlayChatActions = useVoiceStore((s) => s.voiceOverlayChatActions);
  const chatActionSession = useOverlayChatActions(connectionStatus === "connected" && !overlayCompatibility, overlayChat.chatStatus === "ready");
  const overlayChatCompose = useVoiceStore((s) => s.voiceOverlayChatCompose);
  const chatComposeSession = useOverlayChatCompose(connectionStatus === "connected" && !overlayCompatibility, overlayChat.chatStatus === "ready");
  const chatComposeLabel = formatOverlayChatComposeLabel(getLiveOverlayChatTarget(true)?.label);
  const overlayMode = useVoiceStore((s) => s.voiceOverlayMode);
  const overlayPinned = useVoiceStore((s) => s.voiceOverlayPinned);
  const overlayActivityEnabled = useVoiceStore((s) => s.voiceOverlayActivity);
  const overlayVideo=useVoiceStore(s=>s.voiceOverlayVideo),overlayStreams=useVoiceStore(s=>s.voiceOverlayStreams);
  const overlayActivities = useOverlayActivity(overlayActivityEnabled, connectionStatus === "connected");
  const overlayNotificationsEnabled = useVoiceStore((s) => s.voiceOverlayNotifications);
  const overlayNotificationActions = useVoiceStore((s) => s.voiceOverlayNotificationActions);
  const { notifications: overlayNotifications, notificationStatus } = useOverlayNotifications(overlayEnabled && overlayNotificationsEnabled, connectionStatus === "connected");
  const { notificationReplySession, notificationReplyIds } = useOverlayNotificationReply(connectionStatus === "connected" && !overlayCompatibility, overlayNotifications);
  const notificationActionSession = useOverlayNotificationActions(connectionStatus === "connected" && !overlayCompatibility, notificationStatus === "ready" && overlayNotifications.length > 0);
  const overlayQuickActions = useVoiceStore((s) => s.voiceOverlayQuickActions);
  const overlayClickableActions = useVoiceStore((s) => s.voiceOverlayClickableActions);
  const overlaySelfMuted = useVoiceStore((s) => s.isMuted);
  const overlaySelfDeafened = useVoiceStore((s) => s.isDeafened);
  const overlayJoinGeneration = useVoiceStore((s) => s._joinGeneration);
  const overlaySpeakingOpacity = useVoiceStore((s) => s.voiceOverlaySpeakingOpacity);
  const overlayIdleOpacity = useVoiceStore((s) => s.voiceOverlayIdleOpacity);
  const overlayScale = useVoiceStore((s) => s.voiceOverlayScale);
  const overlayPosition = useVoiceStore((s) => s.voiceOverlayPosition);
  const overlaySpeakingOnly = useVoiceStore((s) => s.voiceOverlaySpeakingOnly);
  const overlayAvatarSize = useVoiceStore((s) => s.voiceOverlayAvatarSize);
  const overlayNameDisplay = useVoiceStore((s) => s.voiceOverlayNameDisplay);
  const overlayMaxParticipants = useVoiceStore((s) => s.voiceOverlayMaxParticipants);
  const voiceStates = useVoiceStore((s) => s.voiceStates);
  const overlayChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const activeSpeakers = useVoiceStore((s) => s.activeSpeakers);
  const overlayPolicyAck = useRef<Promise<boolean>>(Promise.resolve(false));
  const awaitOverlayPolicy = useCallback(() => overlayPolicyAck.current, []);
  useEffect(() => {
    overlayPolicyAck.current = Promise.resolve(false);
    if (!window.electronAPI?.sendVoiceOverlaySnapshot) return;
    const currentScope = getAuthSessionSnapshot();
    if (!overlayRenderOwner || currentScope.ownerId !== overlayRenderOwner || currentScope.generation !== overlayRenderGeneration) return;
    // Match the bounded native IPC contract even in large voice channels.
    const participants = (overlayChannelId ? voiceStates[overlayChannelId] ?? [] : []).slice(0, 64).map((p) => ({
      id: p.user_id, name: p.display_name || p.username, avatarUrl: p.avatar_url || "",
      speaking: activeSpeakers[p.user_id] ?? false, muted: p.is_muted, deafened: p.is_deafened,
    }));
    const notificationActions = { voiceOverlayNotificationActions: overlayNotificationActions, notificationReplyIds, ...(notificationReplySession ? { notificationReplySession } : {}), ...(notificationActionSession ? { notificationActionSession } : {}) };
    const chatSnapshot = { voiceOverlayChat: overlayChatEnabled, ...(overlayChatEnabled ? { ...overlayChat, voiceOverlayChatActions: overlayChatActions, ...(chatActionSession ? { chatActionSession } : {}), voiceOverlayChatCompose: overlayChatCompose, ...(chatComposeSession ? { chatComposeSession, chatComposeLabel } : {}) } : {}) };
    const acknowledgement = window.electronAPI.sendVoiceOverlaySnapshot({ enabled: overlayEnabled, voiceOverlayWelcome: overlayWelcome, voiceOverlayGoLive: overlayGoLive, goLiveEligible, ...(goLiveEligible && goLiveSession ? { goLiveSession } : {}), overlayNotificationDurationMs, ...chatSnapshot, voiceOverlayMode: overlayMode, voiceOverlayPinned: overlayPinned, voiceOverlayActivity: overlayActivityEnabled, voiceOverlayVideo:overlayVideo,voiceOverlayStreams:overlayStreams,mediaHeight:overlayVideo||overlayStreams?320:0, activities: overlayActivityEnabled ? overlayActivities : [], voiceOverlayNotifications: overlayNotificationsEnabled, ...(overlayNotificationsEnabled ? { notifications: overlayNotifications, notificationStatus, ...notificationActions } : {}), voiceOverlayQuickActions: overlayQuickActions, voiceOverlayClickableActions: overlayClickableActions, voiceOverlayCompatibility: overlayCompatibility, ...(getOverlayVoiceSession() ? { voiceActionSession: getOverlayVoiceSession() } : {}), selfMuted: overlaySelfMuted, selfDeafened: overlaySelfDeafened, participants, speakingOpacity: overlaySpeakingOpacity, idleOpacity: overlayIdleOpacity, scale: overlayScale, position: overlayPosition, speakingOnly: overlaySpeakingOnly, voiceOverlayAvatarSize: overlayAvatarSize, voiceOverlayNameDisplay: overlayNameDisplay, voiceOverlayMaxParticipants: overlayMaxParticipants });
    overlayPolicyAck.current = Promise.resolve(acknowledgement).then(value => value === true, () => false);
  }, [overlayRenderOwner, overlayRenderGeneration, overlayWelcome, overlayGoLive, goLiveEligible, goLiveSession, overlayNotificationDurationMs, overlayEnabled, overlayChatEnabled, overlayChat, overlayChatActions, chatActionSession, overlayChatCompose, chatComposeSession, chatComposeLabel, overlayMode, overlayPinned, overlayActivityEnabled, overlayVideo,overlayStreams,overlayActivities, overlayNotificationsEnabled, overlayNotificationActions, overlayNotifications, notificationStatus, notificationActionSession, notificationReplySession, notificationReplyIds, overlayQuickActions, overlayClickableActions, overlayCompatibility, overlaySelfMuted, overlaySelfDeafened, overlayJoinGeneration, overlaySpeakingOpacity, overlayIdleOpacity, overlayScale, overlayPosition, overlaySpeakingOnly, overlayAvatarSize, overlayNameDisplay, overlayMaxParticipants, voiceStates, overlayChannelId, activeSpeakers]);
  // Project native compatibility before configuring the chord. This prevents
  // normal-mode re-registration racing the native suspension policy.
  useOverlayShortcut(`${overlayRenderOwner ?? ""}:${overlayRenderGeneration}`, awaitOverlayPolicy);
  useOverlayMediaSender(connectionStatus === "connected");
  useNavigationHistory();

  // Idle detection — auto-set "idle" after 5min inactivity
  useGameActivity({ sendWS, connectionStatus });
  useIdleDetection({ sendPresenceUpdate });

  // Voice AFK activity reporter — sends voice_activity ping while in voice
  useVoiceActivityReporter({ sendWS });

  // Electron taskbar badge for unread count
  useNotificationBadge();

  // Active server's member cosmetics map (Faz G). Covers the mobile layout
  // too — MobileAppLayout renders inside this component.
  useServerCosmeticsSync();

  // E2EE device identity check + key init
  useE2EE();
  const showRecoveryPrompt = useE2EEStore((s) => s.showRecoveryPrompt);
  const legacyRecoveryRequired = useE2EEStore((s) => s.initStatus === "legacy-recovery");

  // Blur + transparent classes are applied at App root level so they also
  // affect pre-auth pages. Wallpaper stays here because it depends on auth
  // (user.wallpaper_url) and must not leak to login screens.
  const wallpaperUrl = useAuthStore((s) => s.user?.wallpaper_url ?? null);
  const wallpaperEnabled = useSettingsStore(isWallpaperVisible);
  const transparentBackground = useSettingsStore((s) => s.transparentBackground);
  const pendingWallpaperPreviewUrl = useSettingsStore((s) => s.pendingWallpaperPreviewUrl);
  const lightningEnabled = useSettingsStore((s) => s.lightningEnabled);
  useEffect(() => {
    if (pendingWallpaperPreviewUrl && !transparentBackground) {
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
  }, [wallpaperUrl, wallpaperEnabled, pendingWallpaperPreviewUrl, transparentBackground]);

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
    if (UI_SHELL_V2) return;
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
    if (UI_SHELL_V2) return;
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
  useOverlayVoiceActions(toggleMute, toggleDeafen);

  // Global keyboard shortcuts
  const { shortcutHelpOpen, closeShortcutHelp, lofiOpen, closeLofi } = useKeyboardShortcuts({ toggleMute, toggleDeafen, navigate: executeNavigationShortcut, conversation: executeConversationShortcut, voice: executeVoiceShortcut, inbox: executeInboxShortcut });

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

  useEffect(() => {
    useGameJoinStore.getState().register(connectionStatus === "connected" ? sendWS : null);
    return () => useGameJoinStore.getState().register(null);
  }, [sendWS, connectionStatus, overlayRenderOwner, overlayRenderGeneration]);

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
      <MessageDeepLinkHandler />
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
      <GroupConversationLauncher />
      <ServerCreationLauncher />
      {shortcutHelpOpen && <KeyboardShortcutHelp onClose={closeShortcutHelp} />}
      {lofiOpen && <LofiPlayer onClose={closeLofi} />}

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
      {showRecoveryPrompt && !legacyRecoveryRequired && <RecoveryPasswordPrompt />}
      {legacyRecoveryRequired && <LegacyKeyRecoveryPrompt />}
    </>
  );

  // VoiceProvider only mounts when the user is (or is rejoining) a voice
  // channel. Outside of voice the lazy chunk + livekit bundle (~528 KiB) stays
  // off the wire entirely — measured on Lighthouse 13 (Mayıs 28 2026).
  // Suspense fallback returns the same body so the screen never blanks during
  // the chunk fetch on first voice join; the existing "Connecting..." toast
  // covers the perceived gap.
  const isVoiceSessionActive = !!currentVoiceChannelId;

  // This owner is stable across desktop/mobile breakpoints and destination changes.
  // Do not put VoiceProvider inside ShellV2 or key it by the selected conversation.
  if (UI_SHELL_V2) {
    const body = <><ShellV2 sidebarProps={sidebarProps} sendTyping={sendTyping} sendDMTyping={sendDMTyping} />{overlays}</>;
    return <>{isVoiceSessionActive ? <Suspense fallback={body}><SectionErrorBoundary section="voice"><VoiceProvider>{body}</VoiceProvider></SectionErrorBoundary></Suspense> : body}<GroupCallProvider/></>;
  }

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

    return <>{mobileContent}<GroupCallProvider/></>;
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

  return <>{desktopContent}<GroupCallProvider/></>;
}

export default AppLayout;
