/**
 * InviteFriendsModal — Invite friends to server via DM or shareable link.
 * Select friends from checkbox list, sends invite URL as DM to each.
 */

import { useState, useEffect, useCallback, useRef, useId, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useFriendStore } from "../../stores/friendStore";
import { useInviteStore } from "../../stores/inviteStore";
import { useDMStore } from "../../stores/dmStore";
import { useToastStore } from "../../stores/toastStore";
import { getInviteUrl, copyToClipboard } from "../../utils/constants";
import type { FriendshipWithUser } from "../../types";
import Avatar from "../shared/Avatar";
import { useChannelStore } from "../../stores/channelStore";
import { useChannelPermissionStore } from "../../stores/channelPermissionStore";
import { useAuthStore } from "../../stores/authStore";
import { Permissions } from "../../utils/permissions";

type InviteFriendsModalProps = {
  serverId: string;
  serverName: string;
  onClose: () => void;
  returnFocus?: HTMLElement;
};

function isVisibleControl(element: HTMLElement): boolean {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    if (node.hidden || node.inert || node.getAttribute("aria-hidden") === "true") return false;
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
  }
  return true;
}

function isActiveDialog(dialog: HTMLElement | null): boolean {
  const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"][role="dialog"], [aria-modal="true"][role="alertdialog"]'));
  return dialogs.filter(isVisibleControl).at(-1) === dialog;
}

function InviteFriendsModal({ serverId, serverName, onClose, returnFocus }: InviteFriendsModalProps) {
  const { t } = useTranslation("servers");
  const dialogRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useLayoutEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const controls = () => Array.from(dialog?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]',
    ) ?? []).filter((element) => element.tabIndex >= 0 && !element.matches(":disabled") && isVisibleControl(element));
    searchRef.current?.focus();
    function keydown(event: KeyboardEvent) {
      if (event.key !== "Tab" || !isActiveDialog(dialog)) return;
      const available = controls();
      const first = available[0], last = available.at(-1);
      if (!first) {
        event.preventDefault(); dialog?.focus(); return;
      }
      if (event.shiftKey && (document.activeElement === first || !dialog?.contains(document.activeElement))) {
        event.preventDefault(); (last ?? dialog)?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog?.contains(document.activeElement))) {
        event.preventDefault(); (first ?? dialog)?.focus();
      }
    }
    function contain(event: FocusEvent) {
      if (!isActiveDialog(dialog)) return;
      if (!dialog?.contains(event.target as Node)) (controls()[0] ?? dialog)?.focus();
    }
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("focusin", contain);
    return () => {
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("focusin", contain);
      const restore = returnFocus?.isConnected ? returnFocus : previous;
      if (restore?.isConnected && (document.activeElement === document.body || dialog?.contains(document.activeElement))) restore.focus();
    };
  }, [returnFocus]);
  const friends = useFriendStore((s) => s.friends);
  const getOrCreateShareInvite = useInviteStore((s) => s.getOrCreateShareInvite);
  const createOrGetChannel = useDMStore((s) => s.createOrGetChannel);
  const sendMessage = useDMStore((s) => s.sendMessage);
  const addToast = useToastStore((s) => s.addToast);
  const accountId = useAuthStore((s) => s.user?.id ?? null);
  const categoriesForServer = useChannelStore((s) => s.categoriesByServer[serverId]);
  const categories = categoriesForServer ?? [];
  const overridesByChannel = useChannelPermissionStore((s) => s.overridesByChannel);
  const fetchOverridesForChannels = useChannelPermissionStore((s) => s.fetchOverridesForChannels);
  const textChannels = categories.flatMap((group) => group.channels).filter((channel) => channel.type === "text");
  const textChannelKey = textChannels.map((channel) => channel.id).join("|");

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sendingContext, setSendingContext] = useState<string | null>(null);
  const [progress, setProgress] = useState({ sent: 0, total: 0 });
  const [copyingContext, setCopyingContext] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [inviteUrl, setInviteUrl] = useState("");
  const [inviteLoading, setInviteLoading] = useState(true);
  const [recipientStatus, setRecipientStatus] = useState<Record<string, "sending" | "sent" | "failed">>({});
  const [targetChannelId, setTargetChannelId] = useState("");
  const contextKey = JSON.stringify([accountId, serverId, targetChannelId]);
  const isSending = sendingContext === contextKey;
  const isCopying = copyingContext === contextKey;
  const activeContext = useRef(contextKey);
  const mounted = useRef(false);
  const targetChannel = textChannels.find((channel) => channel.id === targetChannelId);
  const targetIsPrivate = !!targetChannel && (overridesByChannel[targetChannel.id] ?? []).some((override) => (override.deny & Permissions.ViewChannel) !== 0);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const isCurrentContext = useCallback((key: string, requestAccountId: string | null) => {
    return mounted.current && activeContext.current === key && useAuthStore.getState().user?.id === requestAccountId;
  }, []);

  const loadInviteUrl = useCallback(async (key: string, requestAccountId: string | null, requestServerId: string, requestChannelId: string): Promise<string> => {
    try {
      const invite = await getOrCreateShareInvite(requestServerId, requestChannelId || undefined);
      if (!isCurrentContext(key, requestAccountId)) return "";
      return invite ? getInviteUrl(invite.code) : "";
    } catch {
      return "";
    }
  }, [getOrCreateShareInvite, isCurrentContext]);

  useEffect(() => {
    fetchOverridesForChannels(textChannelKey ? textChannelKey.split("|") : []);
  }, [fetchOverridesForChannels, textChannelKey]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredFriends = friends.filter((friend) => {
    const name = `${friend.display_name ?? ""} ${friend.username}`.toLocaleLowerCase();
    return !normalizedQuery || name.includes(normalizedQuery);
  });

  useEffect(() => {
    let active = true;
    const requestContext = contextKey;
    const requestAccountId = accountId;
    activeContext.current = requestContext;
    void loadInviteUrl(requestContext, requestAccountId, serverId, targetChannelId).then((url) => {
      if (!active || !isCurrentContext(requestContext, requestAccountId)) return;
      setInviteUrl(url);
      setInviteLoading(false);
    }).catch(() => {
      if (!active || !isCurrentContext(requestContext, requestAccountId)) return;
      setInviteUrl("");
      setInviteLoading(false);
    });
    return () => { active = false; };
  }, [accountId, contextKey, isCurrentContext, loadInviteUrl, serverId, targetChannelId]);

  // Close on Escape
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented && !isSending && isActiveDialog(dialogRef.current)) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    },
    [onClose, isSending],
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [handleKeyDown]);

  /** Toggle friend selection */
  function toggleFriend(userId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) {
        next.delete(userId);
      } else {
        next.add(userId);
      }
      return next;
    });
  }

  /** Select/deselect all */
  function toggleAll() {
    if (selected.size === friends.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(friends.map((f) => f.user_id)));
    }
  }

  /** Copy invite link to clipboard for external sharing */
  async function handleCopyLink() {
    if (isCopying) return;
    const requestContext = contextKey;
    setCopyingContext(requestContext);
    const requestAccountId = accountId;
    try {
      const url = inviteUrl || await loadInviteUrl(requestContext, requestAccountId, serverId, targetChannelId);
      if (!isCurrentContext(requestContext, requestAccountId)) return;
      if (url && !inviteUrl) setInviteUrl(url);
      if (!url) {
        addToast("error", t("inviteCreateFailed"));
        return;
      }
      await copyToClipboard(url);
      if (!isCurrentContext(requestContext, requestAccountId)) return;
      addToast("success", t("inviteLinkCopied"));
    } catch {
      if (isCurrentContext(requestContext, requestAccountId)) addToast("error", t("inviteCopyFailed"));
    } finally {
      if (isCurrentContext(requestContext, requestAccountId)) setCopyingContext(null);
    }
  }

  async function sendInviteTo(userId: string, content: string, requestContext: string, requestAccountId: string | null): Promise<boolean> {
    if (!isCurrentContext(requestContext, requestAccountId)) return false;
    setRecipientStatus((state) => ({ ...state, [userId]: "sending" }));
    let sent = false;
    try {
      const channelId = await createOrGetChannel(userId);
      sent = channelId && isCurrentContext(requestContext, requestAccountId)
        ? await sendMessage(channelId, content)
        : false;
    } catch {
      // Treat thrown transport failures like an unsuccessful send so the row
      // becomes retryable and a bulk send can continue for other recipients.
    }
    if (isCurrentContext(requestContext, requestAccountId)) setRecipientStatus((state) => ({ ...state, [userId]: sent ? "sent" : "failed" }));
    return sent;
  }

  async function handleSendOne(userId: string) {
    if (recipientStatus[userId] === "sending" || recipientStatus[userId] === "sent") return;
    const requestContext = contextKey;
    const requestAccountId = accountId;
    const url = inviteUrl || await loadInviteUrl(requestContext, requestAccountId, serverId, targetChannelId);
    if (!isCurrentContext(requestContext, requestAccountId)) return;
    if (url && !inviteUrl) setInviteUrl(url);
    if (!url) {
      setRecipientStatus((state) => ({ ...state, [userId]: "failed" }));
      addToast("error", t("inviteCreateFailed"));
      return;
    }
    await sendInviteTo(userId, url, requestContext, requestAccountId);
  }

  /** Send invite to each selected friend via DM */
  async function handleSendInvites() {
    if (selected.size === 0 || isSending) return;

    setSendingContext(contextKey);
    setProgress({ sent: 0, total: selected.size });
    const requestContext = contextKey;
    const requestAccountId = accountId;

    const url = inviteUrl || await loadInviteUrl(requestContext, requestAccountId, serverId, targetChannelId);
    if (!isCurrentContext(requestContext, requestAccountId)) {
      return;
    }
    if (url && !inviteUrl) setInviteUrl(url);
    if (!url) {
      addToast("error", t("inviteCreateFailed"));
      setSendingContext(null);
      return;
    }

    let sentCount = 0;

    // Send sequentially (rate limit protection)
    for (const userId of selected) {
      if (!isCurrentContext(requestContext, requestAccountId)) break;
      if (recipientStatus[userId] === "sent" || await sendInviteTo(userId, url, requestContext, requestAccountId)) {
        sentCount++;
        if (isCurrentContext(requestContext, requestAccountId)) setProgress({ sent: sentCount, total: selected.size });
      }
    }

    // Done
    if (isCurrentContext(requestContext, requestAccountId) && sentCount > 0) addToast("success", t("invitesSent", { count: sentCount }));
    if (isCurrentContext(requestContext, requestAccountId)) setSendingContext(null);
  }

  /** Render a single friend row */
  function renderFriend(friend: FriendshipWithUser) {
    const isChecked = selected.has(friend.user_id);
    const name = friend.display_name ?? friend.username;

    const status = recipientStatus[friend.user_id];
    return (
      <div
        key={friend.user_id}
        className={`invite-friend-item${isChecked ? " checked" : ""}`}
      >
        <button className="invite-friend-select" onClick={() => toggleFriend(friend.user_id)} disabled={isSending} aria-label={t("selectInviteRecipient", { name })}>
          <span className={`invite-friend-check${isChecked ? " checked" : ""}`}>{isChecked && "\u2713"}</span>
        </button>
        <Avatar
          name={name}
          avatarUrl={friend.avatar_url ?? undefined}
          size={32}
          isCircle
        />
        <span className="invite-friend-name">{name}</span>
        <span className="invite-friend-username">@{friend.username}</span>
        <button
          className="invite-friend-send-one"
          onClick={() => void handleSendOne(friend.user_id)}
          disabled={isSending || status === "sending" || status === "sent"}
        >
          {status === "sending" ? t("inviteSending") : status === "sent" ? t("inviteSent") : status === "failed" ? t("retryInvite") : t("invite")}
        </button>
      </div>
    );
  }

  return createPortal(
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isSending) onClose();
      }}
    >
      <div ref={dialogRef} className="modal-card invite-friends-modal" role="dialog" aria-modal="true"
        aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="modal-header">
          <div>
            <h2 id={titleId} className="modal-title">{t("inviteFriends")}</h2>
            <p id={descriptionId} className="invite-friends-desc">
              {t("inviteFriendsDesc", { server: serverName })}
            </p>
          </div>
          <button onClick={onClose} className="toast-close" aria-label={t("close", { ns: "common" })} disabled={isSending}>
            &#x2715;
          </button>
        </div>

        {/* Copy Link — for external sharing */}
        <div className="invite-friends-copy-section">
          <label className="report-label" htmlFor="invite-target-channel">{t("inviteTargetChannel")}</label>
          <select id="invite-target-channel" className="forward-search" value={targetChannelId} onChange={(event) => { setTargetChannelId(event.target.value); setInviteUrl(""); }} disabled={isSending}>
            <option value="">{t("inviteServerHome")}</option>
            {textChannels.map((channel) => <option key={channel.id} value={channel.id}># {channel.name}</option>)}
          </select>
          {targetIsPrivate && <p className="invite-private-warning" role="note">{t("invitePrivateChannelWarning", { channel: targetChannel?.name })}</p>}
          <input className="invite-friends-link" value={inviteLoading ? t("loading") : inviteUrl} readOnly aria-label={t("inviteLink")} />
          <button
            className="invite-friends-copy-btn"
            onClick={handleCopyLink}
            disabled={isCopying || isSending}
          >
            {isCopying ? "..." : t("copyInviteLink")}
          </button>
          <span className="invite-friends-copy-hint">{t("copyInviteLinkHint")}</span>
        </div>

        <input
          ref={searchRef}
          className="invite-friends-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("searchFriends")}
          aria-label={t("searchFriends")}
        />

        {/* Separator */}
        <div className="invite-friends-separator">
          <span className="invite-friends-separator-line" />
          <span className="invite-friends-separator-text">{t("orSeparator")}</span>
          <span className="invite-friends-separator-line" />
        </div>

        {/* Friend list */}
        <div className="invite-friends-body">
          {filteredFriends.length === 0 ? (
            <div className="invite-friends-empty">
              <p>{t("noFriends")}</p>
            </div>
          ) : (
            <>
              {/* Select all toggle */}
              <button
                className="invite-friends-select-all"
                onClick={toggleAll}
                disabled={isSending}
              >
                {selected.size === friends.length
                  ? t("deselectAll")
                  : t("selectAll")}
                <span className="invite-friends-count">
                  {selected.size}/{friends.length}
                </span>
              </button>

              {/* Scrollable friend list */}
              <div className="invite-friends-list">
                {filteredFriends.map(renderFriend)}
              </div>
            </>
          )}
        </div>

        {/* Footer — send button */}
        <div className="invite-friends-footer">
          {isSending ? (
            <div className="invite-friends-progress">
              <span>{t("sendingInvites", { sent: progress.sent, total: progress.total })}</span>
              <div className="invite-friends-progress-bar">
                <div
                  className="invite-friends-progress-fill"
                  style={{
                    width: progress.total > 0
                      ? `${(progress.sent / progress.total) * 100}%`
                      : "0%",
                  }}
                />
              </div>
            </div>
          ) : (
            <button
              className="invite-friends-send"
              onClick={handleSendInvites}
              disabled={selected.size === 0}
            >
              {t("sendInvites")} {selected.size > 0 && `(${selected.size})`}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

export default InviteFriendsModal;
