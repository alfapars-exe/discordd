/** SearchPanel — Message search with debounced input and pagination. */

import { useState, useCallback, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { searchMessages } from "../../api/search";
import { searchCachedMessages } from "../../crypto/keyStorage";
import { useServerStore } from "../../stores/serverStore";
import { useE2EEStore } from "../../stores/e2eeStore";
import { useMessageStore } from "../../stores/messageStore";
import { useToastStore } from "../../stores/toastStore";
import type { SearchResult } from "../../api/search";
import type { Message } from "../../types";
import Avatar from "../shared/Avatar";

/** Debounce delay (ms) */
const DEBOUNCE_MS = 300;

type SearchPanelProps = {
  channelId?: string;
  onClose: () => void;
  /** Navigate to message's channel on result click */
  onSelectResult?: (message: Message) => void;
};

function SearchPanel({ channelId, onClose, onSelectResult }: SearchPanelProps) {
  const { t, i18n } = useTranslation("chat");
  const { t: tE2ee } = useTranslation("e2ee");
  const isE2EEReady = useE2EEStore((s) => s.initStatus === "ready");
  // E2EE is per-server. Plaintext servers can use backend FTS5; only route
  // through the IndexedDB cache when the active server is actually encrypted.
  const serverE2eeEnabled = useServerStore((s) => s.activeServer?.e2ee_enabled ?? false);
  const useLocalSearch = serverE2eeEnabled && isE2EEReady;
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [offset, setOffset] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Monotonic id per doSearch call — a slow response for an abandoned query
  // must not overwrite the results of the search started after it.
  const searchSeqRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const limit = 25;

  // Auto-focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Clear any pending debounce on unmount — the timer would otherwise fire
  // after close and call setState on an unmounted panel.
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  const doSearch = useCallback(
    async (searchQuery: string, searchOffset: number) => {
      // Bumping before the empty-query early return also invalidates any
      // in-flight search when the user clears the input.
      const seq = ++searchSeqRef.current;

      if (searchQuery.trim().length < 1) {
        setResults(null);
        return;
      }

      setIsSearching(true);

      // E2EE active — client-side IndexedDB search (server has NULL content)
      if (useLocalSearch && channelId) {
        try {
          const cached = await searchCachedMessages(channelId, searchQuery.trim());
          // A newer search started while this one was awaiting — its results
          // (and spinner state) own the panel now.
          if (seq !== searchSeqRef.current) return;
          // Simulate pagination (IndexedDB returns all results)
          const total = cached.length;
          const paged = cached
            .sort((a, b) => b.timestamp - a.timestamp) // newest first
            .slice(searchOffset, searchOffset + limit);

          // CachedDecryptedMessage -> Message minimal format for rendering
          const messages: Message[] = paged.map((c) => ({
            id: c.messageId,
            channel_id: c.channelId,
            user_id: "",
            content: c.content,
            created_at: new Date(c.timestamp).toISOString(),
            edited_at: null,
            attachments: [],
            mentions: [],
            role_mentions: [],
            reactions: [],
            reply_to_id: null,
            referenced_message: null,
            author: { id: "", username: "", display_name: null, avatar_url: null, status: "offline" as const, custom_status: null, created_at: "" },
            encryption_version: 1,
          }));

          setResults({ messages, total_count: total });
        } catch {
          if (seq !== searchSeqRef.current) return;
          setResults({ messages: [], total_count: 0 });
        }
        setIsSearching(false);
        return;
      }

      // Plaintext — server-side FTS5 search
      const serverId = useServerStore.getState().activeServerId;
      if (!serverId) return;
      const res = await searchMessages(serverId, searchQuery.trim(), channelId, limit, searchOffset);
      // Out-of-order guard — see the local-search path above.
      if (seq !== searchSeqRef.current) return;
      if (res.success && res.data) {
        setResults(res.data);
      } else {
        setResults({ messages: [], total_count: 0 });
      }
      setIsSearching(false);
    },
    [channelId, useLocalSearch]
  );

  /** Debounced search on input change */
  function handleInputChange(value: string) {
    setQuery(value);
    setOffset(0);

    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(() => {
      doSearch(value, 0);
    }, DEBOUNCE_MS);
  }

  /** Next page */
  function handleNextPage() {
    const newOffset = offset + limit;
    setOffset(newOffset);
    doSearch(query, newOffset);
  }

  /** Previous page */
  function handlePrevPage() {
    const newOffset = Math.max(0, offset - limit);
    setOffset(newOffset);
    doSearch(query, newOffset);
  }

  const addToast = useToastStore((s) => s.addToast);

  // Live deletion while the panel is open: results are a snapshot, so a
  // WS-deleted message would linger as a dead row. Subscribe to the narrow
  // lastDeleted field (store subscription, not a selector hook — setState
  // belongs in the callback per react-hooks/set-state-in-effect) and drop
  // the row from our own snapshot, NOT the loaded message window — the
  // result may live far outside it.
  useEffect(() => {
    const unsubscribe = useMessageStore.subscribe((state, prev) => {
      const deleted = state.lastDeleted;
      if (!deleted || deleted === prev.lastDeleted) return;
      setResults((prevResults) => {
        if (!prevResults || !prevResults.messages.some((m) => m.id === deleted.id)) {
          return prevResults;
        }
        return {
          ...prevResults,
          messages: prevResults.messages.filter((m) => m.id !== deleted.id),
          total_count: Math.max(0, prevResults.total_count - 1),
        };
      });
    });

    return () => unsubscribe();
  }, []);

  /** Clicking a result navigates to the original message, but the
   *  result list is a snapshot — if the message has been deleted in
   *  another tab/session, the chat scroll-target no longer exists.
   *  Verify against messageStore at click time and bail out with a
   *  toast + local filter instead of leaving the user stranded. */
  const handleResultClick = useCallback(
    (msg: Message) => {
      const live = useMessageStore.getState().messagesByChannel[msg.channel_id];
      if (!live?.some((m) => m.id === msg.id)) {
        addToast("info", t("messageNoLongerExists"));
        setResults((prev) =>
          prev
            ? {
                ...prev,
                messages: prev.messages.filter((m) => m.id !== msg.id),
                total_count: Math.max(0, prev.total_count - 1),
              }
            : null,
        );
        return;
      }
      onSelectResult?.(msg);
    },
    [onSelectResult, addToast, t],
  );

  function formatDate(dateStr: string): string {
    const date = new Date(dateStr);
    // Use the user's chosen i18n language; previously [] (default locale)
    // produced en-US "MM/DD/YYYY" on HF Space prod regardless of UI lang.
    return date.toLocaleDateString(i18n.language, {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  const totalPages = results ? Math.ceil(results.total_count / limit) : 0;
  const currentPage = Math.floor(offset / limit) + 1;

  return (
    <div className="search-panel">
      {/* Header */}
      <div className="search-header">
        <span className="search-header-title">{t("searchMessages")}</span>
        <button onClick={onClose} className="search-close">
          <svg style={{ width: 16, height: 16 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Search input */}
      <div className="search-input-wrap">
        <svg className="search-input-icon" style={{ width: 14, height: 14 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => handleInputChange(e.target.value)}
          placeholder={t("searchPlaceholder")}
          className="search-input"
        />
      </div>

      {/* E2EE client-side search note — only when server is actually encrypted */}
      {useLocalSearch && (
        <p className="search-e2ee-note">{tE2ee("clientSearchNote")}</p>
      )}

      {/* Results */}
      <div className="search-results">
        {isSearching ? (
          <p className="search-empty">{t("searching")}</p>
        ) : !results ? (
          <p className="search-empty">{t("searchHint")}</p>
        ) : results.messages.length === 0 ? (
          <p className="search-empty">{t("noSearchResults")}</p>
        ) : (
          <>
            <p className="search-count">
              {t("searchResultCount", { count: results.total_count })}
            </p>
            {results.messages.map((msg) => {
              const displayName = msg.author?.display_name ?? msg.author?.username ?? "Unknown";

              return (
                <div
                  key={msg.id}
                  className="search-result-item"
                  onClick={() => handleResultClick(msg)}
                >
                  <div className="search-result-header">
                    <Avatar
                      name={displayName}
                      avatarUrl={msg.author?.avatar_url ?? undefined}
                      size={18}
                    />
                    <span className="search-result-author">{displayName}</span>
                    <span className="search-result-time">{formatDate(msg.created_at)}</span>
                  </div>
                  <div className="search-result-content">
                    {msg.content ?? ""}
                  </div>
                </div>
              );
            })}

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="search-pagination">
                <button
                  onClick={handlePrevPage}
                  disabled={currentPage <= 1}
                  className="search-page-btn"
                >
                  {t("searchPrev")}
                </button>
                <span className="search-page-info">
                  {currentPage} / {totalPages}
                </span>
                <button
                  onClick={handleNextPage}
                  disabled={currentPage >= totalPages}
                  className="search-page-btn"
                >
                  {t("searchNext")}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default SearchPanel;
