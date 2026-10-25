import { beforeEach, describe, expect, it, vi } from "vitest";
import type { APIResponse, Category, CategoryWithChannels, WSMessage } from "../types";
const shell = vi.hoisted(() => ({ enabled: true }));
vi.mock("../utils/uiShell", () => ({ get UI_SHELL_V2() { return shell.enabled; } }));
vi.mock("../api/channels", () => ({ getChannels: vi.fn(), reorderChannels: vi.fn(), reorderCategories: vi.fn() }));
import { getChannels, reorderChannels, reorderCategories } from "../api/channels";
import { useChannelStore } from "./channelStore";
import { useServerStore } from "./serverStore";
import { useUIStore, type Destination } from "./uiStore";
import { handleChannelEvent } from "../hooks/ws/channelEventHandlers";

function tree(serverId: string, channelId: string): CategoryWithChannels[] {
  return [{
    category: { id: `category-${serverId}`, name: serverId, position: 0 },
    channels: [{ id: channelId, name: channelId, type: "text", category_id: `category-${serverId}`, topic: null, position: 0, user_limit: 0, bitrate: 64000, created_at: "2026-01-01T00:00:00Z" }],
  }];
}
function destination(serverId: string, channelId: string): Destination {
  return { type: "text", channelId, label: channelId, serverInfo: { serverId, serverName: serverId, serverIconUrl: null } };
}
function deferredTree() {
  let resolve!: (value: APIResponse<CategoryWithChannels[]>) => void;
  const promise = new Promise<APIResponse<CategoryWithChannels[]>>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  shell.enabled = true;
  useServerStore.setState({ activeServerId: "one", activeServer: null, servers: [
    { id: "one", name: "one", icon_url: null }, { id: "two", name: "two", icon_url: null },
  ] });
  useChannelStore.setState({ categories: tree("one", "channel-one"), categoriesByServer: { one: tree("one", "channel-one"), two: tree("two", "channel-two") }, selectedChannelId: "channel-one", isLoading: false });
  useUIStore.setState({ destination: destination("one", "channel-one"), lastChannelByServer: { one: destination("one", "channel-one"), two: destination("two", "channel-two") } });
});

describe("origin-scoped channel refresh", () => {
  it("a background permission event refreshes only its server and preserves the current destination", async () => {
    vi.mocked(getChannels).mockResolvedValue({ success: true, data: [] });
    await handleChannelEvent({ op: "channel_permission_delete", server_id: "two", d: { channel_id: "channel-two", role_id: "role" } });
    await vi.waitFor(() => expect(useChannelStore.getState().categoriesByServer.two).toEqual([]));
    expect(getChannels).toHaveBeenCalledExactlyOnceWith("two");
    expect(useChannelStore.getState().categories).toEqual(tree("one", "channel-one"));
    expect(useUIStore.getState().destination.channelId).toBe("channel-one");
    expect(useUIStore.getState().lastChannelByServer.two).toBeUndefined();
    expect(useChannelStore.getState().isLoading).toBe(false);
  });

  it("permission refresh completing after a server switch never invalidates the new conversation", async () => {
    const pending = deferredTree();
    vi.mocked(getChannels).mockReturnValue(pending.promise);
    await handleChannelEvent({ op: "channel_permission_update", server_id: "one", d: { channel_id: "channel-one", role_id: "role", allow: 0, deny: 1 } } as WSMessage);
    useServerStore.getState().setActiveServer("two");
    useUIStore.setState({ destination: destination("two", "channel-two") });
    useChannelStore.getState().selectChannel("channel-two");
    pending.resolve({ success: true, data: [] });
    await vi.waitFor(() => expect(useChannelStore.getState().categoriesByServer.one).toEqual([]));
    expect(useUIStore.getState().destination.channelId).toBe("channel-two");
    expect(useUIStore.getState().lastChannelByServer.two?.channelId).toBe("channel-two");
    expect(useUIStore.getState().lastChannelByServer.one).toBeUndefined();
    expect(useChannelStore.getState().categories).toEqual(tree("two", "channel-two"));
    expect(useChannelStore.getState().selectedChannelId).toBe("channel-two");
  });

  it("ignores reverse-completing older responses for the same server", async () => {
    const older = deferredTree();
    const newer = deferredTree();
    vi.mocked(getChannels).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const first = useChannelStore.getState().fetchChannels("one");
    const second = useChannelStore.getState().fetchChannels("one");
    newer.resolve({ success: true, data: [] });
    await second;
    expect(useUIStore.getState().destination.type).toBe("server-home");
    older.resolve({ success: true, data: tree("one", "channel-one") });
    await first;
    expect(useChannelStore.getState().categories).toEqual([]);
    expect(useChannelStore.getState().categoriesByServer.one).toEqual([]);
    expect(useChannelStore.getState().selectedChannelId).toBeNull();
  });

  it("does not resurrect an evicted server cache from an in-flight request", async () => {
    const pending = deferredTree();
    vi.mocked(getChannels).mockReturnValue(pending.promise);
    const refresh = useChannelStore.getState().fetchChannels("two");
    useChannelStore.getState().evictServerCache("two");
    pending.resolve({ success: true, data: tree("two", "channel-two") });
    await refresh;
    expect(useChannelStore.getState().categoriesByServer.two).toBeUndefined();
  });

  it.each(["category_create", "category_update", "category_delete", "category_reorder", "channel_create", "channel_update", "channel_delete", "channel_reorder"] as const)("%s from another server cannot mutate the visible tree", async (op) => {
    vi.mocked(getChannels).mockResolvedValue({ success: true, data: tree("two", "updated-two") });
    await handleChannelEvent({ op, server_id: "two", d: { id: op.startsWith("channel_") ? "channel-two" : "category-two", name: "Changed", server_id: "two" } } as WSMessage);
    await vi.waitFor(() => expect(useChannelStore.getState().categoriesByServer.two).toEqual(tree("two", "updated-two")));
    expect(getChannels).toHaveBeenCalledExactlyOnceWith("two");
    expect(useChannelStore.getState().categories).toEqual(tree("one", "channel-one"));
    expect(useUIStore.getState().destination.channelId).toBe("channel-one");
  });

  it("classic permission cleanup reads the originating cache after a mid-flight switch", async () => {
    shell.enabled = false;
    const close = vi.spyOn(useUIStore.getState(), "closeTextTabByChannel");
    const pending = deferredTree();
    vi.mocked(getChannels).mockReturnValue(pending.promise);
    await handleChannelEvent({ op: "channel_permission_delete", server_id: "one", d: { channel_id: "channel-one", role_id: "role" } });
    useServerStore.getState().setActiveServer("two");
    pending.resolve({ success: true, data: tree("one", "channel-one") });
    await vi.waitFor(() => expect(useChannelStore.getState().categoriesByServer.one).toEqual(tree("one", "channel-one")));
    await pending.promise;
    expect(close).not.toHaveBeenCalled();
  });

  it("does not restore the previous server tree when a channel reorder fails after switching servers", async () => {
    let resolve!: (value: APIResponse<CategoryWithChannels[]>) => void;
    vi.mocked(reorderChannels).mockReturnValue(new Promise((done) => { resolve = done; }));
    const pending = useChannelStore.getState().reorderChannels([{ id: "channel-one", position: 1 }]);

    useServerStore.setState({ activeServerId: "two" });
    const otherTree = tree("two", "channel-two-current");
    useChannelStore.setState({ categories: otherTree });
    resolve({ success: false } as APIResponse<CategoryWithChannels[]>);

    expect(await pending).toBe(false);
    expect(useChannelStore.getState().categories).toBe(otherTree);
  });

  it("does not roll back channel reorder over a newer websocket tree", async () => {
    let resolve!: (value: APIResponse<Category[]>) => void;
    vi.mocked(reorderCategories).mockReturnValue(new Promise((done) => { resolve = done; }));
    const pending = useChannelStore.getState().reorderCategories([{ id: "category-one", position: 1 }]);
    const wsTree = tree("one", "channel-one-updated");
    useChannelStore.getState().handleChannelReorder(wsTree);
    resolve({ success: false } as APIResponse<Category[]>);

    expect(await pending).toBe(false);
    expect(useChannelStore.getState().categories).toBe(wsTree);
  });
});
