import { beforeEach, expect, it, vi } from "vitest";
import { navigateUnreadChannel } from "./unreadShortcutNavigation";
const state = vi.hoisted(() => ({
  owner: { id: "a" },
  destination: { type: "text", channelId: "read", serverInfo: { serverId: "s1" } },
  servers: [{ id: "s1", name: "One", icon_url: null }, { id: "s2", name: "Two", icon_url: null }],
  mutedServers: new Set<string>(), mutedChannels: new Set<string>(),
  navigate: vi.fn(), toast: vi.fn(), counts: vi.fn(), tree: vi.fn(),
}));
vi.mock("../api/readState", () => ({ getUnreadCounts: state.counts }));
vi.mock("../api/channels", () => ({ getChannels: state.tree }));
vi.mock("../stores/authStore", () => ({ useAuthStore: { getState: () => ({ user: state.owner }) } }));
vi.mock("../stores/uiStore", () => ({ useUIStore: { getState: () => ({ destination: state.destination, navigate: state.navigate }) } }));
vi.mock("../stores/serverStore", () => ({ useServerStore: { getState: () => ({ servers: state.servers, mutedServerIds: state.mutedServers }) } }));
vi.mock("../stores/channelStore", () => ({ useChannelStore: { getState: () => ({ mutedChannelIds: state.mutedChannels }) } }));
vi.mock("../stores/toastStore", () => ({ useToastStore: { getState: () => ({ addToast: state.toast }) } }));
vi.mock("../i18n", () => ({ default: { t: (key: string) => key } }));
beforeEach(() => {
  vi.clearAllMocks(); document.body.innerHTML = "";
  state.owner = { id: "a" };
  state.destination = { type: "text", channelId: "read", serverInfo: { serverId: "s1" } };
  state.mutedServers.clear(); state.mutedChannels.clear();
  state.counts.mockImplementation(async (id: string) => ({ success: true, data: [{ channel_id: id === "s1" ? "first" : "remote", unread_count: 2 }] }));
  state.tree.mockImplementation(async (id: string) => ({ success: true, data: [{ channels: id === "s1" ? [
    { id: "first", name: "First", type: "text" }, { id: "read", name: "Read", type: "text" },
  ] : [{ id: "remote", name: "Remote", type: "text" }] }] }));
});
it("loads unopened servers and anchors after the active read channel", async () => {
  await navigateUnreadChannel(1);
  expect(state.tree).toHaveBeenCalledWith("s2", expect.objectContaining({ timeoutMs: 15000 }));
  expect(state.navigate).toHaveBeenCalledWith(expect.objectContaining({ channelId: "remote" }));
});
it("traverses backwards in server/channel order", async () => {
  await navigateUnreadChannel(-1);
  expect(state.navigate).toHaveBeenCalledWith(expect.objectContaining({ channelId: "first" }));
});
it("excludes muted servers and channels", async () => {
  state.mutedServers.add("s2"); state.mutedChannels.add("first");
  await navigateUnreadChannel(1);
  expect(state.counts.mock.calls.some(([id]) => id === "s2")).toBe(false);
  expect(state.navigate).not.toHaveBeenCalled();
  expect(state.toast).toHaveBeenCalledWith("info", "common:shortcutNoUnreadChannels");
});
it("does not use partial results on a failed snapshot", async () => {
  state.counts.mockImplementation(async (id: string) => id === "s2" ? { success: false } : { success: true, data: [{ channel_id: "first", unread_count: 1 }] });
  await navigateUnreadChannel(1);
  expect(state.navigate).not.toHaveBeenCalled();
  expect(state.toast).toHaveBeenCalledWith("error", "common:shortcutUnreadFailed");
});
it.each(["account", "destination"])("discards stale responses after %s changes", async (change) => {
  state.counts.mockImplementation(async () => {
    if (change === "account") state.owner = { id: "b" };
    else state.destination = { ...state.destination, channelId: "elsewhere" };
    return { success: true, data: [] };
  });
  await navigateUnreadChannel(1);
  expect(state.navigate).not.toHaveBeenCalled(); expect(state.toast).not.toHaveBeenCalled();
});
it("does not navigate while a modal owns focus", async () => {
  const dialog = document.createElement("dialog"); dialog.open = true;
  document.body.append(dialog);
  await navigateUnreadChannel(1);
  expect(state.counts).not.toHaveBeenCalled();
});
it("does not navigate into archived, voice or thread channels", async () => {
  state.tree.mockResolvedValue({ success: true, data: [{ channels: [
    { id: "first", type: "text", archived_at: "now" }, { id: "remote", type: "voice" }, { id: "first", type: "thread" },
  ] }] });
  await navigateUnreadChannel(1);
  expect(state.navigate).not.toHaveBeenCalled();
});
it("a newer key press aborts and supersedes the previous lookup", async () => {
  const signals: AbortSignal[] = [];
  const release: (() => void)[] = [];
  state.counts.mockImplementation((_id: string, options: { signal: AbortSignal }) => {
    signals.push(options.signal);
    return new Promise((resolve) => release.push(() => resolve({ success: true, data: [] })));
  });
  const first = navigateUnreadChannel(1);
  const second = navigateUnreadChannel(-1);
  expect(signals[0].aborted).toBe(true);
  release.forEach((resolve) => resolve());
  await Promise.all([first, second]);
  expect(state.navigate).not.toHaveBeenCalled();
  expect(state.toast).toHaveBeenCalledTimes(1);
});
it("uses authoritative mention counts, not ordinary unread counts or inbox pages", async () => {
  state.counts.mockImplementation(async (id: string) => ({ success: true, data: [{ channel_id: id === "s1" ? "first" : "remote", unread_count: 70, mention_count: id === "s1" ? 1 : 0 }] }));
  await navigateUnreadChannel(1, true);
  expect(state.navigate).toHaveBeenCalledWith(expect.objectContaining({ channelId: "first" }));
});
it("reports incompatible server data rather than claiming no mentions", async () => {
  await navigateUnreadChannel(1, true);
  expect(state.navigate).not.toHaveBeenCalled();
  expect(state.toast).toHaveBeenCalledWith("error", "common:shortcutUnreadFailed");
});
it("reports the distinct empty mention state", async () => {
  state.counts.mockResolvedValue({ success: true, data: [] });
  await navigateUnreadChannel(1, true);
  expect(state.toast).toHaveBeenCalledWith("info", "common:shortcutNoUnreadMentions");
});
