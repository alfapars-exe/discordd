import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useUIStore } from "../../stores/uiStore";
import { useChannelStore } from "../../stores/channelStore";
import { useChannelPermissionStore } from "../../stores/channelPermissionStore";
import { useVoiceStore } from "../../stores/voiceStore";
import { useP2PCallStore } from "../../stores/p2pCallStore";
import { useAuthStore } from "../../stores/authStore";
import { useThreadStore } from "../../stores/threadStore";
import { useChannelPermissions } from "../../hooks/useChannelPermissions";
import { useConversationCommand } from "../../hooks/useConversationCommand";
import { getAuthGeneration } from "../../api/client";
import { Permissions } from "../../utils/permissions";
import { resolveChatChannel } from "../../utils/resolveChatChannel";
import type { Channel } from "../../types";
import ChatArea from "./ChatArea";
import DMChat from "../dm/DMChat";
import GroupDMChat from "../dm/GroupDMChat";
import FriendsView from "../friends/FriendsView";
import InboxView from "../inbox/InboxView";
import NotificationsView from "../inbox/NotificationsView";
import SavedMessagesView from "../saved/SavedMessagesView";
import P2PCallScreen from "../p2p/P2PCallScreen";
import VoiceRoom from "../voice/VoiceRoom";
import AuditChannel from "../audit/AuditChannel";
import SectionErrorBoundary from "../shared/SectionErrorBoundary";

function VoiceDestination({ channel, serverId, onJoinVoice, sendTyping }: {
  channel: Channel;
  serverId?: string;
  onJoinVoice?: (channelId: string) => void | Promise<void>;
  sendTyping: (channelId: string) => void;
}) {
  const { t } = useTranslation("voice");
  const ownerId = useAuthStore((s) => s.user?.id ?? null);
  const [boundSession] = useState(() => ({ ownerId, authGeneration: getAuthGeneration() }));
  const currentChannel = useVoiceStore((s) => s.currentVoiceChannelId);
  const currentServer = useVoiceStore((s) => s.currentVoiceServerId);
  const { hasChannelPerm, permsResolved } = useChannelPermissions(channel.id, serverId);
  const overridesReady = useChannelPermissionStore((s) => s.fetchedChannels.has(channel.id));
  const [showText, setShowText] = useState(false);
  const [joining, setJoining] = useState(false);
  const [joinFailed, setJoinFailed] = useState(false);
  const pending = useRef(false);
  const connectedHere = currentChannel === channel.id && currentServer === serverId;
  const denied = permsResolved && !hasChannelPerm(Permissions.ConnectVoice);
  const canReadText = Boolean(serverId && permsResolved && overridesReady &&
    hasChannelPerm(Permissions.ViewChannel) && hasChannelPerm(Permissions.ReadMessages));
  const isCurrentScope = () => {
    const active = useUIStore.getState().destination;
    return Boolean(boundSession.ownerId && ownerId === boundSession.ownerId &&
      useAuthStore.getState().user?.id === boundSession.ownerId &&
      getAuthGeneration() === boundSession.authGeneration && active.type === "voice" &&
      active.channelId === channel.id && active.serverInfo?.serverId === serverId);
  };
  const canToggleText = canReadText && isCurrentScope();
  const showingText = showText && canToggleText;

  useConversationCommand({ kind: "voice", id: channel.id, serverId }, (command) => {
    if (command !== "members" || !canToggleText) return false;
    setShowText((value) => !value);
    return true;
  });

  async function join() {
    if (pending.current || connectedHere || denied || !onJoinVoice) return;
    pending.current = true;
    setJoining(true);
    setJoinFailed(false);
    try { await onJoinVoice(channel.id); }
    catch { setJoinFailed(true); }
    finally { pending.current = false; setJoining(false); }
  }
  return <div className="voice-room">
    <div className="channel-bar">
      <span className="ch-hash" aria-hidden="true">◖))</span>
      <span className="ch-name">{channel.name}</span>
      {canToggleText && <button
        type="button"
        className="btn-secondary"
        aria-label={t(showingText ? "voiceRoomView" : "voiceTextView")}
        aria-pressed={showingText}
        title={t(showingText ? "voiceRoomView" : "voiceTextView")}
        onClick={() => {
          if (canToggleText && isCurrentScope()) setShowText((value) => !value);
        }}
      >{t(showingText ? "voiceRoomView" : "voiceTextView")}</button>}
    </div>
    {showingText ? <ChatArea channelId={channel.id} channel={channel} serverId={serverId} sendTyping={sendTyping} /> :
      connectedHere ? <VoiceRoom /> : <div className="shell-empty">
        <h2>{channel.name}</h2><p>{t(denied ? "voiceChannelLocked" : "joinVoicePrompt")}</p>
        {joinFailed && <p role="alert">{t("voiceJoinFailed")}</p>}
        <button className="btn-primary" disabled={joining || denied || !onJoinVoice} onClick={() => { void join(); }}>
          {t(joining ? "connectingToVoice" : "joinVoice")}
        </button>
      </div>}
  </div>;
}

function CallDestination({ callId }: { callId: string }) {
  const { t } = useTranslation("common");
  const { t: tv } = useTranslation("voice");
  const activeCall = useP2PCallStore((s) => s.activeCall);
  if (activeCall?.id === callId) return <P2PCallScreen />;
  return <div className="shell-empty" role="status"><h2>{t("callEnded")}</h2>
    {activeCall && <button className="btn-primary" onClick={() => useUIStore.getState().navigate({ type: "p2p", channelId: activeCall.id, label: tv("returnToCall") })}>{tv("returnToCall")}</button>}
  </div>;
}

/** A destination owns presentation only. Call/WS lifetimes belong to AppLayout. */
export default function DestinationView({ sendTyping, sendDMTyping, onJoinVoice }: {
  sendTyping: (id: string) => void;
  sendDMTyping: (id: string) => void;
  onJoinVoice?: (id: string) => void | Promise<void>;
}) {
  const { t } = useTranslation("common");
  const destination = useUIStore((s) => s.destination);
  const navigationRevision = useUIStore((s) => s.navigationRevision);
  const serverId = destination.serverInfo?.serverId;
  const ownerId = useAuthStore((s) => s.user?.id ?? null);
  const threadState = useThreadStore((s) => s);
  const loadThread = useThreadStore((s) => s.loadThread);
  const tree = useChannelStore((s) => destination.serverInfo
    ? s.categoriesByServer[destination.serverInfo.serverId] : undefined);
  const directTreeChannel = tree?.flatMap((group) => group.channels).find((item) => item.id === destination.channelId && item.type !== "thread");
  const threadCandidate = destination.type === "text" && !!serverId && tree !== undefined && !directTreeChannel;
  const threadRefreshKey = threadCandidate
    ? JSON.stringify([navigationRevision, ownerId, getAuthGeneration(), serverId, destination.channelId])
    : "";
  const [settledThreadRefresh, setSettledThreadRefresh] = useState("");
  useEffect(() => {
    if (!threadCandidate || !serverId || !ownerId) return;
    let active = true;
    void loadThread(serverId, destination.channelId, true).catch(() => undefined).finally(() => {
      if (active) setSettledThreadRefresh(threadRefreshKey);
    });
    return () => { active = false; };
  }, [threadCandidate, serverId, destination.channelId, ownerId, threadRefreshKey, loadThread]);
  const isThreadRefreshSettled = !threadCandidate || settledThreadRefresh === threadRefreshKey;
  const resolved = resolveChatChannel(destination.serverInfo ? destination.channelId : null, serverId, {
    categoriesByServer: serverId ? { [serverId]: tree } : {},
    threads: threadState,
    currentOwnerId: ownerId,
    currentAuthGeneration: getAuthGeneration(),
  });
  const channel = isThreadRefreshSettled ? resolved?.channel : undefined;
  const permissionChannelId = isThreadRefreshSettled ? resolved?.permissionChannelId : undefined;
  const { hasChannelPerm, permsResolved, authorizationResolved } = useChannelPermissions(
    channel?.id ?? null, serverId, permissionChannelId
  );
  const loading = useChannelStore((s) => s.isLoading);
  const retry = useChannelStore((s) => s.fetchChannels);
  const identity = `${destination.type}:${destination.serverInfo?.serverId ?? ""}:${destination.channelId}`;
  const threadLookupPending = threadCandidate && !!ownerId && !isThreadRefreshSettled
    && threadState.ownerId === ownerId && threadState.authGeneration === getAuthGeneration();
  const overridesReady = useChannelPermissionStore((s) => !!permissionChannelId && s.fetchedChannels.has(permissionChannelId));
  const fetchOverrides = useChannelPermissionStore((s) => s.fetchOverrides);
  const [overrideFailure, setOverrideFailure] = useState<string | null>(null);
  const [overrideAttempt, setOverrideAttempt] = useState(0);
  const channelId = channel?.id;
  // Fetch before gating: an explicit channel allow can grant access even
  // when the member's base role denies it. ChatArea cannot own this fetch
  // because denied/unknown content must not mount it.
  useEffect(() => {
    if (!channelId || !permissionChannelId || !serverId || overridesReady) return;
    let active = true;
    void fetchOverrides(permissionChannelId, serverId).then(() => {
      if (active && !useChannelPermissionStore.getState().fetchedChannels.has(permissionChannelId)) setOverrideFailure(identity);
    }).catch(() => { if (active) setOverrideFailure(identity); });
    return () => { active = false; };
  }, [channelId, permissionChannelId, serverId, overridesReady, fetchOverrides, identity, overrideAttempt]);
  const accessReady = channel?.type === "thread"
    ? authorizationResolved && overridesReady
    : permsResolved && overridesReady;
  let content;
  switch (destination.type) {
    case "friends": content = <FriendsView />; break;
    case "dm": content = <DMChat channelId={destination.channelId} sendDMTyping={sendDMTyping} />; break;
    case "group-dm": content = <GroupDMChat groupId={destination.channelId} />; break;
    case "inbox": content = <InboxView />; break;
    case "notifications": content = <NotificationsView />; break;
    case "saved": content = <SavedMessagesView />; break;
    case "p2p": content = <CallDestination callId={destination.channelId} />; break;
    case "server-home": content = <div className="shell-empty">
      <div className="shell-empty-symbol" aria-hidden="true">#</div>
      <h1>{destination.serverInfo?.serverName}</h1><p>{t("shellChooseChannel")}</p>
      <button className="btn-primary" onClick={() => useUIStore.getState().toggleQuickSwitcher()}>{t("quickSwitcherPlaceholder")}</button>
    </div>; break;
    default: {
      const routeMatches = channel && (destination.type === "text"
        ? channel.type === "text" || channel.type === "thread"
        : channel.type === (destination.type === "screen" ? "voice" : destination.type));
      if (!routeMatches) {
        const isLoadingDestination = loading || threadLookupPending;
        content = <div className="shell-empty" role="status"><h2>{t(isLoadingDestination ? "loading" : "shellChannelUnavailable")}</h2>
          {!isLoadingDestination && <><p>{t("shellChannelUnavailableHint")}</p><button className="btn-primary" onClick={() => {
            if (threadCandidate && serverId) void loadThread(serverId, destination.channelId, true);
            else void retry(serverId);
          }}>{t("retry")}</button></>}
        </div>;
      } else if ((destination.type === "text" || destination.type === "audit") && (!accessReady || !hasChannelPerm(Permissions.ViewChannel) || !hasChannelPerm(Permissions.ReadMessages))) {
        content = <div className="shell-empty" role="status"><h2>{t(!accessReady && overrideFailure !== identity ? "loading" : "shellChannelUnavailable")}</h2>
          {overrideFailure === identity && <button className="btn-primary" onClick={() => { setOverrideFailure(null); setOverrideAttempt((attempt) => attempt + 1); }}>{t("retry")}</button>}
          {accessReady && <><p>{t("shellChannelUnavailableHint")}</p><button className="btn-primary" onClick={() => useUIStore.getState().openServer(destination.serverInfo!.serverId)}>{destination.serverInfo?.serverName}</button></>}
        </div>;
      } else if (destination.type === "text") {
        content = <ChatArea channelId={channel.id} channel={channel} serverId={destination.serverInfo?.serverId} sendTyping={sendTyping} />;
      } else if (destination.type === "audit") {
        content = <AuditChannel channelId={channel.id} serverId={destination.serverInfo?.serverId} />;
      } else {
        content = <VoiceDestination channel={channel} serverId={destination.serverInfo?.serverId} onJoinVoice={onJoinVoice} sendTyping={sendTyping} />;
      }
      break;
    }
  }
  return <section className="shell-content" key={identity} aria-label={destination.label || t("friends")}>
    <SectionErrorBoundary key={identity} section="chat">{content}</SectionErrorBoundary>
  </section>;
}
