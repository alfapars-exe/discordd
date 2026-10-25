/**
 * dmStore jump-to-message tests (real store, API + crypto mocked):
 *
 *   1. fetchMessagesAround claims the channel before its first await, so the
 *      freshly opened DM tab's mount-time fetchMessages is skipped instead of
 *      aborting the jump — the around window wins and contains the target.
 *   2. A missing target releases the claim and loads the tail.
 *   3. Sending while detached returns to the present AFTER the POST, so the
 *      refetch includes the sender's own message (DMs have no local insert).
 *   4. Live messages held back while detached merge when paging hits the tail.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../api/dm", () => ({
  listDMChannels: vi.fn(),
  getDMMessages: vi.fn(),
  getDMMessagesAround: vi.fn(),
  getDMMessagesAfter: vi.fn(),
  sendDMMessage: vi.fn(),
  sendEncryptedDMMessage:vi.fn(),
  editEncryptedDMMessage:vi.fn(),editDMMessage:vi.fn(),
  deleteDMMessage:vi.fn(),
}));
vi.mock("../api/clientLog", () => ({ logToServer: vi.fn() }));
vi.mock("../crypto/dmEncryption", () => ({
  encryptDMMessage: vi.fn(),
  decryptDMMessages: vi.fn(async (msgs: unknown[]) => msgs),
  pushSentPlaintext: vi.fn(),
  discardLastSentPlaintext: vi.fn(),
  discardSentPlaintext:vi.fn(),
  persistSentPlaintext: vi.fn(),
  cacheEditPlaintext: vi.fn(),
  discardEditPlaintext:vi.fn(),
}));
vi.mock("../crypto/e2eePayload", () => ({ encodePayload: vi.fn((c: string) => c) }));
vi.mock("../crypto/fileEncryption", () => ({ encryptFile: vi.fn() }));
vi.mock("../crypto/dmMessageCache",()=>({cacheDMMessage:vi.fn(async()=>{})}));
vi.mock("../crypto/keyStorage",()=>({deleteCachedDMMessage:vi.fn(async()=>true)}));
// vi.hoisted: the toast spy and e2ee state are read by hoisted factories (#67).
const hoisted = vi.hoisted(() => ({
  addToast: vi.fn(),
  userId:"me" as string|null,
  e2ee: { initStatus: "ready", localDeviceId: null as string | null },
}));
vi.mock("./e2eeStore", () => ({
  useE2EEStore: { getState: () => hoisted.e2ee },
}));
vi.mock("./authStore", () => ({
  useAuthStore: { getState: () => ({ user: hoisted.userId?{id:hoisted.userId}:null }) },
}));
vi.mock("./uiStore", () => ({
  useUIStore: { getState: () => ({ closeDMTab: vi.fn() }) },
}));
vi.mock("./toastStore", () => ({
  useToastStore: { getState: () => ({ addToast: hoisted.addToast }) },
}));
vi.mock("../i18n", () => ({ default: { t: (k: string) => k } }));

import { useDMStore } from "./dmStore";
import * as dmApi from "../api/dm";
import { decryptDMMessages, encryptDMMessage, discardLastSentPlaintext,discardSentPlaintext,persistSentPlaintext,pushSentPlaintext } from "../crypto/dmEncryption";
import {encryptFile} from "../crypto/fileEncryption";
import type { APIResponse, DMMessage, DMMessagePage,DMChannelWithUser } from "../types";
import {useComposerDraftStore} from "./composerDraftStore";
import {cacheDMMessage} from "../crypto/dmMessageCache";
import {observeDMMessage} from "../crypto/dmMessageVersions";
import {beginDMHistoryBuffer} from "./slices/dmWsSlice";
import {deleteCachedDMMessage} from "../crypto/keyStorage";
import {encodePayload} from "../crypto/e2eePayload";
import { getAuthSessionSnapshot, publishAuthGenerationChange, publishAuthOwnerChange } from "../api/authSessionEvents";

const getDMMessages = vi.mocked(dmApi.getDMMessages);
const getAround = vi.mocked(dmApi.getDMMessagesAround);
const getAfter = vi.mocked(dmApi.getDMMessagesAfter);
const sendDM = vi.mocked(dmApi.sendDMMessage);
it("reports whether DM discovery succeeded so callers can distinguish failure from an empty list",async()=>{
  vi.mocked(dmApi.listDMChannels).mockResolvedValueOnce({success:true,data:[]});expect(await useDMStore.getState().fetchChannels()).toBe(true);expect(useDMStore.getState().isLoading).toBe(false);
  vi.mocked(dmApi.listDMChannels).mockResolvedValueOnce({success:false,error:"offline"});expect(await useDMStore.getState().fetchChannels()).toBe(false);expect(useDMStore.getState().isLoading).toBe(false);
});

const CH = "dm-1";

function makeDM(id: string): DMMessage {
  return {
    id,
    dm_channel_id: CH,
    user_id: "u-2",
    content: `content ${id}`,
    edited_at: null,
    created_at: "2026-10-22T10:00:00Z",
    reply_to_id: null,
    is_pinned: false,
    author: { id: "u-2", username: "bob", display_name: null, avatar_url: null, status: "online", custom_status: null, created_at: "" },
    attachments: [],
    reactions: [],
    referenced_message: null,
    encryption_version: 0,
  };
}

function page(messages: DMMessage[], hasMore: boolean, hasMoreAfter?: boolean): APIResponse<DMMessagePage> {
  return { success: true, data: { messages, has_more: hasMore, has_more_after: hasMoreAfter } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const ids = () => (useDMStore.getState().messagesByChannel[CH] ?? []).map((m) => m.id);

beforeEach(() => {
  hoisted.userId="me";
  useComposerDraftStore.getState().reset();
  publishAuthOwnerChange("me");
  publishAuthGenerationChange(getAuthSessionSnapshot().generation + 1);
  useDMStore.getState().invalidateFetchCache();
  useDMStore.setState({
    ownerId: "me",
    authGeneration: getAuthSessionSnapshot().generation,
    channels: [],
    messagesByChannel: {},
    hasMoreByChannel: {},
    hasMoreAfterByChannel: {},
    isLoadingMessages: false,
    isLoading:false,dmUnreadCounts:{},
  });
  vi.clearAllMocks();
  hoisted.e2ee.localDeviceId = null;
  hoisted.e2ee.initStatus="ready";
  vi.mocked(dmApi.listDMChannels).mockReset();
});

function listedDM(id:string,unread_count=0):DMChannelWithUser{return {id,other_user:makeDM("message").author,e2ee_enabled:true,status:"accepted",initiated_by:"me",created_at:"",last_message_at:null,is_pinned:false,is_muted:false,unread_count,last_message:null}}

describe("dmStore account provenance and send context", () => {
  it.each(["owner", "generation"]) ("clears cached DM data at an auth %s boundary", (boundary) => {
    useDMStore.setState({
      channels: [listedDM(CH)], messagesByChannel: { [CH]: [makeDM("private-old-account")] },
      selectedDMId: CH, dmUnreadCounts: { [CH]: 4 }, typingUsers: { [CH]: ["bob"] },
      replyingTo: makeDM("private-old-account"),
    });
    if (boundary === "owner") publishAuthOwnerChange("other-account");
    else publishAuthGenerationChange(getAuthSessionSnapshot().generation + 1);
    const state = useDMStore.getState();
    expect(state.ownerId).toBe(boundary === "owner" ? "other-account" : "me");
    expect(state.authGeneration).toBe(getAuthSessionSnapshot().generation);
    expect(state.channels).toEqual([]);
    expect(state.messagesByChannel).toEqual({});
    expect(state.dmUnreadCounts).toEqual({});
    expect(state.typingUsers).toEqual({});
    expect(state.replyingTo).toBeNull();
  });

  it("checks an optional caller context before dispatch and forwards it to the send API", async () => {
    useDMStore.setState({ channels: [{ ...listedDM(CH), e2ee_enabled: false }] });
    const scope = { ownerId: useDMStore.getState().ownerId!, authGeneration: useDMStore.getState().authGeneration };
    expect(await useDMStore.getState().sendMessage(CH, "blocked", undefined, undefined, { ...scope, isCurrent: () => false })).toBe(false);
    expect(sendDM).not.toHaveBeenCalled();

    sendDM.mockResolvedValueOnce({ success: true, data: makeDM("sent") });
    expect(await useDMStore.getState().sendMessage(CH, "allowed", undefined, undefined, { ...scope, isCurrent: () => true })).toBe(true);
    expect(sendDM).toHaveBeenCalledOnce();
    expect(sendDM.mock.calls[0][4]).toMatchObject({ isCurrent: expect.any(Function), timeoutMs: 60_000 });
    expect(sendDM.mock.calls[0][4]?.isCurrent?.()).toBe(true);

    expect(await useDMStore.getState().sendMessage(CH, "wrong account context", undefined, undefined, { ...scope, ownerId: "another-user" })).toBe(false);
    expect(sendDM).toHaveBeenCalledOnce();
  });

  it("does not POST encryption prepared before an auth-generation change", async () => {
    hoisted.e2ee.localDeviceId = "device";
    useDMStore.setState({ channels: [listedDM(CH)] });
    const pending = deferred<Awaited<ReturnType<typeof encryptDMMessage>>>();
    vi.mocked(encryptDMMessage).mockReturnValueOnce(pending.promise);
    const sending = useDMStore.getState().sendMessage(CH, "private under old session");
    await vi.waitFor(() => expect(encryptDMMessage).toHaveBeenCalledOnce());
    publishAuthGenerationChange(getAuthSessionSnapshot().generation + 1);
    pending.resolve([]);
    expect(await sending).toBe(false);
    expect(dmApi.sendEncryptedDMMessage).not.toHaveBeenCalled();
    expect(sendDM).not.toHaveBeenCalled();
  });
});

it("applies a confirmed HTTP deletion without requiring a WS echo, including an unloaded target",async()=>{
  vi.mocked(dmApi.deleteDMMessage).mockResolvedValueOnce({success:true,data:{id:"deleted",dm_channel_id:CH,message:"message deleted"}});
  expect(await useDMStore.getState().deleteMessage("deleted")).toBe(true);
  expect(useDMStore.getState().lastDeletedDM).toEqual({id:"deleted",dm_channel_id:CH});
  expect(deleteCachedDMMessage).toHaveBeenCalledWith("deleted",CH,expect.any(Function));
});
it("supports a legacy deletion receipt using the captured loaded conversation",async()=>{
  useDMStore.setState({messagesByChannel:{[CH]:[makeDM("deleted")]}});
  vi.mocked(dmApi.deleteDMMessage).mockResolvedValueOnce({success:true,data:{message:"message deleted"}});
  expect(await useDMStore.getState().deleteMessage("deleted")).toBe(true);expect(ids()).toEqual([]);
});
it("does not delete locally or clear cache after a failed HTTP deletion",async()=>{
  useDMStore.setState({messagesByChannel:{[CH]:[makeDM("deleted")]}});
  vi.mocked(dmApi.deleteDMMessage).mockResolvedValueOnce({success:false,error:"forbidden"});
  expect(await useDMStore.getState().deleteMessage("deleted")).toBe(false);
  expect(ids()).toEqual(["deleted"]);expect(deleteCachedDMMessage).not.toHaveBeenCalled();
});
it.each(["account","generation","device"])("does not apply a late HTTP deletion after %s replacement",async(change)=>{
  const pending=deferred<Awaited<ReturnType<typeof dmApi.deleteDMMessage>>>();vi.mocked(dmApi.deleteDMMessage).mockReturnValueOnce(pending.promise);
  const deleting=useDMStore.getState().deleteMessage("deleted");
  if(change==="account")hoisted.userId="other";else if(change==="generation")useComposerDraftStore.getState().reset();else hoisted.e2ee.localDeviceId="replacement";
  pending.resolve({success:true,data:{id:"deleted",dm_channel_id:CH,message:"message deleted"}});
  expect(await deleting).toBe(false);expect(deleteCachedDMMessage).not.toHaveBeenCalled();
});
it.each([{id:"other",dm_channel_id:CH},{id:"deleted",dm_channel_id:"other"},{id:"deleted"},{dm_channel_id:CH},{id:"deleted",dm_channel_id:""}])("does not apply a mismatched deletion receipt %j",async(receipt)=>{
  useDMStore.setState({messagesByChannel:{[CH]:[makeDM("deleted")]}});
  vi.mocked(dmApi.deleteDMMessage).mockResolvedValueOnce({success:true,data:{...receipt,message:"message deleted"}});
  expect(await useDMStore.getState().deleteMessage("deleted")).toBe(false);expect(ids()).toEqual(["deleted"]);expect(deleteCachedDMMessage).not.toHaveBeenCalled();
});
it.each(["account", "generation", "device"])("drops DM history fetched under an abandoned %s", async (change) => {
  const pending = deferred<APIResponse<DMMessagePage>>();
  vi.mocked(dmApi.getDMMessages).mockReturnValueOnce(pending.promise);
  const loading = useDMStore.getState().fetchMessages(CH);
  if (change === "account") hoisted.userId = "other";
  else if (change === "generation") useComposerDraftStore.getState().reset();
  else hoisted.e2ee.localDeviceId = "replacement";
  pending.resolve(page([makeDM("old")], false));
  await loading;
  expect(decryptDMMessages).not.toHaveBeenCalled();
  expect(ids()).toEqual([]);
});
it("keeps history cancellable while decryption is pending", async () => {
  const pending = deferred<DMMessage[]>();
  vi.mocked(dmApi.getDMMessages).mockResolvedValueOnce(page([makeDM("old")], false));
  vi.mocked(decryptDMMessages).mockReturnValueOnce(pending.promise);
  const loading = useDMStore.getState().fetchMessages(CH);
  await Promise.resolve();
  const guard = vi.mocked(decryptDMMessages).mock.calls[0][1];
  expect(guard?.()).toBe(true);
  useDMStore.getState().invalidateFetchCache();
  expect(guard?.()).toBe(false);
  pending.resolve([makeDM("old")]);
  await loading;
  expect(ids()).toEqual([]);
});
it("does not prepend an older page into a replaced history window", async () => {
  useDMStore.setState({messagesByChannel:{[CH]:[makeDM("anchor")]},hasMoreByChannel:{[CH]:true}});
  const pending = deferred<APIResponse<DMMessagePage>>();
  vi.mocked(dmApi.getDMMessages).mockReturnValueOnce(pending.promise);
  const loading = useDMStore.getState().fetchOlderMessages(CH);
  useDMStore.setState({messagesByChannel:{[CH]:[makeDM("replacement")]}});
  pending.resolve(page([makeDM("old")], false));
  await loading;
  expect(decryptDMMessages).not.toHaveBeenCalled();
  expect(ids()).toEqual(["replacement"]);
});
it("does not let an invalidated newer-page request release its replacement lock", async () => {
  const seed = () => useDMStore.setState({messagesByChannel:{[CH]:[makeDM("anchor")]},hasMoreAfterByChannel:{[CH]:true}});
  seed();
  const old = deferred<APIResponse<DMMessagePage>>();
  const replacement = deferred<APIResponse<DMMessagePage>>();
  vi.mocked(dmApi.getDMMessagesAfter).mockReturnValueOnce(old.promise).mockReturnValueOnce(replacement.promise);
  const first = useDMStore.getState().fetchNewerMessages(CH);
  useDMStore.getState().invalidateFetchCache();
  seed();
  const second = useDMStore.getState().fetchNewerMessages(CH);
  old.resolve(page([makeDM("stale")], false, false));
  await first;
  await useDMStore.getState().fetchNewerMessages(CH);
  expect(dmApi.getDMMessagesAfter).toHaveBeenCalledTimes(2);
  replacement.resolve(page([makeDM("new")], false, false));
  await second;
  expect(ids()).toEqual(["anchor", "new"]);
});
it.each(["network", "decrypt"])("releases the tail loader after a %s exception and allows retry", async (failure) => {
  if (failure === "network") getDMMessages.mockRejectedValueOnce(new Error("offline"));
  else {
    getDMMessages.mockResolvedValueOnce(page([makeDM("old")], false));
    vi.mocked(decryptDMMessages).mockRejectedValueOnce(new Error("decrypt failed"));
  }
  await useDMStore.getState().fetchMessages(CH);
  expect(useDMStore.getState().isLoadingMessages).toBe(false);
  expect(hoisted.addToast).toHaveBeenCalledWith("error", "dm:historyLoadFailed");
  getDMMessages.mockResolvedValueOnce(page([makeDM("retry")], false));
  await useDMStore.getState().fetchMessages(CH);
  expect(ids()).toEqual(["retry"]);
});
it("releases an around-message claim after failure without fetching a different window", async () => {
  getAround.mockResolvedValueOnce({success:false,error:"offline"});
  expect(await useDMStore.getState().fetchMessagesAround(CH, "target")).toBe(false);
  expect(getDMMessages).not.toHaveBeenCalled();
  expect(useDMStore.getState().isLoadingMessages).toBe(false);
  getDMMessages.mockResolvedValueOnce(page([makeDM("retry")], false));
  await useDMStore.getState().fetchMessages(CH);
  expect(ids()).toEqual(["retry"]);
});
it("rejects a stale caller before starting an around request", async () => {
  expect(await useDMStore.getState().fetchMessagesAround(CH,"target",{isCurrent:()=>false})).toBe(false);
  expect(getAround).not.toHaveBeenCalled();
  expect(useDMStore.getState().isLoadingMessages).toBe(false);
});
it("does not replace DM history after an around caller navigates away", async () => {
  const pending=deferred<APIResponse<DMMessagePage>>();
  getAround.mockReturnValueOnce(pending.promise);
  let current=true;
  const loading=useDMStore.getState().fetchMessagesAround(CH,"target",{isCurrent:()=>current});
  current=false;
  pending.resolve(page([makeDM("target")],true,true));
  expect(await loading).toBe(false);
  expect(ids()).toEqual([]);
  expect(useDMStore.getState().isLoadingMessages).toBe(false);
  expect(getDMMessages).not.toHaveBeenCalled();
});
it("does not let an old request failure clear the replacement loader or show a toast", async () => {
  const pending = deferred<APIResponse<DMMessagePage>>();
  const replacement = deferred<APIResponse<DMMessagePage>>();
  getDMMessages.mockReturnValueOnce(pending.promise).mockReturnValueOnce(replacement.promise);
  const first = useDMStore.getState().fetchMessages(CH);
  const second = useDMStore.getState().fetchMessages(CH);
  const oldOptions = getDMMessages.mock.calls[0][3];
  expect(oldOptions?.signal?.aborted).toBe(true);
  pending.resolve({success:false,error:"late failure"});
  await first;
  expect(useDMStore.getState().isLoadingMessages).toBe(true);
  expect(hoisted.addToast).not.toHaveBeenCalled();
  replacement.resolve(page([makeDM("current")], false));
  await second;
  expect(useDMStore.getState().isLoadingMessages).toBe(false);
  expect(ids()).toEqual(["current"]);
});
it("keeps the global loader active until both channel requests finish", async () => {
  const firstPage = deferred<APIResponse<DMMessagePage>>();
  const secondPage = deferred<APIResponse<DMMessagePage>>();
  getDMMessages.mockReturnValueOnce(firstPage.promise).mockReturnValueOnce(secondPage.promise);
  const first = useDMStore.getState().fetchMessages(CH);
  const second = useDMStore.getState().fetchMessages("other-channel");
  firstPage.resolve(page([], false));
  await first;
  expect(useDMStore.getState().isLoadingMessages).toBe(true);
  secondPage.resolve(page([], false));
  await second;
  expect(useDMStore.getState().isLoadingMessages).toBe(false);
});
it("does not resurrect a message deleted while tail history was loading", async () => {
  const pending=deferred<APIResponse<DMMessagePage>>();getDMMessages.mockReturnValueOnce(pending.promise);
  const loading=useDMStore.getState().fetchMessages(CH);
  observeDMMessage(CH,"deleted",true);
  pending.resolve(page([makeDM("deleted"),makeDM("kept")],false));await loading;
  expect(ids()).toEqual(["kept"]);
});
it("preserves a live edit instead of replacing it with the old history response", async () => {
  const pending=deferred<APIResponse<DMMessagePage>>();getDMMessages.mockReturnValueOnce(pending.promise);
  const loading=useDMStore.getState().fetchMessages(CH);
  observeDMMessage(CH,"edited");
  useDMStore.setState({messagesByChannel:{[CH]:[{...makeDM("edited"),content:"new"}]}});
  pending.resolve(page([makeDM("edited"),makeDM("other")],false));await loading;
  expect(useDMStore.getState().messagesByChannel[CH].find(message=>message.id==="edited")?.content).toBe("new");
  expect(ids()).toEqual(["edited","other"]);
});
it("retains a live create and its edit before the first tail window exists",async()=>{
  const pending=deferred<APIResponse<DMMessagePage>>();getDMMessages.mockReturnValueOnce(pending.promise);
  const loading=useDMStore.getState().fetchMessages(CH);
  observeDMMessage(CH,"live");useDMStore.getState().handleDMMessageCreate(makeDM("live"));
  observeDMMessage(CH,"live");useDMStore.getState().handleDMMessageUpdate({...makeDM("live"),content:"edited live"});
  expect(useDMStore.getState().messagesByChannel[CH]).toBeUndefined();
  pending.resolve(page([makeDM("history"),makeDM("live")],false));await loading;
  expect(ids()).toEqual(["history","live"]);
  expect(useDMStore.getState().messagesByChannel[CH][1].content).toBe("edited live");
});
it.each(["tail","around","older","newer"])("preserves off-page reaction and pin updates while %s history loads",async(direction)=>{
  const pending=deferred<APIResponse<DMMessagePage>>();
  if(direction==="older"||direction==="newer")useDMStore.setState({messagesByChannel:{[CH]:[makeDM("anchor")]},hasMoreByChannel:{[CH]:true},hasMoreAfterByChannel:{[CH]:true}});
  const read=direction==="around"?getAround:direction==="newer"?getAfter:getDMMessages;
  read.mockReturnValueOnce(pending.promise);
  const loading=direction==="tail"?useDMStore.getState().fetchMessages(CH):direction==="around"?useDMStore.getState().fetchMessagesAround(CH,"target"):direction==="older"?useDMStore.getState().fetchOlderMessages(CH):useDMStore.getState().fetchNewerMessages(CH);
  const reactions=[{emoji:"👍",count:1,users:["peer"]}];
  useDMStore.getState().handleDMReactionUpdate({dm_channel_id:CH,dm_message_id:"target",reactions});
  useDMStore.getState().handleDMMessagePin({dm_channel_id:CH,message:makeDM("target")});
  pending.resolve(page([makeDM("target")],false,false));await loading;
  const target=useDMStore.getState().messagesByChannel[CH].find(message=>message.id==="target");
  expect(target).toMatchObject({is_pinned:true,reactions});
});
it("keeps reaction removal and unpin as explicit values instead of restoring old history metadata",async()=>{
  const pending=deferred<APIResponse<DMMessagePage>>();getDMMessages.mockReturnValueOnce(pending.promise);
  const loading=useDMStore.getState().fetchMessages(CH);
  useDMStore.getState().handleDMMessagePin({dm_channel_id:CH,message:makeDM("target")});
  useDMStore.getState().handleDMMessageUnpin({dm_channel_id:CH,message_id:"target"});
  useDMStore.getState().handleDMReactionUpdate({dm_channel_id:CH,dm_message_id:"target",reactions:[]});
  pending.resolve(page([{...makeDM("target"),is_pinned:true,reactions:[{emoji:"👍",count:1,users:["peer"]}]}],false));await loading;
  expect(useDMStore.getState().messagesByChannel[CH][0]).toMatchObject({is_pinned:false,reactions:[]});
});
it("retains an eligible HTTP-confirmed encrypted send during initial loading before its WS echo",async()=>{
  hoisted.e2ee.localDeviceId="device";useDMStore.setState({channels:[listedDM(CH)]});
  const history=deferred<APIResponse<DMMessagePage>>();getDMMessages.mockReturnValueOnce(history.promise);
  const loading=useDMStore.getState().fetchMessages(CH);
  vi.mocked(encryptDMMessage).mockResolvedValueOnce([]);
  let sent!:DMMessage;
  vi.mocked(dmApi.sendEncryptedDMMessage).mockImplementationOnce(async(_id,ciphertext,sender_device_id,e2ee_metadata)=>{
    sent={...makeDM("sent"),user_id:"me",encryption_version:1,content:null,ciphertext,sender_device_id,e2ee_metadata};
    return {success:true,data:sent};
  });
  expect(await useDMStore.getState().sendMessage(CH,"confirmed text")).toBe(true);
  history.resolve(page([makeDM("history"),sent],false));await loading;
  expect(ids()).toEqual(["history","sent"]);
  expect(useDMStore.getState().messagesByChannel[CH][1].content).toBe("confirmed text");
});
it("removes a buffered live create when it is deleted before the tail response",async()=>{
  const pending=deferred<APIResponse<DMMessagePage>>();getDMMessages.mockReturnValueOnce(pending.promise);
  const loading=useDMStore.getState().fetchMessages(CH);
  observeDMMessage(CH,"live");useDMStore.getState().handleDMMessageCreate(makeDM("live"));
  observeDMMessage(CH,"live",true);useDMStore.getState().handleDMMessageDelete({dm_channel_id:CH,id:"live"});
  pending.resolve(page([makeDM("history"),makeDM("live")],false));await loading;
  expect(ids()).toEqual(["history"]);
});
it("retains an unloaded around target edit without mixing unrelated live tail messages",async()=>{
  const pending=deferred<APIResponse<DMMessagePage>>();getAround.mockReturnValueOnce(pending.promise);
  const loading=useDMStore.getState().fetchMessagesAround(CH,"target");
  observeDMMessage(CH,"target");useDMStore.getState().handleDMMessageUpdate({...makeDM("target"),content:"new target"});
  observeDMMessage(CH,"live");useDMStore.getState().handleDMMessageCreate(makeDM("live"));
  pending.resolve(page([makeDM("target")],true,true));expect(await loading).toBe(true);
  expect(ids()).toEqual(["target"]);expect(useDMStore.getState().messagesByChannel[CH][0].content).toBe("new target");
});
it("prefers a confirmed HTTP edit over the unchanged loaded around target",async()=>{
  const original={...makeDM("target"),user_id:"me"};hoisted.e2ee.localDeviceId="device";
  useDMStore.setState({channels:[listedDM(CH)],messagesByChannel:{[CH]:[original]}});
  const history=deferred<APIResponse<DMMessagePage>>();getAround.mockReturnValueOnce(history.promise);
  const loading=useDMStore.getState().fetchMessagesAround(CH,"target");
  vi.mocked(encryptDMMessage).mockResolvedValueOnce([]);
  vi.mocked(dmApi.editEncryptedDMMessage).mockImplementationOnce(async(_id,ciphertext,sender_device_id,e2ee_metadata)=>({success:true,data:{...original,ciphertext,sender_device_id,e2ee_metadata}}));
  expect(await useDMStore.getState().editMessage("target","confirmed edit")).toBe(true);
  history.resolve(page([original],false,false));expect(await loading).toBe(true);
  expect(useDMStore.getState().messagesByChannel[CH][0].content).toBe("confirmed edit");
});
it("keeps shared history events until the final reader releases its own lease",()=>{
  const first=beginDMHistoryBuffer(CH),second=beginDMHistoryBuffer(CH);
  useDMStore.getState().handleDMMessageCreate(makeDM("live"));first.release();
  expect(second.read().map(message=>message.id)).toEqual(["live"]);
  second.release();const fresh=beginDMHistoryBuffer(CH);expect(fresh.read()).toEqual([]);
  first.release();useDMStore.getState().handleDMMessageCreate(makeDM("new"));expect(fresh.read().map(message=>message.id)).toEqual(["new"]);fresh.release();
});
it("does not leak a failed history window buffer into its retry",async()=>{
  const pending=deferred<APIResponse<DMMessagePage>>();getDMMessages.mockReturnValueOnce(pending.promise);
  const loading=useDMStore.getState().fetchMessages(CH);
  observeDMMessage(CH,"live");useDMStore.getState().handleDMMessageCreate(makeDM("live"));
  pending.resolve({success:false,error:"offline"});await loading;
  const fresh=beginDMHistoryBuffer(CH);expect(fresh.read()).toEqual([]);fresh.release();
});
it.each(["network", "decrypt"])("releases the around claim after a %s exception", async (failure) => {
  if (failure === "network") getAround.mockRejectedValueOnce(new Error("offline"));
  else {
    getAround.mockResolvedValueOnce(page([makeDM("target")], false));
    vi.mocked(decryptDMMessages).mockRejectedValueOnce(new Error("decrypt failed"));
  }
  expect(await useDMStore.getState().fetchMessagesAround(CH,"target")).toBe(false);
  expect(useDMStore.getState().isLoadingMessages).toBe(false);
  getDMMessages.mockResolvedValueOnce(page([makeDM("retry")],false));
  await useDMStore.getState().fetchMessages(CH);
  expect(ids()).toEqual(["retry"]);
});
it.each(["older", "newer"])("preserves the page and permits retry after %s pagination fails", async (direction) => {
  useDMStore.setState({messagesByChannel:{[CH]:[makeDM("anchor")]},hasMoreByChannel:{[CH]:true},hasMoreAfterByChannel:{[CH]:true}});
  const read = direction === "older" ? getDMMessages : getAfter;
  const load = () => direction === "older" ? useDMStore.getState().fetchOlderMessages(CH) : useDMStore.getState().fetchNewerMessages(CH);
  read.mockRejectedValueOnce(new Error("offline"));
  await load();
  expect(ids()).toEqual(["anchor"]);
  expect(hoisted.addToast).toHaveBeenCalledWith("error","dm:historyLoadFailed");
  read.mockResolvedValueOnce(page([makeDM("retry")],false,false));
  await load();
  expect(ids()).toEqual(direction === "older" ? ["retry","anchor"] : ["anchor","retry"]);
});
it.each(["account", "generation", "device"])("rejects an around-message response from an abandoned %s", async (change) => {
  const pending = deferred<APIResponse<DMMessagePage>>();
  vi.mocked(dmApi.getDMMessagesAround).mockReturnValueOnce(pending.promise);
  const loading = useDMStore.getState().fetchMessagesAround(CH, "target");
  if (change === "account") hoisted.userId = "other";
  else if (change === "generation") useComposerDraftStore.getState().reset();
  else hoisted.e2ee.localDeviceId = "replacement";
  pending.resolve(page([makeDM("target")], false));
  expect(await loading).toBe(false);
  expect(decryptDMMessages).not.toHaveBeenCalled();
  expect(ids()).toEqual([]);
});
it.each(["account","generation"])("rejects a late DM list from the abandoned %s context",async(change)=>{
 const pending=deferred<APIResponse<DMChannelWithUser[]>>();vi.mocked(dmApi.listDMChannels).mockReturnValueOnce(pending.promise);const loading=useDMStore.getState().fetchChannels();
 const guard=vi.mocked(dmApi.listDMChannels).mock.calls[0][0]?.isCurrent;expect(guard?.()).toBe(true);
 if(change==="account")hoisted.userId="other";else useComposerDraftStore.getState().reset();
 useDMStore.setState({channels:[listedDM("current",2)],dmUnreadCounts:{current:2},isLoading:false});pending.resolve({success:true,data:[listedDM("old-private",99)]});expect(await loading).toBe(false);
 expect(guard?.()).toBe(false);expect(useDMStore.getState().channels.map(channel=>channel.id)).toEqual(["current"]);expect(useDMStore.getState().dmUnreadCounts).toEqual({current:2});
});
it("keeps the latest list and unread counts when overlapping refreshes finish in reverse order",async()=>{
 const first=deferred<APIResponse<DMChannelWithUser[]>>(),second=deferred<APIResponse<DMChannelWithUser[]>>();vi.mocked(dmApi.listDMChannels).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
 const old=useDMStore.getState().fetchChannels(),fresh=useDMStore.getState().fetchChannels();second.resolve({success:true,data:[listedDM("new",3)]});expect(await fresh).toBe(true);first.resolve({success:true,data:[listedDM("old",90)]});expect(await old).toBe(false);expect(useDMStore.getState().channels.map(channel=>channel.id)).toEqual(["new"]);expect(useDMStore.getState().dmUnreadCounts).toEqual({new:3});
});
it("does not let an in-flight list snapshot replace a newer WS message preview or unread count",async()=>{
 const pending=deferred<APIResponse<DMChannelWithUser[]>>();
 useDMStore.setState({channels:[listedDM("dm",1)],dmUnreadCounts:{dm:1}});
 vi.mocked(dmApi.listDMChannels).mockReturnValueOnce(pending.promise);
 const loading=useDMStore.getState().fetchChannels();
 useDMStore.getState().handleDMMessageCreate({...makeDM("new-live-message"),dm_channel_id:"dm"});
 useDMStore.getState().incrementDMUnread("dm");
 pending.resolve({success:true,data:[listedDM("dm",0)]});
 expect(await loading).toBe(true);
 expect(useDMStore.getState().channels[0].last_message?.id).toBe("new-live-message");
 expect(useDMStore.getState().dmUnreadCounts.dm).toBe(2);
});
it("does not resurrect unread counts cleared by a newer cross-session read event",async()=>{
 useDMStore.setState({channels:[listedDM("dm",3)],dmUnreadCounts:{dm:3}});
 const pending=deferred<APIResponse<DMChannelWithUser[]>>();
 vi.mocked(dmApi.listDMChannels).mockReturnValueOnce(pending.promise);
 const loading=useDMStore.getState().fetchChannels();
 useDMStore.getState().handleDMReadSync({dm_channel_id:"dm",unread_count:0});
 pending.resolve({success:true,data:[listedDM("dm",3)]});
 expect(await loading).toBe(true);
 expect(useDMStore.getState().dmUnreadCounts).toEqual({});
});
it("does not clear a newer loading state when an older refresh fails",async()=>{
 const first=deferred<APIResponse<DMChannelWithUser[]>>(),second=deferred<APIResponse<DMChannelWithUser[]>>();vi.mocked(dmApi.listDMChannels).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
 const old=useDMStore.getState().fetchChannels(),fresh=useDMStore.getState().fetchChannels();first.resolve({success:false,error:"old failure"});expect(await old).toBe(false);expect(useDMStore.getState().isLoading).toBe(true);second.resolve({success:true,data:[]});expect(await fresh).toBe(true);expect(useDMStore.getState().isLoading).toBe(false);
});
it("clears loading on an active thrown error and never fetches without an account",async()=>{
 vi.mocked(dmApi.listDMChannels).mockRejectedValueOnce(new Error("offline"));expect(await useDMStore.getState().fetchChannels()).toBe(false);expect(useDMStore.getState().isLoading).toBe(false);hoisted.userId=null;expect(await useDMStore.getState().fetchChannels()).toBe(false);expect(dmApi.listDMChannels).toHaveBeenCalledOnce();
});
it("fences pending metadata refreshes when the DM fetch cache is invalidated",async()=>{
 const pending=deferred<APIResponse<DMChannelWithUser[]>>();vi.mocked(dmApi.listDMChannels).mockReturnValueOnce(pending.promise);const loading=useDMStore.getState().fetchChannels();useDMStore.getState().invalidateFetchCache();pending.resolve({success:true,data:[listedDM("stale",5)]});expect(await loading).toBe(false);expect(useDMStore.getState().channels).toEqual([]);expect(useDMStore.getState().isLoading).toBe(false);
});

async function jumpIntoPast() {
  getAround.mockResolvedValueOnce(page([makeDM("old-1"), makeDM("target")], true, true));
  expect(await useDMStore.getState().fetchMessagesAround(CH, "target")).toBe(true);
}

describe("dmStore — fetchMessagesAround vs mount-time fetchMessages race", () => {
  it("skips fetchMessages while the jump is in flight; the around window wins", async () => {
    const around = deferred<APIResponse<DMMessagePage>>();
    getAround.mockReturnValueOnce(around.promise);

    const jumping = useDMStore.getState().fetchMessagesAround(CH, "target");
    await useDMStore.getState().fetchMessages(CH);
    expect(getDMMessages).not.toHaveBeenCalled();

    around.resolve(page([makeDM("a-1"), makeDM("target")], true, true));
    expect(await jumping).toBe(true);
    expect(ids()).toEqual(["a-1", "target"]);
    expect(useDMStore.getState().hasMoreAfterByChannel[CH]).toBe(true);
    expect(useDMStore.getState().isLoadingMessages).toBe(false);
  });

  it("releases the claim when the target is gone and loads the tail", async () => {
    getAround.mockResolvedValueOnce({ success: false, status: 404, error: "not found" });
    getDMMessages.mockResolvedValueOnce(page([makeDM("tail-1")], false));

    expect(await useDMStore.getState().fetchMessagesAround(CH, "gone")).toBe(false);
    await vi.waitFor(() => expect(ids()).toEqual(["tail-1"]));
  });
});

describe("dmStore — leaving a jumped-to window", () => {
  it("sending while detached refetches the tail after the POST so the own message shows", async () => {
    await jumpIntoPast();
    useDMStore.setState({channels:[{...listedDM(CH),e2ee_enabled:false}]});
    sendDM.mockResolvedValueOnce({ success: true, data: makeDM("mine") });
    // The echo arrives before the HTTP response and is held back (detached).
    useDMStore.getState().handleDMMessageCreate(makeDM("mine"));
    getDMMessages.mockResolvedValueOnce(page([makeDM("t-1"), makeDM("mine")], true));

    expect(await useDMStore.getState().sendMessage(CH, "hello")).toBe(true);
    expect(useDMStore.getState().hasMoreAfterByChannel[CH]).toBe(false);
    await vi.waitFor(() => expect(ids()).toEqual(["t-1", "mine"]));
    expect(getDMMessages).toHaveBeenCalledTimes(1);
  });

  it("merges held live messages when forward paging reaches the tail", async () => {
    await jumpIntoPast();
    useDMStore.getState().handleDMMessageCreate(makeDM("live-1"));
    expect(ids()).toEqual(["old-1", "target"]);

    getAfter.mockResolvedValueOnce(page([makeDM("new-1")], false, false));
    await useDMStore.getState().fetchNewerMessages(CH);
    expect(getAfter).toHaveBeenCalledWith(CH, "target", 50, expect.objectContaining({isCurrent:expect.any(Function),timeoutMs:15000}));
    expect(ids()).toEqual(["old-1", "target", "new-1", "live-1"]);
    expect(useDMStore.getState().hasMoreAfterByChannel[CH]).toBe(false);
  });
  it("uses the latest edit of a live message held outside a jumped-to window", async () => {
    await jumpIntoPast();
    useDMStore.getState().handleDMMessageCreate(makeDM("live"));
    useDMStore.getState().handleDMMessageUpdate({...makeDM("live"),content:"edited while held"});
    getAfter.mockResolvedValueOnce(page([],false,false));
    await useDMStore.getState().fetchNewerMessages(CH);
    expect(ids()).toEqual(["old-1","target","live"]);
    expect(useDMStore.getState().messagesByChannel[CH][2].content).toBe("edited while held");
  });
  it("retains held-message reaction and pin events while the forward response is pending",async()=>{
    await jumpIntoPast();useDMStore.getState().handleDMMessageCreate(makeDM("live"));
    const pending=deferred<APIResponse<DMMessagePage>>();getAfter.mockReturnValueOnce(pending.promise);
    const loading=useDMStore.getState().fetchNewerMessages(CH);
    const reactions=[{emoji:"👍",count:1,users:["peer"]}];
    useDMStore.getState().handleDMReactionUpdate({dm_channel_id:CH,dm_message_id:"live",reactions});
    useDMStore.getState().handleDMMessagePin({dm_channel_id:CH,message:makeDM("live")});
    pending.resolve(page([makeDM("live")],false,false));await loading;
    expect(useDMStore.getState().messagesByChannel[CH].find(message=>message.id==="live")).toMatchObject({reactions,is_pinned:true});
  });
});

describe("dmStore — encrypted self-DM send failure", () => {
  it.each(["edit","delete","matching_echo"])("fences a sent HTTP cache receipt against a live %s", async (event) => {
    hoisted.e2ee.localDeviceId="device";
    useDMStore.setState({channels:[listedDM(CH)]});
    vi.mocked(encryptDMMessage).mockResolvedValueOnce([]);
    const response=deferred<APIResponse<DMMessage>>();
    vi.mocked(dmApi.sendEncryptedDMMessage).mockReturnValueOnce(response.promise);
    const sending=useDMStore.getState().sendMessage(CH,"sent text");
    await vi.waitFor(()=>expect(dmApi.sendEncryptedDMMessage).toHaveBeenCalledOnce());
    const [,ciphertext,sender_device_id,e2ee_metadata]=vi.mocked(dmApi.sendEncryptedDMMessage).mock.calls[0];
    const sent={...makeDM("sent"),user_id:"me",ciphertext,sender_device_id,e2ee_metadata};
    observeDMMessage(CH,"sent",event==="delete",event==="matching_echo"?sent:{...sent,ciphertext:"newer"});
    response.resolve({success:true,data:sent});
    expect(await sending).toBe(true);
    if(event==="matching_echo")expect(cacheDMMessage).toHaveBeenCalledOnce();
    else expect(cacheDMMessage).not.toHaveBeenCalled();
  });
  it("does not cache a sent HTTP response attributed to a different device",async()=>{
    hoisted.e2ee.localDeviceId="device";useDMStore.setState({channels:[listedDM(CH)]});vi.mocked(encryptDMMessage).mockResolvedValueOnce([]);
    vi.mocked(dmApi.sendEncryptedDMMessage).mockImplementationOnce(async(_id,ciphertext,_device,e2ee_metadata)=>({success:true,data:{...makeDM("sent"),user_id:"me",ciphertext,e2ee_metadata,sender_device_id:"other-device"}}));
    expect(await useDMStore.getState().sendMessage(CH,"sent text")).toBe(true);expect(cacheDMMessage).not.toHaveBeenCalled();
  });
  it.each(["edit","delete"])("does not cache an old edit HTTP response after a live %s",async(event)=>{
    const original={...makeDM("edit"),user_id:"me"};hoisted.e2ee.localDeviceId="device";
    useDMStore.setState({channels:[listedDM(CH)],messagesByChannel:{[CH]:[original]}});vi.mocked(encryptDMMessage).mockResolvedValueOnce([]);
    const response=deferred<APIResponse<DMMessage>>();vi.mocked(dmApi.editEncryptedDMMessage).mockReturnValueOnce(response.promise);
    const editing=useDMStore.getState().editMessage("edit","old edit");
    await vi.waitFor(()=>expect(dmApi.editEncryptedDMMessage).toHaveBeenCalledOnce());
    const [,ciphertext,sender_device_id,e2ee_metadata]=vi.mocked(dmApi.editEncryptedDMMessage).mock.calls[0];
    observeDMMessage(CH,"edit",event==="delete",{...original,ciphertext:"newer"});
    response.resolve({success:true,data:{...original,ciphertext,sender_device_id,e2ee_metadata}});
    expect(await editing).toBe(true);expect(cacheDMMessage).not.toHaveBeenCalled();
  });
  it("preserves attachment keys and writes a source-bound cache after its own encrypted edit",async()=>{
    const keys=[{key:"key",iv:"iv",digest:"digest",filename:"file.txt",mimeType:"text/plain",originalSize:1}],original={...makeDM("edit"),user_id:"me",e2ee_file_keys:keys};hoisted.e2ee.localDeviceId="device";useDMStore.setState({channels:[listedDM(CH)],messagesByChannel:{[CH]:[original]}});vi.mocked(encryptDMMessage).mockResolvedValueOnce([]);
    vi.mocked(dmApi.editEncryptedDMMessage).mockImplementationOnce(async(_id,ciphertext,sender_device_id,e2ee_metadata)=>({success:true,data:{...original,ciphertext,sender_device_id,e2ee_metadata,edited_at:"2026-10-24T01:00:00Z"}}));
    expect(await useDMStore.getState().editMessage("edit","new text")).toBe(true);expect(encodePayload).toHaveBeenCalledWith("new text",keys);expect(cacheDMMessage).toHaveBeenCalledWith(expect.objectContaining({id:"edit"}),{content:"new text",file_keys:keys},expect.any(Function));expect(dmApi.editDMMessage).not.toHaveBeenCalled();
  });
  it.each(["RECIPIENT_NO_KEYS","not_ready","no_device"])("never downgrades an encrypted edit on %s",async(reason)=>{
    hoisted.e2ee.localDeviceId="device";useDMStore.setState({channels:[listedDM(CH)],messagesByChannel:{[CH]:[{...makeDM("edit"),user_id:"me"}]}});
    if(reason==="not_ready")hoisted.e2ee.initStatus="initializing";else if(reason==="no_device")hoisted.e2ee.localDeviceId=null;else vi.mocked(encryptDMMessage).mockRejectedValueOnce(new Error(reason));
    expect(await useDMStore.getState().editMessage("edit","new text")).toBe(false);expect(dmApi.editDMMessage).not.toHaveBeenCalled();expect(dmApi.editEncryptedDMMessage).not.toHaveBeenCalled();expect(cacheDMMessage).not.toHaveBeenCalled();
  });
  it("does not dispatch an old-session edit after encryption finishes",async()=>{
    hoisted.e2ee.localDeviceId="device";useDMStore.setState({channels:[listedDM(CH)],messagesByChannel:{[CH]:[{...makeDM("edit"),user_id:"me"}]}});const pending=deferred<Awaited<ReturnType<typeof encryptDMMessage>>>();vi.mocked(encryptDMMessage).mockReturnValueOnce(pending.promise);const editing=useDMStore.getState().editMessage("edit","new text");useComposerDraftStore.getState().reset();pending.resolve([]);expect(await editing).toBe(false);expect(dmApi.editEncryptedDMMessage).not.toHaveBeenCalled();expect(dmApi.editDMMessage).not.toHaveBeenCalled();expect(hoisted.addToast).not.toHaveBeenCalled();
  });
  it("does not edit attachments using an incomplete historical key array",async()=>{
    const original={...makeDM("edit"),user_id:"me",attachments:[{id:"a",dm_message_id:"edit",filename:"encrypted_2.bin",file_url:"/file",file_size:1,mime_type:"application/octet-stream"}],e2ee_file_keys:[]};hoisted.e2ee.localDeviceId="device";useDMStore.setState({channels:[listedDM(CH)],messagesByChannel:{[CH]:[original]}});expect(await useDMStore.getState().editMessage("edit","new text")).toBe(false);expect(encryptDMMessage).not.toHaveBeenCalled();expect(dmApi.editEncryptedDMMessage).not.toHaveBeenCalled();expect(dmApi.editDMMessage).not.toHaveBeenCalled();
  });
  it.each([true,false])("caches sent plaintext only for the matching HTTP source (matches=%s)",async(matches)=>{
    hoisted.e2ee.localDeviceId="device";useDMStore.setState({channels:[listedDM(CH)]});vi.mocked(encryptDMMessage).mockResolvedValueOnce([]);vi.mocked(dmApi.sendEncryptedDMMessage).mockImplementationOnce(async(_id,ciphertext,device,metadata)=>({success:true,data:{...makeDM("sent"),user_id:"me",ciphertext:matches?ciphertext:"different",sender_device_id:device,e2ee_metadata:metadata}}));
    expect(await useDMStore.getState().sendMessage(CH,"sent text")).toBe(true);if(matches)expect(cacheDMMessage).toHaveBeenCalledWith(expect.objectContaining({id:"sent",user_id:"me"}),{content:"sent text",file_keys:undefined},expect.any(Function));else expect(cacheDMMessage).not.toHaveBeenCalled();
  });
  it("binds queued payloads to distinct per-send metadata even for identical empty envelope arrays",async()=>{
    hoisted.e2ee.localDeviceId="device";useDMStore.setState({channels:[listedDM(CH)]});vi.mocked(encryptDMMessage).mockResolvedValueOnce([]).mockResolvedValueOnce([]);vi.mocked(dmApi.sendEncryptedDMMessage).mockResolvedValueOnce({success:true,data:makeDM("first")}).mockResolvedValueOnce({success:true,data:makeDM("second")});
    expect(await useDMStore.getState().sendMessage(CH,"first")).toBe(true);expect(await useDMStore.getState().sendMessage(CH,"second")).toBe(true);
    const calls=vi.mocked(dmApi.sendEncryptedDMMessage).mock.calls,first=calls[0][3],second=calls[1][3];expect(JSON.parse(first).client_send_id).toMatch(/^[a-f0-9-]{36}$/);expect(first).not.toBe(second);expect(vi.mocked(pushSentPlaintext).mock.calls.map(call=>call[2])).toEqual([{ciphertext:"[]",metadata:first},{ciphertext:"[]",metadata:second}]);
  });
  it.each(["RECIPIENT_NO_KEYS","not_ready","no_device"])("never downgrades encrypted DM to plaintext on %s",async(reason)=>{
    hoisted.e2ee.localDeviceId="device";useDMStore.setState({channels:[listedDM(CH)]});
    if(reason==="not_ready")hoisted.e2ee.initStatus="initializing";else if(reason==="no_device")hoisted.e2ee.localDeviceId=null;else vi.mocked(encryptDMMessage).mockRejectedValueOnce(new Error(reason));
    expect(await useDMStore.getState().sendMessage(CH,"private")).toBe(false);expect(sendDM).not.toHaveBeenCalled();expect(dmApi.sendEncryptedDMMessage).not.toHaveBeenCalled();expect(hoisted.addToast).toHaveBeenCalledWith("error","e2ee:encryptionFailed");
  });
  it.each(["account","generation","device"])("does not dispatch encryption prepared under the old %s context",async(change)=>{
    hoisted.e2ee.localDeviceId="device";useDMStore.setState({channels:[listedDM(CH)]});const encrypted=deferred<Awaited<ReturnType<typeof encryptDMMessage>>>();vi.mocked(encryptDMMessage).mockReturnValueOnce(encrypted.promise);
    const sending=useDMStore.getState().sendMessage(CH,"private");if(change==="account")hoisted.userId="other";else if(change==="generation")useComposerDraftStore.getState().reset();else hoisted.e2ee.localDeviceId="replacement";encrypted.resolve([]);expect(await sending).toBe(false);expect(dmApi.sendEncryptedDMMessage).not.toHaveBeenCalled();expect(sendDM).not.toHaveBeenCalled();expect(pushSentPlaintext).not.toHaveBeenCalled();expect(hoisted.addToast).not.toHaveBeenCalled();
  });
  it("stops after file preparation if the session changes before message encryption",async()=>{
    hoisted.e2ee.localDeviceId="device";useDMStore.setState({channels:[listedDM(CH)]});const encrypted=deferred<Awaited<ReturnType<typeof encryptFile>>>();vi.mocked(encryptFile).mockReturnValueOnce(encrypted.promise);
    const sending=useDMStore.getState().sendMessage(CH,"private",[new File(["private"],"file.txt")]);useComposerDraftStore.getState().reset();encrypted.resolve({encryptedBlob:new Blob(["cipher"]),meta:{key:"key",iv:"iv",filename:"file.txt",mimeType:"text/plain",originalSize:7,digest:"digest"}});expect(await sending).toBe(false);expect(encryptDMMessage).not.toHaveBeenCalled();expect(sendDM).not.toHaveBeenCalled();expect(dmApi.sendEncryptedDMMessage).not.toHaveBeenCalled();
  });
  it.each([true,false])("does not cache or toast a late encrypted HTTP result after session replacement (success=%s)",async(success)=>{
    hoisted.e2ee.localDeviceId="device";useDMStore.setState({channels:[listedDM(CH)]});vi.mocked(encryptDMMessage).mockResolvedValueOnce([]);const response=deferred<APIResponse<DMMessage>>();vi.mocked(dmApi.sendEncryptedDMMessage).mockReturnValueOnce(response.promise);
    const sending=useDMStore.getState().sendMessage(CH,"private");await vi.waitFor(()=>expect(dmApi.sendEncryptedDMMessage).toHaveBeenCalledOnce());useComposerDraftStore.getState().reset();response.resolve(success?{success:true,data:makeDM("sent")}:{success:false,status:500,error:"old failure"});expect(await sending).toBe(false);expect(persistSentPlaintext).not.toHaveBeenCalled();expect(hoisted.addToast).not.toHaveBeenCalled();expect(discardSentPlaintext).toHaveBeenCalledWith(CH,expect.objectContaining({content:"private"}));
  });
  it("SELF_FANOUT_UNAVAILABLE shows the encryption-failed toast and never sends plaintext", async () => {
    hoisted.e2ee.localDeviceId = "dev-local";
    useDMStore.setState({
      channels: [{ id: CH, e2ee_enabled: true, other_user: { id: "me" } }] as never,
    });
    vi.mocked(encryptDMMessage).mockRejectedValueOnce(new Error("SELF_FANOUT_UNAVAILABLE"));

    expect(await useDMStore.getState().sendMessage(CH, "secret note")).toBe(false);

    expect(sendDM).not.toHaveBeenCalled();
    expect(hoisted.addToast).toHaveBeenCalledWith("error", "e2ee:encryptionFailed");
    // Encryption failed before this send queued anything, so it must not
    // discard another in-flight send's queue entry.
    expect(discardLastSentPlaintext).not.toHaveBeenCalled();
  });
});
