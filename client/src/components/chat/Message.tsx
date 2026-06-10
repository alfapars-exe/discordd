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

import { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "../../stores/authStore";
import { useE2EEStore } from "../../stores/e2eeStore";
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
import type { MemberWithRoles, User } from "../../types";
import Avatar from "../shared/Avatar";
import BadgePill from "../shared/BadgePill";
import ContextMenu from "../shared/ContextMenu";
import LinkPreviewCard from "./LinkPreviewCard";
import MemberCard from "../members/MemberCard";
import MentionAutocomplete from "./MentionAutocomplete";
import MessageAttachments from "./MessageAttachments";
import MessageHoverActions from "./MessageHoverActions";
import MessageReactions from "./MessageReactions";
import MobileMessageActions from "./MobileMessageActions";

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
};

function Message({
  message,
  isCompact,
  isPinned,
  mode,
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
}: MessageProps) {
  const { t, i18n } = useTranslation("chat");
  const { t: tE2ee } = useTranslation("e2ee");
  const currentUser = useAuthStore((s) => s.user);
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
  const [profileTarget, setProfileTarget] = useState<{ user: User; top: number; left: number } | null>(null);

  const isOwner = currentUser?.id === message.user_id;

  // Role display info — member prop is undefined in DMs (showRoleColors=false)
  const roleType = getRoleType(member);
  const roleColor = getHighestRoleColor(member);

  const userBadges = useUserBadges(message.user_id);

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
    const ok = await confirm({
      message: t("deleteMessageConfirm"),
      confirmLabel: t("deleteMessage"),
      danger: true,
    });
    if (!ok) return;
    await deleteMessage(message.id);
  }, [confirm, deleteMessage, message.id, t]);

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

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      const items: ContextMenuItem[] = [];

      // Universal items first
      items.push({ label: t("replyMessage"), onClick: handleReply });
      items.push({ label: t("addReaction"), onClick: () => setPickerSource("bar") });
      items.push({
        label: t("copyMessage"),
        onClick: () => {
          if (message.content) copyToClipboard(message.content);
        },
      });

      // Pin/unpin requires manage permission
      if (canManageMessages) {
        items.push({
          label: isPinned ? t("unpinMessage") : t("pinMessage"),
          onClick: handlePinToggle,
          separator: true,
        });
      }

      // Edit — owner only
      if (isOwner) {
        items.push({
          label: t("editMessage"),
          onClick: startEdit,
          separator: !canManageMessages,
        });
      }

      // Delete — owner or has manage permission
      if (isOwner || canManageMessages) {
        items.push({
          label: t("deleteMessage"),
          onClick: handleDelete,
          danger: true,
        });
      }

      // Power-user: copy raw message id
      items.push({
        label: t("copyId"),
        onClick: () => copyToClipboard(message.id),
        separator: true,
      });

      openMenu(e, items);
    },
    [t, handleReply, message.content, message.id, canManageMessages, isOwner, isPinned, handlePinToggle, handleDelete, startEdit, openMenu],
  );

  // Long-press → bottom-sheet on mobile (in lieu of context menu)
  const longPressHandlers = useLongPress(
    useCallback(() => setMobileActionsOpen(true), []),
    { delay: 500 },
  );

  const displayName =
    message.author?.display_name ?? message.author?.username ?? "Unknown";

  const renderedContent = useMemo(
    () => renderMessageContent(message.content, roles, members),
    [message.content, roles, members],
  );

  const previewUrls = useMemo(() => getMessagePreviewUrls(message.content), [message.content]);

  const msgClass =
    `msg${!isCompact ? " first-of-group" : " grouped"}` +
    `${pickerSource ? " picker-open" : ""}` +
    `${isMentioned ? " msg-mentioned" : ""}`;

  return (
    <div
      className={msgClass}
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
            <Avatar
              name={displayName}
              role={roleType}
              avatarUrl={message.author?.avatar_url ?? undefined}
              size={30}
            />
          </button>
        </div>

        <div className="msg-body">
          <div className="msg-meta">
            <span className="msg-name" style={roleColor ? { color: roleColor } : undefined}>
              {displayName}
            </span>
            {userBadges.length > 0 && (
              <span className="msg-badges">
                {userBadges.map((ub) =>
                  ub.badge ? <BadgePill key={ub.id} badge={ub.badge} size="sm" /> : null,
                )}
              </span>
            )}
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
                    {message.referenced_message.content ?? t("noContent")}
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
          ) : (
            <div className="msg-text">
              {renderedContent}
              {previewUrls.length > 0 && (
                <span className="msg-link-previews">
                  {previewUrls.map((url) => (
                    <LinkPreviewCard key={url} url={url} />
                  ))}
                </span>
              )}
              {message.edited_at && <span className="msg-edited">{t("edited")}</span>}
              {isCompact && (
                <span className="msg-gtime" title={formatFullDate(message.created_at)}>
                  {formatTime(message.created_at)}
                </span>
              )}
            </div>
          )}

          <MessageAttachments message={message} />

          <MessageReactions
            message={message}
            pickerSource={pickerSource}
            onPickerOpen={() => setPickerSource("bar")}
            onPickerClose={() => setPickerSource(null)}
            onReaction={handleReaction}
          />
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
          onReply={() => {
            handleReply();
            setMobileActionsOpen(false);
          }}
          onPinToggle={handlePinToggle}
          onEdit={startEdit}
          onDelete={handleDelete}
          onReaction={handleReaction}
          onCopy={() => {
            if (message.content) copyToClipboard(message.content);
          }}
          canManageMessages={canManageMessages}
          isPinned={isPinned}
        />
      )}

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
