/**
 * Message — Renders a single chat message (channel or DM).
 *
 * Single responsibility: composition + presentation of one message row.
 * State and pure logic live elsewhere:
 *   - useMessageEditing       — edit mode state machine + mention autocomplete
 *   - utils/messageParsers    — content rendering, role helpers, preview URLs
 *   - MessageList             — reads ChatContext once and fans out per-row
 *     props (this component is memoized; see the MessageProps comment)
 *   - useContextMenu / useLongPress — interaction primitives
 */

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "../../stores/authStore";
import { getAuthSessionSnapshot } from "../../api/authSessionEvents";
import { useE2EEStore } from "../../stores/e2eeStore";
import { useSavedStore } from "../../stores/savedStore";
import { useSpamVisibility } from "../../hooks/useSpamVisibility";
import UnclassifiedMediaGate from "./UnclassifiedMediaGate";
import MessageBodyMediaGate from "./MessageBodyMediaGate";
import SpamPreview from "./SpamPreview";
import type { ChatMessage } from "../../hooks/useChatContext";
import { copyToClipboard } from "../../utils/constants";
import { formatFullDateTime, formatMessageTime } from "../../utils/dateFormat";
import { useConfirm } from "../../hooks/useConfirm";
import { useContextMenu } from "../../hooks/useContextMenu";
import type { ContextMenuItem } from "../../hooks/useContextMenu";
import { useIsMobile } from "../../hooks/useMediaQuery";
import { useLongPress } from "../../hooks/useLongPress";
import { useMessageEditing } from "../../hooks/useMessageEditing";
import { useUserBadges } from "../../hooks/useUserBadges";
import { useActiveRoles } from "../../stores/roleStore";
import {
  getHighestRoleColor,
  getMessagePreviewUrls,
  getRoleType,
  renderMessageContent,
} from "../../utils/messageParsers";
import { plainPreview } from "../../utils/expressionTokens";
import type { MemberWithRoles, PublicUser } from "../../types";
import DecoratedAvatar from "../cosmetics/DecoratedAvatar";
import StyledName from "../cosmetics/StyledName";
import { useUserCosmetics } from "../../hooks/useUserCosmetics";
import BadgePill from "../shared/BadgePill";
import ContextMenu from "../shared/ContextMenu";
import LinkPreviewCard from "./LinkPreviewCard";
import MemberCard from "../members/MemberCard";
import MentionAutocomplete from "./MentionAutocomplete";
import MessageAttachments from "./MessageAttachments";
import MessageHoverActions from "./MessageHoverActions";
import MessageReactions from "./MessageReactions";
import GameMessageOrigin from "./GameMessageOrigin";
import MobileMessageActions from "./MobileMessageActions";
import ReportModal from "../shared/ReportModal";
import {
  getApplicationInvocation,
  invokeMessageApplicationAction,
  type ApplicationAction,
} from "../../api/applications";
import { useToastStore } from "../../stores/toastStore";
import { useAccessibilityStore } from "../../stores/accessibilityStore";
import { useDeveloperSettingsStore } from "../../stores/developerSettingsStore";
import { useIgnoredMessageVisibility } from "../../hooks/useIgnoredMessage";
import { markUnreadFrom } from "../../api/readState";
import { markDMUnreadFrom } from "../../api/dm";
import { useReadStateStore } from "../../stores/readStateStore";
import { useDMStore } from "../../stores/dmStore";
import { buildMessageLink } from "../../utils/messageLinks";
import ReminderModal from "./ReminderModal";
import { buildMessageActions } from "./messageActionRegistry";
import ForwardMessageModal from "./ForwardMessageModal";
import ThreadModal from "./ThreadModal";
import { useThreadStore } from "../../stores/threadStore";
import { useChannelStore } from "../../stores/channelStore";
import { useServerStore } from "../../stores/serverStore";
import { useUIStore } from "../../stores/uiStore";
import { focusMessageComposer, runMessageShortcut } from "../../utils/messageShortcuts";
import { speakMessage } from "../../utils/textToSpeech";
import { useShortcutBindingsStore } from "../../stores/shortcutBindingsStore";
import { useShortcutCaptureStore } from "../../stores/shortcutCaptureStore";

type MessageProps = {
  message: ChatMessage;
  /** Consecutive message from same author? (compact mode) */
  isCompact: boolean;
  /**
   * Everything below used to come from useChatContext(). Rows now receive
   * plain props instead so React.memo can skip them: the provider's context
   * value changes identity on every typing event / presence churn / reply
   * state change, which re-rendered EVERY message row on each keystroke-
   * adjacent event. MessageList (which re-renders anyway) reads the context
   * once and fans out per-row props; the action callbacks are
   * useCallback-stable in the providers.
   */
  isPinned: boolean;
  mode: "channel" | "dm";
  /** Cosmetics scope: the server id in a channel, null in DMs (Faz G). */
  cosmeticScope: string | null;
  canManageMessages: boolean;
  /** Author's member entry (role color/type) — undefined in DMs. */
  member: MemberWithRoles | undefined;
  /** Current user's member entry — role-mention highlight. */
  currentMember: MemberWithRoles | undefined;
  /** Full member list — mention tokens inside message content. */
  members: MemberWithRoles[];
  editMessage: (id: string, content: string) => Promise<boolean>;
  deleteMessage: (id: string) => Promise<boolean>;
  toggleReaction: (messageId: string, emoji: string) => void;
  setReplyingTo: (msg: ChatMessage | null) => void;
  setScrollToMessageId: (id: string | null) => void;
  pinMessage: (messageId: string) => Promise<void>;
  unpinMessage: (messageId: string) => Promise<void>;
  channelId: string;
  applicationActions: ApplicationAction[];
};

/**
 * Thread actions are only supported from text-channel parents. When a server
 * tree has not loaded yet, preserve the existing text-chat affordance unless
 * the thread store already proves this channel is itself a thread; nested
 * threads are not supported by the API.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function canStartThreadFromChannel(
  channelID: string,
  channelTree: ReturnType<typeof useChannelStore.getState>["categoriesByServer"][string],
  knownThread: boolean,
): boolean {
  const listedChannel = channelTree?.flatMap((category) => category.channels).find((channel) => channel.id === channelID);
  if (listedChannel) return listedChannel.type === "text";
  return !knownThread;
}

// Zustand selectors must return a referentially stable fallback. Returning a
// fresh `{}` here made React's external-store snapshot change on every read,
// so rendering the first real message could recurse until the chat boundary
// crashed with "Maximum update depth exceeded".

function Message({
  message,
  isCompact,
  isPinned,
  mode,
  cosmeticScope,
  canManageMessages,
  member,
  currentMember,
  members,
  editMessage,
  deleteMessage,
  toggleReaction,
  setReplyingTo,
  setScrollToMessageId,
  pinMessage,
  unpinMessage,
  channelId,
  applicationActions,
}: MessageProps) {
  const { t, i18n } = useTranslation("chat");
  const { t: tE2ee } = useTranslation("e2ee");
  const { t: tSaved } = useTranslation("saved");
  const currentUser = useAuthStore((s) => s.user);
  const spam = useSpamVisibility(message, { kind: mode === "dm" ? "dm" : "channel", channelId });
  const roleColorMode = useAccessibilityStore((s) => s.roleColorMode);
  const officialMessageStyle = useAccessibilityStore((s) => s.officialMessageStyle);
  const { ignored: isIgnored, shown: showIgnoredContent, reveal: revealIgnoredContent } = useIgnoredMessageVisibility(message, `${mode}:${channelId}`);
  const developerMode = useDeveloperSettingsStore((s) => s.developerMode);
  // Bookmark state — channel and DM messages live in separate id indexes.
  const isSaved = useSavedStore((s) =>
    mode === "dm" ? !!s.savedDMMessageIds[message.id] : !!s.savedMessageIds[message.id],
  );
  const toggleSaved = useSavedStore((s) => s.toggle);
  const ensureSavedIds = useSavedStore((s) => s.ensureIds);
  // Surface E2EE decryption failures inline so empty bubbles aren't
  // mistaken for blank messages. dmEncryption.ts pushes both failure
  // paths (decrypt throw + missing envelope for this device) into the
  // store; this selector reads the per-message presence flag.
  const hasDecryptionError = useE2EEStore((s) =>
    s.decryptionErrors.some((e) => e.messageId === message.id),
  );

  const roles = useActiveRoles();
  const isMobile = useIsMobile();
  const confirm = useConfirm();
  const { menuState, openMenu, closeMenu } = useContextMenu();
  const channelThreads = useThreadStore((state) => state.byParent[channelId]);
  const loadThreads = useThreadStore((state) => state.loadParent);
  const rememberThread = useThreadStore((state) => state.remember);
  const channelTree = useChannelStore((state) => cosmeticScope ? state.categoriesByServer[cosmeticScope] : undefined);
  const knownThread = useThreadStore((state) => state.byID[channelId]?.type === "thread" && state.serverIdByThread[channelId] === cosmeticScope);
  const threadActionsAllowed = mode === "channel" && Boolean(cosmeticScope)
    && canStartThreadFromChannel(channelId, channelTree, knownThread);
  const messageThread = threadActionsAllowed ? channelThreads?.find((thread) => thread.starter_message_id === message.id) : undefined;
  const threadGeneration = getAuthSessionSnapshot().generation;
  useEffect(() => {
    const scope = getAuthSessionSnapshot();
    if (threadActionsAllowed && cosmeticScope && currentUser?.id === scope.ownerId && threadGeneration === scope.generation) void loadThreads(cosmeticScope, channelId);
  }, [threadActionsAllowed, cosmeticScope, channelId, loadThreads, currentUser?.id, threadGeneration]);

  const openExistingThread = useCallback(() => {
    if (!threadActionsAllowed || !messageThread || !cosmeticScope) return;
    const scope = getAuthSessionSnapshot();
    if (!currentUser?.id || currentUser.id !== scope.ownerId || threadGeneration !== scope.generation) return;
    rememberThread(messageThread, cosmeticScope);
    const server = useServerStore.getState().servers.find((item) => item.id === cosmeticScope);
    useUIStore.getState().openTab(messageThread.id, "text", messageThread.name, server ? { serverId: cosmeticScope, serverName: server.name, serverIconUrl: server.icon_url } : undefined);
  }, [messageThread, cosmeticScope, rememberThread, threadActionsAllowed, currentUser, threadGeneration]);

  const invokeApplicationAction = useCallback(async (action: ApplicationAction) => {
    if (!cosmeticScope || !action.id) return;
    const toast = useToastStore.getState().addToast;
    const started = await invokeMessageApplicationAction(cosmeticScope, channelId, message.id, action.id);
    if (!started.success || !started.data) {
      toast("error", t("applicationActionFailed"));
      return;
    }

    toast("info", t("applicationActionQueued", { action: action.label }));
    const invocationID = started.data.id;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
      const status = await getApplicationInvocation(invocationID);
      if (!status.success || !status.data) continue;
      if (status.data.status === "succeeded") {
        toast("success", status.data.result_text?.trim() || t("applicationActionCompleted"));
        return;
      }
      if (status.data.status === "failed" || status.data.status === "expired") {
        toast("error", t(status.data.status === "expired" ? "applicationActionExpired" : "applicationActionFailed"));
        return;
      }
    }
    toast("warning", t("applicationActionPending"));
  }, [channelId, cosmeticScope, message.id, t]);

  // Destructure the editing hook's return at the top so downstream JSX
  // reads named locals (editTextareaRef, editContent, onChange, ...)
  // instead of `editing.<prop>` everywhere — the react-hooks/refs rule
  // treats `<hookBag>.<refLike>` access in render as a "current read"
  // because it can't statically prove the property isn't a ref.
  const {
    isEditing,
    editContent,
    editMentionQuery,
    editTextareaRef,
    startEdit,
    saveAndExit,
    cancel: cancelEdit,
    onChange: onEditChange,
    onMentionSelect: onEditMentionSelect,
    closeMentionAutocomplete: closeEditMentionAutocomplete,
  } = useMessageEditing({
    initialContent: message.content,
    saveEdit: (newContent) => editMessage(message.id, newContent),
  });

  const [pickerSource, setPickerSource] = useState<"bar" | "hover" | null>(null);
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reminderOpen, setReminderOpen] = useState(false);
  const [forwardOpen, setForwardOpen] = useState(false);
  const [threadOpen, setThreadOpen] = useState(false);
  const [profileTarget, setProfileTarget] = useState<{ user: PublicUser; top: number; left: number } | null>(null);

  const isOwner = currentUser?.id === message.user_id;
  const displayName = message.author?.display_name ?? message.author?.username ?? "Unknown";

  // Role display info — member prop is undefined in DMs (showRoleColors=false)
  const roleType = getRoleType(member);
  const roleColor = getHighestRoleColor(member);

  const userBadges = useUserBadges(message.user_id);
  const cosmetics = useUserCosmetics(message.author?.id ?? message.user_id, cosmeticScope);

  // Highlight the message if the current user is mentioned (direct or via role).
  const isMentioned = useMemo(() => {
    if (!currentUser) return false;
    if (message.mentions?.includes(currentUser.id)) return true;
    if (message.role_mentions?.length && currentMember?.roles?.length) {
      const myRoleIds = new Set(currentMember.roles.map((r) => r.id));
      return message.role_mentions.some((rid) => myRoleIds.has(rid));
    }
    return false;
  }, [message, currentUser, currentMember]);

  const locale = i18n.language ?? "en";
  const yesterdayLabel = t("yesterday");
  const timeLabels = useMemo(() => ({ yesterday: yesterdayLabel }), [yesterdayLabel]);
  const formatTime = (dateStr: string) => formatMessageTime(dateStr, locale, timeLabels);
  const formatFullDate = (dateStr: string) => formatFullDateTime(dateStr, locale);

  const handleDelete = useCallback(async () => {
    const actorId = currentUser?.id;
    const ok = await confirm({
      message: t("deleteMessageConfirm"),
      confirmLabel: t("deleteMessage"),
      danger: true,
    });
    if (!ok || !actorId || useAuthStore.getState().user?.id !== actorId) return;
    await deleteMessage(message.id);
  }, [confirm, deleteMessage, message.id, t, currentUser?.id]);

  const handlePinToggle = useCallback(async () => {
    if (isPinned) await unpinMessage(message.id);
    else await pinMessage(message.id);
  }, [isPinned, message.id, pinMessage, unpinMessage]);

  const handleReply = useCallback(() => setReplyingTo(message), [message, setReplyingTo]);
  const handleReaction = useCallback(
    (emoji: string) => toggleReaction(message.id, emoji),
    [message.id, toggleReaction],
  );

  const handleScrollToReply = useCallback(() => {
    if (message.reply_to_id) setScrollToMessageId(message.reply_to_id);
  }, [message.reply_to_id, setScrollToMessageId]);

  const handleToggleSave = useCallback(() => {
    void toggleSaved({ kind: mode === "dm" ? "dm" : "message", id: message.id });
  }, [toggleSaved, mode, message.id]);

  const handleMarkUnread = useCallback(async () => {
    const result = mode === "channel" && cosmeticScope
      ? await markUnreadFrom(cosmeticScope, channelId, message.id)
      : await markDMUnreadFrom(channelId, message.id);
    if (!result.success || !result.data) {
      useToastStore.getState().addToast("error", t("markUnreadFailed"));
      return;
    }
    if (mode === "channel") {
      useReadStateStore.setState((state) => ({ unreadCounts: { ...state.unreadCounts, [channelId]: result.data!.unread_count } }));
    } else {
      useDMStore.setState((state) => ({ dmUnreadCounts: { ...state.dmUnreadCounts, [channelId]: result.data!.unread_count } }));
    }
    useToastStore.getState().addToast("success", t("markedUnread"));
  }, [channelId, cosmeticScope, message.id, mode, t]);

  const handleCopyLink = useCallback(async () => {
    const target = mode === "channel" && cosmeticScope
      ? { kind: "channel" as const, serverId: cosmeticScope, channelId, messageId: message.id }
      : { kind: "dm" as const, channelId, messageId: message.id };
    try {
      await copyToClipboard(buildMessageLink(target));
      useToastStore.getState().addToast("success", t("messageLinkCopied"));
    } catch {
      useToastStore.getState().addToast("error", t("messageLinkCopyFailed"));
    }
  }, [channelId, cosmeticScope, message.id, mode, t]);

  const messageActions = useMemo(() => buildMessageActions({
    labels: {
      reply: t("replyMessage"),
      reaction: t("addReaction"),
      forward: t("forwardMessage"),
      thread: t("threadAction"),
      copy: t("copyMessage"),
      speak: t("common:shortcutMessageSpeak"),
      "copy-link": t("copyMessageLink"),
      save: isSaved ? tSaved("unsave") : tSaved("save"),
      "mark-unread": t("markUnread"),
      reminder: t("remindMe"),
      applications: t("applicationActions"),
      "applications-empty": t("applicationActionsEmpty"),
      report: t("reportMessage"),
      pin: isPinned ? t("unpinMessage") : t("pinMessage"),
      edit: t("editMessage"),
      delete: t("deleteMessage"),
      "copy-id": t("copyId"),
    },
    hasContent: Boolean(message.content) && !spam.hidden && (!isIgnored || showIgnoredContent) && !hasDecryptionError,
    isOwner,
    isSaved,
    isPinned,
    canManageMessages,
    developerMode,
    supportsApplications: mode === "channel" && Boolean(cosmeticScope),
    supportsThreads: threadActionsAllowed,
    applicationActions,
    onApplicationAction: (action) => { void invokeApplicationAction(action); },
    onReply: handleReply,
    onReaction: () => setPickerSource("bar"),
    onForward: () => setForwardOpen(true),
    onThread: () => setThreadOpen(true),
    onCopy: () => { if (message.content) void copyToClipboard(message.content).catch(() => useToastStore.getState().addToast("error",t("common:shortcutCopyFailed"))); },
    onSpeak: () => {
      if (spam.hidden || (isIgnored && !showIgnoredContent) || hasDecryptionError) return;
      if (!speakMessage(displayName, message.content)) useToastStore.getState().addToast("error", t("common:shortcutSpeechUnavailable"));
    },
    onCopyLink: () => { void handleCopyLink(); },
    onSaveToggle: handleToggleSave,
    onMarkUnread: () => { void handleMarkUnread(); },
    onRemind: () => setReminderOpen(true),
    onReport: () => setReportOpen(true),
    onPinToggle: () => { void handlePinToggle(); },
    onEdit: startEdit,
    onDelete: () => { void handleDelete(); },
    onCopyID: () => { void copyToClipboard(message.id).catch(() => useToastStore.getState().addToast("error",t("common:shortcutCopyFailed"))); },
  }), [applicationActions, canManageMessages, cosmeticScope, developerMode, handleCopyLink,
    handleDelete, handleMarkUnread, handlePinToggle, handleReply, handleToggleSave, invokeApplicationAction,
    isOwner, isPinned, isSaved, message.content, message.id, mode, startEdit, t, tSaved, spam.hidden, isIgnored, showIgnoredContent, hasDecryptionError, displayName, threadActionsAllowed]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      // Bookmark. The id index is normally warmed by the sidebar header;
      // this keeps the label right when that button never mounted.
      void ensureSavedIds();
      const items: ContextMenuItem[] = messageActions.map((action) => ({
        label: action.label,
        onClick: action.run,
        danger: action.danger,
        separator: action.separator,
        disabled: action.disabled,
        children: action.children?.map((child) => ({
          label: child.label,
          onClick: child.run,
          disabled: child.disabled,
        })),
      }));
      openMenu(e, items);
    },
    [ensureSavedIds, messageActions, openMenu],
  );

  // Long-press → bottom-sheet on mobile (in lieu of context menu)
  const longPressHandlers = useLongPress(
    useCallback(() => setMobileActionsOpen(true), []),
    { delay: 500 },
  );

  const renderedContent = useMemo(
    () => renderMessageContent(message.content, roles, members),
    [message.content, roles, members],
  );

  const previewUrls = useMemo(() => getMessagePreviewUrls(message.content), [message.content]);

  const msgClass =
    `msg${!isCompact ? " first-of-group" : " grouped"}` +
    `${pickerSource ? " picker-open" : ""}` +
    `${isMentioned ? " msg-mentioned" : ""}` +
    `${message.author?.is_bot ? ` msg-official msg-official-${officialMessageStyle}` : ""}`;

  return (
    <div
      className={msgClass}
      tabIndex={0}
      role="article"
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || useShortcutCaptureStore.getState().active) return;
        if (event.ctrlKey && event.code === "KeyC" && window.getSelection()?.toString()) return;
        runMessageShortcut(event.nativeEvent, messageActions, spam.hidden || (isIgnored && !showIgnoredContent) || hasDecryptionError, useShortcutBindingsStore.getState().bindings, () => focusMessageComposer(event.currentTarget));
      }}
      {...(isMobile ? longPressHandlers : {})}
      onContextMenu={isMobile ? longPressHandlers.onContextMenu : handleContextMenu}
    >
      <div className="msg-row">
        <div className="msg-avatar">
          <button
            className="msg-avatar-btn"
            onClick={(e) => {
              if (!message.author) return;
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setProfileTarget({
                user: message.author,
                top: rect.top,
                left: rect.right + 8,
              });
            }}
          >
            {/* Never animated in the message list (Karar G-12). */}
            <DecoratedAvatar
              name={displayName}
              role={roleType}
              avatarUrl={message.author?.avatar_url ?? undefined}
              size={30}
              frame={cosmetics.avatar_frame}
              animateFrame={false}
            />
          </button>
        </div>

        <div className="msg-body">
          <div className="msg-meta">
            <span className="msg-name">
              {roleColorMode === "dots" && roleColor && <span className="msg-role-color-dot" style={{ backgroundColor: roleColor }} aria-hidden="true" />}
              <StyledName name={displayName} style={cosmetics.name_style} fallbackColor={roleColorMode === "names" ? roleColor : null} />
            </span>
            {userBadges.length > 0 && (
              <span className="msg-badges">
                {userBadges.map((ub) =>
                  ub.badge ? <BadgePill key={ub.id} badge={ub.badge} size="sm" /> : null,
                )}
              </span>
            )}
            {mode === "dm" && <GameMessageOrigin applicationID={message.application_id} authorID={message.user_id} />}
            <span className="msg-time" title={formatFullDate(message.created_at)}>
              {formatTime(message.created_at)}
            </span>
          </div>

          {message.reply_to_id && (
            <div className="msg-reply-preview" onClick={handleScrollToReply}>
              <div className="msg-reply-bar" />
              {message.referenced_message?.author ? (
                <>
                  <span className="msg-reply-author">
                    {message.referenced_message.author.display_name ??
                      message.referenced_message.author.username}
                  </span>
                  <span className="msg-reply-content">
                    <SpamPreview kind={mode === "dm" ? "dm" : "channel"} message={{ id: message.referenced_message.id, user_id: message.referenced_message.author.id, content: message.referenced_message.content }}>
                      {plainPreview(message.referenced_message.content) || t("noContent")}
                    </SpamPreview>
                  </span>
                </>
              ) : (
                <span className="msg-reply-deleted">{t("replyDeleted")}</span>
              )}
            </div>
          )}

          {isPinned && (
            <div className="msg-pin-indicator">
              <svg style={{ width: 12, height: 12 }} fill="currentColor" viewBox="0 0 24 24" stroke="none">
                <path d="M16 4v4l2 2v4h-5v6l-1 1-1-1v-6H6v-4l2-2V4a1 1 0 011-1h6a1 1 0 011 1z" />
              </svg>
              <span>{t("pinnedMessages")}</span>
            </div>
          )}

          {isEditing ? (
            <div className="msg-edit-area">
              {editMentionQuery !== null && mode === "channel" && (
                <MentionAutocomplete
                  query={editMentionQuery}
                  onSelect={onEditMentionSelect}
                  onClose={closeEditMentionAutocomplete}
                />
              )}
              <textarea
                ref={editTextareaRef}
                value={editContent}
                onChange={onEditChange}
                onKeyDown={(e) => {
                  // While the autocomplete is open, defer nav keys to it
                  if (editMentionQuery !== null) {
                    if (["Enter", "Tab", "ArrowUp", "ArrowDown", "Escape"].includes(e.key)) return;
                  }
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    saveAndExit();
                  }
                  if (e.key === "Escape") cancelEdit();
                }}
                className="msg-edit-textarea"
                rows={2}
                autoFocus
              />
              <p className="msg-edit-hint">
                escape = {t("editCancel", "cancel")}, enter = {t("editSave", "save")}
              </p>
            </div>
          ) : hasDecryptionError ? (
            <div className="msg-text msg-decryption-failed">
              <span className="msg-decryption-failed-icon" aria-hidden>🔒</span>
              <span className="msg-decryption-failed-text">{tE2ee("decryptionError")}</span>
              {isCompact && (
                <span className="msg-gtime" title={formatFullDate(message.created_at)}>
                  {formatTime(message.created_at)}
                </span>
              )}
            </div>
          ) : spam.hidden ? (
            <div className="msg-text msg-ignored" role="note">
              <span>{t("spamHidden")}</span>
              <span>{spam.reasons.map((reason) => t(`spamReason.${reason}`)).join(" · ")}</span>
              <button type="button" onClick={spam.restore}>{t("spamRestore")}</button>
              {spam.syncError && <span role="alert">{t("spamSyncFailed")} <button type="button" onClick={spam.retry}>{t("spamRetry")}</button></span>}
            </div>
          ) : isIgnored && !showIgnoredContent ? (
            <div className="msg-text msg-ignored" role="note">
              <span>{t("ignoredMessage")}</span>
              <button type="button" className="msg-ignored-reveal" onClick={revealIgnoredContent}>{t("showIgnoredMessage")}</button>
            </div>
          ) : (
            <div className="msg-text">
              <MessageBodyMediaGate content={message.content} authorId={message.user_id} messageId={message.id} revision={message.edited_at??"original"} sourceKind={mode} sourceChannelId={channelId}>
                {renderedContent}
              </MessageBodyMediaGate>
              {previewUrls.length > 0 && (
                <div className="msg-link-previews">
                  {previewUrls.map((url) => (
                    <UnclassifiedMediaGate key={url} authorId={message.user_id} messageId={message.id} revision={message.edited_at ?? "original"} identity={`${message.id}:${url}`}>
                      <LinkPreviewCard url={url} />
                    </UnclassifiedMediaGate>
                  ))}
                </div>
              )}
              {message.edited_at && <span className="msg-edited">{t("edited")}</span>}
              {isCompact && (
                <span className="msg-gtime" title={formatFullDate(message.created_at)}>
                  {formatTime(message.created_at)}
                </span>
              )}
            </div>
          )}

          {!spam.hidden && (!isIgnored || showIgnoredContent) && <MessageAttachments message={message} />}

          {!spam.hidden && (!isIgnored || showIgnoredContent) && <MessageReactions
            message={message}
            sourceKind={mode}
            sourceChannelId={channelId}
            pickerSource={pickerSource}
            onPickerOpen={() => setPickerSource("bar")}
            onPickerClose={() => setPickerSource(null)}
            onReaction={handleReaction}
          />}
          {messageThread && (
            <button type="button" className="thread-summary" onClick={openExistingThread}>
              <span>{messageThread.name}</span>
              <strong>{t("threadReplyCount", { count: messageThread.reply_count ?? 0 })}</strong>
            </button>
          )}
        </div>

        {!isEditing && (
          <MessageHoverActions
            isOwner={isOwner}
            isPinned={isPinned}
            canManageMessages={canManageMessages}
            pickerSource={pickerSource}
            onReply={handleReply}
            onReaction={handleReaction}
            onPickerOpen={() => setPickerSource("hover")}
            onPickerClose={() => setPickerSource(null)}
            onPinToggle={handlePinToggle}
            onEditStart={startEdit}
            onDelete={handleDelete}
          />
        )}
      </div>

      <ContextMenu state={menuState} onClose={closeMenu} />

      {isMobile && (
        <MobileMessageActions
          isOpen={mobileActionsOpen}
          onClose={() => setMobileActionsOpen(false)}
          message={message}
          onReaction={handleReaction}
          actions={messageActions}
        />
      )}

      {reportOpen && !isOwner && (
        <ReportModal
          userId={message.user_id}
          username={displayName}
          onClose={() => setReportOpen(false)}
          messageEvidence={{
            kind: mode,
            serverId: cosmeticScope ?? undefined,
            channelId,
            messageId: message.id,
            content: message.content ?? "",
            encrypted: (message.encryption_version ?? 0) > 0,
          }}
        />
      )}

      {reminderOpen && (
        <ReminderModal
          source={{
            source_kind: mode,
            server_id: mode === "channel" ? cosmeticScope : null,
            channel_id: channelId,
            message_id: message.id,
          }}
          onClose={() => setReminderOpen(false)}
        />
      )}

      {forwardOpen && <ForwardMessageModal message={message} onClose={() => setForwardOpen(false)} />}
      {threadOpen && threadActionsAllowed && cosmeticScope && <ThreadModal serverId={cosmeticScope} channelId={channelId} messageId={message.id} defaultName={(message.content || t("threadDefaultName")).slice(0, 100)} onClose={() => setThreadOpen(false)} />}

      {profileTarget && (
        <MemberCard
          member={member}
          user={profileTarget.user}
          position={{ top: profileTarget.top, left: profileTarget.left }}
          onClose={() => setProfileTarget(null)}
        />
      )}
    </div>
  );
}

// memo: rows skip re-renders for context-level churn (typing indicators,
// reply state, other rows' reactions). Default shallow compare is correct —
// callbacks are provider-stable, message/member identities only change when
// the row's own data changes (or on wholesale member refresh, which must
// re-render mention tokens anyway).
export default memo(Message);
