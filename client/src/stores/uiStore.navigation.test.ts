import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => {
  const server = { id: "s1", name: "One", icon_url: null };
  return {
    enabled: true,
    servers: { servers: [server, { ...server, id: "s2", name: "Two" }], activeServerId: "s1", setActiveServer: vi.fn() },
    channels: { categoriesByServer: { s1: [{ channels: [{ id: "a" }] }], s2: [{ channels: [{ id: "b" }] }] }, selectChannel: vi.fn() },
    messages: { messagesByChannel: {} },
    read: { markAsRead: vi.fn(), clearUnread: vi.fn() },
    dm: { selectDM: vi.fn(), clearDMUnread: vi.fn() },
    mobile: { closeAllDrawers: vi.fn() },
    voice: { currentVoiceChannelId: "voice", _onLeaveCallback: vi.fn() },
  };
});
vi.mock("../utils/uiShell", () => ({ get UI_SHELL_V2() { return fixture.enabled; } }));
vi.mock("./serverStore", () => ({ useServerStore: { getState: () => fixture.servers } }));
vi.mock("./channelStore", () => ({ useChannelStore: { getState: () => fixture.channels } }));
vi.mock("./messageStore", () => ({ useMessageStore: { getState: () => fixture.messages } }));
vi.mock("./readStateStore", () => ({ useReadStateStore: { getState: () => fixture.read } }));
vi.mock("./dmStore", () => ({ useDMStore: { getState: () => fixture.dm } }));
vi.mock("./mobileStore", () => ({ useMobileStore: { getState: () => fixture.mobile } }));
vi.mock("./voiceStore", () => ({ useVoiceStore: { getState: () => fixture.voice } }));

import { HOME_DESTINATION, useUIStore } from "./uiStore";
const one = { serverId: "s1", serverName: "One", serverIconUrl: null };
const two = { serverId: "s2", serverName: "Two", serverIconUrl: null };

beforeEach(() => {
  vi.clearAllMocks();
  fixture.enabled = true;
  fixture.servers.activeServerId = "s1";
  fixture.servers.setActiveServer.mockImplementation((id: string) => { fixture.servers.activeServerId = id; });
  useUIStore.setState({ destination: HOME_DESTINATION, navigationRevision: 0, lastChannelByServer: {}, panels: { test: { id: "test", tabs: [], activeTabId: null } }, activePanelId: "test", layout: { type: "leaf", panelId: "test" } });
});

describe("single destination navigation", () => {
  it("opens a cross-server conversation without creating tabs and marks only that text channel read", () => {
    useUIStore.getState().openTab("b", "text", "B", two);
    expect(fixture.servers.setActiveServer).toHaveBeenCalledWith("s2");
    expect(fixture.channels.selectChannel).toHaveBeenCalledWith("b");
    expect(fixture.read.clearUnread).toHaveBeenCalledExactlyOnceWith("b");
    expect(useUIStore.getState().destination.channelId).toBe("b");
    expect(useUIStore.getState().panels.test.tabs).toEqual([]);
  });

  it("restores the last visible channel but uses a server landing when a cached target disappeared", () => {
    useUIStore.getState().openTab("a", "text", "A", one);
    useUIStore.getState().navigate(HOME_DESTINATION);
    useUIStore.getState().openServer("s1");
    expect(useUIStore.getState().destination.channelId).toBe("a");
    useUIStore.setState({ lastChannelByServer: { s1: { type: "text", channelId: "removed", label: "", serverInfo: one } } });
    fixture.read.clearUnread.mockClear();
    useUIStore.getState().openServer("s1");
    expect(useUIStore.getState().destination.type).toBe("server-home");
    expect(fixture.read.clearUnread).not.toHaveBeenCalled();
  });

  it("selects DMs and navigation never ends the voice session", () => {
    useUIStore.getState().openTab("dm1", "dm", "Friend");
    expect(fixture.dm.selectDM).toHaveBeenCalledWith("dm1");
    useUIStore.getState().navigate(HOME_DESTINATION);
    useUIStore.getState().closeVoiceTabs("voice");
    expect(fixture.voice._onLeaveCallback).not.toHaveBeenCalled();
    expect(useUIStore.getState().destination).toEqual(HOME_DESTINATION);
  });

  it("channel removal falls back to that server and server removal falls back home", () => {
    useUIStore.getState().openTab("a", "text", "A", one);
    useUIStore.getState().closeTextTabByChannel("a");
    expect(useUIStore.getState().destination.type).toBe("server-home");
    expect(useUIStore.getState().lastChannelByServer.s1).toBeUndefined();
    useUIStore.getState().closeTabsForServer("s1");
    expect(useUIStore.getState().destination.type).toBe("friends");
  });

  it("does not let completion of an old call displace the user's current conversation", () => {
    useUIStore.getState().openTab("dm1", "dm", "Friend");
    useUIStore.getState().closeDestination("old-call");
    expect(useUIStore.getState().destination.channelId).toBe("dm1");
  });

  it("classic rollback retains the original tab behavior", () => {
    fixture.enabled = false;
    useUIStore.getState().openTab("a", "text", "A", one);
    expect(useUIStore.getState().panels.test.tabs).toHaveLength(1);
    expect(useUIStore.getState().destination).toEqual(HOME_DESTINATION);
    expect(fixture.servers.setActiveServer).not.toHaveBeenCalled();
  });
});
