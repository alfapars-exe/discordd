/**
 * AuditChannel — Server moderation event log, rendered as a chat-style feed.
 *
 * Only mounted when the user has `canViewAudit` permission AND the active
 * tab is the audit channel. Permission gating is enforced server-side too
 * (broadcast filter + endpoint check) — this component just hides the UI;
 * even a malicious client opening this view directly will see no data
 * because the API will 403 them.
 *
 * Scroll behavior intentionally mirrors MessageList:
 * - Stick to the bottom while the user hasn't scrolled up
 * - ResizeObserver re-pins when async layout shifts (rare here, but cheap)
 * - Scroll past the top → fetchOlder
 *
 * No composer / typing indicator / input area — audit channels are read-only
 * by design (the server is the only writer).
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";

import { useAuditStore } from "../../stores/auditStore";
import { useChannelStore } from "../../stores/channelStore";
import AuditEntry from "./AuditEntry";

type AuditChannelProps = {
  channelId: string;
  serverId?: string;
};

function AuditChannel({ channelId, serverId }: AuditChannelProps) {
  const { t } = useTranslation("audit");

  // Look up channel metadata for the header (name / ⚖️ icon).
  const categories = useChannelStore((s) => s.categories);
  const channel = useMemo(() => {
    for (const cg of categories) {
      const found = cg.channels.find((ch) => ch.id === channelId);
      if (found) return found;
    }
    return null;
  }, [categories, channelId]);

  // Store selectors — split to keep re-renders narrow.
  const entries = useAuditStore((s) =>
    serverId ? s.eventsByServer[serverId] : undefined
  );
  const hasMore = useAuditStore((s) =>
    serverId ? !!s.hasMoreByServer[serverId] : false
  );
  const isLoading = useAuditStore((s) =>
    serverId ? !!s.isLoadingByServer[serverId] : false
  );
  const fetchInitial = useAuditStore((s) => s.fetchInitial);
  const fetchOlder = useAuditStore((s) => s.fetchOlder);

  // ─── Scroll refs / pin-to-bottom intent ───
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const prevScrollTopRef = useRef(0);
  const prevEntryCountRef = useRef(0);

  // ─── Initial fetch when the panel mounts for a new server ───
  useEffect(() => {
    if (serverId) {
      fetchInitial(serverId);
    }
  }, [serverId, fetchInitial]);

  function scrollToBottom() {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }

  // After initial render with data, jump to bottom (newest event in view).
  useLayoutEffect(() => {
    if (!isLoading && entries && entries.length > 0 && scrollRef.current) {
      if (prevEntryCountRef.current === 0) {
        scrollToBottom();
        stickToBottomRef.current = true;
        prevScrollTopRef.current = scrollRef.current.scrollTop;
      }
      prevEntryCountRef.current = entries.length;
    }
  }, [isLoading, entries]);

  // Auto-scroll on new event (only when user is at the bottom).
  useEffect(() => {
    const count = entries?.length ?? 0;
    if (count > prevEntryCountRef.current && stickToBottomRef.current) {
      scrollToBottom();
    }
    prevEntryCountRef.current = count;
  }, [entries?.length]);

  // ResizeObserver — re-pin when content height changes (e.g. avatar load).
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

  // Scroll handler — manages stick-to-bottom intent + triggers older-page fetch.
  const handleScroll = useCallback(() => {
    if (!scrollRef.current || !serverId) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const prev = prevScrollTopRef.current;

    const nearBottom = scrollHeight - scrollTop - clientHeight < 20;
    if (scrollTop < prev - 5) {
      stickToBottomRef.current = false;
    } else if (nearBottom) {
      stickToBottomRef.current = true;
    }
    prevScrollTopRef.current = scrollTop;

    // Approaching the top → pull older page, then anchor scroll so the
    // user's view doesn't jump (same trick MessageList uses).
    if (scrollTop < 100 && hasMore && !isLoading) {
      const prevScrollHeight = scrollRef.current.scrollHeight;
      fetchOlder(serverId).then(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop =
            scrollRef.current.scrollHeight - prevScrollHeight;
        }
      });
    }
  }, [serverId, hasMore, isLoading, fetchOlder]);

  // ─── Render ───

  return (
    <div className="audit-area">
      {/* Channel bar — mirrors text channel header */}
      <div className="channel-bar">
        <span className="ch-hash">{"⚖️"}</span>
        <span className="ch-name">{channel?.name ?? t("title")}</span>
      </div>

      <div className="audit-scroll" ref={scrollRef} onScroll={handleScroll}>
        <div ref={contentRef}>
          {/* Load-older spinner */}
          {isLoading && entries && entries.length > 0 && (
            <div className="audit-loading-more">
              <div className="spinner" />
            </div>
          )}

          {/* Initial loading skeleton */}
          {isLoading && (!entries || entries.length === 0) && (
            <div className="audit-empty">{t("loading")}</div>
          )}

          {/* Empty state */}
          {!isLoading && entries && entries.length === 0 && (
            <div className="audit-empty">{t("empty")}</div>
          )}

          {/* Entries list — oldest first, newest at the bottom */}
          {entries && entries.length > 0 && (
            <div className="audit-list">
              {entries.map((e) => (
                <AuditEntry key={e.id} entry={e} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default AuditChannel;
