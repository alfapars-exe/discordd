/**
 * Notification Store — persisted activity feed (mentions, replies, friend
 * and DM requests). Backed by GET /users/me/notifications; kept live via
 * the `notification_create` / `notification_read` WS ops.
 *
 * `unreadCount` is server-authoritative: seeded by fetchCount() on `ready`,
 * bumped locally on create / read, and overwritten by `notification_read`
 * syncs from other devices.
 *
 * Stable empty refs (EMPTY_*) prevent infinite re-renders in selectors.
 */

import { create } from "zustand";
import * as notificationsApi from "../api/notifications";
import type { AppNotification } from "../types";

const EMPTY_ITEMS: AppNotification[] = [];
const PAGE_SIZE = 20;

type NotificationState = {
  items: AppNotification[];
  unreadCount: number;
  hasMore: boolean;
  isLoading: boolean;
  /** Filter for list fetches; flipping it refetches from the top. */
  unreadOnly: boolean;

  // ─── Actions ───
  fetchInitial: () => Promise<void>;
  fetchMore: () => Promise<void>;
  fetchCount: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  setUnreadOnly: (unreadOnly: boolean) => void;

  // ─── WS Event Handlers ───
  handleCreate: (n: AppNotification) => void;
  handleReadSync: (data: { ids: string[]; all: boolean; unread_count: number }) => void;
};

export const useNotificationStore = create<NotificationState>((set, get) => ({
  items: EMPTY_ITEMS,
  unreadCount: 0,
  hasMore: false,
  isLoading: false,
  unreadOnly: false,

  // ─── Actions ───

  fetchInitial: async () => {
    set({ isLoading: true });
    try {
      const res = await notificationsApi.listNotifications({
        unreadOnly: get().unreadOnly,
        limit: PAGE_SIZE,
      });
      if (res.success && res.data) {
        set({
          items: res.data.notifications ?? EMPTY_ITEMS,
          hasMore: res.data.has_more,
        });
      }
    } finally {
      set({ isLoading: false });
    }
  },

  fetchMore: async () => {
    const { items, hasMore, isLoading, unreadOnly } = get();
    if (!hasMore || isLoading || items.length === 0) return;
    set({ isLoading: true });
    try {
      const res = await notificationsApi.listNotifications({
        before: items[items.length - 1].id,
        unreadOnly,
        limit: PAGE_SIZE,
      });
      if (res.success && res.data) {
        const seen = new Set(get().items.map((n) => n.id));
        const fresh = (res.data.notifications ?? []).filter((n) => !seen.has(n.id));
        set((s) => ({
          items: [...s.items, ...fresh],
          hasMore: res.data!.has_more,
        }));
      }
    } finally {
      set({ isLoading: false });
    }
  },

  fetchCount: async () => {
    const res = await notificationsApi.getNotificationCount();
    if (res.success && res.data) {
      set({ unreadCount: Math.max(0, res.data.unread_count) });
    }
  },

  markRead: async (id) => {
    const target = get().items.find((n) => n.id === id);
    // Already read (or unknown locally) — nothing to flip; the server call is
    // idempotent but skipping it avoids a pointless round-trip per click.
    if (target && target.read_at) return;

    const readAt = new Date().toISOString();
    set((s) => ({
      items: s.items.map((n) => (n.id === id ? { ...n, read_at: readAt } : n)),
      unreadCount: Math.max(0, s.unreadCount - 1),
    }));
    const res = await notificationsApi.markNotificationRead(id);
    if (!res.success) {
      // Roll back the optimistic flip; the count is re-pulled from the server
      // rather than guessed, since another device may have moved it meanwhile.
      set((s) => ({
        items: s.items.map((n) =>
          n.id === id ? { ...n, read_at: target?.read_at ?? null } : n
        ),
      }));
      get().fetchCount();
    }
  },

  markAllRead: async () => {
    const readAt = new Date().toISOString();
    set((s) => ({
      items: s.items.map((n) => (n.read_at ? n : { ...n, read_at: readAt })),
      unreadCount: 0,
    }));
    const res = await notificationsApi.markAllNotificationsRead();
    if (!res.success) {
      get().fetchCount();
    }
  },

  setUnreadOnly: (unreadOnly) => {
    if (get().unreadOnly === unreadOnly) return;
    set({ unreadOnly, items: EMPTY_ITEMS, hasMore: false });
    get().fetchInitial();
  },

  // ─── WS Event Handlers ───

  handleCreate: (n) => {
    set((s) => {
      if (s.items.some((existing) => existing.id === n.id)) return s;
      // Under the unread-only filter an already-read create is not listed,
      // but it still cannot bump the unread count.
      const listed = !s.unreadOnly || !n.read_at;
      return {
        items: listed ? [n, ...s.items] : s.items,
        unreadCount: n.read_at ? s.unreadCount : s.unreadCount + 1,
      };
    });
  },

  handleReadSync: (data) => {
    const readAt = new Date().toISOString();
    const ids = new Set(data.ids);
    set((s) => ({
      items: s.items.map((n) => {
        if (n.read_at) return n;
        if (data.all || ids.has(n.id)) return { ...n, read_at: readAt };
        return n;
      }),
      unreadCount: Math.max(0, data.unread_count),
    }));
  },
}));
