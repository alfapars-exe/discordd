/** SearchPanel — Message search with debounced input and pagination. */

import { useState, useCallback, useRef, useEffect, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { getAuthSessionOwner, subscribeAuthOwnerChanges, getAuthSessionSnapshot, subscribeAuthGenerationChanges } from "../../api/authSessionEvents";
import { searchMessages } from "../../api/search";
import type { CachedSearchSnapshot } from "../../crypto/cachedSearchSnapshot";
import { getCachedSearchResetGeneration, subscribeCachedSearchResets } from "../../crypto/cachedSearchEpoch";
import { runCachedSearch, type CachedSearchPage } from "../../crypto/cachedSearchRunner";
import { useCachedSearchDeletionPool } from "../../hooks/useCachedSearchDeletionPool";
import type { SearchDeletionPool, SearchDeletionSpool } from "../../crypto/cachedSearchDeletionSpool";
import { useServerStore } from "../../stores/serverStore";
import { useE2EEStore } from "../../stores/e2eeStore";
import { useMessageStore } from "../../stores/messageStore";
import type { SearchResult } from "../../api/search";
import type { Message } from "../../types";
import Avatar from "../shared/Avatar";
import SpamPreview from "./SpamPreview";

/** Debounce delay (ms) */
const DEBOUNCE_MS = 300;

type SearchPanelProps = Readonly<{
  channelId?: string;
  onClose: () => void;
  /**
   * Navigate to the message on result click. Resolves false when the
   * message no longer exists (the panel drops the row; the navigator toasts).
   */
  onSelectResult?: (message: Message) => Promise<boolean>;
}>;

function SearchPanel(props: SearchPanelProps) {
  const activeServerId = useServerStore((s) => s.activeServerId);
  const serverE2eeEnabled = useServerStore((s) => s.activeServer?.e2ee_enabled ?? false);
  const keysReady = useE2EEStore((s) => s.initStatus === "ready");
  const owner = useSyncExternalStore(subscribeAuthOwnerChanges, getAuthSessionOwner);
  const generation = useSyncExternalStore(subscribeAuthGenerationChanges, () => getAuthSessionSnapshot().generation);
  const resetGeneration = useSyncExternalStore(subscribeCachedSearchResets, getCachedSearchResetGeneration);
  const deviceId = useE2EEStore(s => s.localDeviceId);
  const scope = JSON.stringify([owner, generation, serverE2eeEnabled && resetGeneration, serverE2eeEnabled && deviceId, activeServerId, props.channelId, serverE2eeEnabled, serverE2eeEnabled && keysReady]);
  return <ScopedSearchPanel key={scope} {...props} activeServerId={activeServerId} serverE2eeEnabled={serverE2eeEnabled} keysReady={keysReady} />;
}

function ScopedSearchPanel({ channelId, onClose, onSelectResult, activeServerId, serverE2eeEnabled, keysReady }: Readonly<SearchPanelProps & {
  activeServerId: string | null;
  serverE2eeEnabled: boolean;
  keysReady: boolean;
}>) {
  const { t, i18n } = useTranslation("chat");
  const { t: tE2ee } = useTranslation("e2ee");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const [offset, setOffset] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Monotonic id per doSearch call — a slow response for an abandoned query
  // must not overwrite the results of the search started after it.
  const searchSeqRef = useRef(0);
  const searching = useRef(false);
  const queryOffset = useRef(0);
  const localSearch = useRef<AbortController | null>(null);
  const localMatches = useRef<CachedSearchSnapshot | null>(null);
  const deletionPool = useCachedSearchDeletionPool(Boolean(serverE2eeEnabled && keysReady));
  const deletionSpool = useRef<SearchDeletionSpool | null>(null);
  const queryRef = useRef("");
  const inputRef = useRef<HTMLInputElement>(null);

  const limit = 25;

  // Auto-focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Clear any pending debounce on unmount — the timer would otherwise fire
  // after close and call setState on an unmounted panel.
  useEffect(() => () => {
    localSearch.current?.abort();
    searchSeqRef.current++;
    const snapshot = localMatches.current; localMatches.current = null;
    const frontier = deletionSpool.current; deletionSpool.current = null;
    void frontier?.dispose().catch(() => {});
    void snapshot?.dispose().catch(() => {});
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  const failCurrentSearch = useCallback(() => {
    searchSeqRef.current++; localSearch.current?.abort();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = null;
    const frontier = deletionSpool.current; deletionSpool.current = null;
    const snapshot = localMatches.current; localMatches.current = null;
    void frontier?.dispose().catch(() => {}); void snapshot?.dispose().catch(() => {});
    searching.current = false; setIsSearching(false); setResults(null); setSearchFailed(true);
  }, []);
  const startFrontier = useCallback((pool: SearchDeletionPool) => {
    const frontier = pool.create(() => { if (deletionSpool.current === frontier) failCurrentSearch(); });
    return frontier;
  }, [failCurrentSearch]);

  const publishCachedPage = useCallback((page: CachedSearchPage, searchOffset: number) => {
    queryOffset.current = page.offset;
    if (page.offset !== searchOffset) setOffset(page.offset);
    const paged = page.messages;
    const total = page.total;

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
  }, []);

  const doSearch = useCallback(
    async (searchQuery: string, searchOffset: number) => {
      // Bumping before the empty-query early return also invalidates any
      // in-flight search when the user clears the input.
      const seq = ++searchSeqRef.current;
      setSearchFailed(false);
      queryOffset.current = searchOffset;
      localSearch.current?.abort();

      if (searchQuery.trim().length < 1) {
        setResults(null);
        searching.current = false; setIsSearching(false);
        return;
      }

      searching.current = true; setIsSearching(true);

      const current = useServerStore.getState();
      if (!activeServerId || current.activeServerId !== activeServerId || current.activeServer?.id !== activeServerId ||
          (current.activeServer.e2ee_enabled ?? false) !== serverE2eeEnabled) {
        setResults(null);
        searching.current = false; setIsSearching(false);
        return;
      }
      if (serverE2eeEnabled) {
        if (!channelId || useE2EEStore.getState().initStatus !== "ready") {
          setResults(null);
          searching.current = false; setIsSearching(false);
          return;
        }
        return runCachedSearch({
          kind: "channel", channelId, query: searchQuery, offset: searchOffset, limit,
          controller: localSearch, snapshot: localMatches, deletions: deletionSpool,
          getPool: () => deletionPool.get(), startFrontier,
          matches: (row, lowerTerm) => row.channelId === channelId && row.content.toLowerCase().includes(lowerTerm),
          isCurrent: () => seq === searchSeqRef.current,
          publish: page => publishCachedPage(page, searchOffset),
          fail: failCurrentSearch,
          finish: () => { searching.current = false; setIsSearching(false); },
        });
      }

      // Plaintext — server-side FTS5 search
      const res = await searchMessages(activeServerId, searchQuery.trim(), channelId, limit, searchOffset);
      // Out-of-order guard — see the local-search path above.
      if (seq !== searchSeqRef.current) return;
      if (res.success && res.data) {
        setResults(res.data);
      } else {
        setResults({ messages: [], total_count: 0 });
      }
      searching.current = false; setIsSearching(false);
    },
    [activeServerId, channelId, serverE2eeEnabled, deletionPool, startFrontier, failCurrentSearch, publishCachedPage]
  );

  /** Debounced search on input change */
  function handleInputChange(value: string) {
    const previous = localMatches.current; localMatches.current = null;
    void previous?.dispose().catch(() => {});
    const frontier = deletionSpool.current; deletionSpool.current = null;
    void frontier?.dispose().catch(() => {});
    queryRef.current = value;
    searchSeqRef.current++;
    localSearch.current?.abort();
    setQuery(value); setSearchFailed(false);
    if (!value.trim()) { searching.current = false; setIsSearching(false); setResults(null); }
    setOffset(0); queryOffset.current = 0;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { debounceRef.current = null; void doSearch(value, 0); }, DEBOUNCE_MS);
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

  const removeLocalMatch = useCallback((id: string) => {
    if (!serverE2eeEnabled) return false;
    if (!queryRef.current.trim()) return true;
    if (!localMatches.current && !searching.current && debounceRef.current === null) return true;
    try {
      let frontier = deletionSpool.current;
      if (!frontier) {
        const pool = deletionPool.peek();
        if (!pool) { failCurrentSearch(); return true; }
        frontier = startFrontier(pool); deletionSpool.current = frontier;
      }
      frontier.append(id);
    } catch { failCurrentSearch(); return true; }
    if (!searching.current && debounceRef.current === null) {
      searching.current = true; setIsSearching(true);
      void doSearch(queryRef.current, queryOffset.current);
    }
    return true;
  }, [serverE2eeEnabled, deletionPool, startFrontier, failCurrentSearch, doSearch]);


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
      if (serverE2eeEnabled && deleted.channel_id === channelId && removeLocalMatch(deleted.id)) return;
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
  }, [channelId, removeLocalMatch, serverE2eeEnabled]);

  /** Clicking a result navigates to the original message. The result
   *  list is a snapshot — if the message was deleted meanwhile, the
   *  navigation (which fetches a window around it) resolves false; drop
   *  the dead row. The navigator (useOpenAtMessage) already toasted, so
   *  the panel stays silent to avoid a duplicate. */
  const handleResultClick = useCallback(
    async (msg: Message) => {
      if (!onSelectResult) return;
      const found = await onSelectResult(msg);
      if (found) return;
      if (serverE2eeEnabled && removeLocalMatch(msg.id)) return;
      setResults((prev) =>
        prev?.messages.some((m) => m.id === msg.id)
          ? {
              ...prev,
              messages: prev.messages.filter((m) => m.id !== msg.id),
              total_count: Math.max(0, prev.total_count - 1),
            }
          : prev,
      );
    },
    [onSelectResult, removeLocalMatch, serverE2eeEnabled],
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

  function renderResults() {
    if (isSearching) return <p className="search-empty">{t("searching")}</p>;
    if (searchFailed) return <p className="search-empty" role="alert">{t("searchFailed")}</p>;
    if (!results) return <p className="search-empty">{t("searchHint")}</p>;
    if (results.messages.length === 0) return <p className="search-empty">{t("noSearchResults")}</p>;
    return (
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
              onClick={() => void handleResultClick(msg)}
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
                <SpamPreview kind="channel" message={msg} />
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
    );
  }

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
      {serverE2eeEnabled && (
        <p className="search-e2ee-note">{tE2ee("clientSearchNote")}</p>
      )}

      {/* Results */}
      <div className="search-results">
        {renderResults()}
      </div>
    </div>
  );
}

export default SearchPanel;
