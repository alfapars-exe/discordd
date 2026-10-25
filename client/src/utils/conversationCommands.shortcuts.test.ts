vi.mock("./inboxShortcutToggle",()=>({toggleInboxShortcut:()=>fixture.navigate({type:"inbox",channelId:"inbox",label:"common:shellInbox"})}));
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { executeConversationShortcut, dispatchConversationCommand, CONVERSATION_COMMAND_EVENT, type ConversationCommandDetail } from "./conversationCommands";

const fixture = vi.hoisted(() => ({
  destination: { type: "text" as string, channelId: "c1", label: "general", serverInfo: { serverId: "s1", serverName: "server", serverIconUrl: null } as { serverId: string; serverName: string; serverIconUrl: null } | undefined },
  navigationRevision: 1,
  userId: "u1" as string | null,
  generation: 7,
  messages: [{ id: "m9" }],
  channelServerMap: { c1: "s1", c2: "s1", other: "s2" } as Record<string, string>,
  clearUnread: vi.fn(),
  fetchUnreadCounts: vi.fn(),
  addToast: vi.fn(),
  markRead: vi.fn(),
  markAllRead: vi.fn(),
  getMessages: vi.fn(),
  copyToClipboard: vi.fn(),
  destinationPath: vi.fn(() => "/channels/server/s1/text/c1"),
  navigate: vi.fn(),
  isNativeApp: false,
  dmOwner: "u1", dmGeneration: 7, dmPresent: true,
  groupOwner: "u1", groupGeneration: 7, groupPresent: true,
  getDMMessages: vi.fn(), markDMRead: vi.fn(), fetchDMChannels: vi.fn(),
  listGroupDMMessages: vi.fn(), markGroupDMRead: vi.fn(), handleGroupRead: vi.fn(),
}));

vi.mock("../stores/uiStore", () => ({ useUIStore: { getState: () => ({ destination: fixture.destination, navigationRevision: fixture.navigationRevision, navigate: fixture.navigate }) } }));
vi.mock("../stores/toastStore", () => ({ useToastStore: { getState: () => ({ addToast: fixture.addToast }) } }));
vi.mock("../stores/authStore", () => ({ useAuthStore: { getState: () => ({ user: fixture.userId ? { id: fixture.userId } : null }) } }));
vi.mock("../stores/messageStore", () => ({ useMessageStore: { getState: () => ({ messagesByChannel: { c1: fixture.messages } }) } }));
vi.mock("../stores/readStateStore", () => ({ useReadStateStore: { getState: () => ({ channelServerMap: fixture.channelServerMap, clearUnread: fixture.clearUnread, fetchUnreadCounts: fixture.fetchUnreadCounts }) } }));
vi.mock("../api/readState", () => ({ markRead: fixture.markRead, markAllRead: fixture.markAllRead }));
vi.mock("../api/messages", () => ({ getMessages: fixture.getMessages }));
vi.mock("../api/dm", () => ({ getDMMessages: fixture.getDMMessages, markDMRead: fixture.markDMRead }));
vi.mock("../api/groupDM", () => ({ listGroupDMMessages: fixture.listGroupDMMessages, markGroupDMRead: fixture.markGroupDMRead }));
vi.mock("../stores/dmStore", () => ({ useDMStore: { getState: () => ({ ownerId: fixture.dmOwner, authGeneration: fixture.dmGeneration, channels: fixture.dmPresent ? [{ id: "dm1" }] : [], fetchChannels: fixture.fetchDMChannels }) } }));
vi.mock("../stores/groupDMStore", () => ({ useGroupDMStore: { getState: () => ({ ownerId: fixture.groupOwner, authGeneration: fixture.groupGeneration, groupsReady: true, groups: fixture.groupPresent ? [{ id: "g1", members: [{ id: "u1" }] }] : [], handleReadState: fixture.handleGroupRead }) } }));
vi.mock("../api/client", () => ({ getAuthGeneration: () => fixture.generation }));
vi.mock("./constants", () => ({ copyToClipboard: fixture.copyToClipboard, isNativeApp: () => fixture.isNativeApp }));
vi.mock("../hooks/useNavigationHistory", () => ({ destinationPath: fixture.destinationPath }));
vi.mock("../i18n", () => ({ default: { t: (key: string) => key } }));

beforeEach(() => {
  vi.resetAllMocks();
  fixture.fetchUnreadCounts.mockResolvedValue(true);
  fixture.getMessages.mockResolvedValue({ success: true, data: { messages: [{ id: "m-latest" }], has_more: true } });
  fixture.markRead.mockResolvedValue({ success: true, data: { message: "ok" } });
  fixture.markAllRead.mockResolvedValue({ success: true, data: { message: "ok" } });
  fixture.dmOwner = "u1"; fixture.dmGeneration = 7; fixture.dmPresent = true;
  fixture.groupOwner = "u1"; fixture.groupGeneration = 7; fixture.groupPresent = true;
  fixture.getDMMessages.mockResolvedValue({ success: true, data: { messages: [{ id: "latest-dm", dm_channel_id: "dm1" }] } });
  fixture.markDMRead.mockResolvedValue({ success: true }); fixture.fetchDMChannels.mockResolvedValue(true);
  fixture.listGroupDMMessages.mockResolvedValue({ success: true, data: { messages: [{ id: "latest-group", group_id: "g1" }] } });
  fixture.markGroupDMRead.mockResolvedValue({ success: true, data: { group_id: "g1", last_read_message_id: "latest-group", unread_count: 2, revision: 5 } });
});

afterEach(() => {
  fixture.destination = { type: "text", channelId: "c1", label: "general", serverInfo: { serverId: "s1", serverName: "server", serverIconUrl: null } };
  fixture.navigationRevision = 1;
  fixture.userId = "u1";
  fixture.generation = 7;
  fixture.isNativeApp = false;
  fixture.messages = [{ id: "m9" }];
  fixture.channelServerMap = { c1: "s1", c2: "s1", other: "s2" };
  window.history.replaceState({}, "", "/channels/server/s1/text/c1");
});

it("marks the active channel through its current server and refreshes authoritative counts", async () => {
  fixture.markRead.mockResolvedValue({ success: true, data: { message: "ok" } });
  fixture.getMessages.mockResolvedValue({ success: true, data: { messages: [{ id: "m-latest" }], has_more: true } });
  executeConversationShortcut("chat-mark-channel-read");
  await vi.waitFor(() => expect(fixture.fetchUnreadCounts).toHaveBeenCalledWith("s1", expect.objectContaining({ timeoutMs: 15000, isCurrent: expect.any(Function) })));
  expect(fixture.getMessages).toHaveBeenCalledWith("s1", "c1", undefined, 1, expect.objectContaining({ timeoutMs: 15000, isCurrent: expect.any(Function) }));
  expect(fixture.markRead).toHaveBeenCalledWith("s1", "c1", "m-latest", expect.objectContaining({ timeoutMs: 15000, isCurrent: expect.any(Function) }));
  expect(fixture.clearUnread).not.toHaveBeenCalled();
  expect(fixture.addToast).toHaveBeenCalledWith("success", "common:shortcutMarkedRead");
});

it.each(["chat-mark-channel-read", "chat-mark-server-read"] as const)("reports a failed count refresh for %s without claiming success", async (command) => {
  fixture.fetchUnreadCounts.mockResolvedValueOnce(false);
  executeConversationShortcut(command);
  await vi.waitFor(() => expect(fixture.addToast).toHaveBeenCalledWith("error", "common:shortcutReadFailed"));
  expect(fixture.addToast).not.toHaveBeenCalledWith("success", expect.anything());
  expect(fixture.clearUnread).not.toHaveBeenCalled();
});

it.each(["chat-mark-channel-read", "chat-mark-server-read"] as const)("reports a rejected count refresh for %s without claiming success", async (command) => {
  fixture.fetchUnreadCounts.mockRejectedValueOnce(new Error("offline"));
  executeConversationShortcut(command);
  await vi.waitFor(() => expect(fixture.addToast).toHaveBeenCalledWith("error", "common:shortcutReadFailed"));
  expect(fixture.addToast).not.toHaveBeenCalledWith("success", expect.anything());
});

it("does not show a count-refresh failure in a different account or destination", async () => {
  let finish!: (result: boolean) => void;
  fixture.fetchUnreadCounts.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  executeConversationShortcut("chat-mark-channel-read");
  await vi.waitFor(() => expect(fixture.fetchUnreadCounts).toHaveBeenCalledOnce());
  fixture.navigationRevision++;
  fixture.userId = "u2";
  finish(false);
  await Promise.resolve(); await Promise.resolve();
  expect(fixture.addToast).not.toHaveBeenCalled();
});

it("marks a DM at its authoritative latest ID and refreshes metadata without clearing newer unread messages", async () => {
  fixture.destination = { type: "dm", channelId: "dm1", label: "DM", serverInfo: undefined };
  executeConversationShortcut("chat-mark-channel-read");
  await vi.waitFor(() => expect(fixture.fetchDMChannels).toHaveBeenCalledOnce());
  expect(fixture.getDMMessages).toHaveBeenCalledWith("dm1", undefined, 1, expect.objectContaining({ timeoutMs: 15000, isCurrent: expect.any(Function) }));
  expect(fixture.markDMRead).toHaveBeenCalledWith("dm1", "latest-dm", expect.objectContaining({ isCurrent: expect.any(Function) }));
  expect(fixture.addToast).toHaveBeenCalledWith("success", "common:shortcutMarkedRead");
  expect(fixture.markRead).not.toHaveBeenCalled();
});

it("marks a group at its latest ID and applies only the revisioned authoritative read state", async () => {
  fixture.destination = { type: "group-dm", channelId: "g1", label: "Group", serverInfo: undefined };
  executeConversationShortcut("chat-mark-channel-read");
  await vi.waitFor(() => expect(fixture.handleGroupRead).toHaveBeenCalledExactlyOnceWith({ group_id: "g1", last_read_message_id: "latest-group", unread_count: 2, revision: 5 }));
  expect(fixture.markGroupDMRead).toHaveBeenCalledWith("g1", "latest-group", expect.objectContaining({ isCurrent: expect.any(Function) }));
  expect(fixture.addToast).toHaveBeenCalledWith("success", "common:shortcutMarkedRead");
});

it.each(["dm", "group-dm"])("does not mark %s after navigation changes while latest history is pending", async (kind) => {
  fixture.destination = { type: kind, channelId: kind === "dm" ? "dm1" : "g1", label: "Private", serverInfo: undefined };
  const history = kind === "dm" ? fixture.getDMMessages : fixture.listGroupDMMessages;
  let finish!: (result: unknown) => void;
  history.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  executeConversationShortcut("chat-mark-channel-read");
  expect(history).toHaveBeenCalledOnce();
  fixture.navigationRevision++;
  finish({ success: true, data: { messages: [{ id: "late", dm_channel_id: "dm1", group_id: "g1" }] } });
  await Promise.resolve(); await Promise.resolve();
  expect(fixture.markDMRead).not.toHaveBeenCalled(); expect(fixture.markGroupDMRead).not.toHaveBeenCalled();
  expect(fixture.addToast).not.toHaveBeenCalled();
});

it.each(["dm", "group-dm"])("reports rejected %s read without success or local count changes", async (kind) => {
  fixture.destination = { type: kind, channelId: kind === "dm" ? "dm1" : "g1", label: "Private", serverInfo: undefined };
  (kind === "dm" ? fixture.markDMRead : fixture.markGroupDMRead).mockResolvedValueOnce({ success: false });
  executeConversationShortcut("chat-mark-channel-read");
  await vi.waitFor(() => expect(fixture.addToast).toHaveBeenCalledWith("error", "common:shortcutReadFailed"));
  expect(fixture.fetchDMChannels).not.toHaveBeenCalled(); expect(fixture.handleGroupRead).not.toHaveBeenCalled();
});

it("refuses private sources from another account/session or a removed group", async () => {
  fixture.destination = { type: "dm", channelId: "dm1", label: "DM", serverInfo: undefined }; fixture.dmGeneration--;
  executeConversationShortcut("chat-mark-channel-read"); await Promise.resolve();
  fixture.destination = { type: "group-dm", channelId: "g1", label: "Group", serverInfo: undefined }; fixture.groupPresent = false;
  executeConversationShortcut("chat-mark-channel-read"); await Promise.resolve();
  expect(fixture.getDMMessages).not.toHaveBeenCalled(); expect(fixture.listGroupDMMessages).not.toHaveBeenCalled();
});

it.each(["dm", "group-dm"])("does not apply a %s result after same-account reauthentication", async (kind) => {
  fixture.destination = { type: kind, channelId: kind === "dm" ? "dm1" : "g1", label: "Private", serverInfo: undefined };
  const mark = kind === "dm" ? fixture.markDMRead : fixture.markGroupDMRead;
  let finish!: (result: unknown) => void;
  mark.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  executeConversationShortcut("chat-mark-channel-read");
  await vi.waitFor(() => expect(mark).toHaveBeenCalledOnce());
  const options = mark.mock.calls[0][2];
  expect(options.isCurrent()).toBe(true);
  fixture.generation++;
  expect(options.isCurrent()).toBe(false);
  finish({ success: true, data: { group_id: "g1", unread_count: 0, revision: 9 } });
  await Promise.resolve(); await Promise.resolve();
  expect(fixture.fetchDMChannels).not.toHaveBeenCalled(); expect(fixture.handleGroupRead).not.toHaveBeenCalled();
  expect(fixture.addToast).not.toHaveBeenCalled();
});

it("does not report DM success when its authoritative metadata refresh fails", async () => {
  fixture.destination = { type: "dm", channelId: "dm1", label: "Private", serverInfo: undefined };
  fixture.fetchDMChannels.mockResolvedValueOnce(false);
  executeConversationShortcut("chat-mark-channel-read");
  await vi.waitFor(() => expect(fixture.addToast).toHaveBeenCalledWith("error", "common:shortcutReadFailed"));
});

it("rejects a malformed or foreign group read acknowledgement", async () => {
  fixture.destination = { type: "group-dm", channelId: "g1", label: "Group", serverInfo: undefined };
  fixture.markGroupDMRead.mockResolvedValueOnce({ success: true, data: { group_id: "wrong", unread_count: 0, revision: 5 } });
  executeConversationShortcut("chat-mark-channel-read");
  await vi.waitFor(() => expect(fixture.addToast).toHaveBeenCalledWith("error", "common:shortcutReadFailed"));
  expect(fixture.handleGroupRead).not.toHaveBeenCalled();
});

it("does not apply a late read result after destination changes", async () => {
  let resolve!: (value: { success: boolean; data: { message: string } }) => void;
  fixture.markRead.mockReturnValue(new Promise((done) => { resolve = done; }));
  fixture.getMessages.mockResolvedValue({ success: true, data: { messages: [{ id: "m-latest" }], has_more: true } });
  executeConversationShortcut("chat-mark-channel-read");
  await vi.waitFor(() => expect(fixture.markRead).toHaveBeenCalledOnce());
  const current = fixture.markRead.mock.calls[0][3].isCurrent as () => boolean;
  expect(current()).toBe(true);
  fixture.navigationRevision += 1;
  resolve({ success: true, data: { message: "ok" } });
  await vi.waitFor(() => expect(fixture.markRead).toHaveBeenCalledOnce());
  await Promise.resolve();
  expect(fixture.fetchUnreadCounts).not.toHaveBeenCalled();
  expect(fixture.clearUnread).not.toHaveBeenCalled();
  expect(fixture.addToast).not.toHaveBeenCalledWith("success", "common:shortcutMarkedRead");
});

it("refreshes unread counts instead of clearing them when a newer message arrives during mark-read", async () => {
  let resolve!: (value: { success: boolean; data: { message: string } }) => void;
  fixture.getMessages.mockResolvedValue({ success: true, data: { messages: [{ id: "m9" }], has_more: true } });
  fixture.markRead.mockReturnValue(new Promise((done) => { resolve = done; }));
  executeConversationShortcut("chat-mark-channel-read");
  await vi.waitFor(() => expect(fixture.markRead).toHaveBeenCalledWith("s1", "c1", "m9", expect.anything()));
  fixture.messages = [{ id: "m9" }, { id: "m10" }];
  resolve({ success: true, data: { message: "ok" } });
  await vi.waitFor(() => expect(fixture.fetchUnreadCounts).toHaveBeenCalledWith("s1", expect.objectContaining({ isCurrent: expect.any(Function) })));
  expect(fixture.clearUnread).not.toHaveBeenCalled();
});

it("marks the current server then refreshes authoritative unread counts", async () => {
  fixture.destination = { ...fixture.destination, type: "server-home", channelId: "s1" };
  fixture.markAllRead.mockResolvedValue({ success: true, data: { message: "ok" } });
  executeConversationShortcut("chat-mark-server-read");
  await vi.waitFor(() => expect(fixture.fetchUnreadCounts).toHaveBeenCalledWith("s1", expect.objectContaining({ timeoutMs: 15000, isCurrent: expect.any(Function) })));
  expect(fixture.markAllRead).toHaveBeenCalledWith("s1", expect.objectContaining({ timeoutMs: 15000, isCurrent: expect.any(Function) }));
  expect(fixture.clearUnread).not.toHaveBeenCalled();
});

it("copies an absolute active channel URL and reports clipboard failure without success", async () => {
  fixture.copyToClipboard.mockResolvedValue(undefined);
  executeConversationShortcut("chat-copy-channel-link");
  await vi.waitFor(() => expect(fixture.addToast).toHaveBeenCalledWith("success", "common:copySuccess"));
  expect(fixture.copyToClipboard).toHaveBeenCalledWith(`${window.location.origin}/channels/server/s1/text/c1`);

  vi.clearAllMocks();
  fixture.copyToClipboard.mockRejectedValue(new Error("denied"));
  executeConversationShortcut("chat-copy-channel-link");
  await vi.waitFor(() => expect(fixture.addToast).toHaveBeenCalledWith("error", "common:shortcutCopyFailed"));
  expect(fixture.addToast).not.toHaveBeenCalledWith("success", "common:copySuccess");
});

it("copies channel links using the native HashRouter URL form", async () => {
  fixture.isNativeApp = true;
  window.history.replaceState({}, "", "/index.html");
  fixture.copyToClipboard.mockResolvedValue(undefined);
  executeConversationShortcut("chat-copy-channel-link");
  await vi.waitFor(() => expect(fixture.copyToClipboard).toHaveBeenCalledWith(
    window.location.href.split("#", 1)[0] + "#/channels/server/s1/text/c1",
  ));
});

it("opens the existing inbox destination from the inbox shortcut", () => {
  executeConversationShortcut("chat-open-inbox");
  expect(fixture.navigate).toHaveBeenCalledWith({ type: "inbox", channelId: "inbox", label: "common:shellInbox" });
});
it("routes a voice members shortcut to its text-view toggle and other actions to its channel composer", () => {
  fixture.destination={...fixture.destination,type:"voice"};
  const details:ConversationCommandDetail[]=[];
  const handler=(event:Event)=>{const request=event as CustomEvent<ConversationCommandDetail>;details.push(request.detail);request.preventDefault();};
  window.addEventListener(CONVERSATION_COMMAND_EVENT,handler);
  try {
    expect(dispatchConversationCommand("members")).toBe(true);
    expect(dispatchConversationCommand("emoji")).toBe(true);
    expect(details.map(detail=>detail.target)).toEqual([
      {kind:"voice",id:"c1",serverId:"s1"},
      {kind:"channel",id:"c1",serverId:"s1"},
    ]);
  } finally {window.removeEventListener(CONVERSATION_COMMAND_EVENT,handler);}
});

it("requests the existing group conversation flow without constructing a group directly", () => {
  const handler = vi.fn();
  window.addEventListener("hichat:create-group-conversation", handler);
  try {
    executeConversationShortcut("chat-create-group");
    expect(handler).toHaveBeenCalledOnce();
  } finally {
    window.removeEventListener("hichat:create-group-conversation", handler);
  }
  expect(fixture.navigate).not.toHaveBeenCalled();
});

it.each(["dialog", "menu", "aria-modal"])("blocks direct chat commands behind a %s boundary", async (surface) => {
  const overlay = document.createElement("div");
  if (surface === "aria-modal") overlay.setAttribute("aria-modal", "true");
  else overlay.setAttribute("role", surface);
  document.body.append(overlay);
  const listener = vi.fn();
  window.addEventListener(CONVERSATION_COMMAND_EVENT, listener);
  try {
    expect(dispatchConversationCommand("emoji")).toBe(false);
    for (const command of ["chat-mark-server-read", "chat-mark-channel-read", "chat-copy-channel-link", "chat-open-inbox"] as const) {
      expect(executeConversationShortcut(command)).toBe(false);
    }
    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();
    expect(fixture.markAllRead).not.toHaveBeenCalled();
    expect(fixture.getMessages).not.toHaveBeenCalled();
    expect(fixture.copyToClipboard).not.toHaveBeenCalled();
    expect(fixture.navigate).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener(CONVERSATION_COMMAND_EVENT, listener);
    overlay.remove();
  }
});

it("does not steal focus/navigation from an already open dialog", () => {
  const dialog = document.createElement("dialog");
  dialog.open = true;
  document.body.append(dialog);
  const handler = vi.fn();
  window.addEventListener("hichat:create-group-conversation", handler);
  try {
    executeConversationShortcut("chat-open-inbox");
    executeConversationShortcut("chat-create-group");
    expect(fixture.navigate).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener("hichat:create-group-conversation", handler);
    dialog.remove();
  }
});
