import { beforeEach, expect, it, vi } from "vitest";
import { adjacentId, executeNavigationShortcut, observeShortcutDestinationTransition } from "./shortcutNavigation";
vi.mock("./unreadShortcutNavigation", () => ({ navigateUnreadChannel: vi.fn() }));
const state = vi.hoisted(() => ({
  ui: { destination: { type: "text", channelId: "text", serverInfo: { serverId: "s1" } as {serverId:string} | undefined }, openServer: vi.fn(), navigate: vi.fn(), openTab: vi.fn() },
  p2p: { activeCall: null as null | {id:string; caller_id:string; caller_username:string; caller_display_name:string|null; receiver_username:string; receiver_display_name:string|null} },
  voice: { currentVoiceChannelId: null as string | null, currentVoiceServerId: null as string | null },
  user: { id: "me" as string | undefined },
  servers: { activeServerId: "s1", servers: [{ id: "s1", name: "One", icon_url: null }, { id: "s2", name: "Two", icon_url: null }] },
  channels: { categoriesByServer: { s1: [{ channels: [{ id: "text", name: "Text", type: "text" }, { id: "thread", type: "thread" }, { id: "voice", name: "Voice", type: "voice" }] }] } },
}));
vi.mock("../stores/uiStore", () => ({ useUIStore: { getState: () => state.ui } }));
vi.mock("../stores/serverStore", () => ({ useServerStore: { getState: () => state.servers } }));
vi.mock("../stores/channelStore", () => ({ useChannelStore: { getState: () => state.channels } }));
vi.mock("../stores/groupDMStore", () => ({ useGroupDMStore: { getState: () => ({ groups: [{id:"group",name:"Group"}] }) } }));
vi.mock("../stores/dmStore", () => ({ useDMStore: { getState: () => ({ channels: [{id:"dm",status:"accepted",other_user:{username:"Friend"}},{id:"pending",status:"pending",other_user:{username:"Pending"}}] }) } }));
vi.mock("../stores/p2pCallStore", () => ({ useP2PCallStore: { getState: () => state.p2p } }));
vi.mock("../stores/authStore", () => ({ useAuthStore: { getState: () => ({ user: state.user.id ? { id: state.user.id } : null }) } }));
vi.mock("../stores/voiceStore", () => ({ useVoiceStore: { getState: () => state.voice } }));
beforeEach(() => { vi.clearAllMocks(); state.ui.destination.type = "text"; state.ui.destination.channelId = "text"; state.ui.destination.serverInfo = {serverId:"s1"}; });
it("handles absent selections, wrapping and empty lists", () => {
  expect(adjacentId([], "missing", 1)).toBeUndefined();
  expect(adjacentId(["a", "b"], "b", 1)).toBe("a");
  expect(adjacentId(["a", "b"], "a", -1)).toBe("b");
  expect(adjacentId(["a", "b"], "missing", -1)).toBe("b");
});
it("changes server through the existing remembered destination path", () => {
  executeNavigationShortcut("next-server");
  expect(state.ui.openServer).toHaveBeenCalledWith("s2");
  expect(state.ui.navigate).not.toHaveBeenCalled();
});
it("skips nested threads and presents voice without joining a call", () => {
  executeNavigationShortcut("next-channel");
  expect(state.ui.navigate).toHaveBeenCalledWith({ type: "voice", channelId: "voice", label: "Voice", serverInfo: { serverId: "s1", serverName: "One", serverIconUrl: null } });
});
it("does not navigate to missing server trees or departed servers", () => {
  state.ui.destination.serverInfo = {serverId:"s2"};
  executeNavigationShortcut("next-channel");
  state.ui.destination.serverInfo = {serverId:"departed"};
  executeNavigationShortcut("next-channel");
  expect(state.ui.navigate).not.toHaveBeenCalled();
});
it("navigates private conversations instead of a stale active server and excludes pending requests", () => {
  state.ui.destination.type = "group-dm"; state.ui.destination.channelId = "group"; state.ui.destination.serverInfo = undefined;
  executeNavigationShortcut("next-channel");
  expect(state.ui.navigate).toHaveBeenLastCalledWith({ type: "dm", channelId: "dm", label: "Friend" });
  state.ui.destination.type = "dm"; state.ui.destination.channelId = "dm";
  executeNavigationShortcut("next-channel");
  expect(state.ui.navigate).toHaveBeenLastCalledWith({ type: "group-dm", channelId: "group", label: "Group" });
});
it("uses browser history shortcuts and emits the existing add-server modal event", () => {
  const back = vi.fn();
  const forward = vi.fn();
  const openServer = vi.fn();
  window.addEventListener("hichat:history-back", back);
  window.addEventListener("hichat:history-forward", forward);
  window.addEventListener("hichat:open-add-server", openServer);
  executeNavigationShortcut("history-back");
  executeNavigationShortcut("history-forward");
  executeNavigationShortcut("add-server");
  expect(back).toHaveBeenCalledOnce();
  expect(forward).toHaveBeenCalledOnce();
  expect(openServer).toHaveBeenCalledOnce();
  window.removeEventListener("hichat:history-back", back);
  window.removeEventListener("hichat:history-forward", forward);
  window.removeEventListener("hichat:open-add-server", openServer);
});
it("returns to the active P2P call with the peer's real display name", () => {
  state.p2p.activeCall = { id: "call1", caller_id: "me", caller_username: "me", caller_display_name: null, receiver_username: "friend", receiver_display_name: "Friend Name" };
  executeNavigationShortcut("return-to-call");
  expect(state.ui.openTab).toHaveBeenCalledWith("call1", "p2p", "Friend Name");
  state.ui.openTab.mockClear();
  state.p2p.activeCall = null;
  executeNavigationShortcut("return-to-call");
  expect(state.ui.openTab).not.toHaveBeenCalled();
  state.voice.currentVoiceChannelId = "voice";
  state.voice.currentVoiceServerId = "s1";
  executeNavigationShortcut("return-to-call");
  expect(state.ui.openTab).toHaveBeenCalledWith("voice", "voice", "Voice", { serverId: "s1", serverName: "One", serverIconUrl: null });
  state.voice.currentVoiceChannelId = null; state.voice.currentVoiceServerId = null;
});
it("toggles only between the latest server and private destinations", () => {
  const server = { type: "text" as const, channelId: "c1", label: "general", serverInfo: { serverId: "s1", serverName: "One", serverIconUrl: null } };
  const dm = { type: "dm" as const, channelId: "dm", label: "Friend", serverInfo: undefined };
  observeShortcutDestinationTransition(server, dm);
  state.ui.destination = dm;
  executeNavigationShortcut("previous-destination");
  expect(state.ui.navigate).toHaveBeenLastCalledWith(server);
  executeNavigationShortcut("previous-destination");
  expect(state.ui.navigate).toHaveBeenLastCalledWith(dm);
});
