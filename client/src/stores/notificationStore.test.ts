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
import { clearTokens, getAuthGeneration, setTokens } from "../api/client";
import { useAuthStore } from "./authStore";
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
    badgeUnreadCount: 0,
    hasMore: false,
    isLoading: false,
    hasLoaded: false,
    fetchError: false,
    unreadOnly: false,
    ownerId: "me",
    authGeneration: getAuthGeneration(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearTokens();
  useAuthStore.setState({ user: null as never });
  setTokens("test-access", "", "me");
  useAuthStore.setState({ user: { id: "me" } as never });
  resetStore();
});

describe("handleCreate", () => {
  it("clears immediately on same-owner credential replacement before any auth-store edit", () => {
    useNotificationStore.getState().handleCreate(makeNotification());
    expect(useNotificationStore.getState().items).toHaveLength(1);
    setTokens("replacement-access", "", "me");
    expect(useAuthStore.getState().user?.id).toBe("me");
    expect(useNotificationStore.getState().items).toEqual([]);
    expect(useNotificationStore.getState().hasLoaded).toBe(false);
    expect(useNotificationStore.getState().authGeneration).toBe(getAuthGeneration());
  });
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("account and request fencing", () => {
  it("reports only the latest initial fetch outcome for this account", async () => {
    await useNotificationStore.getState().fetchInitial();
    expect(useNotificationStore.getState().hasLoaded).toBe(true);
    expect(useNotificationStore.getState().fetchError).toBe(false);

    vi.mocked(api.listNotifications).mockResolvedValueOnce({ success: false, error: "offline" });
    await useNotificationStore.getState().fetchInitial();
    expect(useNotificationStore.getState().hasLoaded).toBe(false);
    expect(useNotificationStore.getState().fetchError).toBe(true);
  });

  it("filters list and page payloads to the bound owner", async () => {
    vi.mocked(api.listNotifications).mockResolvedValueOnce({
      success: true,
      data: { notifications: [makeNotification({ id: "owned", user_id: "me" }), makeNotification({ id: "foreign", user_id: "other" })], has_more: true },
    });
    await useNotificationStore.getState().fetchInitial();
    expect(useNotificationStore.getState().items.map((item) => item.id)).toEqual(["owned"]);

    vi.mocked(api.listNotifications).mockResolvedValueOnce({
      success: true,
      data: { notifications: [makeNotification({ id: "foreign-page", user_id: "other" })], has_more: false },
    });
    await useNotificationStore.getState().fetchMore();
    expect(useNotificationStore.getState().items.map((item) => item.id)).toEqual(["owned"]);
  });

  it("ignores initial-list replies after account or same-account auth generation changes", async () => {
    const pending = deferred<Awaited<ReturnType<typeof api.listNotifications>>>();
    vi.mocked(api.listNotifications).mockReturnValueOnce(pending.promise);
    const request = useNotificationStore.getState().fetchInitial();
    useAuthStore.setState({ user: { id: "other" } as never });
    pending.resolve({ success: true, data: { notifications: [makeNotification({ user_id: "other", id: "wrong-account" })], has_more: true } });
    await request;
    expect(useNotificationStore.getState().items).toEqual([]);
    expect(useNotificationStore.getState().ownerId).toBe("other");

    const sameAccount = deferred<Awaited<ReturnType<typeof api.listNotifications>>>();
    vi.mocked(api.listNotifications).mockReturnValueOnce(sameAccount.promise);
    const second = useNotificationStore.getState().fetchInitial();
    setTokens("reauth-access", "", "other");
    useAuthStore.setState({ user: { id: "other" } as never });
    sameAccount.resolve({ success: true, data: { notifications: [makeNotification({ user_id: "other", id: "stale-generation" })], has_more: false } });
    await second;
    expect(useNotificationStore.getState().items).toEqual([]);
    expect(useNotificationStore.getState().authGeneration).toBe(getAuthGeneration());
  });

  it("merges websocket arrivals instead of letting an in-flight initial fetch erase them", async () => {
    const pending = deferred<Awaited<ReturnType<typeof api.listNotifications>>>();
    vi.mocked(api.listNotifications).mockReturnValueOnce(pending.promise);
    const request = useNotificationStore.getState().fetchInitial();
    useNotificationStore.getState().handleCreate(makeNotification({ id: "arrived", user_id: "me" }));
    pending.resolve({ success: true, data: { notifications: [makeNotification({ id: "from-server", user_id: "me" })], has_more: false } });
    await request;
    expect(useNotificationStore.getState().items.map((item) => item.id)).toEqual(["arrived", "from-server"]);
  });

  it("does not let unchanged cached read state override the server's refreshed row", async () => {
    useNotificationStore.setState({ items: [makeNotification({ id: "same" })] });
    vi.mocked(api.listNotifications).mockResolvedValueOnce({
      success: true,
      data: { notifications: [makeNotification({ id: "same", read_at: "server-read" })], has_more: false },
    });

    await useNotificationStore.getState().fetchInitial();

    expect(useNotificationStore.getState().items).toHaveLength(1);
    expect(useNotificationStore.getState().items[0].read_at).toBe("server-read");
  });

  it("preserves a read arriving during the request but drops old rows omitted by the refreshed list", async () => {
    useNotificationStore.setState({ items: [makeNotification({ id: "same" }), makeNotification({ id: "stale-cache" })] });
    const pending = deferred<Awaited<ReturnType<typeof api.listNotifications>>>();
    vi.mocked(api.listNotifications).mockReturnValueOnce(pending.promise);
    const request = useNotificationStore.getState().fetchInitial();
    useNotificationStore.getState().handleReadSync({ ids: ["same"], all: false, unread_count: 1 });
    pending.resolve({
      success: true,
      data: { notifications: [makeNotification({ id: "same" })], has_more: false },
    });

    await request;

    expect(useNotificationStore.getState().items.map((item) => item.id)).toEqual(["same"]);
    expect(useNotificationStore.getState().items[0].read_at).not.toBeNull();
  });

  it("ignores an old page reply after the unread filter starts a newer list intent", async () => {
    useNotificationStore.setState({ items: [makeNotification({ id: "cursor" })], hasMore: true });
    const page = deferred<Awaited<ReturnType<typeof api.listNotifications>>>();
    vi.mocked(api.listNotifications).mockReturnValueOnce(page.promise).mockResolvedValueOnce({
      success: true,
      data: { notifications: [makeNotification({ id: "unread-result" })], has_more: false },
    });
    const oldPage = useNotificationStore.getState().fetchMore();
    useNotificationStore.getState().setUnreadOnly(true);
    await Promise.resolve();
    page.resolve({ success: true, data: { notifications: [makeNotification({ id: "stale-page" })], has_more: true } });
    await oldPage;
    await vi.waitFor(() => expect(useNotificationStore.getState().items.map((item) => item.id)).toEqual(["unread-result"]));
  });

  it("does not apply stale counts after a newer unread event", async () => {
    const count = deferred<Awaited<ReturnType<typeof api.getNotificationCount>>>();
    vi.mocked(api.getNotificationCount).mockReturnValueOnce(count.promise);
    const request = useNotificationStore.getState().fetchCount();
    useNotificationStore.getState().handleCreate(makeNotification({ id: "new-unread", user_id: "me" }));
    count.resolve({ success: true, data: { unread_count: 0 } });
    await request;
    expect(useNotificationStore.getState().unreadCount).toBe(1);
  });

  it("does not roll back a newer websocket read when the optimistic request fails", async () => {
    useNotificationStore.setState({ items: [makeNotification({ id: "a" })], unreadCount: 1 });
    const pending = deferred<Awaited<ReturnType<typeof api.markNotificationRead>>>();
    vi.mocked(api.markNotificationRead).mockReturnValueOnce(pending.promise);
    const request = useNotificationStore.getState().markRead("a");
    useNotificationStore.getState().handleReadSync({ ids: ["a"], all: false, unread_count: 0 });
    pending.resolve({ success: false, error: "offline" });
    await request;
    expect(useNotificationStore.getState().items[0]?.read_at).not.toBeNull();
  });

  it("ignores failed read responses after an account switch", async () => {
    useNotificationStore.setState({ items: [makeNotification({ id: "a" })], unreadCount: 1 });
    const pending = deferred<Awaited<ReturnType<typeof api.markNotificationRead>>>();
    vi.mocked(api.markNotificationRead).mockReturnValueOnce(pending.promise);
    const request = useNotificationStore.getState().markRead("a");
    useAuthStore.setState({ user: { id: "other" } as never });
    useNotificationStore.getState().handleCreate(makeNotification({ id: "other-account-item", user_id: "other" }));
    pending.resolve({ success: false, error: "late failure" });
    await request;
    expect(useNotificationStore.getState().items.map((item) => item.id)).toEqual(["other-account-item"]);
    expect(useNotificationStore.getState().unreadCount).toBe(1);
  });

  it("binds websocket creates to the current owner and clears feed on auth change", () => {
    useNotificationStore.getState().handleCreate(makeNotification({ id: "foreign", user_id: "other" }));
    expect(useNotificationStore.getState().items).toEqual([]);
    useNotificationStore.getState().handleCreate(makeNotification({ id: "owned", user_id: "me" }));
    expect(useNotificationStore.getState().items.map((item) => item.id)).toEqual(["owned"]);
    useAuthStore.setState({ user: { id: "other" } as never });
    expect(useNotificationStore.getState().items).toEqual([]);
    expect(useNotificationStore.getState().ownerId).toBe("other");
  });
});

describe("authoritative message notification badge and read ordering", () => {
  const dm = (id = "dm-message-one") => makeNotification({ id, kind: "system", server_id: null,
    channel_id: null, dm_channel_id: "dm", payload: { action: "incoming_message", source: "dm" } });

  it("uses the server badge aggregate with a partial paginated inbox", async () => {
    useNotificationStore.setState({ items: [dm()], hasMore: true });
    vi.mocked(api.getNotificationCount).mockResolvedValueOnce({ success: true,
      data: { unread_count: 115, badge_unread_count: 55 } });
    await useNotificationStore.getState().fetchCount();
    expect(useNotificationStore.getState()).toMatchObject({ unreadCount: 115, badgeUnreadCount: 55, hasMore: true });
    expect(useNotificationStore.getState().items).toHaveLength(1);
  });

  it("counts a new DM in the inbox once but leaves its app badge to the DM counter", () => {
    const store = useNotificationStore.getState();
    store.handleCreate(dm()); store.handleCreate(dm());
    expect(useNotificationStore.getState()).toMatchObject({ unreadCount: 1, badgeUnreadCount: 0 });
    store.handleCreate(makeNotification({ id: "ordinary" }));
    expect(useNotificationStore.getState()).toMatchObject({ unreadCount: 2, badgeUnreadCount: 1 });
  });

  it("does not resurrect a read source whose create arrives after its read event", () => {
    const store = useNotificationStore.getState();
    store.handleReadSync({ ids: ["dm-message-late"], all: false, unread_count: 0, badge_unread_count: 0 });
    store.handleCreate(dm("dm-message-late"));
    expect(useNotificationStore.getState().items[0].read_at).toBeTruthy();
    expect(useNotificationStore.getState()).toMatchObject({ unreadCount: 0, badgeUnreadCount: 0 });
    store.handleCreate(dm("dm-message-new"));
    expect(useNotificationStore.getState()).toMatchObject({ unreadCount: 1, badgeUnreadCount: 0 });
  });

  it("keeps badge count when marking a DM and decrements an ordinary notification", async () => {
    useNotificationStore.setState({ items: [dm(), makeNotification({ id: "ordinary" })], unreadCount: 2, badgeUnreadCount: 1 });
    await useNotificationStore.getState().markRead("dm-message-one");
    expect(useNotificationStore.getState()).toMatchObject({ unreadCount: 1, badgeUnreadCount: 1 });
    await useNotificationStore.getState().markRead("ordinary");
    expect(useNotificationStore.getState()).toMatchObject({ unreadCount: 0, badgeUnreadCount: 0 });
  });

  it("refreshes authoritative data instead of growing unbounded read tombstones", async () => {
    const authoritative = makeNotification({ id: "server-confirmed" });
    vi.mocked(api.listNotifications).mockResolvedValueOnce({ success: true,
      data: { notifications: [authoritative], has_more: false } });
    vi.mocked(api.getNotificationCount).mockResolvedValueOnce({ success: true,
      data: { unread_count: 1, badge_unread_count: 1 } });
    const store = useNotificationStore.getState();
    store.handleReadSync({ ids: Array.from({ length: 2100 }, (_, i) => `read-${i}`), all: false, unread_count: 0, badge_unread_count: 0 });
    store.handleCreate(dm("read-2099")); store.handleCreate(dm("another-stale-create"));
    await vi.waitFor(() => expect(useNotificationStore.getState().items.map(item => item.id)).toEqual(["server-confirmed"]));
    expect(api.listNotifications).toHaveBeenCalledOnce(); expect(api.getNotificationCount).toHaveBeenCalledOnce();
    expect(useNotificationStore.getState()).toMatchObject({ unreadCount: 1, badgeUnreadCount: 1 });
  });

  it("clears badge and read tombstones on account transition", () => {
    useNotificationStore.getState().handleReadSync({ ids: ["reuse"], all: false, unread_count: 5, badge_unread_count: 3 });
    useAuthStore.setState({ user: { id: "other" } as never });
    expect(useNotificationStore.getState()).toMatchObject({ unreadCount: 0, badgeUnreadCount: 0 });
    useNotificationStore.getState().handleCreate(makeNotification({ id: "reuse", user_id: "other" }));
    expect(useNotificationStore.getState().items[0].read_at).toBeNull();
    expect(useNotificationStore.getState()).toMatchObject({ unreadCount: 1, badgeUnreadCount: 1 });
  });

  it("honors a bounded server read acknowledgement by reloading authoritative rows", async () => {
    vi.mocked(api.listNotifications).mockResolvedValueOnce({ success: true,
      data: { notifications: [dm("unread-new-source")], has_more: true } });
    vi.mocked(api.getNotificationCount).mockResolvedValueOnce({ success: true,
      data: { unread_count: 1, badge_unread_count: 0 } });
    useNotificationStore.getState().handleReadSync({ ids: ["first-bounded-id"], all: false,
      unread_count: 1, badge_unread_count: 0, refresh_required: true });
    await vi.waitFor(() => expect(useNotificationStore.getState().items.map(item => item.id)).toEqual(["unread-new-source"]));
    expect(useNotificationStore.getState()).toMatchObject({ unreadCount: 1, badgeUnreadCount: 0, hasMore: true });
  });
});

it("leaves canonical group badge ownership to group unread while retaining inbox count and dedup",()=>{
 const group=makeNotification({id:"group-source",kind:"system",server_id:null,channel_id:null,dm_channel_id:null,group_dm_channel_id:"group",payload:{action:"incoming_message",source:"group"}});
 useNotificationStore.getState().handleCreate(group);useNotificationStore.getState().handleCreate(group);
 expect(useNotificationStore.getState()).toMatchObject({unreadCount:1,badgeUnreadCount:0});
});
