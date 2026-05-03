/**
 * Message — Renders a single chat message (channel or DM).
 *
 * Single responsibility: composition + presentation of one message row.
 * State and pure logic live elsewhere:
 *   - useMessageEditing       — edit mode state machine + mention autocomplete
 *   - utils/messageParsers    — content rendering, role helpers, preview URLs
 *   - useChatContext          — channel/DM-agnostic data + actions
 *   - useContextMenu / useLongPress — interaction primitives
 */

import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "../../stores/authStore";
import { useChatContext } from "../../hooks/useChatContext";
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
import type { User } from "../../types";
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
};

function Message({ message, isCompact }: MessageProps) {
  const { t, i18n } = useTranslation("chat");
  const currentUser = useAuthStore((s) => s.user);
  const {
    mode,
    editMessage,
    deleteMessage,
    toggleReaction,
    setReplyingTo,
    setScrollToMessageId,
    pinMessage,
    unpinMessage,
    isMessagePinned,
    canManageMessages,
    showRoleColors,
    members,
  } = useChatContext();

  const roles = useActiveRoles();
  const isMobile = useIsMobile();
  const confirm = useConfirm();
  const { menuState, openMenu, closeMenu } = useContextMenu();

  const editing = useMessageEditing({
    initialContent: message.content,
    saveEdit: (newContent) => editMessage(message.id, newContent),
  });

  const [pickerSource, setPickerSource] = useState<"bar" | "hover" | null>(null);
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false);
  const [profileTarget, setProfileTarget] = useState<{ user: User; top: number; left: number } | null>(null);

  const isOwner = currentUser?.id === message.user_id;

  // Role display info — skipped in DMs (showRoleColors=false, members=[])
  const member = showRoleColors ? members.find((m) => m.id === message.user_id) : undefined;
  const roleType = getRoleType(member);
  const roleColor = getHighestRoleColor(member);

  const userBadges = useUserBadges(message.user_id);
  const isPinned = isMessagePinned(message.id);

  // Highlight the message if the current user is mentioned (direct or via role).
  const currentMember = members.find((m) => m.id === currentUser?.id);
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
          onClick: editing.startEdit,
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
    [t, handleReply, message.content, message.id, canManageMessages, isOwner, isPinned, handlePinToggle, handleDelete, editing.startEdit, openMenu],
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

          {editing.isEditing ? (
            <div className="msg-edit-area">
              {editing.editMentionQuery !== null && mode === "channel" && (
                <MentionAutocomplete
                  query={editing.editMentionQuery}
                  onSelect={editing.onMentionSelect}
                  onClose={editing.closeMentionAutocomplete}
                />
              )}
              <textarea
                ref={editing.editTextareaRef}
                value={editing.editContent}
                onChange={editing.onChange}
                onKeyDown={(e) => {
                  // While the autocomplete is open, defer nav keys to it
                  if (editing.editMentionQuery !== null) {
                    if (["Enter", "Tab", "ArrowUp", "ArrowDown", "Escape"].includes(e.key)) return;
                  }
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    editing.saveAndExit();
                  }
                  if (e.key === "Escape") editing.cancel();
                }}
                className="msg-edit-textarea"
                rows={2}
                autoFocus
              />
              <p className="msg-edit-hint">
                escape = {t("editCancel", "cancel")}, enter = {t("editSave", "save")}
              </p>
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

        {!editing.isEditing && (
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
            onEditStart={editing.startEdit}
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
          onEdit={editing.startEdit}
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

export default Message;
