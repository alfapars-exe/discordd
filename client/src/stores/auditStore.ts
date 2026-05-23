/**
 * auditStore — per-server audit event cache.
 *
 * Mirrors messageStore's shape (entries keyed by server, paginated cursor
 * on created_at). The store is hydrated lazily when an audit channel
 * panel mounts: AuditChannel.tsx calls fetchInitial(serverId) which pulls
 * the latest page; user-initiated scroll to the top triggers fetchOlder.
 *
 * Real-time `audit_event` WebSocket messages are merged in via
 * handleAuditEvent — new events land at the top of the list (highest
 * created_at), the UI scrolls to bottom if the user was already pinned
 * there. Events are NOT broadcast to clients without audit-view
 * permission (server filters before sending), so we don't need to
 * permission-gate anything client-side.
 *
 * Memory footprint stays bounded because we only fetch what the user
 * actively scrolls through — no infinite background prefetch.
 */

import { create } from "zustand";

import { listServerAudit } from "../api/audit";
import type { AuditLog } from "../types";

type AuditState = {
  /** server_id -> entries, sorted by created_at ASC (oldest first, newest at end) */
  eventsByServer: Record<string, AuditLog[]>;
  /** server_id -> whether we know there's an older page on the server */
  hasMoreByServer: Record<string, boolean>;
  /** server_id -> initial-fetch / pagination loading flag */
  isLoadingByServer: Record<string, boolean>;
  /**
   * server_id -> whether the initial DB backfill has run for this server.
   *
   * Separate from `eventsByServer[serverId]` because a WebSocket event can
   * seed the entries map BEFORE the user ever opens the audit channel
   * (post-Track-R behaviour: live events are never dropped). When they
   * later open the channel, we still want fetchInitial to run once and
   * pull older history from the DB — so the gate is "have we backfilled?"
   * not "is the map populated?".
   */
  initialFetchedByServer: Record<string, boolean>;

  /** Fetch the latest page for a server if we don't have it cached. */
  fetchInitial: (serverId: string) => Promise<void>;
  /** Fetch the next-older page using the oldest cached entry as cursor. */
  fetchOlder: (serverId: string) => Promise<void>;
  /** Append a single event arriving via WebSocket. */
  handleAuditEvent: (event: AuditLog) => void;
  /** Drop cached events for a server (called on leave/refresh). */
  clearServer: (serverId: string) => void;
};

const PAGE_SIZE = 50;

export const useAuditStore = create<AuditState>((set, get) => ({
  eventsByServer: {},
  hasMoreByServer: {},
  isLoadingByServer: {},
  initialFetchedByServer: {},

  fetchInitial: async (serverId) => {
    const state = get();
    // Gate on initialFetched, not on map presence — a WS event may have
    // seeded entries already and we still want one backfill pass to pull
    // older history from the DB.
    if (state.initialFetchedByServer[serverId] || state.isLoadingByServer[serverId]) {
      return;
    }
    set((s) => ({ isLoadingByServer: { ...s.isLoadingByServer, [serverId]: true } }));
    try {
      const res = await listServerAudit(serverId, { limit: PAGE_SIZE });
      if (res.success && res.data) {
        // Snapshot the narrowed payload so the `set` callback below keeps
        // its non-undefined type — TS doesn't preserve control-flow
        // narrowing across closure boundaries.
        const entries = res.data.entries;
        // Server returns newest first; flip to oldest-first for natural
        // chat-style chronological rendering (oldest at top, newest at
        // bottom, just like text channels).
        const fetched = [...entries].reverse();
        set((s) => {
          // Merge with any WS-seeded entries already present. Dedup by id
          // (only when id is non-empty — Track R fixed server-side empty
          // ids, but defense in depth never hurt anyone). Then re-sort by
          // created_at so a live event whose timestamp is older than the
          // newest fetched row (rare clock skew) still lands in order.
          const existing = s.eventsByServer[serverId] ?? [];
          const fetchedIds = new Set(fetched.map((e) => e.id).filter(Boolean));
          const seededExtras = existing.filter(
            (e) => !e.id || !fetchedIds.has(e.id),
          );
          const merged = [...fetched, ...seededExtras].sort((a, b) =>
            a.created_at.localeCompare(b.created_at),
          );
          return {
            eventsByServer: { ...s.eventsByServer, [serverId]: merged },
            hasMoreByServer: {
              ...s.hasMoreByServer,
              [serverId]: entries.length === PAGE_SIZE,
            },
            initialFetchedByServer: {
              ...s.initialFetchedByServer,
              [serverId]: true,
            },
          };
        });
      }
    } finally {
      set((s) => ({ isLoadingByServer: { ...s.isLoadingByServer, [serverId]: false } }));
    }
  },

  fetchOlder: async (serverId) => {
    const state = get();
    const current = state.eventsByServer[serverId];
    if (!current || current.length === 0) return;
    if (state.isLoadingByServer[serverId]) return;
    if (!state.hasMoreByServer[serverId]) return;

    // The OLDEST cached entry is at index 0 because we sorted ascending.
    const oldest = current[0];
    set((s) => ({ isLoadingByServer: { ...s.isLoadingByServer, [serverId]: true } }));
    try {
      const res = await listServerAudit(serverId, {
        limit: PAGE_SIZE,
        before: oldest.created_at,
      });
      if (res.success && res.data) {
        // Snapshot the narrowed payload — see fetchInitial for the
        // reasoning (TS drops narrowing inside the set() closure).
        const entries = res.data.entries;
        // New page is newest-first too; reverse + prepend.
        const older = [...entries].reverse();
        set((s) => ({
          eventsByServer: {
            ...s.eventsByServer,
            [serverId]: [...older, ...s.eventsByServer[serverId]],
          },
          hasMoreByServer: {
            ...s.hasMoreByServer,
            [serverId]: entries.length === PAGE_SIZE,
          },
        }));
      }
    } finally {
      set((s) => ({ isLoadingByServer: { ...s.isLoadingByServer, [serverId]: false } }));
    }
  },

  handleAuditEvent: (event) => {
    set((s) => {
      const current = s.eventsByServer[event.server_id];

      // Pre-Track-R this dropped the event when current was undefined
      // ("avoid showing one isolated row in an empty panel"). That was the
      // bug — moderation actions taken before the user ever tabbed into
      // the audit channel were lost from the live feed, and worse, when
      // they later opened it the fetchInitial gate skipped because
      // entries were already populated by some other code path.
      //
      // Now: seed the map with this event. hasMoreByServer is set to true
      // so the channel UI knows there's older history to backfill, and
      // initialFetchedByServer is left untouched — fetchInitial will still
      // run on next channel mount and merge older DB rows.
      if (!current) {
        return {
          eventsByServer: {
            ...s.eventsByServer,
            [event.server_id]: [event],
          },
          hasMoreByServer: {
            ...s.hasMoreByServer,
            [event.server_id]: true,
          },
        };
      }

      // Dedup by id only when id is non-empty. Pre-Track-R server
      // broadcasts carried id="" so two sequential events both matched
      // `e.id === event.id` (both empty) and the second one was dropped.
      // Track R's RETURNING fix populates real ids now; this guard keeps
      // the check well-defined if any legacy/in-flight event still arrives
      // without one.
      if (event.id && current.some((e) => e.id === event.id)) {
        return s;
      }

      return {
        eventsByServer: {
          ...s.eventsByServer,
          [event.server_id]: [...current, event],
        },
      };
    });
  },

  clearServer: (serverId) => {
    set((s) => {
      const events = { ...s.eventsByServer };
      const hasMore = { ...s.hasMoreByServer };
      const isLoading = { ...s.isLoadingByServer };
      const initialFetched = { ...s.initialFetchedByServer };
      delete events[serverId];
      delete hasMore[serverId];
      delete isLoading[serverId];
      delete initialFetched[serverId];
      return {
        eventsByServer: events,
        hasMoreByServer: hasMore,
        isLoadingByServer: isLoading,
        initialFetchedByServer: initialFetched,
      };
    });
  },
}));
