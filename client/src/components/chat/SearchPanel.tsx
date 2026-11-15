/** SearchPanel — Message search with debounced input and pagination. */

import { useState, useCallback, useRef, useEffect, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { getAuthSessionOwner, subscribeAuthOwnerChanges, getAuthSessionSnapshot, subscribeAuthGenerationChanges } from "../../api/authSessionEvents";
import { searchMessages } from "../../api/search";
import { createCachedSearchSnapshot, type CachedSearchSnapshot } from "../../crypto/cachedSearchSnapshot";
import { getCachedSearchResetGeneration, subscribeCachedSearchResets } from "../../crypto/cachedSearchEpoch";
import { readCachedSearchPage } from "../../crypto/cachedSearchPage";
import { useServerStore } from "../../stores/serverStore";
import { useE2EEStore } from "../../stores/e2eeStore";
import { useMessageStore } from "../../stores/messageStore";
import type { SearchResult } from "../../api/search";
import type { Message } from "../../types";
import Avatar from "../shared/Avatar";
import SpamPreview from "./SpamPreview";

/** Debounce delay (ms) */
const DEBOUNCE_MS = 300;

type SearchPanelProps = {
  channelId?: string;
  onClose: () => void;
  /**
   * Navigate to the message on result click. Resolves false when the
   * message no longer exists (the panel then drops the row and toasts).
   */
  onSelectResult?: (message: Message) => Promise<boolean>;
};

function SearchPanel(props: SearchPanelProps) {
  const activeServerId = useServerStore((s) => s.activeServerId);
  const serverE2eeEnabled = useServerStore((s) => s.activeServer?.e2ee_enabled ?? false);
  const keysReady = useE2EEStore((s) => s.initStatus === "ready");
  const owner = useSyncExternalStore(subscribeAuthOwnerChanges, getAuthSessionOwner);
  const generation = useSyncExternalStore(subscribeAuthGenerationChanges, () => getAuthSessionSnapshot().generation);
  const resetGeneration = useSyncExternalStore(subscribeCachedSearchResets, getCachedSearchResetGeneration);
  const deviceId = useE2EEStore(s => s.localDeviceId);
  const scope = JSON.stringify([owner, generation, serverE2eeEnabled && resetGeneration, serverE2eeEnabled && deviceId, activeServerId, props.channelId, serverE2eeEnabled, serverE2eeEnabled && keysReady]);
  return <ScopedSearchPanel key={scope} {...props} activeServerId={activeServerId} serverE2eeEnabled={serverE2eeEnabled} />;
}

function ScopedSearchPanel({ channelId, onClose, onSelectResult, activeServerId, serverE2eeEnabled }: SearchPanelProps & {
  activeServerId: string | null;
  serverE2eeEnabled: boolean;
}) {
  const { t, i18n } = useTranslation("chat");
  const { t: tE2ee } = useTranslation("e2ee");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [offset, setOffset] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Monotonic id per doSearch call — a slow response for an abandoned query
  // must not overwrite the results of the search started after it.
  const searchSeqRef = useRef(0);
  const searching = useRef(false);
  const queryOffset = useRef(0);
  const localSearch = useRef<AbortController | null>(null);
  const localMatches = useRef<CachedSearchSnapshot | null>(null);
  const deletedIds = useRef(new Set<string>());
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
    deletedIds.current.clear();
    void snapshot?.dispose().catch(() => {});
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  const doSearch = useCallback(
    async (searchQuery: string, searchOffset: number) => {
      // Bumping before the empty-query early return also invalidates any
      // in-flight search when the user clears the input.
      const seq = ++searchSeqRef.current;
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
        try {
          const controller = new AbortController();
          localSearch.current = controller;
          const term = searchQuery.trim();
          const pendingDeletes = deletedIds.current;
          if (!localMatches.current) {
            const snapshot = await createCachedSearchSnapshot("channel", channelId!, term, controller.signal);
            if (seq !== searchSeqRef.current) { await snapshot.dispose(); return; }
            localMatches.current = snapshot;
          }
          const snapshot = localMatches.current;
          for (const id of pendingDeletes) {
            await snapshot.remove(id, controller.signal);
            if (seq !== searchSeqRef.current) return;
            pendingDeletes.delete(id);
          }
          const lowerTerm = term.toLowerCase();
          const page = await readCachedSearchPage(snapshot, searchOffset, limit,
            row => row.channelId === channelId && row.content.toLowerCase().includes(lowerTerm) && !pendingDeletes.has(row.messageId),
            () => seq === searchSeqRef.current, controller.signal);
          if (!page || seq !== searchSeqRef.current) return;
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
        } catch {
          if (seq !== searchSeqRef.current) return;
          const failed = localMatches.current; localMatches.current = null;
          deletedIds.current.clear(); deletedIds.current = new Set();
          void failed?.dispose().catch(() => {});
          setResults({ messages: [], total_count: 0 });
        }
        searching.current = false; setIsSearching(false);
        return;
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
    [activeServerId, channelId, serverE2eeEnabled]
  );

  /** Debounced search on input change */
  function handleInputChange(value: string) {
    const previous = localMatches.current; localMatches.current = null;
    void previous?.dispose().catch(() => {});
    deletedIds.current.clear(); deletedIds.current = new Set();
    searchSeqRef.current++;
    localSearch.current?.abort();
    setQuery(value);
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
    if (!query.trim()) return true;
    const snapshot = localMatches.current;
    // A failed/finished query has no index or pending scan to reconcile.
    // Do not accumulate tombstones or enqueue no-op React updates indefinitely.
    if (!snapshot && !searching.current && debounceRef.current === null) return true;
    const pending = deletedIds.current;
    if (pending.has(id)) return true;
    pending.add(id);
    // Hide a live deletion immediately, even before IndexedDB commits.
    setResults(prev => prev && ({ ...prev, messages: prev.messages.filter(message => message.id !== id) }));
    if (!snapshot) return true;
    void snapshot.remove(id).then(change => {
      if (snapshot !== localMatches.current || !pending.has(id)) return;
      const refresh = searching.current || (change.removed && change.position < queryOffset.current + limit);
      // Invalidate older reads before releasing the tombstone: an index read
      // may have completed before this deletion but returned after its commit.
      searchSeqRef.current++; localSearch.current?.abort();
      pending.delete(id);
      setResults(prev => prev && ({ messages: prev.messages.filter(message => message.id !== id), total_count: Math.min(prev.total_count, change.total) }));
      if (refresh) {
        const nextOffset = Math.min(queryOffset.current, Math.max(0, Math.floor((change.total - 1) / limit) * limit));
        setOffset(nextOffset);
        void doSearch(query, nextOffset);
      }
    }).catch(() => {
      if (snapshot !== localMatches.current) return;
      localMatches.current = null; searchSeqRef.current++; localSearch.current?.abort();
      deletedIds.current.clear(); deletedIds.current = new Set();
      void snapshot.dispose().catch(() => {});
      setResults({ messages: [], total_count: 0 });
      searching.current = false; setIsSearching(false);
    });
    return true;
  }, [doSearch, query, serverE2eeEnabled]);


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
        )}
      </div>
    </div>
  );
}

export default SearchPanel;
