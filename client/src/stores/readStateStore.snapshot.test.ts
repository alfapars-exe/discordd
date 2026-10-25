import { beforeEach, expect, it, vi } from "vitest";
import { useReadStateStore } from "./readStateStore";

const api = vi.hoisted(() => ({ getUnreadCounts: vi.fn() }));
vi.mock("../api/readState", () => ({ getUnreadCounts: api.getUnreadCounts, markRead: vi.fn(), markAllRead: vi.fn() }));
vi.mock("./serverStore", () => ({ useServerStore: { getState: () => ({ servers: [], mutedServerIds: new Set<string>() }) } }));
vi.mock("./channelStore", () => ({ useChannelStore: { getState: () => ({ mutedChannelIds: new Set<string>() }) } }));

beforeEach(() => {
  vi.clearAllMocks();
  useReadStateStore.setState({
    unreadCounts: { c1: 2 },
    unreadRevisions: {},
    channelServerMap: { c1: "s1" },
    seenMentions: {},
  });
});

it("does not let a pending authoritative snapshot erase a newer websocket unread increment", async () => {
  let resolve!: (value: { success: boolean; data: [] }) => void;
  api.getUnreadCounts.mockReturnValue(new Promise((done) => { resolve = done; }));
  const pending = useReadStateStore.getState().fetchUnreadCounts("s1", { isCurrent: () => true });
  useReadStateStore.getState().incrementUnread("c1");
  resolve({ success: true, data: [] });
  await pending;
  expect(useReadStateStore.getState().unreadCounts.c1).toBe(3);
});

it("applies a fresh empty server snapshot when no newer local event occurred", async () => {
  api.getUnreadCounts.mockResolvedValue({ success: true, data: [] });
  await useReadStateStore.getState().fetchUnreadCounts("s1", { isCurrent: () => true });
  expect(useReadStateStore.getState().unreadCounts.c1).toBeUndefined();
});

it("ignores an account or destination-scoped snapshot after its guard expires", async () => {
  api.getUnreadCounts.mockResolvedValue({ success: true, data: [] });
  await useReadStateStore.getState().fetchUnreadCounts("s1", { isCurrent: () => false });
  expect(useReadStateStore.getState().unreadCounts.c1).toBe(2);
});

it("does not let an older concurrent HTTP snapshot overwrite the latest snapshot", async () => {
  const pending: Array<(value: { success: boolean; data: Array<{ channel_id: string; unread_count: number }> }) => void> = [];
  api.getUnreadCounts.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
  const older = useReadStateStore.getState().fetchUnreadCounts("s1");
  const newer = useReadStateStore.getState().fetchUnreadCounts("s1");
  pending[1]({ success: true, data: [{ channel_id: "c1", unread_count: 5 }] });
  await newer;
  pending[0]({ success: true, data: [{ channel_id: "c1", unread_count: 1 }] });
  await older;
  expect(useReadStateStore.getState().unreadCounts.c1).toBe(5);
});
