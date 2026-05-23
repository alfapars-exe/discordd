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

  fetchInitial: async (serverId) => {
    const state = get();
    if (state.eventsByServer[serverId] || state.isLoadingByServer[serverId]) {
      return;
    }
    set((s) => ({ isLoadingByServer: { ...s.isLoadingByServer, [serverId]: true } }));
    try {
      const res = await listServerAudit(serverId, { limit: PAGE_SIZE });
      if (res.success && res.data) {
        // Server returns newest first; flip to oldest-first for natural
        // chat-style chronological rendering (oldest at top, newest at
        // bottom, just like text channels).
        const sorted = [...res.data.entries].reverse();
        set((s) => ({
          eventsByServer: { ...s.eventsByServer, [serverId]: sorted },
          hasMoreByServer: {
            ...s.hasMoreByServer,
            [serverId]: res.data.entries.length === PAGE_SIZE,
          },
        }));
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
        // New page is newest-first too; reverse + prepend.
        const older = [...res.data.entries].reverse();
        set((s) => ({
          eventsByServer: {
            ...s.eventsByServer,
            [serverId]: [...older, ...s.eventsByServer[serverId]],
          },
          hasMoreByServer: {
            ...s.hasMoreByServer,
            [serverId]: res.data.entries.length === PAGE_SIZE,
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
      if (!current) {
        // We haven't fetched this server's audit yet — drop the live
        // event; the next fetchInitial pull will include it. This avoids
        // showing a single isolated event in an otherwise-empty panel.
        return s;
      }
      // Dedup by id in case the broadcast races a pagination fetch.
      if (current.some((e) => e.id === event.id)) {
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
      delete events[serverId];
      delete hasMore[serverId];
      delete isLoading[serverId];
      return {
        eventsByServer: events,
        hasMoreByServer: hasMore,
        isLoadingByServer: isLoading,
      };
    });
  },
}));
