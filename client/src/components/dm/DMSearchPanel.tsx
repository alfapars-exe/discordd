/** DMSearchPanel — DM message search panel. Same pattern as channel SearchPanel. */

import { useState, useCallback, useRef, useEffect, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useDMStore } from "../../stores/dmStore";
import { useE2EEStore } from "../../stores/e2eeStore";
import { useOpenAtMessage } from "../../hooks/useOpenAtMessage";
import { getAuthSessionOwner, subscribeAuthOwnerChanges, getAuthSessionSnapshot, subscribeAuthGenerationChanges } from "../../api/authSessionEvents";
import { getCachedSearchResetGeneration, subscribeCachedSearchResets } from "../../crypto/cachedSearchEpoch";
import { readCachedSearchPage } from "../../crypto/cachedSearchPage";
import { createCachedSearchSnapshot, type CachedSearchSnapshot } from "../../crypto/cachedSearchSnapshot";
import Avatar from "../shared/Avatar";
import SpamPreview from "../chat/SpamPreview";
import GameMessageOrigin from "../chat/GameMessageOrigin";
import type { DMMessage } from "../../types";

/** Debounce delay (ms) */
const DEBOUNCE_MS = 300;

/** Results per page */
const LIMIT = 25;

type DMSearchPanelProps = {
  channelId: string;
  onClose: () => void;
};

type SearchState = {
  messages: DMMessage[];
  totalCount: number;
} | null;

function DMSearchPanel(props: DMSearchPanelProps) {
  const encrypted = useDMStore((s) => s.channels.find((c) => c.id === props.channelId)?.e2ee_enabled);
  const keysReady = useE2EEStore((s) => s.initStatus === "ready");
  const owner = useSyncExternalStore(subscribeAuthOwnerChanges, getAuthSessionOwner);
  const generation = useSyncExternalStore(subscribeAuthGenerationChanges, () => getAuthSessionSnapshot().generation);
  const resetGeneration = useSyncExternalStore(subscribeCachedSearchResets, getCachedSearchResetGeneration);
  const deviceId = useE2EEStore(s => s.localDeviceId);
  const scope = JSON.stringify([owner, generation, encrypted && resetGeneration, encrypted && deviceId, props.channelId, encrypted, encrypted && keysReady]);
  return <ScopedDMSearchPanel key={scope} {...props} encrypted={encrypted} />;
}

function ScopedDMSearchPanel({ channelId, onClose, encrypted }: DMSearchPanelProps & { encrypted?: boolean }) {
  const { t, i18n } = useTranslation("chat");
  const { t: tE2ee } = useTranslation("e2ee");
  const searchMessages = useDMStore((s) => s.searchMessages);
  const setScrollToMessageId = useDMStore((s) => s.setScrollToMessageId);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchState>(null);
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
  const deletedIds = useRef(new Set<string>());
  const inputRef = useRef<HTMLInputElement>(null);

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
      setSearchFailed(false);
      queryOffset.current = searchOffset;
      localSearch.current?.abort();

      if (searchQuery.trim().length < 1) {
        setResults(null);
        searching.current = false; setIsSearching(false);
        return;
      }

      searching.current = true; setIsSearching(true);

      // E2EE active — client-side IndexedDB search
      const current = useDMStore.getState().channels.find((c) => c.id === channelId);
      if (encrypted === undefined || current?.e2ee_enabled !== encrypted ||
          (encrypted && useE2EEStore.getState().initStatus !== "ready")) {
        setResults(null);
        searching.current = false; setIsSearching(false);
        return;
      }
      if (encrypted) {
        try {
          const controller = new AbortController();
          localSearch.current = controller;
          const term = searchQuery.trim();
          const pendingDeletes = deletedIds.current;
          if (!localMatches.current) {
            const snapshot = await createCachedSearchSnapshot("dm", channelId!, term, controller.signal);
            if (seq !== searchSeqRef.current) { await snapshot.dispose(); return; }
            localMatches.current = snapshot;
          }
          const snapshot = localMatches.current;
          while (pendingDeletes.size) {
            const batch: string[] = [];
            for (const id of pendingDeletes) {
              batch.push(id);
              if (batch.length === 128) break;
            }
            await snapshot.removeMany(batch, controller.signal);
            if (seq !== searchSeqRef.current) return;
            for (const id of batch) pendingDeletes.delete(id);
          }
          const lowerTerm = term.toLowerCase();
          const page = await readCachedSearchPage(snapshot, searchOffset, LIMIT,
            row => row.dmChannelId === channelId && row.content.toLowerCase().includes(lowerTerm) && !pendingDeletes.has(row.messageId),
            () => seq === searchSeqRef.current, controller.signal);
          if (!page || seq !== searchSeqRef.current) return;
          queryOffset.current = page.offset;
          if (page.offset !== searchOffset) setOffset(page.offset);
          const paged = page.messages;
          const total = page.total;

          // CachedDecryptedMessage -> DMMessage minimal format
          const messages: DMMessage[] = paged.map((c) => ({
            id: c.messageId,
            dm_channel_id: channelId,
            user_id: c.senderUserId ?? "",
            application_id: c.applicationId,
            source_sequence: c.sourceSequence,
            content: c.content,
            created_at: new Date(c.timestamp).toISOString(),
            edited_at: null,
            is_pinned: false,
            attachments: [],
            reactions: [],
            reply_to_id: null,
            referenced_message: null,
            author: { id: "", username: "", display_name: null, avatar_url: null, status: "offline" as const, custom_status: null, created_at: "" },
            encryption_version: 1,
          }));

          setResults({ messages, totalCount: total });
        } catch {
          if (seq !== searchSeqRef.current) return;
          const failed = localMatches.current; localMatches.current = null;
          deletedIds.current.clear(); deletedIds.current = new Set();
          void failed?.dispose().catch(() => {});
          setResults(null); setSearchFailed(true);
        }
        searching.current = false; setIsSearching(false);
        return;
      }

      // Plaintext — server-side FTS5 search
      const result = await searchMessages(channelId, searchQuery.trim(), LIMIT, searchOffset);
      // Out-of-order guard — see the local-search path above.
      if (seq !== searchSeqRef.current) return;
      setResults({
        messages: result.messages,
        totalCount: result.total_count,
      });
      searching.current = false; setIsSearching(false);
    },
    [channelId, encrypted, searchMessages]
  );

  /** Debounced search on input change */
  function handleInputChange(value: string) {
    const previous = localMatches.current; localMatches.current = null;
    void previous?.dispose().catch(() => {});
    deletedIds.current.clear(); deletedIds.current = new Set();
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
    const newOffset = offset + LIMIT;
    setOffset(newOffset);
    doSearch(query, newOffset);
  }

  /** Previous page */
  function handlePrevPage() {
    const newOffset = Math.max(0, offset - LIMIT);
    setOffset(newOffset);
    doSearch(query, newOffset);
  }

  const removeLocalMatch = useCallback((id: string) => {
    if (!encrypted) return false;
    if (!query.trim()) return true;
    const snapshot = localMatches.current;
    // A failed/finished query has no index or pending scan to reconcile.
    // Do not accumulate tombstones or enqueue no-op React updates indefinitely.
    if (!snapshot && !searching.current && debounceRef.current === null) return true;
    const pending = deletedIds.current;
    if (pending.has(id)) return true;
    pending.add(id);
    // Visible results hide deletions immediately. During a search the spinner
    // hides this page; tombstones reconcile the incoming page without retaining
    // a React state updater for every event received while the index is pending.
    if (!searching.current) setResults(prev => prev && ({ ...prev, messages: prev.messages.filter(message => message.id !== id) }));
    if (!snapshot) return true;
    void snapshot.remove(id).then(change => {
      if (snapshot !== localMatches.current || !pending.has(id)) return;
      const refresh = searching.current || (change.removed && change.position < queryOffset.current + LIMIT);
      // Invalidate older reads before releasing the tombstone: an index read
      // may have completed before this deletion but returned after its commit.
      searchSeqRef.current++; localSearch.current?.abort();
      pending.delete(id);
      setResults(prev => prev && ({ messages: prev.messages.filter(message => message.id !== id), totalCount: Math.min(prev.totalCount, change.total) }));
      if (refresh) {
        const nextOffset = Math.min(queryOffset.current, Math.max(0, Math.floor((change.total - 1) / LIMIT) * LIMIT));
        setOffset(nextOffset);
        void doSearch(query, nextOffset);
      }
    }).catch(() => {
      if (snapshot !== localMatches.current) return;
      localMatches.current = null; searchSeqRef.current++; localSearch.current?.abort();
      deletedIds.current.clear(); deletedIds.current = new Set();
      void snapshot.dispose().catch(() => {});
      setResults(null); setSearchFailed(true);
      searching.current = false; setIsSearching(false);
    });
    return true;
  }, [doSearch, query, encrypted]);

  const { openAtDMMessage } = useOpenAtMessage();

  // Live deletion while the panel is open: results are a snapshot, so a
  // WS-deleted message would linger as a dead row. Subscribe to the narrow
  // lastDeletedDM field (store subscription, not a selector hook — setState
  // belongs in the callback per react-hooks/set-state-in-effect) and drop
  // the row from our own snapshot, NOT the loaded message window — the
  // result may live far outside it.
  useEffect(() => {
    const unsubscribe = useDMStore.subscribe((state, prev) => {
      const deleted = state.lastDeletedDM;
      if (!deleted || deleted === prev.lastDeletedDM || deleted.dm_channel_id !== channelId) return;
      if (removeLocalMatch(deleted.id)) return;
      setResults((prevResults) => {
        if (!prevResults || !prevResults.messages.some((m) => m.id === deleted.id)) {
          return prevResults;
        }
        return {
          ...prevResults,
          messages: prevResults.messages.filter((m) => m.id !== deleted.id),
          totalCount: Math.max(0, prevResults.totalCount - 1),
        };
      });
    });

    return () => unsubscribe();
  }, [channelId, removeLocalMatch]);

  /** Scroll to message on result click. Inside the loaded window this is
   *  a plain scroll; outside it, fetch a window around the message. Results
   *  are a snapshot — if the message has been deleted (other session, peer
   *  revocation) the around-fetch resolves false: drop the row. The hook
   *  already toasted, so no second toast here. */
  async function handleSelectResult(msg: DMMessage) {
    const live = useDMStore.getState().messagesByChannel[channelId];
    if (live?.some((m) => m.id === msg.id)) {
      setScrollToMessageId(msg.id);
      onClose();
      return;
    }
    const found = await openAtDMMessage(channelId, msg.id);
    if (found) {
      onClose();
      return;
    }
    if (removeLocalMatch(msg.id)) return;
    setResults((prev) =>
      prev?.messages.some((m) => m.id === msg.id)
        ? {
            ...prev,
            messages: prev.messages.filter((m) => m.id !== msg.id),
            totalCount: Math.max(0, prev.totalCount - 1),
          }
        : prev,
    );
  }

  /** Format timestamp using the user's chosen i18n language. Passing []
   *  resolved to the browser locale (en-US on HF Space prod), producing
   *  "MM/DD/YYYY" inside an otherwise-Turkish UI. */
  function formatDate(dateStr: string): string {
    const date = new Date(dateStr);
    return date.toLocaleDateString(i18n.language, {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  const totalPages = results ? Math.ceil(results.totalCount / LIMIT) : 0;
  const currentPage = Math.floor(offset / LIMIT) + 1;

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

      {/* E2EE client-side search note — only when THIS channel is encrypted */}
      {encrypted && (
        <p className="search-e2ee-note">{tE2ee("clientSearchNote")}</p>
      )}

      {/* Results */}
      <div className="search-results">
        {isSearching ? (
          <p className="search-empty">{t("searching")}</p>
        ) : searchFailed ? (
          <p className="search-empty" role="alert">{t("searchFailed")}</p>
        ) : !results ? (
          <p className="search-empty">{t("searchHint")}</p>
        ) : results.messages.length === 0 ? (
          <p className="search-empty">{t("noSearchResults")}</p>
        ) : (
          <>
            <p className="search-count">
              {t("searchResultCount", { count: results.totalCount })}
            </p>
            {results.messages.map((msg) => {
              const displayName = msg.author?.display_name ?? msg.author?.username ?? "Unknown";

              return (
                <div
                  key={msg.id}
                  className="search-result-item"
                  onClick={() => void handleSelectResult(msg)}
                >
                  <div className="search-result-header">
                    <Avatar
                      name={displayName}
                      avatarUrl={msg.author?.avatar_url ?? undefined}
                      size={18}
                    />
                    <span className="search-result-author">{displayName}</span>
                    <span className="search-result-time">{formatDate(msg.created_at)}</span>
                    <GameMessageOrigin applicationID={msg.application_id} authorID={msg.user_id} />
                  </div>
                  <div className="search-result-content">
                    <SpamPreview kind="dm" message={msg} />
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

export default DMSearchPanel;
