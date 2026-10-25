import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => {
  function store() { let state: Record<string, unknown> = {}; return { getState: () => state, set: (value: Record<string, unknown>) => { state = { ...state, ...value }; } }; }
  return { auth: store(), feed: store(), prefs: store(), blocks: store(), servers: store(), channels: store(), members: store(), overrides: store(), threads: store(), messages: store(), e2ee: store(), ui: store(),
    scope: { ownerId: "owner", generation: 1 }, ignored: {} as Record<string, boolean>, spam: false, pending: false, visible: true, markRead: vi.fn(), primeMembers: vi.fn(), primeOverrides: vi.fn() };
});
vi.mock("../api/authSessionEvents", () => ({ getAuthSessionSnapshot: () => h.scope }));
vi.mock("../stores/authStore", () => ({ useAuthStore: h.auth }));
vi.mock("../stores/notificationStore", () => ({ useNotificationStore: h.feed }));
vi.mock("../stores/preferencesStore", () => ({ usePreferencesStore: h.prefs }));
vi.mock("../stores/blockStore", () => ({ useBlockStore: h.blocks }));
vi.mock("../stores/serverStore", () => ({ useServerStore: h.servers }));
vi.mock("../stores/channelStore", () => ({ useChannelStore: h.channels }));
vi.mock("../stores/memberStore", () => ({ useMemberStore: h.members }));
vi.mock("../stores/channelPermissionStore", () => ({ useChannelPermissionStore: h.overrides }));
vi.mock("../stores/threadStore", () => ({ useThreadStore: h.threads }));
vi.mock("../stores/messageStore", () => ({ useMessageStore: h.messages }));
vi.mock("../stores/e2eeStore", () => ({ useE2EEStore: h.e2ee }));
vi.mock("../stores/uiStore", () => ({ useUIStore: h.ui }));
vi.mock("./overlayNotificationAccess", () => ({ getLiveOverlayNotificationItems: () => h.visible ? [{ id: "notice", category: "mention" }] : [] }));
vi.mock("./messageSpamPolicy", () => ({ shouldSuppressMessagePreview: () => h.spam || h.pending }));
import { prepareOverlayNotificationReply, primeOverlayNotificationReplyAccess, resolveOverlayNotificationReplySource } from "./overlayNotificationReply";
import { composerKey, useComposerDraftStore } from "../stores/composerDraftStore";
import { Permissions } from "./permissions";
import type { Message } from "../types";
const key = composerKey("owner", "channel", "channel", "server");
const notice = { id: "notice", user_id: "owner", kind: "mention", actor_id: "actor", server_id: "server", channel_id: "channel", message_id: "message", dm_channel_id: null, payload: {} };
const message = { id: "message", channel_id: "channel", user_id: "actor", author: { id: "actor" }, content: "hello", attachments: [], reactions: [], encryption_version: 0 } as unknown as Message;
const allowed = Permissions.ViewChannel | Permissions.ReadMessages | Permissions.SendMessages;
beforeEach(() => {
  vi.clearAllMocks(); h.scope = { ownerId: "owner", generation: 1 }; h.ignored = {}; h.spam = false; h.pending = false; h.visible = true; document.body.replaceChildren();
  h.auth.set({ user: { id: "owner" } });
  h.feed.set({ items: [notice], markRead: h.markRead });
  h.prefs.set({ accountId: "owner", isLoaded: true, get: () => ({ ignoredUsers: h.ignored }) });
  h.blocks.set({ ownerId: "owner", authGeneration: 1, snapshotReady: true, isLoading: false, blockedUserIds: [] });
  h.servers.set({ servers: [{ id: "server" }], mutedServerIds: new Set() });
  h.channels.set({ categoriesByServer: { server: [{ channels: [{ id: "channel", type: "text", name: "Channel" }] }] }, mutedChannelIds: new Set() });
  h.members.set({ ownerId: "owner", authGeneration: 1, statusByServer: { server: "ready" }, loadingServers: new Set(), membersByServer: { server: [{ id: "owner", roles: [{ id: "role" }], effective_permissions: allowed }] }, fetchMembers: h.primeMembers });
  h.overrides.set({ statusByChannel: { channel: { ownerId: "owner", authGeneration: 1, serverId: "server", status: "ready" } }, overridesByChannel: { channel: [] }, fetchOverrides: h.primeOverrides });
  h.threads.set({ ownerId: "owner", authGeneration: 1, byID: {}, serverIdByThread: {}, statusByParent: {} });
  h.messages.set({ ownerId: "owner", authGeneration: 1, messagesByChannel: { channel: [message] } });
  h.e2ee.set({ initStatus: "ready", decryptionErrors: [], localDeviceId: "device" });
  h.ui.set({ destination: { type: "friends", channelId: "friends" }, navigationRevision: 0, panels: {}, activePanelId: "main" });
  useComposerDraftStore.getState().reset();
});
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function openSource(found: Promise<boolean> = Promise.resolve(true)) {
  return vi.fn(() => { h.ui.set({ destination: { type: "text", channelId: "channel", serverInfo: { serverId: "server" } }, navigationRevision: 1 }); return found; });
}
it("prepares the exact persisted source in the single main chat without sending or changing text/files", async () => {
  const file = new File(["draft"], "draft.txt"), store = useComposerDraftStore.getState();
  store.patch(key, { content: "unfinished text", files: [file] });
  const source = resolveOverlayNotificationReplySource("notice")!; const open = openSource();
  expect(await prepareOverlayNotificationReply(source, open, () => true)).toBe("prepared");
  expect(open).toHaveBeenCalledWith("server", "channel", "message", "Channel", expect.objectContaining({ isCurrent: expect.any(Function) }));
  expect(useComposerDraftStore.getState().drafts[key]).toMatchObject({ content: "unfinished text", files: [file], replyingTo: { id: "message", user_id: "actor" } });
  expect(h.markRead).toHaveBeenCalledExactlyOnceWith("notice");
});
it("fetches through the existing open/decryption path when the source body is not loaded; never prepares an undecryptable source", async () => {
  h.messages.set({ messagesByChannel: {} }); const source = resolveOverlayNotificationReplySource("notice")!;
  expect(source).not.toBeNull(); const wait = deferred<boolean>(), open = openSource(wait.promise);
  const result = prepareOverlayNotificationReply(source, open, () => true);
  expect(h.markRead).not.toHaveBeenCalled();
  h.messages.set({ messagesByChannel: { channel: [{ ...message, encryption_version: 1, content: null }] } }); wait.resolve(true);
  expect(await result).toBe("unavailable"); expect(useComposerDraftStore.getState().drafts[key]).toBeUndefined(); expect(h.markRead).not.toHaveBeenCalled();
});
it("fails closed on current ACL, block/ignore/mute/spam, malformed roles and E2EE denial", () => {
  expect(resolveOverlayNotificationReplySource("notice")).not.toBeNull();
  h.ignored.actor = true; expect(resolveOverlayNotificationReplySource("notice")).toBeNull(); h.ignored = {};
  h.blocks.set({ blockedUserIds: ["actor"] }); expect(resolveOverlayNotificationReplySource("notice")).toBeNull(); h.blocks.set({ blockedUserIds: [] });
  h.channels.set({ mutedChannelIds: new Set(["channel"]) }); expect(resolveOverlayNotificationReplySource("notice")).toBeNull(); h.channels.set({ mutedChannelIds: new Set() });
  h.spam = true; expect(resolveOverlayNotificationReplySource("notice")).toBeNull(); h.spam = false;
  h.members.set({ membersByServer: { server: [{ id: "owner", roles: null, effective_permissions: allowed }] } }); expect(() => resolveOverlayNotificationReplySource("notice")).not.toThrow(); expect(resolveOverlayNotificationReplySource("notice")).toBeNull();
  h.members.set({ membersByServer: { server: [{ id: "owner", roles: [{ id: "role" }], effective_permissions: allowed }] } });
  h.overrides.set({ overridesByChannel: { channel: [{ role_id: "role", allow: 0, deny: Permissions.SendMessages }] } }); expect(resolveOverlayNotificationReplySource("notice")).toBeNull();
  h.overrides.set({ overridesByChannel: { channel: [] } }); h.messages.set({ messagesByChannel: { channel: [{ ...message, encryption_version: 1 }] } }); h.e2ee.set({ initStatus: "locked" }); expect(resolveOverlayNotificationReplySource("notice")).toBeNull();
});
it("never silently replaces another reply, inline edit or sending draft", async () => {
  const source = resolveOverlayNotificationReplySource("notice")!, open = openSource();
  useComposerDraftStore.getState().patch(key, { replyingTo: { ...message, id: "other", is_pinned: false } });
  expect(await prepareOverlayNotificationReply(source, open, () => true)).toBe("conflict"); expect(open).not.toHaveBeenCalled();
  useComposerDraftStore.getState().reset();
  const editor = document.createElement("div"), input = document.createElement("textarea");
  editor.className = "msg-edit-area"; input.value = "editing text";
  editor.append(input); document.body.append(editor);
  expect(await prepareOverlayNotificationReply(source, open, () => true)).toBe("conflict"); expect(document.querySelector("textarea")?.value).toBe("editing text");
  editor.remove(); useComposerDraftStore.getState().beginSend(key);
  expect(await prepareOverlayNotificationReply(source, open, () => true)).toBe("conflict"); expect(h.markRead).not.toHaveBeenCalled();
});
it("keeps a draft changed during source fetch instead of clearing or retargeting it", async () => {
  const source = resolveOverlayNotificationReplySource("notice")!, wait = deferred<boolean>(), open = openSource(wait.promise);
  const result = prepareOverlayNotificationReply(source, open, () => true);
  useComposerDraftStore.getState().patch(key, { content: "typed while loading" }); wait.resolve(true);
  expect(await result).toBe("conflict"); expect(useComposerDraftStore.getState().drafts[key].content).toBe("typed while loading"); expect(h.markRead).not.toHaveBeenCalled();
});
it.each(["auth", "navigation", "permission", "source", "spam", "ignored", "muted", "device", "deleted"])("discards a delayed %s race without preparing or reading the wrong target", async reason => {
  const source = resolveOverlayNotificationReplySource("notice")!, wait = deferred<boolean>(), open = openSource(wait.promise);
  const result = prepareOverlayNotificationReply(source, open, () => true);
  if (reason === "auth") h.scope = { ownerId: "different", generation: 2 };
  if (reason === "navigation") h.ui.set({ destination: { type: "text", channelId: "other", serverInfo: { serverId: "server" } }, navigationRevision: 2 });
  if (reason === "permission") h.overrides.set({ statusByChannel: {} });
  if (reason === "source") h.feed.set({ items: [{ ...notice, message_id: "other" }] });
  if (reason === "spam") h.spam = true;
  if (reason === "ignored") h.ignored.actor = true;
  if (reason === "muted") h.channels.set({ mutedChannelIds: new Set(["channel"]) });
  if (reason === "device") h.e2ee.set({ localDeviceId: "replacement-device" });
  if (reason === "deleted") h.messages.set({ messagesByChannel: { channel: [] } });
  wait.resolve(true); expect(await result).toBe("unavailable");
  expect(useComposerDraftStore.getState().drafts[key]).toBeUndefined(); expect(h.markRead).not.toHaveBeenCalled();
});
it("uses a known thread's parent ACL while preserving the thread as the exact reply destination", async () => {
  h.feed.set({ items: [{ ...notice, channel_id: "thread" }] });
  h.threads.set({ byID: { thread: { id: "thread", type: "thread", name: "Thread", parent_channel_id: "channel" } }, serverIdByThread: { thread: "server" }, statusByParent: { '["server","channel"]': "ready" } });
  const source = resolveOverlayNotificationReplySource("notice")!;
  expect(source.channelId).toBe("thread"); expect(source.permissionChannelId).toBe("channel");
  await primeOverlayNotificationReplyAccess(["notice"]);
  expect(h.primeOverrides).toHaveBeenCalledWith("channel", "server");
  h.overrides.set({ overridesByChannel: { channel: [{ role_id: "role", allow: 0, deny: Permissions.ReadMessages }] } });
  expect(resolveOverlayNotificationReplySource("notice")).toBeNull();
});


it("never quotes a pending spam/relationship decision into a reply or reads the notification before it resolves", async () => {
  const source = resolveOverlayNotificationReplySource("notice")!, wait = deferred<boolean>(), open = openSource(wait.promise);
  const result = prepareOverlayNotificationReply(source, open, () => true);
  h.pending = true; wait.resolve(true);
  expect(await result).toBe("unavailable"); expect(useComposerDraftStore.getState().drafts[key]).toBeUndefined(); expect(h.markRead).not.toHaveBeenCalled();
  expect(resolveOverlayNotificationReplySource("notice")).toBeNull();
  h.pending = false;
  expect(await prepareOverlayNotificationReply(source, openSource(), () => true)).toBe("prepared");
});
