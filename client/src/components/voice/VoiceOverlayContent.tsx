import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export type VoiceOverlaySnapshot = {
  unlocked?: boolean;
  voiceOverlayPinned?: boolean;
  voiceOverlayQuickActions?: boolean;
  voiceOverlayClickableActions?: boolean;
  voiceOverlayNotificationActions?: boolean;
  voiceOverlayActivity?: boolean;
  voiceOverlayWelcome?: boolean;
  voiceOverlayGoLive?: boolean;
  goLiveEligible?: boolean;
  goLive?: { id: number; expiresAt: number } | null;
  goLiveHeight?: number;
  welcome?: { id: number; expiresAt: number } | null;
  welcomeHeight?: number;
  activities?: Array<{ userId: string; label: string; gameName: string }>;
  voiceOverlayNotifications?: boolean;
  voiceOverlayChat?: boolean;
  voiceOverlayChatActions?: boolean;
  voiceOverlayChatCompose?: boolean;
  chatStatus?: "ready" | "unavailable";
  chatMessages?: Array<{ id: string; author: string; text: string }>;
  chatActionSession?: string;
  chatActionsUnavailable?: boolean;
  chatComposeSession?: string;
  chatComposeLabel?: string;
  notificationActionSession?: string;
  notificationReplySession?: string;
  notificationReplyIds?: string[];
  notificationReplyButtons?: Array<{ id: string; row: number }>;
  notificationActionsUnavailable?: boolean;
  notificationStatus?: "loading" | "ready" | "unavailable";
  notifications?: Array<{ id: string; category: "mention" | "reply" | "friend_request" | "dm_request" | "system" }>;
  voiceActionSession?: string;
  selfMuted?: boolean;
  selfDeafened?: boolean;
  layoutSaveFailed?: boolean;
  quickActionsUnavailable?: boolean;
  enabled: boolean;
  participants: Array<{ id: string; name: string; avatarUrl: string; speaking: boolean; muted: boolean; deafened: boolean }>;
  speakingOpacity: number;
  idleOpacity: number;
  scale: number;
  position: "top-left" | "bottom-left" | "top-right" | "bottom-right";
  speakingOnly: boolean;
  voiceOverlayAvatarSize: "small" | "large";
  voiceOverlayNameDisplay: "always" | "speaking" | "never";
  voiceOverlayMaxParticipants: number;
};

type Props = { snapshot: VoiceOverlaySnapshot; actionsOnly?: boolean; notificationActionsOnly?: boolean; chatActionsOnly?: boolean; chatComposerOnly?: boolean };

const CHAT_MAX_MESSAGES = 5;
const CHAT_ROW_MAX_HEIGHT = 72;
const CHAT_HEADER_HEIGHT = 20;
const CHAT_MAX_HEIGHT = CHAT_HEADER_HEIGHT + CHAT_MAX_MESSAGES * CHAT_ROW_MAX_HEIGHT;

function boundedChatMessages(value: VoiceOverlaySnapshot["chatMessages"]): Array<{ id: string; author: string; text: string }> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, CHAT_MAX_MESSAGES).filter((message) =>
    !!message && typeof message.id === "string" && message.id.length > 0 && message.id.length <= 128 &&
    typeof message.author === "string" && message.author.length > 0 && message.author.length <= 128 &&
    typeof message.text === "string" && message.text.trim().length > 0 && message.text.length <= 500
  );
}

function VoiceOverlayToolbar({ snapshot }: { snapshot: VoiceOverlaySnapshot }) {
  const { t } = useTranslation("common");
  const [actionFailed, setActionFailed] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const actionBusy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const actionsEnabled = (snapshot.unlocked || snapshot.voiceOverlayClickableActions) && !!window.electronAPI?.sendOverlayVoiceAction;
  async function act(action: "toggle-mute" | "toggle-deafen") {
    if (!actionsEnabled || actionBusy.current || !snapshot.voiceActionSession) return;
    actionBusy.current = true;
    setActionPending(true);
    setActionFailed(false);
    try { if (await window.electronAPI!.sendOverlayVoiceAction!(action, snapshot.voiceActionSession) !== true && mounted.current) setActionFailed(true); }
    catch { if (mounted.current) setActionFailed(true); }
    finally { if (mounted.current) { actionBusy.current = false; setActionPending(false); } }
  }

  return <div className="voice-overlay-actions" role="group" aria-label={t("overlayQuickActions")}>
      <button type="button" tabIndex={-1} disabled={!actionsEnabled || actionPending} aria-pressed={snapshot.selfMuted === true} aria-label={t("overlayToggleMute")} title={t("overlayToggleMute")} onClick={() => void act("toggle-mute")}>⌁</button>
      <button type="button" tabIndex={-1} disabled={!actionsEnabled || actionPending} aria-pressed={snapshot.selfDeafened === true} aria-label={t("overlayToggleDeafen")} title={t("overlayToggleDeafen")} onClick={() => void act("toggle-deafen")}>◉</button>
      {(actionFailed || snapshot.quickActionsUnavailable) && <span className="voice-overlay-action-error" role="alert" title={t(snapshot.quickActionsUnavailable ? "overlayActionsUnavailable" : "overlayActionFailed")} aria-label={t(snapshot.quickActionsUnavailable ? "overlayActionsUnavailable" : "overlayActionFailed")}>!</span>}
    </div>;
}

function NotificationInboxButton({ session, replySession, replyButtons = [] }: { session: string; replySession?: string; replyButtons?: Array<{ id: string; row: number }> }) {
  const { t } = useTranslation("common");
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);
  const busy = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const send = window.electronAPI?.sendOverlayOpenInbox;
  async function openInbox() {
    if (!send || busy.current) return;
    busy.current = true;
    setPending(true);
    setFailed(false);
    try {
      if (await send(session) !== true && mounted.current) setFailed(true);
    } catch {
      if (mounted.current) setFailed(true);
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  }
  async function prepareReply(notificationId: string) {
    if (!replySession || !window.electronAPI?.sendOverlayPrepareNotificationReply || busy.current) return;
    busy.current = true; setPending(true); setFailed(false);
    try { if (await window.electronAPI.sendOverlayPrepareNotificationReply({ session: replySession, notificationId }) !== true && mounted.current) setFailed(true); }
    catch { if (mounted.current) setFailed(true); }
    finally { busy.current = false; if (mounted.current) setPending(false); }
  }
  const buttons = replyButtons.slice(0, 3).filter((item, index, all) => typeof item.id === "string" && item.id.length > 0 && item.id.length <= 128
    && Number.isInteger(item.row) && item.row >= 0 && item.row < 3 && all.findIndex(other => other.id === item.id || other.row === item.row) === index);
  return <div className="voice-overlay-notification-action-surface" style={{ height: 20 + (buttons.length ? Math.max(...buttons.map(item => item.row)) + 1 : 0) * 32 }}>
    {replySession && buttons.map(item => <button key={item.id} type="button" tabIndex={-1} style={{ position: "absolute", top: 20 + item.row * 32 + 6, left: 0 }}
      disabled={pending || !window.electronAPI?.sendOverlayPrepareNotificationReply} aria-label={t("overlayPrepareReply")} onClick={() => void prepareReply(item.id)}>{t("overlayPrepareReply")}</button>)}
    <button type="button" tabIndex={-1} disabled={!send || pending} aria-label={t("overlayOpenInbox")} title={t(failed ? "overlayOpenInboxFailed" : "overlayOpenInbox")}
      onClick={() => void openInbox()}>{t("overlayOpenInbox")}</button>
    {failed && <span className="voice-overlay-inbox-error" role="alert" aria-label={t("overlayOpenInboxFailed")} title={t("overlayOpenInboxFailed")}>!</span>}
  </div>;
}

function ChatActionSurface({ openSession, composeSession }: { openSession?: string; composeSession?: string }) {
  const { t } = useTranslation("common");
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [failedKind, setFailedKind] = useState<"main" | "composer">("main");
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const openChat = window.electronAPI?.sendOverlayOpenChat;
  const openComposer = window.electronAPI?.sendOverlayOpenChatComposer;
  const send = async (kind: "main" | "composer") => {
    const session = kind === "main" ? openSession : composeSession;
    const callback = kind === "main" ? openChat : openComposer;
    if (!session || !callback || busy.current) return;
    busy.current = true;
    setPending(true);
    setFailed(false);
    setFailedKind(kind);
    try { if (await callback(session) !== true && mounted.current) setFailed(true); }
    catch { if (mounted.current) setFailed(true); }
    finally { busy.current = false; if (mounted.current) setPending(false); }
  };
  return <div className="voice-overlay-notification-action-surface" style={{ width: openSession && composeSession ? 184 : 88, display: "flex", gap: 8 }}>
    {composeSession && <button type="button" tabIndex={-1} disabled={!openComposer || pending} aria-label={t("overlayComposeChat")} title={t(failed ? "overlayComposeChatFailed" : "overlayComposeChat")} onClick={() => void send("composer")}>{t("overlayComposeChat")}</button>}
    {openSession && <button type="button" tabIndex={-1} disabled={!openChat || pending} aria-label={t("overlayOpenChatInApp")} title={t(failed ? "overlayOpenChatFailed" : "overlayOpenChatInApp")} onClick={() => void send("main")}>{t("overlayOpenChat")}</button>}
    {failed && <span className="voice-overlay-inbox-error" role="alert" aria-label={t(failedKind === "main" ? "overlayOpenChatFailed" : "overlayComposeChatFailed")} title={t(failedKind === "main" ? "overlayOpenChatFailed" : "overlayComposeChatFailed")}>!</span>}
  </div>;
}

const CHAT_COMPOSER_MAX_LENGTH = 2000;
// This explicit control-character filter bounds IPC payloads while preserving LF and tab.
// eslint-disable-next-line no-control-regex
const DISALLOWED_CHAT_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

function ChatComposer({ session, label }: { session: string; label?: string }) {
  const { t } = useTranslation("common");
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<"failed" | "unavailable" | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const mounted = useRef(true);
  const busy = useRef(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { mounted.current = true; textarea.current?.focus(); return () => { mounted.current = false; }; }, []);
  const sendMessage = window.electronAPI?.sendOverlayChatMessage;
  const closeComposer = window.electronAPI?.closeOverlayChatComposer;
  useEffect(() => window.electronAPI?.onOverlayChatComposerClosed?.((event) => {
    if (event?.session !== session || !mounted.current) return;
    setDraft("");
    setResult(null);
    setConfirmDiscard(false);
  }), [session]);
  const send = async () => {
    const text = draft;
    if (!sendMessage || busy.current || !text.trim() || text.length > CHAT_COMPOSER_MAX_LENGTH || DISALLOWED_CHAT_CONTROLS.test(text)) return;
    busy.current = true;
    setPending(true);
    setResult(null);
    try {
      const status = await sendMessage({ session, requestId: crypto.randomUUID(), text });
      if (!mounted.current) return;
      if (status === "sent") { setDraft(""); setResult(null); }
      else setResult(status === "unavailable" ? "unavailable" : "failed");
    } catch { if (mounted.current) setResult("failed"); }
    finally { busy.current = false; if (mounted.current) setPending(false); }
  };
  const close = async () => {
    if (!closeComposer || pending) return;
    try { if (await closeComposer(session) !== true && mounted.current) setResult("unavailable"); }
    catch { if (mounted.current) setResult("unavailable"); }
  };
  const requestClose = () => {
    if (pending) return;
    if (draft.length > 0) setConfirmDiscard(true);
    else void close();
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape" && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); requestClose(); return; }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
      event.preventDefault(); void send();
    }
  };
  const input = (value: string) => {
    if (value.length <= CHAT_COMPOSER_MAX_LENGTH && !DISALLOWED_CHAT_CONTROLS.test(value)) { setDraft(value); setResult(null); setConfirmDiscard(false); }
  };
  return <section aria-label={t("overlayChatComposerTitle")} style={{ boxSizing: "border-box", width: "100%", height: "100%", minHeight: 0, padding: 8, display: "flex", flexDirection: "column", gap: 6, overflowY: "auto", background: "rgba(12, 14, 20, .96)", color: "#f4f6fb", font: "12px sans-serif" }}>
    <header className="voice-overlay-chat-composer-header" style={{ height: 20, minHeight: 20, flex: "0 0 20px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, minWidth: 0 }}><strong style={{ minWidth: 0, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{t("overlayChatComposerTitle")}{label ? ` · ${label}` : ""}</strong><button type="button" onClick={requestClose} disabled={pending} style={{ flex: "0 0 auto", minHeight: 24 }}>{t("overlayChatClose")}</button></header>
    <textarea ref={textarea} aria-label={t("overlayChatMessageLabel")} maxLength={CHAT_COMPOSER_MAX_LENGTH} value={draft} disabled={pending} onChange={(event) => input(event.target.value)} onKeyDown={onKeyDown} style={{ boxSizing: "border-box", width: "100%", minHeight: 50, flex: "1 0 50px", resize: "none" }} />
    {result && <p role="alert" style={{ margin: 0, flex: "0 0 auto" }}>{t(result === "failed" ? "overlayChatSendUnknown" : "overlayChatSendUnavailable")}</p>}
    {confirmDiscard ? <div role="group" aria-label={t("overlayChatDiscardConfirmation")} style={{ flex: "0 0 auto", display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}><span>{t("overlayChatDiscardConfirmation")}</span><button type="button" onClick={() => { setDraft(""); setConfirmDiscard(false); void close(); }} style={{ minHeight: 24 }}>{t("overlayChatDiscard")}</button><button type="button" onClick={() => setConfirmDiscard(false)} style={{ minHeight: 24 }}>{t("overlayChatKeepEditing")}</button></div>
      : <button type="button" disabled={pending || !draft.trim() || !sendMessage || draft.length > CHAT_COMPOSER_MAX_LENGTH || DISALLOWED_CHAT_CONTROLS.test(draft)} onClick={() => void send()} style={{ flex: "0 0 auto", minHeight: 24 }}>{pending ? t("overlayChatSending") : t("overlayChatSend")}</button>}
    <small style={{ flex: "0 0 auto", overflowWrap: "anywhere" }}>{t("overlayChatComposeSessionWarning")}</small>
  </section>;
}

function OverlayWelcomeNotice({ notice, bottom, height = 32, textKey = "overlayWelcomeNotice" }: { notice: { id: number; expiresAt: number }; bottom: number; height?: 32 | 64; textKey?: "overlayWelcomeNotice" | "overlayGoLiveGuidance" }) {
  const { t } = useTranslation("common");
  const [visible, setVisible] = useState(() => notice.expiresAt > Date.now() && notice.expiresAt <= Date.now() + 20000);
  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(false), Math.max(0, notice.expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [notice.expiresAt]);
  return visible ? <div role="status" className="voice-overlay-welcome" style={{ position: "absolute", bottom, left: 8, right: 8, height, boxSizing: "border-box", overflow: "hidden", padding: "6px", borderRadius: 6, background: "rgba(12, 14, 20, .96)", color: "#f4f6fb", fontSize: 12, lineHeight: height === 64 ? "16px" : "20px", overflowWrap: "anywhere", pointerEvents: "none" }}>{t(textKey)}</div> : null;
}

export default function VoiceOverlayContent({ snapshot, actionsOnly = false, notificationActionsOnly = false, chatActionsOnly = false, chatComposerOnly = false }: Props) {
  const { t } = useTranslation("common");
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const updateWidth = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", updateWidth);
    return () => window.removeEventListener("resize", updateWidth);
  }, []);
  const showActions = snapshot.voiceOverlayQuickActions === true && !!snapshot.voiceActionSession;
  const showActivity = snapshot.voiceOverlayActivity === true;
  const showNotifications = snapshot.voiceOverlayNotifications === true;
  const showChat = snapshot.voiceOverlayChat === true;
  const canOpenInbox = showNotifications && snapshot.voiceOverlayNotificationActions === true
    && snapshot.notificationStatus === "ready" && (snapshot.notifications?.length ?? 0) > 0
    && typeof snapshot.notificationActionSession === "string" && snapshot.notificationActionsUnavailable !== true;
  const notificationActionAuthorized = snapshot.enabled && showNotifications
    && snapshot.voiceOverlayNotificationActions === true && typeof snapshot.notificationActionSession === "string";
  const canOpenChat = showChat && snapshot.voiceOverlayChatActions === true && snapshot.chatStatus === "ready"
    && typeof snapshot.chatActionSession === "string" && snapshot.chatActionsUnavailable !== true;
  const chatActionAuthorized = snapshot.enabled && canOpenChat;
  const composeSession = snapshot.enabled && snapshot.voiceOverlayChatCompose === true && typeof snapshot.chatComposeSession === "string" && snapshot.chatComposeSession.length > 0 ? snapshot.chatComposeSession : undefined;
  if (chatComposerOnly) {
    const label = typeof snapshot.chatComposeLabel === "string" && snapshot.chatComposeLabel.length <= 128 && !DISALLOWED_CHAT_CONTROLS.test(snapshot.chatComposeLabel) ? snapshot.chatComposeLabel : undefined;
    return composeSession ? <ChatComposer key={composeSession} session={composeSession} label={label} /> : null;
  }
  if (notificationActionsOnly) return notificationActionAuthorized
    ? <NotificationInboxButton key={`${snapshot.notificationActionSession}:${snapshot.notificationReplySession ?? ""}`} session={snapshot.notificationActionSession!} replySession={snapshot.notificationReplySession} replyButtons={snapshot.notificationReplyButtons} />
    : null;
  if (chatActionsOnly) {
    const openSession = chatActionAuthorized ? snapshot.chatActionSession : undefined;
    if (!openSession && !composeSession) return null;
    return <ChatActionSurface key={`${openSession ?? ""}:${composeSession ?? ""}`} openSession={openSession} composeSession={composeSession} />;
  }
  if (!snapshot.enabled || (snapshot.voiceOverlayMaxParticipants === 0 && !showActions && !showActivity && !showNotifications && !showChat)) return null;
  const participants = snapshot.participants.filter((participant) => !snapshot.speakingOnly || participant.speaking)
    .slice(0, Math.max(0, Math.min(25, Math.floor(snapshot.voiceOverlayMaxParticipants))));
  const transformOrigin = `${snapshot.position.startsWith("top") ? "top" : "bottom"} ${snapshot.position.endsWith("left") ? "left" : "right"}`;
  const scaleFactor = snapshot.scale / 100;
  const maxWidthVw = viewportWidth > 0 ? Math.min(100, Math.max(0, ((viewportWidth - 16) / scaleFactor / viewportWidth) * 100)) : 100;
  const toolbar = showActions && <VoiceOverlayToolbar key={snapshot.voiceActionSession} snapshot={snapshot} />;
  if (actionsOnly) return <div className="voice-overlay-action-surface">{toolbar}</div>;
  const activities = (snapshot.activities ?? []).slice(0, 5);
  const activityHeight = showActivity ? 20 + Math.max(1, activities.length) * 40 : 0;
  const notifications = (snapshot.notifications ?? []).slice(0, 3);
  const notificationRows = snapshot.notificationStatus === "ready" ? Math.max(1, notifications.length) : 1;
  const notificationHeight = showNotifications ? 20 + notificationRows * 32 : 0;
  const actionHeight = showActions ? 48 : 0;
  const goLiveHeight = snapshot.voiceOverlayGoLive === true && snapshot.goLiveEligible === true && snapshot.goLiveHeight === 64 ? 64 : 0;
  const goLive = goLiveHeight && snapshot.goLive && Number.isSafeInteger(snapshot.goLive.id) && snapshot.goLive.id > 0 && Number.isFinite(snapshot.goLive.expiresAt) ? snapshot.goLive : null;
  const welcomeHeight = snapshot.voiceOverlayWelcome === true && snapshot.welcomeHeight === 32 ? 32 : 0;
  const welcome = welcomeHeight && snapshot.welcome && Number.isSafeInteger(snapshot.welcome.id) && snapshot.welcome.id > 0 && Number.isFinite(snapshot.welcome.expiresAt) ? snapshot.welcome : null;
  const notificationLabels = {
    mention: "overlayNotificationMention",
    reply: "overlayNotificationReply",
    friend_request: "overlayNotificationFriendRequest",
    dm_request: "overlayNotificationDMRequest",
    system: "overlayNotificationSystem",
  } as const;
  const notificationStatus = snapshot.notificationStatus ?? "unavailable";
  const canShowChatCTA = canOpenChat;
  const chatMessages = showChat && snapshot.chatStatus === "ready" ? boundedChatMessages(snapshot.chatMessages) : [];
  const chatHasRows = snapshot.chatStatus === "ready" && chatMessages.length > 0;
  const chatHeight = showChat ? CHAT_HEADER_HEIGHT + (chatHasRows ? chatMessages.length : 1) * CHAT_ROW_MAX_HEIGHT : 0;
  return <div className="voice-overlay-root" data-position={snapshot.position} data-unlocked={snapshot.unlocked === true} data-actions={showActions}
    style={{ paddingTop: 8 + chatHeight, paddingBottom: 8 + actionHeight + activityHeight + notificationHeight + welcomeHeight + goLiveHeight }}>
    {toolbar}
    {goLive && <OverlayWelcomeNotice key={`go-live:${goLive.id}`} notice={goLive} bottom={8 + actionHeight + activityHeight + notificationHeight + welcomeHeight} height={64} textKey="overlayGoLiveGuidance" />}
    {welcome && <OverlayWelcomeNotice key={welcome.id} notice={welcome} bottom={8 + actionHeight + activityHeight + notificationHeight} />}
    {showChat && <section className="voice-overlay-chat" aria-label={t("overlayChatTitle")}
      style={{ position: "absolute", top: 8, left: 8, right: 8, height: chatHeight, maxHeight: CHAT_MAX_HEIGHT, overflow: "hidden", boxSizing: "border-box", borderRadius: 6, background: "rgba(12, 14, 20, .94)", color: "#f4f6fb", zIndex: 2, pointerEvents: "none" }}>
      <header style={{ boxSizing: "border-box", height: CHAT_HEADER_HEIGHT, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 4, padding: "2px 6px", overflow: "hidden" }}>
        <h2 style={{ minWidth: 0, flex: "1 1 auto", margin: 0, fontSize: 12, lineHeight: "16px", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{t("overlayChatTitle")}</h2>
        {canShowChatCTA && <span className="voice-overlay-open-inbox" aria-hidden="true">{t("overlayOpenChat")}</span>}
        {snapshot.chatActionsUnavailable && snapshot.voiceOverlayChatActions === true && <span className="voice-overlay-action-error" role="img" title={t("overlayChatActionsUnavailable")} aria-label={t("overlayChatActionsUnavailable")}>!</span>}
      </header>
      {snapshot.chatStatus !== "ready"
        ? <p className="voice-overlay-chat-state" style={{ height: CHAT_ROW_MAX_HEIGHT, maxHeight: CHAT_ROW_MAX_HEIGHT, boxSizing: "border-box", margin: 0, padding: "6px", overflow: "hidden", color: "#b5bccd", fontSize: 12, lineHeight: "16px" }}>{t("overlayChatUnavailable")}</p>
        : chatMessages.length === 0
          ? <p className="voice-overlay-chat-state" style={{ height: CHAT_ROW_MAX_HEIGHT, maxHeight: CHAT_ROW_MAX_HEIGHT, boxSizing: "border-box", margin: 0, padding: "6px", overflow: "hidden", color: "#b5bccd", fontSize: 12, lineHeight: "16px" }}>{t("overlayChatEmpty")}</p>
          : chatMessages.map((message) => <article className="voice-overlay-chat-row" key={message.id}
            style={{ height: CHAT_ROW_MAX_HEIGHT, maxHeight: CHAT_ROW_MAX_HEIGHT, boxSizing: "border-box", overflow: "hidden", padding: "4px 6px", fontSize: 12, lineHeight: "16px" }}>
            <strong style={{ display: "block", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{message.author}</strong>
            <div style={{ maxHeight: 48, overflow: "hidden", overflowWrap: "anywhere", color: "#d6dbea" }}>{message.text}</div>
          </article>)}
    </section>}
    {showNotifications && <section className="voice-overlay-notifications" aria-label={t("overlayNotificationsTitle")}
      style={{ bottom: 8 + actionHeight, height: notificationHeight }}>
      <header className="voice-overlay-notifications-header">
        <h2>{t("overlayNotificationsTitle")}</h2>
        {canOpenInbox && <span className="voice-overlay-open-inbox" aria-hidden="true">{t("overlayOpenInbox")}</span>}
        {snapshot.notificationActionsUnavailable && <span className="voice-overlay-action-error" role="img" title={t("overlayNotificationActionsUnavailable")} aria-label={t("overlayNotificationActionsUnavailable")}>!</span>}
      </header>
      {notificationStatus === "loading" ? <p className="voice-overlay-notification-state">{t("overlayNotificationsLoading")}</p>
        : notificationStatus === "unavailable" ? <p className="voice-overlay-notification-state">{t("overlayNotificationsUnavailable")}</p>
          : notifications.length === 0 ? <p className="voice-overlay-notification-state">{t("overlayNotificationsEmpty")}</p>
            : notifications.map((notification) => <div className="voice-overlay-notification-row" key={notification.id} style={{ paddingRight: snapshot.notificationReplyIds?.includes(notification.id) ? 100 : undefined }}>
              <span aria-hidden="true" className="voice-overlay-notification-dot" />
              <span>{t(notificationLabels[notification.category])}</span>
            </div>)}
    </section>}
    {showActivity && <section className="voice-overlay-activity" aria-label={t("overlayActivityTitle")} style={{ bottom: 8 + actionHeight + notificationHeight, height: activityHeight }}>
      <h2>{t("overlayActivityTitle")}</h2>
      {activities.length ? activities.map((entry) => <div className="voice-overlay-activity-row" key={entry.userId} title={t("gameActivitySelfReported")}>
        <strong>{entry.label}</strong><span>{t("gameActivityPlaying", { name: entry.gameName })}</span>
      </div>) : <p className="voice-overlay-activity-empty">{t("overlayActivityEmpty")}</p>}
    </section>}
    {snapshot.layoutSaveFailed && <span className="voice-overlay-layout-error" role="alert" title={t("overlayLayoutSaveFailed")} aria-label={t("overlayLayoutSaveFailed")}>!</span>}
    {snapshot.voiceOverlayPinned && <span className="voice-overlay-pin" title={t("overlayWidgetPinned")} aria-label={t("overlayWidgetPinned")}>⌖</span>}
    <div className="voice-overlay-widget" data-avatar-size={snapshot.voiceOverlayAvatarSize} style={{ transform: `scale(${scaleFactor})`, transformOrigin, maxWidth: `${maxWidthVw}vw` }}>
      {participants.map((participant) => <div key={participant.id}
        className={`voice-overlay-row${participant.speaking ? " speaking" : ""}`}
        style={{ opacity: (participant.speaking ? snapshot.speakingOpacity : snapshot.idleOpacity) / 100 }}>
        <div className="voice-overlay-avatar" aria-hidden="true">
          {participant.avatarUrl ? <img src={participant.avatarUrl} alt="" /> : participant.name.charAt(0).toUpperCase()}
        </div>
        {snapshot.voiceOverlayNameDisplay !== "never" && (snapshot.voiceOverlayNameDisplay !== "speaking" || participant.speaking) && <span>{participant.name}</span>}
        {(participant.muted || participant.deafened) && <b aria-hidden="true">{participant.deafened ? "◉" : "⌁"}</b>}
      </div>)}
    </div>
  </div>;
}
