import { beforeEach, describe, expect, it, vi } from "vitest";
import type { APIResponse, Server, CategoryWithChannels } from "../types";
const shell = vi.hoisted(() => ({ enabled: false }));
vi.mock("../utils/uiShell", () => ({ get UI_SHELL_V2() { return shell.enabled; } }));
vi.mock("../api/servers", () => ({ getServer: vi.fn(), createServer: vi.fn(), joinServer: vi.fn(), leaveServer: vi.fn(), deleteServer: vi.fn(), reorderServers: vi.fn() }));
import { getServer, createServer, joinServer, leaveServer, deleteServer, reorderServers } from "../api/servers";
import { useServerStore } from "./serverStore";
import { useChannelStore } from "./channelStore";
import { useUIStore } from "./uiStore";
import { useVoiceStore } from "./voiceStore";
import { useAuthStore } from "./authStore";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  shell.enabled = false;
  useServerStore.setState({ activeServerId: "one", activeServer: null });
  useAuthStore.setState({ user: null });
  useUIStore.getState().resetNavigation();
});

describe("server removal voice isolation", () => {
  it.each(["event", "leave", "delete"])("%s only disconnects voice belonging to the removed server", async (action) => {
    shell.enabled = true;
    const activeServer = { id: "one", name: "Current" } as Server;
    useServerStore.setState({
      servers: [{ id: "one", name: "Current", icon_url: null }, { id: "two", name: "Other", icon_url: null }],
      activeServerId: "one", activeServer,
    });
    const leaveVoiceChannel = vi.fn();
    const send = vi.fn();
    vi.spyOn(useVoiceStore, "getState").mockReturnValue({
      ...useVoiceStore.getState(),
      currentVoiceChannelId: "voice-one", currentVoiceServerId: "one",
      leaveVoiceChannel, _wsSend: send,
    });
    vi.mocked(leaveServer).mockResolvedValue({ success: true });
    vi.mocked(deleteServer).mockResolvedValue({ success: true });
    const remove = async (id: string) => {
      if (action === "event") useServerStore.getState().handleServerDelete(id);
      else if (action === "leave") await useServerStore.getState().leaveServer(id);
      else await useServerStore.getState().deleteServer(id);
    };

    await remove("two");
    expect(leaveVoiceChannel).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(useServerStore.getState().activeServer).toBe(activeServer);

    await remove("one");
    expect(leaveVoiceChannel).toHaveBeenCalledExactlyOnceWith();
    expect(send).toHaveBeenCalledExactlyOnceWith("voice_leave", {});
    expect(useServerStore.getState().activeServer).toBeNull();
  });
});

describe("server navigation races", () => {
  it.each(["create", "join"])("opens the new server after %s instead of leaving the old tree visible", async (action) => {
    shell.enabled = true;
    const oldTree = [{ category: { id: "old-category" }, channels: [{ id: "old-channel" }] }] as CategoryWithChannels[];
    useChannelStore.setState({ categories: oldTree, categoriesByServer: {}, selectedChannelId: "old-channel" });
    const server = { id: "new", name: "New", icon_url: null } as Server;
    vi.mocked(createServer).mockResolvedValue({ success: true, data: server });
    vi.mocked(joinServer).mockResolvedValue({ success: true, data: server });
    if (action === "create") await useServerStore.getState().createServer({ name: "New", host_type: "mqvi_hosted" });
    else await useServerStore.getState().joinServer("invite");
    expect(useUIStore.getState().destination).toMatchObject({ type: "server-home", serverInfo: { serverId: "new" } });
    expect(useChannelStore.getState().categories).toEqual([]);
    expect(useChannelStore.getState().categoriesByServer.one).toEqual(oldTree);
    expect(useChannelStore.getState().selectedChannelId).toBeNull();
  });
  it("ignores metadata from a server the user has already left", async () => {
    let resolve!: (value: APIResponse<Server>) => void;
    vi.mocked(getServer).mockImplementation(() => new Promise((done) => { resolve = done; }));
    const pending = useServerStore.getState().fetchActiveServer();
    useServerStore.setState({ activeServerId: "two" });
    resolve({ success: true, data: { id: "one", name: "Old" } as Server });
    await pending;
    expect(useServerStore.getState().activeServer).toBeNull();
  });

  it("does not clear metadata or the channel tree when selecting the same server", () => {
    const active = { id: "one", name: "Current" } as Server;
    useServerStore.setState({ activeServer: active });
    useServerStore.getState().setActiveServer("one");
    expect(useServerStore.getState().activeServer).toBe(active);
  });
});

describe("server reorder rollback ownership", () => {
  it("does not restore the prior account's list after an account switch", async () => {
    let resolve!: (value: APIResponse<never>) => void;
    vi.mocked(reorderServers).mockReturnValue(new Promise((done) => { resolve = done; }));
    useAuthStore.setState({ user: { id: "first" } as never });
    useServerStore.setState({ servers: [{ id: "a", name: "A", icon_url: null }, { id: "b", name: "B", icon_url: null }] });

    const pending = useServerStore.getState().reorderServers([{ id: "b", position: 0 }, { id: "a", position: 1 }]);
    useAuthStore.setState({ user: { id: "second" } as never });
    const secondAccountServers = [{ id: "x", name: "X", icon_url: null }];
    useServerStore.setState({ servers: secondAccountServers });
    resolve({ success: false } as APIResponse<never>);

    expect(await pending).toBe(false);
    expect(useServerStore.getState().servers).toBe(secondAccountServers);
  });

  it("does not roll back over a newer server websocket update", async () => {
    let resolve!: (value: APIResponse<never>) => void;
    vi.mocked(reorderServers).mockReturnValue(new Promise((done) => { resolve = done; }));
    useServerStore.setState({ servers: [{ id: "a", name: "A", icon_url: null }, { id: "b", name: "B", icon_url: null }] });

    const pending = useServerStore.getState().reorderServers([{ id: "b", position: 0 }, { id: "a", position: 1 }]);
    useServerStore.getState().handleServerUpdate({ id: "a", name: "Updated by WS" } as Server);
    resolve({ success: false } as APIResponse<never>);

    expect(await pending).toBe(false);
    expect(useServerStore.getState().servers.find((server) => server.id === "a")?.name).toBe("Updated by WS");
  });
});
