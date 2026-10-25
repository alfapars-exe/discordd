import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { jumpToOldestUnread } from "./oldestUnreadShortcut";
const fixture = vi.hoisted(() => ({
  destination: { type:"text", channelId:"c", serverInfo:{ serverId:"s" } } as {type:string;channelId:string;serverInfo?:{serverId:string}}, navigationRevision:1,
  userId:"u", generation:1, getUnreadCounts:vi.fn(), fetchAroundMessage:vi.fn(), setScrollToMessageId:vi.fn(), toast:vi.fn(),listDMChannels:vi.fn(),fetchMessagesAround:vi.fn(),listGroupDMs:vi.fn(),setScrollTarget:vi.fn(),
}));
vi.mock("../api/client", () => ({ getAuthGeneration: () => fixture.generation }));
vi.mock("../api/readState", () => ({ getUnreadCounts:fixture.getUnreadCounts }));
vi.mock("../api/dm", () => ({listDMChannels:fixture.listDMChannels}));
vi.mock("../stores/dmStore", () => ({useDMStore:{getState:()=>fixture}}));
vi.mock("../api/groupDM", () => ({listGroupDMs:fixture.listGroupDMs}));
vi.mock("../stores/groupDMStore", () => ({useGroupDMStore:{getState:()=>fixture}}));
vi.mock("../stores/authStore", () => ({ useAuthStore:{ getState:() => ({user:{id:fixture.userId}}) } }));
vi.mock("../stores/uiStore", () => ({ useUIStore:{ getState:() => fixture } }));
vi.mock("../stores/messageStore", () => ({ useMessageStore:{ getState:() => fixture } }));
vi.mock("../stores/toastStore", () => ({ useToastStore:{ getState:() => ({addToast:fixture.toast}) } }));
vi.mock("../i18n", () => ({default:{t:(key:string) => key}}));
beforeEach(() => {
  vi.clearAllMocks(); fixture.userId="u"; fixture.generation=1; fixture.navigationRevision=1;
  fixture.destination={type:"text",channelId:"c",serverInfo:{serverId:"s"}};
  fixture.getUnreadCounts.mockResolvedValue({success:true,data:[{channel_id:"c",unread_count:300,oldest_unread_message_id:"old-unloaded"}]});
  fixture.fetchAroundMessage.mockResolvedValue(true);
  fixture.fetchMessagesAround.mockResolvedValue(true);
});
afterEach(() => { document.body.replaceChildren(); });
it("jumps in voice text chat only while its message surface is mounted", async () => {
  fixture.destination={type:"voice",channelId:"c",serverInfo:{serverId:"s"}};
  await jumpToOldestUnread();
  expect(fixture.getUnreadCounts).not.toHaveBeenCalled();
  const surface=document.createElement("div");surface.className="messages-scroll";document.body.append(surface);
  await jumpToOldestUnread();
  expect(fixture.fetchAroundMessage).toHaveBeenCalledWith("s","c","old-unloaded",expect.any(Object));
  expect(fixture.setScrollToMessageId).toHaveBeenCalledWith("old-unloaded");
});
it("loads a group authoritative unread anchor and signals its own scroll target", async () => {
  fixture.destination={type:"group-dm",channelId:"g"};
  fixture.listGroupDMs.mockResolvedValue({success:true,data:{group_dms:[{id:"g",unread_count:80,oldest_unread_message_id:"g-old"}]}});
  await jumpToOldestUnread();
  expect(fixture.fetchMessagesAround).toHaveBeenCalledWith("g","g-old",expect.objectContaining({isCurrent:expect.any(Function)}));
  expect(fixture.setScrollTarget).toHaveBeenCalledWith("g","g-old");
  expect(fixture.getUnreadCounts).not.toHaveBeenCalled();
  expect(fixture.setScrollToMessageId).not.toHaveBeenCalled();
});
it("jumps to a DM authoritative anchor without borrowing server unread state", async () => {
  fixture.destination={type:"dm",channelId:"private"};
  fixture.listDMChannels.mockResolvedValue({success:true,data:[{id:"private",unread_count:75,oldest_unread_message_id:"dm-old"}]});
  await jumpToOldestUnread();
  expect(fixture.getUnreadCounts).not.toHaveBeenCalled();
  expect(fixture.fetchMessagesAround).toHaveBeenCalledWith("private","dm-old",expect.objectContaining({isCurrent:expect.any(Function)}));
  expect(fixture.setScrollToMessageId).toHaveBeenCalledWith("dm-old");
});
it("discards a late DM anchor after navigation", async () => {
  fixture.destination={type:"dm",channelId:"private"};
  let resolve!:(value:unknown)=>void;
  fixture.listDMChannels.mockReturnValue(new Promise(done=>{resolve=done;}));
  const pending=jumpToOldestUnread(); fixture.navigationRevision++;
  resolve({success:true,data:[{id:"private",unread_count:1,oldest_unread_message_id:"late"}]}); await pending;
  expect(fixture.fetchMessagesAround).not.toHaveBeenCalled();
  expect(fixture.setScrollToMessageId).not.toHaveBeenCalled();
});
it("loads the authoritative unread anchor even outside loaded history without navigating or marking read", async () => {
  await jumpToOldestUnread();
  expect(fixture.fetchAroundMessage).toHaveBeenCalledWith("s","c","old-unloaded",expect.objectContaining({isCurrent:expect.any(Function),timeoutMs:15000}));
  expect(fixture.setScrollToMessageId).toHaveBeenCalledWith("old-unloaded");
  expect(fixture.navigationRevision).toBe(1);
  expect(fixture.toast).not.toHaveBeenCalled();
});
it("does not fetch another channel's anchor or infer one when the server omits it", async () => {
  fixture.getUnreadCounts.mockResolvedValue({success:true,data:[{channel_id:"other",unread_count:5,oldest_unread_message_id:"foreign"}]});
  await jumpToOldestUnread();
  expect(fixture.fetchAroundMessage).not.toHaveBeenCalled();
  expect(fixture.toast).toHaveBeenCalledWith("info","common:shortcutNoUnread");
});
it("does not replace a newer jump with an older response in the same conversation", async () => {
  let resolve!:(value:unknown)=>void;
  fixture.getUnreadCounts.mockReturnValueOnce(new Promise(done=>{resolve=done;}));
  const older=jumpToOldestUnread();
  await jumpToOldestUnread();
  resolve({success:true,data:[{channel_id:"c",unread_count:1,oldest_unread_message_id:"stale"}]});
  await older;
  expect(fixture.fetchAroundMessage).toHaveBeenCalledTimes(1);
  expect(fixture.setScrollToMessageId).toHaveBeenCalledTimes(1);
  expect(fixture.setScrollToMessageId).toHaveBeenCalledWith("old-unloaded");
});
it("ignores late anchor responses after navigation or account/session changes", async () => {
  for (const mutate of [() => {fixture.navigationRevision++;}, () => {fixture.userId="other";}, () => {fixture.generation++;}]) {
    fixture.userId="u"; fixture.generation=1; fixture.navigationRevision=1;
    let resolve!:(value:unknown) => void;
    fixture.getUnreadCounts.mockReturnValue(new Promise(done => {resolve=done;}));
    const pending=jumpToOldestUnread(); mutate();
    resolve({success:true,data:[{channel_id:"c",unread_count:1,oldest_unread_message_id:"late"}]}); await pending;
  }
  expect(fixture.fetchAroundMessage).not.toHaveBeenCalled();
  expect(fixture.toast).not.toHaveBeenCalled();
});
it("passes a live scope guard and does not scroll another destination after around fetch", async () => {
  let resolve!:(value:boolean) => void;
  fixture.fetchAroundMessage.mockReturnValue(new Promise(done => {resolve=done;}));
  const pending=jumpToOldestUnread();
  await vi.waitFor(() => expect(fixture.fetchAroundMessage).toHaveBeenCalled());
  const options=fixture.fetchAroundMessage.mock.calls[0][3];
  expect(options.isCurrent()).toBe(true);
  fixture.destination={...fixture.destination,channelId:"new"};
  expect(options.isCurrent()).toBe(false);
  resolve(true); await pending;
  expect(fixture.setScrollToMessageId).not.toHaveBeenCalled();
});
it("preserves modal focus and reports failures without a success toast", async () => {
  const dialog=document.createElement("dialog"); dialog.open=true; document.body.append(dialog);
  await jumpToOldestUnread(); expect(fixture.getUnreadCounts).not.toHaveBeenCalled(); dialog.remove();
  fixture.getUnreadCounts.mockResolvedValue({success:false});
  await jumpToOldestUnread();
  expect(fixture.toast).toHaveBeenCalledWith("error","common:shortcutJumpFailed");
  expect(fixture.setScrollToMessageId).not.toHaveBeenCalled();
});
