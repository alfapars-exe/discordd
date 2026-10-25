/**
 * Notification Store — account-scoped persisted activity feed.
 *
 * Every async result and websocket mutation is fenced by the authenticated
 * owner plus API auth generation. This keeps stale requests and events from
 * contaminating the next account or same-account reauthentication.
 */

import { create } from "zustand";
import { getAuthGeneration } from "../api/client";
import * as notificationsApi from "../api/notifications";
import type { AppNotification } from "../types";
import { isPrivateMessageNotification } from "../utils/dmMessageNotification";
import { useAuthStore } from "./authStore";
import { getAuthSessionOwner, subscribeAuthOwnerChanges, subscribeAuthGenerationChanges } from "../api/authSessionEvents";

const EMPTY_ITEMS: AppNotification[] = [];
const PAGE_SIZE = 20;

type Session = { ownerId: string; authGeneration: number };

type NotificationState = {
  items: AppNotification[];
  unreadCount: number;
  badgeUnreadCount: number;
  hasMore: boolean;
  isLoading: boolean;
  /** Latest account-scoped initial list request completed successfully. */
  hasLoaded: boolean;
  /** Latest account-scoped initial list request failed or returned no data. */
  fetchError: boolean;
  /** Filter for list fetches; flipping it refetches from the top. */
  unreadOnly: boolean;
  /** Account and login-session that own this feed snapshot. */
  ownerId: string | null;
  authGeneration: number;

  // ─── Actions ───
  fetchInitial: () => Promise<void>;
  fetchMore: () => Promise<void>;
  fetchCount: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  setUnreadOnly: (unreadOnly: boolean) => void;

  // ─── WS Event Handlers ───
  handleCreate: (n: AppNotification) => void;
  handleReadSync: (data: { ids: string[]; all: boolean; unread_count: number; badge_unread_count?: number; refresh_required?: boolean }) => void;
};

let listIntent = 0;
let countIntent = 0;
let unreadRevision = 0;
let readRevision = 0;
const pendingReadRevisions = new Map<string, number>();
const readIds = new Set<string>();
const MAX_READ_IDS = 2048;
let readHistoryIncomplete = false;
let refreshQueued: { session: Session; again: boolean; started: boolean } | null = null;

// Exact read IDs fence delayed creates even when the acknowledged row was on
// an unloaded page. Overflow switches to authoritative refresh, never guesses
// from the loaded page or permits an unbounded account-owned tombstone set.
function rememberReadIds(ids: string[]): void {
  for (const id of ids) {
    if (readIds.size >= MAX_READ_IDS && !readIds.has(id)) { readHistoryIncomplete = true; continue; }
    readIds.add(id);
  }
}
function queueAuthoritativeRefresh(): void {
  const session = currentSession();
  if (!session) return;
  if (refreshQueued?.session.ownerId === session.ownerId && refreshQueued.session.authGeneration === session.authGeneration) {
    if (refreshQueued.started) refreshQueued.again = true;
    return;
  }
  const entry = { session, again: false, started: false };
  refreshQueued = entry;
  queueMicrotask(() => {
    if (!isSessionCurrent(session)) { if (refreshQueued === entry) refreshQueued = null; return; }
    entry.started = true;
    void Promise.allSettled([useNotificationStore.getState().fetchInitial(), useNotificationStore.getState().fetchCount()])
      .finally(() => {
        if (refreshQueued !== entry) return;
        refreshQueued = null;
        if (entry.again && isSessionCurrent(session)) queueAuthoritativeRefresh();
      });
  });
}

function currentSession(): Session | null {
  const ownerId = useAuthStore.getState().user?.id;
  const authGeneration = getAuthGeneration();
  return ownerId ? { ownerId, authGeneration } : null;
}

function isSessionCurrent(session: Session): boolean {
  const auth = useAuthStore.getState();
  const store = useNotificationStore.getState();
  return auth.user?.id === session.ownerId && getAuthGeneration() === session.authGeneration
    && store.ownerId === session.ownerId && store.authGeneration === session.authGeneration;
}

function clearForOwner(ownerId: string | null, authGeneration: number): void {
  listIntent += 1;
  countIntent += 1;
  unreadRevision += 1;
  readRevision += 1;
  pendingReadRevisions.clear();
  readIds.clear(); readHistoryIncomplete = false;
  useNotificationStore.setState((state) => ({
    items: EMPTY_ITEMS,
    unreadCount: 0,
    badgeUnreadCount: 0,
    hasMore: false,
    isLoading: false,
    hasLoaded: false,
    fetchError: false,
    ownerId,
    authGeneration,
    // The display filter is a UI choice, not notification data.
    unreadOnly: state.unreadOnly,
  }));
}

export const useNotificationStore = create<NotificationState>((set, get) => {
  function adoptCurrentOwner(): Session | null {
    const session = currentSession();
    const state = get();
    if (state.ownerId !== (session?.ownerId ?? null) || state.authGeneration !== getAuthGeneration()) {
      listIntent += 1;
      countIntent += 1;
      unreadRevision += 1;
      readRevision += 1;
      pendingReadRevisions.clear();
      readIds.clear(); readHistoryIncomplete = false;
      set({
        items: EMPTY_ITEMS,
        unreadCount: 0,
        badgeUnreadCount: 0,
        hasMore: false,
        isLoading: false,
        hasLoaded: false,
        fetchError: false,
        ownerId: session?.ownerId ?? null,
        authGeneration: getAuthGeneration(),
      });
    }
    return session;
  }

  function currentOwnedSession(): Session | null {
    const session = currentSession();
    if (!session) return null;
    const state = get();
    return state.ownerId === session.ownerId && state.authGeneration === session.authGeneration ? session : null;
  }

  return {
    items: EMPTY_ITEMS,
    unreadCount: 0,
    badgeUnreadCount: 0,
    hasMore: false,
    isLoading: false,
    hasLoaded: false,
    fetchError: false,
    unreadOnly: false,
    ownerId: null,
    authGeneration: -1,

    fetchInitial: async () => {
      const session = adoptCurrentOwner();
      if (!session) return;
      const state = get();
      const unreadOnly = state.unreadOnly;
      const itemsByIdAtRequestStart = new Map(state.items.map((item) => [item.id, item]));
      const request = ++listIntent;
      set({ isLoading: true });
      set({ hasLoaded: false, fetchError: false });
      try {
        const res = await notificationsApi.listNotifications({ unreadOnly, limit: PAGE_SIZE });
        if (!isSessionCurrent(session) || request !== listIntent || get().unreadOnly !== unreadOnly) return;
        if (res.success && res.data) {
          const currentItems = get().items;
          const remote = Array.isArray(res.data.notifications)
            ? res.data.notifications.filter((item) => item.user_id === session.ownerId)
            : EMPTY_ITEMS;
          const remoteIds = new Set(remote.map((item) => item.id));
          const currentById = new Map(currentItems.map((item) => [item.id, item]));
          const refreshed = remote
            .filter((item) => !unreadOnly || !item.read_at)
            .map((item) => {
              const current = currentById.get(item.id);
              // Only a post-start local mutation wins over the authoritative
              // server row (unchanged cached read state may be stale).
              return current && current !== itemsByIdAtRequestStart.get(item.id)
                ? { ...item, read_at: current.read_at } : item;
            });
          // Retain only genuinely new WS arrivals from after the request began.
          // Old cached rows omitted by the authoritative list must disappear.
          const arrivedDuringRequest = currentItems.filter((item) =>
            !itemsByIdAtRequestStart.has(item.id) && !remoteIds.has(item.id) && (!unreadOnly || !item.read_at));
          set({
            items: [...arrivedDuringRequest, ...refreshed],
            hasMore: res.data.has_more,
            hasLoaded: true,
            fetchError: false,
          });
        } else {
          set({ fetchError: true });
        }
      } catch {
        if (isSessionCurrent(session) && request === listIntent && get().unreadOnly === unreadOnly) set({ fetchError: true });
      } finally {
        if (isSessionCurrent(session) && request === listIntent) set({ isLoading: false });
      }
    },

    fetchMore: async () => {
      const session = adoptCurrentOwner();
      if (!session) return;
      const { items, hasMore, isLoading, unreadOnly } = get();
      if (!hasMore || isLoading || items.length === 0) return;
      const before = items[items.length - 1].id;
      const request = ++listIntent;
      set({ isLoading: true });
      try {
        const res = await notificationsApi.listNotifications({ before, unreadOnly, limit: PAGE_SIZE });
        if (!isSessionCurrent(session) || request !== listIntent || get().unreadOnly !== unreadOnly) return;
        if (res.success && res.data) {
          set((state) => {
            const seen = new Set(state.items.map((item) => item.id));
            const fresh = (Array.isArray(res.data!.notifications) ? res.data!.notifications : EMPTY_ITEMS)
              .filter((item) => item.user_id === session.ownerId && !seen.has(item.id) && (!unreadOnly || !item.read_at));
            return { items: [...state.items, ...fresh], hasMore: res.data!.has_more };
          });
        }
      } catch {
        // Keep the last confirmed page on network failure.
      } finally {
        if (isSessionCurrent(session) && request === listIntent) set({ isLoading: false });
      }
    },

    fetchCount: async () => {
      const session = adoptCurrentOwner();
      if (!session) return;
      const request = ++countIntent;
      const revision = unreadRevision;
      try {
        const res = await notificationsApi.getNotificationCount();
        if (isSessionCurrent(session) && request === countIntent && revision === unreadRevision && res.success && res.data) {
          const total = Math.max(0, res.data.unread_count);
          set({ unreadCount: total, badgeUnreadCount: Number.isFinite(res.data.badge_unread_count)
            ? Math.max(0, Math.min(total, res.data.badge_unread_count!)) : total });
        }
      } catch {
        // Keep the last confirmed count on network failure.
      }
    },

    markRead: async (id) => {
      const session = adoptCurrentOwner();
      if (!session) return;
      const target = get().items.find((item) => item.id === id);
      if (target?.read_at) return;

      const readAt = new Date().toISOString();
      const revision = ++readRevision;
      pendingReadRevisions.set(id, revision);
      unreadRevision += 1;
      set((state) => ({
        items: state.items.map((item) => (item.id === id ? { ...item, read_at: readAt } : item)),
        unreadCount: Math.max(0, state.unreadCount - 1),
        badgeUnreadCount: target && !isPrivateMessageNotification(target) ? Math.max(0, state.badgeUnreadCount - 1) : state.badgeUnreadCount,
      }));

      let succeeded: boolean;
      try {
        const res = await notificationsApi.markNotificationRead(id);
        succeeded = res.success;
      } catch {
        succeeded = false;
      }
      if (!isSessionCurrent(session)) return;
      const stillLatest = pendingReadRevisions.get(id) === revision;
      if (pendingReadRevisions.has(id)) pendingReadRevisions.delete(id);
      if (!succeeded) {
        if (stillLatest && get().items.some((item) => item.id === id && item.read_at === readAt)) {
          // Only this still-current optimistic value may be rolled back. A
          // newer WS read or read mutation has a different revision/value.
          set((state) => ({ items: state.items.map((item) =>
            item.id === id && item.read_at === readAt ? { ...item, read_at: target?.read_at ?? null } : item) }));
        }
        void get().fetchCount();
      } else {
        rememberReadIds([id]);
        if (!target) void get().fetchCount();
      }
    },

    markAllRead: async () => {
      const session = adoptCurrentOwner();
      if (!session) return;
      unreadRevision += 1;
      const readAt = new Date().toISOString();
      pendingReadRevisions.clear();
      set((state) => ({
        items: state.items.map((item) => (item.read_at ? item : { ...item, read_at: readAt })),
        unreadCount: 0,
        badgeUnreadCount: 0,
      }));
      try {
        const res = await notificationsApi.markAllNotificationsRead();
        if (!isSessionCurrent(session)) return;
        if (!res.success) void get().fetchCount();
      } catch {
        if (isSessionCurrent(session)) void get().fetchCount();
      }
    },

    setUnreadOnly: (unreadOnly) => {
      if (get().unreadOnly === unreadOnly) return;
      listIntent += 1;
      set({ unreadOnly, items: EMPTY_ITEMS, hasMore: false, isLoading: false, hasLoaded: false, fetchError: false });
      void get().fetchInitial();
    },

    handleCreate: (notification) => {
      const session = currentOwnedSession();
      if (!session || notification.user_id !== session.ownerId) return;
      if (readHistoryIncomplete && !get().items.some(item => item.id === notification.id)) {
        queueAuthoritativeRefresh(); return;
      }
      if (readIds.has(notification.id)) notification = { ...notification, read_at: notification.read_at ?? new Date().toISOString() };
      set((state) => {
        if (state.ownerId !== session.ownerId || state.authGeneration !== session.authGeneration
          || state.items.some((existing) => existing.id === notification.id)) return state;
        const listed = !state.unreadOnly || !notification.read_at;
        if (!notification.read_at) unreadRevision += 1;
        return {
          items: listed ? [notification, ...state.items] : state.items,
          unreadCount: notification.read_at ? state.unreadCount : state.unreadCount + 1,
          badgeUnreadCount: notification.read_at || isPrivateMessageNotification(notification) ? state.badgeUnreadCount : state.badgeUnreadCount + 1,
        };
      });
    },

    handleReadSync: (data) => {
      const session = currentOwnedSession();
      if (!session || !data || !Array.isArray(data.ids) || typeof data.all !== "boolean"
        || !Number.isFinite(data.unread_count)) return;
      const ids = new Set(data.ids);
      rememberReadIds(data.ids);
      if (data.refresh_required === true) readHistoryIncomplete = true;
      for (const id of pendingReadRevisions.keys()) {
        if (data.all || ids.has(id)) pendingReadRevisions.delete(id);
      }
      unreadRevision += 1;
      set((state) => {
        if (state.ownerId !== session.ownerId || state.authGeneration !== session.authGeneration) return state;
        const readAt = new Date().toISOString();
        return {
          items: state.items.map((item) => {
            if (item.read_at) return item;
            if (data.all || ids.has(item.id)) return { ...item, read_at: readAt };
            return item;
          }),
          unreadCount: Math.max(0, data.unread_count),
          badgeUnreadCount: data.all ? 0 : Number.isFinite(data.badge_unread_count)
            ? Math.max(0, Math.min(data.unread_count, data.badge_unread_count!)) : Math.max(0, data.unread_count),
        };
      });
      if (data.refresh_required === true) queueAuthoritativeRefresh();
    },
  };
});

// Auth changes synchronously clear account-owned feed data. Generation also
// changes for same-account reauthentication, so stale same-user requests die.
function synchronizeAuthOwner(ownerId: string | null, authGeneration: number): void {
  const state = useNotificationStore.getState();
  if (state.ownerId === ownerId && state.authGeneration === authGeneration) return;
  clearForOwner(ownerId, authGeneration);
}

synchronizeAuthOwner(getAuthSessionOwner(), getAuthGeneration());
subscribeAuthOwnerChanges((owner) => synchronizeAuthOwner(owner, getAuthGeneration()));
subscribeAuthGenerationChanges((generation) => clearForOwner(null, generation));
