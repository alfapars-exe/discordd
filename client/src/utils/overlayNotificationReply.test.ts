import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => {
  function store() { let state: Record<string, unknown> = {}; return { getState: () => state, set: (value: Record<string, unknown>) => { state = { ...state, ...value }; } }; }
  return { groups: store(), listGroups: vi.fn(), dms: store(), listDMs: vi.fn(), auth: store(), feed: store(), prefs: store(), blocks: store(), servers: store(), channels: store(), members: store(), overrides: store(), threads: store(), messages: store(), e2ee: store(), ui: store(),
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
vi.mock("../stores/groupDMStore", () => ({ useGroupDMStore: h.groups }));
vi.mock("../api/groupDM", () => ({ listGroupDMs: h.listGroups }));
vi.mock("../stores/dmStore", () => ({ useDMStore: h.dms }));
vi.mock("../api/dm", () => ({ listDMChannels: h.listDMs }));
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
const dm = { id: "dm", status: "accepted", is_muted: false, other_user: { id: "actor", username: "Actor" } };
function setupDM() {
  h.feed.set({ items: [{ ...notice, kind: "system", server_id: null, channel_id: null, dm_channel_id: "dm", payload: { action: "incoming_message", source: "dm" } }] });
  h.dms.set({ownerId:"owner",authGeneration:1,isLoading:false,channels:[dm],messagesByChannel:{dm:[{...message,channel_id:undefined,dm_channel_id:"dm"}]}});
  h.listDMs.mockResolvedValue({success:true,data:[dm]});
  return resolveOverlayNotificationReplySource("notice")!;
}
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
  h.groups.set({ownerId:"owner",authGeneration:1,groupsReady:true,loading:false,groups:[],messages:{}});
  h.e2ee.set({ initStatus: "ready", decryptionErrors: [], localDeviceId: "device" });
  h.ui.set({ destination: { type: "friends", channelId: "friends" }, navigationRevision: 0, panels: {}, activePanelId: "main" });
  useComposerDraftStore.getState().reset();
});
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function openSource(found: Promise<boolean> = Promise.resolve(true)) {
  return vi.fn(() => { h.ui.set({ destination: { type: "text", channelId: "channel", serverInfo: { serverId: "server" } }, navigationRevision: 1 }); return found; });
}
it("prepares an accepted DM's exact source after fresh access without copying or sending its draft", async () => {
  const source=setupDM(), draftKey=composerKey("owner","dm","dm"), files=[new File(["x"],"draft.txt")];
  useComposerDraftStore.getState().patch(draftKey,{content:"unfinished",files});
  const openDM=vi.fn(async()=>{h.ui.set({destination:{type:"dm",channelId:"dm"},navigationRevision:1});return true;});
  const channelOpen=vi.fn();
  expect(await prepareOverlayNotificationReply(source,channelOpen,()=>true,openDM)).toBe("prepared");
  expect(openDM).toHaveBeenCalledWith("dm","message",expect.objectContaining({isCurrent:expect.any(Function)}));
  expect(channelOpen).not.toHaveBeenCalled();
  expect(useComposerDraftStore.getState().drafts[draftKey]).toMatchObject({content:"unfinished",files,replyingTo:{id:"message",content:"hello"}});
  expect(h.markRead).toHaveBeenCalledExactlyOnceWith("notice");
});
it.each(["pending","muted","blocked","ignored","stale","spam","classification pending","decrypt"])("denies DM reply preparation when %s", async reason => {
  setupDM();
  if(reason==="pending")h.dms.set({channels:[{...dm,status:"pending"}]});
  if(reason==="muted")h.dms.set({channels:[{...dm,is_muted:true}]});
  if(reason==="blocked")h.blocks.set({blockedUserIds:["actor"]});
  if(reason==="ignored")h.ignored.actor=true;
  if(reason==="stale")h.dms.set({authGeneration:0});
  if(reason==="spam")h.spam=true;
  if(reason==="classification pending")h.pending=true;
  if(reason==="decrypt")h.dms.set({messagesByChannel:{dm:[{...message,dm_channel_id:"dm",encryption_version:1,content:null}]}});
  expect(resolveOverlayNotificationReplySource("notice")).toBeNull();
  expect(h.markRead).not.toHaveBeenCalled();
});
it("rejects authoritative DM denial and late account loss without opening or acknowledging",async()=>{
  let source=setupDM();const open=vi.fn();h.listDMs.mockResolvedValueOnce({success:true,data:[{...dm,status:"pending"}]});
  expect(await prepareOverlayNotificationReply(source,open,()=>true,open)).toBe("unavailable");
  source=setupDM();const wait=deferred<{success:boolean;data:typeof dm[]}>();h.listDMs.mockReturnValueOnce(wait.promise);
  const result=prepareOverlayNotificationReply(source,open,()=>true,open);h.scope={ownerId:"new-owner",generation:2};wait.resolve({success:true,data:[dm]});
  expect(await result).toBe("unavailable");expect(open).not.toHaveBeenCalled();expect(h.markRead).not.toHaveBeenCalled();
});
it("preserves a DM draft changed during source fetching and never acknowledges a conflicted reply",async()=>{
  const source=setupDM(),wait=deferred<boolean>(),draftKey=composerKey("owner","dm","dm");
  const open=vi.fn(()=>{h.ui.set({destination:{type:"dm",channelId:"dm"},navigationRevision:1});return wait.promise;});
  const result=prepareOverlayNotificationReply(source,vi.fn(),()=>true,open);
  await vi.waitFor(()=>expect(open).toHaveBeenCalled());
  useComposerDraftStore.getState().patch(draftKey,{content:"new draft"});wait.resolve(true);
  expect(await result).toBe("conflict");expect(useComposerDraftStore.getState().drafts[draftKey].content).toBe("new draft");expect(h.markRead).not.toHaveBeenCalled();
});
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

const group = {id:"group",name:"Group",key_epoch:3,read_key_epoch:3,is_muted:false,members:[{id:"owner"},{id:"actor"}]};
function setupGroup() {
  h.feed.set({items:[{...notice,kind:"system",server_id:null,channel_id:null,group_dm_channel_id:"group",payload:{action:"incoming_message",source:"group"}}]});
  h.groups.set({ownerId:"owner",authGeneration:1,groupsReady:true,loading:false,groups:[group],messages:{group:[{...message,channel_id:undefined,group_id:"group",key_epoch:1,encryption_version:1}]}});
  h.listGroups.mockResolvedValue({success:true,data:{group_dms:[group]}});
  return resolveOverlayNotificationReplySource("notice")!;
}
function openGroup() { return vi.fn(async()=>{h.ui.set({destination:{type:"group-dm",channelId:"group"},navigationRevision:1});return true;}); }
it("prepares historical group source using current membership epoch, preserving text/files and using the real group reply field",async()=>{
 const source=setupGroup(),draftKey=composerKey("owner","group","group"),files=[new File(["x"],"draft.txt")];
 useComposerDraftStore.getState().patch(draftKey,{content:"unfinished",files});const open=openGroup();
 expect(await prepareOverlayNotificationReply(source,vi.fn(),()=>true,undefined,open)).toBe("prepared");
 expect(useComposerDraftStore.getState().drafts[draftKey]).toMatchObject({content:"unfinished",files,groupReplyToId:"message",replyingTo:null});
 expect(open).toHaveBeenCalledWith("group","message",expect.objectContaining({isCurrent:expect.any(Function)}));expect(h.markRead).toHaveBeenCalledExactlyOnceWith("notice");
});
it.each(["removed","muted","stale epoch","blocked","ignored","pending spam","decrypt"])("denies group preparation for %s",async reason=>{
 setupGroup();if(reason==="removed")h.groups.set({groups:[]});if(reason==="muted")h.groups.set({groups:[{...group,is_muted:true}]});
 if(reason==="stale epoch")h.groups.set({groups:[{...group,read_key_epoch:2}]});if(reason==="blocked")h.blocks.set({blockedUserIds:["actor"]});
 if(reason==="ignored")h.ignored.actor=true;if(reason==="pending spam")h.pending=true;
 if(reason==="decrypt")h.groups.set({messages:{group:[{...message,group_id:"group",encryption_version:1,content:null}]}});
 expect(resolveOverlayNotificationReplySource("notice")).toBeNull();expect(h.markRead).not.toHaveBeenCalled();
});
it("does not open or acknowledge a group after authoritative denial or rejoin during access refresh",async()=>{
 const source=setupGroup(),read=deferred<{success:boolean;data:{group_dms:typeof group[]}}>();h.listGroups.mockReturnValueOnce(read.promise);const open=openGroup();
 const pending=prepareOverlayNotificationReply(source,vi.fn(),()=>true,undefined,open);h.groups.set({groups:[{...group,key_epoch:4,read_key_epoch:4}]});
 read.resolve({success:true,data:{group_dms:[group]}});expect(await pending).toBe("unavailable");expect(open).not.toHaveBeenCalled();expect(h.markRead).not.toHaveBeenCalled();
});
it("rejects group target changes while source loads and preserves an existing reply",async()=>{
 const source=setupGroup(),draftKey=composerKey("owner","group","group");useComposerDraftStore.getState().patch(draftKey,{groupReplyToId:"other",content:"keep"});
 expect(await prepareOverlayNotificationReply(source,vi.fn(),()=>true,undefined,openGroup())).toBe("conflict");expect(h.markRead).not.toHaveBeenCalled();
 useComposerDraftStore.getState().patch(draftKey,{groupReplyToId:undefined});const read=deferred<boolean>(),open=vi.fn(()=>{h.ui.set({destination:{type:"group-dm",channelId:"group"},navigationRevision:1});return read.promise;});
 const pending=prepareOverlayNotificationReply(source,vi.fn(),()=>true,undefined,open);await vi.waitFor(()=>expect(open).toHaveBeenCalled());
 h.e2ee.set({localDeviceId:"replacement"});read.resolve(true);expect(await pending).toBe("unavailable");expect(h.markRead).not.toHaveBeenCalled();
});

it("keeps a valid historical source after its author leaves and rejects draft edits during group loading",async()=>{
 const source=setupGroup(),draftKey=composerKey("owner","group","group");h.groups.set({groups:[{...group,members:[{id:"owner"}]}]});h.listGroups.mockResolvedValue({success:true,data:{group_dms:[{...group,members:[{id:"owner"}]}]}});
 const found=deferred<boolean>(),open=vi.fn(()=>{h.ui.set({destination:{type:"group-dm",channelId:"group"},navigationRevision:1});return found.promise;});
 const pending=prepareOverlayNotificationReply(source,vi.fn(),()=>true,undefined,open);await vi.waitFor(()=>expect(open).toHaveBeenCalled());
 useComposerDraftStore.getState().patch(draftKey,{content:"typed while loading"});found.resolve(true);expect(await pending).toBe("conflict");expect(h.markRead).not.toHaveBeenCalled();expect(useComposerDraftStore.getState().drafts[draftKey].content).toBe("typed while loading");
});

it("fails closed on a missing authoritative group list without navigating or acknowledging",async()=>{
 const source=setupGroup();h.listGroups.mockResolvedValueOnce({success:true,data:{}});const open=openGroup();
 expect(await prepareOverlayNotificationReply(source,vi.fn(),()=>true,undefined,open)).toBe("unavailable");expect(open).not.toHaveBeenCalled();expect(h.markRead).not.toHaveBeenCalled();
});
