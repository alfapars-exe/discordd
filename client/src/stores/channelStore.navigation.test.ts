import { beforeEach, describe, expect, it, vi } from "vitest";
import type { APIResponse, Category, CategoryWithChannels, Message, WSMessage } from "../types";
const shell = vi.hoisted(() => ({ enabled: true }));
vi.mock("../utils/uiShell", () => ({ get UI_SHELL_V2() { return shell.enabled; } }));
vi.mock("../api/channels", () => ({ getChannels: vi.fn(), reorderChannels: vi.fn(), reorderCategories: vi.fn() }));
import { getChannels, reorderChannels, reorderCategories } from "../api/channels";
import * as messageApi from "../api/messages";
import { getAuthSessionOwner, publishAuthOwnerChange } from "../api/authSessionEvents";
import { useThreadStore } from "./threadStore";
import { useMessageStore } from "./messageStore";
import { captureHistoryAccess } from "./shared/channelHistoryAccess";
import { Permissions } from "../utils/permissions";
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
  it("evicts only the text channel whose read permission was revoked and accepts new events after a grant", async () => {
    const original = tree("one", "channel-one");
    const [channel] = original[0].channels;
    useMessageStore.setState({ messagesByChannel: { "channel-one": [], "standalone-thread": [], "channel-two": [] } });
    const oldDecrypt = captureHistoryAccess(channel.id);
    vi.mocked(getChannels).mockResolvedValueOnce({ success: true, data: [{
      ...original[0], channels: [{ ...channel, effective_permissions: Permissions.ViewChannel }],
    }] });
    await useChannelStore.getState().fetchChannels("one");
    expect(Object.keys(useMessageStore.getState().messagesByChannel).sort()).toEqual(["channel-two", "standalone-thread"]);
    expect(oldDecrypt()).toBe(false);
    const deniedEvent = captureHistoryAccess(channel.id);
    vi.mocked(getChannels).mockResolvedValueOnce({ success: true, data: [{
      ...original[0], channels: [{ ...channel, effective_permissions: Permissions.ViewChannel | Permissions.ReadMessages }],
    }] });
    await useChannelStore.getState().fetchChannels("one");
    expect(oldDecrypt()).toBe(false);
    expect(deniedEvent()).toBe(false);
    expect(captureHistoryAccess(channel.id)()).toBe(true);
  });

  it("evicts a known child under the revoked parent, fences its late page and fetches afresh after a grant", async () => {
    const previousOwner = getAuthSessionOwner();
    publishAuthOwnerChange("thread-reader");
    try {
      const original = tree("one", "parent");
      const [parent] = original[0].channels;
      const child = { ...parent, type: "thread" as const, id: "known-child", parent_channel_id: parent.id };
      useThreadStore.getState().remember(child, "one");
      useThreadStore.getState().remember({ ...child, id: "other-server-child" }, "two");
      const [publicSibling] = tree("one", "public-parent")[0].channels;
      useThreadStore.getState().remember({ ...child, id: "sibling-thread", parent_channel_id: publicSibling.id }, "one");
      const readable = Permissions.ViewChannel | Permissions.ReadMessages;
      const list = (permissions: number) => [{ ...original[0], channels: [
        { ...parent, effective_permissions: permissions }, { ...publicSibling, effective_permissions: readable },
      ] }];
      vi.mocked(getChannels).mockResolvedValueOnce({ success:true, data:list(readable) });
      await useChannelStore.getState().fetchChannels("one");
      const history = vi.spyOn(messageApi, "getMessages");
      const initial = { id:"before", channel_id:child.id, content:"old", created_at:"2026-01-01T00:00:00Z", encryption_version:0 } as const;
      type Page = Awaited<ReturnType<typeof messageApi.getMessages>>;
      const makePage = (id: string): Page => ({ success:true, data:{ messages:[{...initial, id} as Message], has_more:true } });
      history.mockResolvedValueOnce(makePage("before"));
      await useMessageStore.getState().fetchMessages(child.id, "one");
      const oldAccess = captureHistoryAccess(child.id);
      let resolve!: (value: Page) => void;
      history.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
      const pending = useMessageStore.getState().fetchOlderMessages(child.id, "one");
      vi.mocked(getChannels).mockResolvedValueOnce({ success:true, data:list(Permissions.ViewChannel) });
      await useChannelStore.getState().fetchChannels("one");
      expect(useMessageStore.getState().messagesByChannel[child.id]).toBeUndefined();
      expect(oldAccess()).toBe(false);
      expect(captureHistoryAccess("other-server-child")()).toBe(true);
      expect(captureHistoryAccess("sibling-thread")()).toBe(true);
      vi.mocked(getChannels).mockResolvedValueOnce({ success:true, data:list(readable) });
      await useChannelStore.getState().fetchChannels("one");
      expect(captureHistoryAccess(child.id)()).toBe(true);
      expect(oldAccess()).toBe(false);
      resolve(makePage("late"));
      await pending;
      expect(useMessageStore.getState().messagesByChannel[child.id]).toBeUndefined();
      history.mockResolvedValueOnce(makePage("after"));
      await useMessageStore.getState().fetchMessages(child.id, "one");
      expect(useMessageStore.getState().messagesByChannel[child.id].map((row) => row.id)).toEqual(["after"]);
    } finally {
      publishAuthOwnerChange(previousOwner);
    }
  });

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
