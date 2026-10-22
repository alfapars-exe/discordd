/**
 * notificationStore — WS create / dedupe / cross-device read sync, plus the
 * optimistic markRead path and its rollback.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the API module before importing the store so nothing hits the network.
vi.mock("../api/notifications", () => ({
  listNotifications: vi.fn(async () => ({
    success: true,
    data: { notifications: [], has_more: false },
  })),
  getNotificationCount: vi.fn(async () => ({ success: true, data: { unread_count: 0 } })),
  markNotificationRead: vi.fn(async () => ({ success: true, data: { message: "ok" } })),
  markAllNotificationsRead: vi.fn(async () => ({ success: true, data: { marked: 0 } })),
}));

import { useNotificationStore } from "./notificationStore";
import * as api from "../api/notifications";
import type { AppNotification } from "../types";

function makeNotification(overrides: Partial<AppNotification> = {}): AppNotification {
  return {
    id: "n-1",
    user_id: "me",
    kind: "mention",
    actor_id: "u-2",
    actor: null,
    server_id: "srv-1",
    channel_id: "ch-1",
    message_id: "m-1",
    dm_channel_id: null,
    payload: { preview: "hi", channel_name: "genel" },
    read_at: null,
    created_at: "2026-10-21T10:00:00Z",
    ...overrides,
  };
}

function resetStore() {
  useNotificationStore.setState({
    items: [],
    unreadCount: 0,
    hasMore: false,
    isLoading: false,
    unreadOnly: false,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
});

describe("handleCreate", () => {
  it("prepends the notification and bumps unreadCount", () => {
    useNotificationStore.setState({ items: [makeNotification({ id: "n-old" })], unreadCount: 1 });

    useNotificationStore.getState().handleCreate(makeNotification({ id: "n-new" }));

    const { items, unreadCount } = useNotificationStore.getState();
    expect(items.map((n) => n.id)).toEqual(["n-new", "n-old"]);
    expect(unreadCount).toBe(2);
  });

  it("dedupes by id — a replayed create neither duplicates nor double-counts", () => {
    const n = makeNotification({ id: "n-dup" });
    useNotificationStore.getState().handleCreate(n);
    useNotificationStore.getState().handleCreate({ ...n });

    const { items, unreadCount } = useNotificationStore.getState();
    expect(items).toHaveLength(1);
    expect(unreadCount).toBe(1);
  });

  it("does not bump unreadCount for a create that arrives already read", () => {
    useNotificationStore.getState().handleCreate(
      makeNotification({ id: "n-read", read_at: "2026-10-21T10:01:00Z" })
    );

    expect(useNotificationStore.getState().unreadCount).toBe(0);
    expect(useNotificationStore.getState().items).toHaveLength(1);
  });
});

describe("handleReadSync (another device marked read)", () => {
  it("flags the listed ids as read and adopts the server unread count", () => {
    useNotificationStore.setState({
      items: [makeNotification({ id: "a" }), makeNotification({ id: "b" })],
      unreadCount: 2,
    });

    useNotificationStore.getState().handleReadSync({ ids: ["a"], all: false, unread_count: 1 });

    const { items, unreadCount } = useNotificationStore.getState();
    expect(items.find((n) => n.id === "a")?.read_at).not.toBeNull();
    expect(items.find((n) => n.id === "b")?.read_at).toBeNull();
    expect(unreadCount).toBe(1);
  });

  it("all=true flags every unread item and zeroes the count", () => {
    useNotificationStore.setState({
      items: [makeNotification({ id: "a" }), makeNotification({ id: "b" })],
      unreadCount: 2,
    });

    useNotificationStore.getState().handleReadSync({ ids: [], all: true, unread_count: 0 });

    const { items, unreadCount } = useNotificationStore.getState();
    expect(items.every((n) => n.read_at !== null)).toBe(true);
    expect(unreadCount).toBe(0);
  });

  it("does not call the REST read endpoint (no echo loop)", () => {
    useNotificationStore.setState({ items: [makeNotification({ id: "a" })], unreadCount: 1 });

    useNotificationStore.getState().handleReadSync({ ids: ["a"], all: false, unread_count: 0 });

    expect(api.markNotificationRead).not.toHaveBeenCalled();
    expect(api.markAllNotificationsRead).not.toHaveBeenCalled();
  });
});

describe("markRead", () => {
  it("flips read_at optimistically, decrements the count and calls the API", async () => {
    useNotificationStore.setState({ items: [makeNotification({ id: "a" })], unreadCount: 1 });

    await useNotificationStore.getState().markRead("a");

    expect(api.markNotificationRead).toHaveBeenCalledWith("a");
    expect(useNotificationStore.getState().items[0].read_at).not.toBeNull();
    expect(useNotificationStore.getState().unreadCount).toBe(0);
  });

  it("skips the API call when the item is already read", async () => {
    useNotificationStore.setState({
      items: [makeNotification({ id: "a", read_at: "2026-10-21T10:01:00Z" })],
      unreadCount: 0,
    });

    await useNotificationStore.getState().markRead("a");

    expect(api.markNotificationRead).not.toHaveBeenCalled();
  });

  it("rolls back read_at and re-pulls the count when the API fails", async () => {
    vi.mocked(api.markNotificationRead).mockResolvedValueOnce({ success: false, error: "boom" });
    vi.mocked(api.getNotificationCount).mockResolvedValueOnce({
      success: true,
      data: { unread_count: 1 },
    });
    useNotificationStore.setState({ items: [makeNotification({ id: "a" })], unreadCount: 1 });

    await useNotificationStore.getState().markRead("a");
    // fetchCount() is fire-and-forget inside markRead — let it settle.
    await Promise.resolve();

    expect(useNotificationStore.getState().items[0].read_at).toBeNull();
    expect(api.getNotificationCount).toHaveBeenCalled();
    expect(useNotificationStore.getState().unreadCount).toBe(1);
  });
});

describe("fetchMore", () => {
  it("pages with before=<last id> and appends without duplicates", async () => {
    useNotificationStore.setState({
      items: [makeNotification({ id: "a" }), makeNotification({ id: "b" })],
      hasMore: true,
    });
    vi.mocked(api.listNotifications).mockResolvedValueOnce({
      success: true,
      data: {
        notifications: [makeNotification({ id: "b" }), makeNotification({ id: "c" })],
        has_more: false,
      },
    });

    await useNotificationStore.getState().fetchMore();

    expect(api.listNotifications).toHaveBeenCalledWith(
      expect.objectContaining({ before: "b" })
    );
    expect(useNotificationStore.getState().items.map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(useNotificationStore.getState().hasMore).toBe(false);
  });

  it("is a no-op when hasMore is false", async () => {
    useNotificationStore.setState({ items: [makeNotification({ id: "a" })], hasMore: false });

    await useNotificationStore.getState().fetchMore();

    expect(api.listNotifications).not.toHaveBeenCalled();
  });
});
