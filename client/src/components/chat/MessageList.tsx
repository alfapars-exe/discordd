/** MessageList — Scrollable message container with auto-scroll, infinite scroll, and compact mode. */

import { useEffect, useLayoutEffect, useRef, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useChatContext } from "../../hooks/useChatContext";
import { useAuthStore } from "../../stores/authStore";
import { useActiveMembers } from "../../stores/memberStore";
import { useReadStateStore } from "../../stores/readStateStore";
import { MessageSkeleton } from "../shared/Skeleton";
import Message from "./Message";

/** Compact threshold for consecutive messages from same author (ms) */
const COMPACT_THRESHOLD = 5 * 60 * 1000;

/** Per-channel scroll position cache. Survives component unmount/remount. */
const scrollPositions = new Map<string, number>();

function MessageList() {
  const { t } = useTranslation("chat");
  const {
    mode,
    channelId,
    channelName,
    messages,
    isLoading,
    isLoadingMore,
    hasMore,
    fetchMessages,
    fetchOlderMessages,
    scrollToMessageId,
    setScrollToMessageId,
  } = useChatContext();

  const currentUser = useAuthStore((s) => s.user);
  const members = useActiveMembers();

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  /**
   * "Should we stay pinned to the bottom?" — intent flag updated by user
   * scrolling. Replaces the older `stickToBottomRef` which mixed "current
   * position" with "user's intent" and missed the case where async
   * content (images, embeds, GIFs) expanded after we'd already scrolled
   * to bottom, pushing the last message out of view without us catching
   * up via a ResizeObserver.
   */
  const stickToBottomRef = useRef(true);
  /** Last observed scrollTop — used to detect direction in handleScroll. */
  const prevScrollTopRef = useRef(0);
  const prevMessageCountRef = useRef(0);
  /** Tracks the channelId we've already restored scroll for, so the
   *  layout-effect below stays a one-shot per channel even though
   *  messages.length is now in its dep array (lint required it because
   *  the body reads messages.length). */
  const restoredForChannelRef = useRef<string | null>(null);

  // ─── Mention Navigation State ───
  const seenMentions = useReadStateStore((s) => s.seenMentions[channelId]);
  const markMentionSeen = useReadStateStore((s) => s.markMentionSeen);

  // Compute unseen mention message IDs (exclude already-seen mentions)
  const mentionMessageIds = useMemo(() => {
    if (!currentUser) return [];
    const myMember = members.find((m) => m.id === currentUser.id);
    const myRoleIds = myMember?.roles?.length
      ? new Set(myMember.roles.map((r) => r.id))
      : null;

    const ids: string[] = [];
    for (const msg of messages) {
      // Skip mentions already seen by the user
      if (seenMentions?.has(msg.id)) continue;

      if (msg.mentions?.includes(currentUser.id)) {
        ids.push(msg.id);
        continue;
      }
      if (msg.role_mentions?.length && myRoleIds) {
        if (msg.role_mentions.some((rid) => myRoleIds.has(rid))) {
          ids.push(msg.id);
        }
      }
    }
    return ids;
  }, [messages, currentUser, members, seenMentions]);

  const mentionCount = mentionMessageIds.length;

  function handleMentionNavClick() {
    if (mentionCount === 0) return;
    const msgId = mentionMessageIds[0];

    // Mark as seen — removes from the list permanently (survives channel switch)
    markMentionSeen(channelId, msgId);

    const el = document.getElementById(`msg-${msgId}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("msg-highlight");
      setTimeout(() => el.classList.remove("msg-highlight"), 2000);
    }
  }

  // Fetch messages on channel change, disable auto-scroll during transition
  useEffect(() => {
    stickToBottomRef.current = false;
    // Allow the restore-effect below to run again for the new channel.
    restoredForChannelRef.current = null;

    if (channelId) {
      fetchMessages();
    }
  }, [channelId, fetchMessages]);

  // scrollToBottom lifted up (declaration moved here from below) so
  // the auto-scroll useEffect can call it without
  // react-hooks/immutability flagging a forward reference. Pure DOM
  // mutation, no state, no captured render values — useCallback
  // wrapping would be ceremony.
  function scrollToBottom() {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }

  // Auto-scroll on new message (only when already at bottom)
  useEffect(() => {
    if (messages.length > prevMessageCountRef.current && stickToBottomRef.current) {
      scrollToBottom();
    }
    prevMessageCountRef.current = messages.length;
  }, [messages.length]);

  // Pin-to-bottom on async content load. Without this, images / embeds /
  // GIFs that resolve AFTER initial render grow the message list height
  // and push the latest message off-screen — even though we WERE at the
  // bottom when the message arrived. ResizeObserver fires on every
  // content size change; if the user hasn't scrolled away, re-snap to
  // the bottom.
  //
  // Using stickToBottomRef as the trigger (intent) instead of measuring
  // current position avoids a feedback loop where the auto-scroll
  // changes scrollTop and the observer re-fires.
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const observer = new ResizeObserver(() => {
      if (stickToBottomRef.current && scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  /**
   * Restore scroll position — runs before paint via useLayoutEffect.
   *
   * One-shot per channel: guarded by restoredForChannelRef so new
   * messages arriving in the same channel don't re-trigger the body
   * (which would jump the scrollbar away from the user's position).
   * The guard is reset to null when channelId changes (see fetch
   * useEffect above), allowing the next channel's restore to run.
   */
  useLayoutEffect(() => {
    if (restoredForChannelRef.current === channelId) return;
    if (isLoading || messages.length === 0 || !scrollRef.current) return;

    restoredForChannelRef.current = channelId;

    const savedPos = scrollPositions.get(channelId);
    if (savedPos !== undefined) {
      scrollRef.current.scrollTop = savedPos;
      // Stick-to-bottom intent matches whatever position we restored to:
      // if the user was within ~20px of the floor when they left this
      // channel, keep them pinned as new messages arrive.
      const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
      stickToBottomRef.current = scrollHeight - scrollTop - clientHeight < 20;
      prevScrollTopRef.current = scrollTop;
    } else {
      scrollToBottom();
      // No saved position → user just opened the channel → keep them pinned.
      stickToBottomRef.current = true;
      prevScrollTopRef.current = scrollRef.current.scrollTop;
    }
    prevMessageCountRef.current = messages.length;
  }, [isLoading, channelId, messages.length]);

  /** Scroll-to-message effect — triggered when reply preview is clicked. */
  useEffect(() => {
    if (!scrollToMessageId) return;

    const el = document.getElementById(`msg-${scrollToMessageId}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("msg-highlight");
      const timer = setTimeout(() => {
        el.classList.remove("msg-highlight");
      }, 2000);
      setScrollToMessageId(null);
      return () => clearTimeout(timer);
    }

    setScrollToMessageId(null);
  }, [scrollToMessageId, setScrollToMessageId]);

  /** Scroll handler — save position + update stick-to-bottom intent + trigger infinite scroll */
  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;

    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const prev = prevScrollTopRef.current;

    // Direction-aware sticky update. The old `< 20px from bottom` check
    // was correct for the FALLING edge (user-scrolled-up-from-bottom)
    // but flipped sticky=true back on every programmatic scroll-to-
    // bottom, which fought the ResizeObserver. Now: a user-initiated
    // scroll UP by 5+ pixels turns sticky OFF, returning to within
    // 20px of the floor turns it back ON.
    const nearBottom = scrollHeight - scrollTop - clientHeight < 20;
    if (scrollTop < prev - 5) {
      stickToBottomRef.current = false;
    } else if (nearBottom) {
      stickToBottomRef.current = true;
    }
    prevScrollTopRef.current = scrollTop;

    if (channelId) {
      scrollPositions.set(channelId, scrollTop);
    }

    if (scrollTop < 100 && hasMore && !isLoadingMore && channelId) {
      const prevScrollHeight = scrollRef.current.scrollHeight;
      fetchOlderMessages().then(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop =
            scrollRef.current.scrollHeight - prevScrollHeight;
        }
      });
    }
  }, [hasMore, isLoadingMore, channelId, fetchOlderMessages]);

  /** Compact mode for consecutive messages from same author within 5min. Replies always show full header. */
  function isCompact(index: number): boolean {
    if (index === 0) return false;

    const current = messages[index];
    if (current.reply_to_id) return false;

    const previous = messages[index - 1];

    if (current.user_id !== previous.user_id) return false;

    const timeDiff =
      new Date(current.created_at).getTime() -
      new Date(previous.created_at).getTime();

    return timeDiff < COMPACT_THRESHOLD;
  }

  if (!channelId) {
    return <div className="no-channel">Select a channel</div>;
  }

  if (isLoading) {
    return (
      <div className="messages-scroll">
        <MessageSkeleton count={6} />
      </div>
    );
  }

  // Welcome icon: "#" for channels, "@" for DMs
  const welcomeIcon = mode === "dm" ? "@" : "#";

  return (
    <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="messages-scroll"
      >
        {/* Inner content wrapper observed by ResizeObserver — fires when
            async media (images / embeds / GIFs) expand the message list
            after initial render so we can re-pin to the bottom. */}
        <div ref={contentRef}>
        {/* Loading more indicator */}
        {isLoadingMore && (
          <div style={{ display: "flex", justifyContent: "center", padding: "16px 0" }}>
            <div className="spinner" />
          </div>
        )}

        {/* Messages */}
        {messages.length === 0 ? (
          <div className="msg-welcome">
            <div className="msg-welcome-icon">
              <span>{welcomeIcon}</span>
            </div>
            <h2>
              {mode === "dm"
                ? t("welcomeDM", { user: channelName })
                : t("welcomeChannel", { channel: channelName })}
            </h2>
            <p>
              {mode === "dm"
                ? t("dmStart", { user: channelName })
                : t("channelStart", { channel: channelName })}
            </p>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", justifyContent: "flex-end", padding: "8px 0" }}>
            {messages.map((msg, index) => (
              <div key={msg.id} id={`msg-${msg.id}`}>
                <Message
                  message={msg}
                  isCompact={isCompact(index)}
                />
              </div>
            ))}
          </div>
        )}
        </div>
      </div>

      {/* Mention Navigation FAB */}
      {mentionCount > 0 && (
        <button
          className="mention-nav-fab"
          onClick={handleMentionNavClick}
          title={t("jumpToMention")}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="4" />
            <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
          </svg>
          <span>{mentionCount}</span>
        </button>
      )}
    </div>
  );
}

export default MessageList;
