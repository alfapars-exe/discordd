import { act, fireEvent, render, screen, waitFor,within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import GroupDMChat from "./GroupDMChat";
import { useGroupDMStore } from "../../stores/groupDMStore";
import { useAuthStore } from "../../stores/authStore";
import { useGroupCallStore } from "../../stores/groupCallStore";
import { getAuthGeneration } from "../../api/client";
import { publishAuthOwnerChange } from "../../api/authSessionEvents";
import { useE2EEStore } from "../../stores/e2eeStore";
import type { GroupDM, GroupDMMessage } from "../../types/groupDM";
import { reportUser } from "../../api/report";
import type { ReactNode } from "react";
import { useUIStore } from "../../stores/uiStore";
import { dispatchConversationCommand } from "../../utils/conversationCommands";
import { copyToClipboard } from "../../utils/constants";
import { speakMessage } from "../../utils/textToSpeech";
import { useToastStore } from "../../stores/toastStore";
import { composerKey, useComposerDraftStore } from "../../stores/composerDraftStore";
import { executeVoiceShortcut } from "../../hooks/useVoiceShortcutAction";
import { useShortcutCaptureStore } from "../../stores/shortcutCaptureStore";
import { pinCurrentGroupDMMessage } from "../../utils/groupDMPins";
vi.mock("../../utils/groupDMPins", () => ({ pinCurrentGroupDMMessage: vi.fn(async () => true) }));
vi.mock("./GroupDMPinsPanel", () => ({ default: ({ onClose }: { onClose: () => void }) => <aside aria-label="group-pins"><button onClick={onClose}>close-pins</button></aside> }));
const gate = vi.hoisted(() => ({ hidden: true, confirm: vi.fn(async () => true),forward:vi.fn(), touch:false }));
const callApi = vi.hoisted(() => ({ getToken: vi.fn(), list:vi.fn() }));
const expressionCallbacks = vi.hoisted(() => ({ emoji: undefined as ((value: string) => void) | undefined, gif: undefined as ((value: string) => void) | undefined, sticker: undefined as ((value: string) => void) | undefined }));
vi.mock("../shared/EmojiPicker", () => ({ default: ({ onSelect }: { onSelect: (value: string) => void }) => { expressionCallbacks.emoji = onSelect; return <button type="button" onClick={() => onSelect("😀")}>select-emoji</button>; } }));
vi.mock("../shared/GifPicker", () => ({ default: ({ onSelect }: { onSelect: (value: string) => void }) => { expressionCallbacks.gif = onSelect; return <button type="button" onClick={() => onSelect("https://static.klipy.com/example.gif")}>select-gif</button>; } }));
vi.mock("../shared/StickerPicker", () => ({ default: ({ onSelect }: { onSelect: (value: string) => void }) => { expressionCallbacks.sticker = onSelect; return <button type="button" onClick={() => onSelect("<sticker:sample:1>")}>select-sticker</button>; } }));
vi.mock("../../api/groupDM", () => ({ getGroupDMCallToken: callApi.getToken,listGroupDMs:callApi.list }));
vi.mock("../chat/ForwardMessageModal",()=>({default:({message,onClose}:{message:{content:string|null;attachments:unknown[]};onClose:()=>void})=>{gate.forward(message);return <div role="dialog" aria-label="forward-source"><p>{message.content}</p><button onClick={onClose}>close-forward</button></div>}}));
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => gate.confirm }));
vi.mock("../../hooks/useMediaQuery", () => ({ useIsTouch: () => gate.touch }));

vi.mock("react-i18next", async (original) => ({ ...(await original<typeof import("react-i18next")>()), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../api/report", () => ({ reportUser: vi.fn() }));
vi.mock("../../utils/constants",async (original)=>({...await original<typeof import("../../utils/constants")>(),copyToClipboard:vi.fn(async()=>{})}));
vi.mock("../../utils/textToSpeech",()=>({speakMessage:vi.fn(()=>true)}));
vi.mock("./GroupDMCall", () => ({ default: () => null }));
vi.mock("../shared/Avatar", () => ({ default: () => null }));
// A quarantined message must still be reportable without revealing its body.
vi.mock("../chat/GroupSpamGate", () => ({ default: ({children}:{children:ReactNode}) => gate.hidden ? <span>quarantined</span> : children }));

const message = (id: string, author: string): GroupDMMessage => ({
  id, group_id: "group", user_id: author, content: "private decrypted body",
  encryption_version: 1, ciphertext: "ciphertext", sender_device_id: "device",
  e2ee_metadata: null, key_epoch: 1, reply_to_id: null, edited_at: null,
  created_at: "2026-10-24T00:00:00Z", reactions: [], attachments: [],
});

it("saves a private group mute from the header and reflects authoritative saved state",async()=>{
  const save=vi.fn(async(_id:string,muted:boolean)=>{
    useGroupDMStore.getState().handleReadState({group_id:"group",last_read_message_id:null,unread_count:0,revision:0,is_muted:muted,settings_revision:1});return true;
  });
  useGroupDMStore.setState({setMuted:save});render(<GroupDMChat groupId="group"/>);
  fireEvent.click(screen.getByRole("button",{name:"dm:muteDM"}));
  await waitFor(()=>expect(save).toHaveBeenCalledExactlyOnceWith("group",true));
  expect(screen.getByRole("button",{name:"dm:unmuteDM"})).toHaveAttribute("aria-pressed","true");
});
beforeEach(() => {
  const active=useGroupCallStore.getState().session;if(active)useGroupCallStore.getState().leave(active.nonce);
  vi.clearAllMocks();
  expressionCallbacks.emoji = undefined; expressionCallbacks.gif = undefined; expressionCallbacks.sticker = undefined;
  useComposerDraftStore.getState().reset();
  gate.hidden = true; gate.confirm.mockResolvedValue(true);
  gate.touch = false;
  vi.mocked(copyToClipboard).mockResolvedValue(undefined); vi.mocked(speakMessage).mockReturnValue(true);
  vi.mocked(reportUser).mockResolvedValue({ success: true });
  callApi.getToken.mockReset();
  callApi.getToken.mockResolvedValue({ success: true, data: { url: "wss://voice.test", token: "token", channel_id:"group", e2ee_passphrase: "key",e2ee_key_context:"context",e2ee_key_epoch:1,e2ee_key_index:1 } });
  useShortcutCaptureStore.setState({ active: false });
  useUIStore.setState({ destination: { type: "group-dm", channelId: "group", label: "Test group" } as never });
  useAuthStore.setState({ user: { id: "me" } as NonNullable<ReturnType<typeof useAuthStore.getState>["user"]> });
  publishAuthOwnerChange("me");
  useE2EEStore.setState({ initStatus: "ready", localDeviceId: "test-device" });
  const group: GroupDM = { id: "group", name: "Test group", owner_id: "me", members: [{id:"me",username:"me",display_name:null,avatar_url:null,custom_status:null,status:"online",created_at:"2026-01-01"}], icon_url: null, key_epoch: 1, call_room_key: "room", unread_count: 0, created_at: "2026-10-24T00:00:00Z", updated_at: "2026-10-24T00:00:00Z" };
  useGroupDMStore.setState({ ownerId:"me",authGeneration:getAuthGeneration(),groups: [group], messages: { group: [message("own", "me"), message("other-message", "other")] },hasMoreAfterByGroup:{},scrollTarget:null, error: null,uploadRecoveries:{},pendingSends:{},groupsReady:true,setMuted:vi.fn(async()=>false),restoreStatus:"ready",restoreBlocked:[],restoredQueue:{}, fetchMessages: vi.fn(async () => true),jumpToPresent:vi.fn(), markRead: vi.fn(async () => {}),markUnread:vi.fn(async()=>true) });
  callApi.list.mockResolvedValue({success:true,data:{group_dms:[group]}});
});
it("loads group history when account crypto becomes ready after the route mounts", async () => {
  const fetchMessages = vi.fn(async () => true);
  useGroupDMStore.setState({ fetchMessages });
  useE2EEStore.setState({ initStatus: "initializing", localDeviceId: null });
  render(<GroupDMChat groupId="group" />);
  expect(fetchMessages).not.toHaveBeenCalled();
  act(() => useE2EEStore.setState({ initStatus: "ready", localDeviceId: "loaded-device" }));
  await waitFor(() => expect(fetchMessages).toHaveBeenCalledExactlyOnceWith("group"));
});

it("inserts an emoji at the current selection while preserving files and reply", () => {
  const key = composerKey("me", "group", "group"), file = new File(["keep"], "keep.txt");
  useComposerDraftStore.getState().patch(key, { content: "hello", files: [file], groupReplyToId: "reply" });
  render(<GroupDMChat groupId="group" />);
  const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
  textarea.setSelectionRange(1, 4);
  act(() => { expect(dispatchConversationCommand("emoji")).toBe(true); });
  fireEvent.click(screen.getByRole("button", { name: "select-emoji" }));
  expect(useComposerDraftStore.getState().drafts[key]).toMatchObject({ content: "h😀o", files: [file], groupReplyToId: "reply" });
});

it.each(["gif", "sticker"] as const)("sends a %s independently without clearing composer content, attachments or reply", async (kind) => {
  const key = composerKey("me", "group", "group"), file = new File(["keep"], "keep.txt");
  const send = vi.fn(async () => true);
  useGroupDMStore.setState({ send });
  useComposerDraftStore.getState().patch(key, { content: "keep draft", files: [file], groupReplyToId: "reply" });
  render(<GroupDMChat groupId="group" />);
  act(() => { expect(dispatchConversationCommand(kind)).toBe(true); });
  fireEvent.click(screen.getByRole("button", { name: `select-${kind}` }));
  await waitFor(() => expect(send).toHaveBeenCalledOnce());
  expect(send).toHaveBeenCalledWith("group", kind === "gif" ? "https://static.klipy.com/example.gif" : "<sticker:sample:1>", undefined, undefined,
    expect.objectContaining({ ownerId: "me", isCurrent: expect.any(Function) }));
  await waitFor(() => expect(useComposerDraftStore.getState().drafts[key].sending).toBeNull());
  expect(useComposerDraftStore.getState().drafts[key]).toMatchObject({ content: "keep draft", files: [file], groupReplyToId: "reply" });
});

it("retires picker callbacks after group key epoch changes and opens only one picker", () => {
  const send = vi.fn(async () => true);
  useGroupDMStore.setState({ send });
  render(<GroupDMChat groupId="group" />);
  fireEvent.click(screen.getByRole("button", { name: "chat:gif" }));
  const oldSelect = expressionCallbacks.gif!;
  fireEvent.click(screen.getByRole("button", { name: "chat:emoji" }));
  expect(screen.queryByRole("button", { name: "select-gif" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "select-emoji" })).toBeInTheDocument();
  act(() => useGroupDMStore.setState((state) => ({ groups: state.groups.map((item) => ({ ...item, key_epoch: item.key_epoch + 1 })) })));
  expect(screen.queryByRole("button", { name: "select-emoji" })).not.toBeInTheDocument();
  act(() => oldSelect("https://static.klipy.com/stale.gif"));
  expect(send).not.toHaveBeenCalled();
});

it("does not adopt an existing pending operation from a retained picker callback", () => {
  const send = vi.fn(async () => true);
  useGroupDMStore.setState({ send });
  render(<GroupDMChat groupId="group" />);
  fireEvent.click(screen.getByRole("button", { name: "chat:gif" }));
  const select = expressionCallbacks.gif!;
  act(() => useGroupDMStore.setState({ pendingSends: { group: { id: "other-operation", busy: true, current: () => true } as never } }));
  act(() => select("https://static.klipy.com/new.gif"));
  expect(send).not.toHaveBeenCalled();
  act(() => useGroupDMStore.setState({ pendingSends: {} }));
  expect(screen.queryByRole("button", { name: "select-gif" })).not.toBeInTheDocument();
});

it("keeps the composer draft on picker send failure and reports the error", async () => {
  const key = composerKey("me", "group", "group"), file = new File(["keep"], "keep.txt");
  const send = vi.fn(async () => false);
  useGroupDMStore.setState({ send });
  useComposerDraftStore.getState().patch(key, { content: "keep draft", files: [file], groupReplyToId: "reply" });
  const toast = vi.spyOn(useToastStore.getState(), "addToast");
  render(<GroupDMChat groupId="group" />);
  fireEvent.click(screen.getByRole("button", { name: "chat:gif" }));
  fireEvent.click(screen.getByRole("button", { name: "select-gif" }));
  await waitFor(() => expect(toast).toHaveBeenCalledWith("error", "error"));
  expect(useComposerDraftStore.getState().drafts[key]).toMatchObject({ content: "keep draft", files: [file], groupReplyToId: "reply", sending: null });
});

it("opens the upload shortcut and appends selected files without replacing the draft or reply", () => {
  const first = new File(["first"], "first.txt"), second = new File(["second"], "second.txt");
  const key = composerKey("me", "group", "group");
  useComposerDraftStore.getState().patch(key, { content: "keep", files: [first], groupReplyToId: "reply" });
  render(<GroupDMChat groupId="group" />);
  const input = screen.getByLabelText("groupAttachFiles") as HTMLInputElement;
  const click = vi.spyOn(input, "click").mockImplementation(() => {});
  act(() => { expect(dispatchConversationCommand("upload")).toBe(true); });
  expect(click).toHaveBeenCalledOnce();
  fireEvent.change(input, { target: { files: [second] } });
  expect(useComposerDraftStore.getState().drafts[key]).toMatchObject({ content: "keep", files: [first, second], groupReplyToId: "reply" });
  act(() => useGroupDMStore.setState({ restoreStatus: "loading" }));
  expect(input).toBeDisabled();
  act(() => { expect(dispatchConversationCommand("upload")).toBe(false); });
  expect(click).toHaveBeenCalledOnce();
});

it("caps group attachment selection instead of sending an oversized file list", () => {
  const key = composerKey("me", "group", "group");
  render(<GroupDMChat groupId="group" />);
  fireEvent.change(screen.getByLabelText("groupAttachFiles"), { target: { files: Array.from({ length: 11 }, (_, index) => new File(["x"], `${index}.txt`)) } });
  expect(useComposerDraftStore.getState().drafts[key].files).toHaveLength(10);
});

it("focuses and inserts background typing into the group draft without changing attachments or reply context", async () => {
  const file = new File(["keep"], "draft.txt");
  const key = composerKey("me", "group", "group");
  useComposerDraftStore.getState().patch(key, { content: "hello", files: [file], groupReplyToId: "reply-1" });
  render(<GroupDMChat groupId="group" />);
  const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
  fireEvent.change(textarea, { target: { value: "hello" } });
  act(() => { useComposerDraftStore.getState().patch(key, { groupEditingId: "edit-1" }); });
  textarea.blur();
  Object.defineProperty(textarea, "clientHeight", { configurable: true, value: 36 });
  vi.spyOn(textarea, "getClientRects").mockReturnValue([{ } as DOMRect] as unknown as DOMRectList);
  textarea.setSelectionRange(2, 4);
  const event = new KeyboardEvent("keydown", { key: "X", code: "KeyX", bubbles: true, cancelable: true });
  document.dispatchEvent(event);

  expect(event.defaultPrevented).toBe(true);
  expect(textarea).toHaveFocus();
  await waitFor(() => expect(textarea.selectionStart).toBe(3));
  expect(textarea).toHaveValue("heXo");
  expect(useComposerDraftStore.getState().drafts[key]).toMatchObject({
    content: "heXo",
    files: [file],
    groupReplyToId: "reply-1",
    groupEditingId: "edit-1",
  });
});

it("does not steal focus or consume a key when the group draft has no remaining capacity", () => {
  const key = composerKey("me", "group", "group");
  const full = "x".repeat(4000);
  useComposerDraftStore.getState().patch(key, { content: full });
  render(<GroupDMChat groupId="group" />);
  const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
  textarea.blur();
  const event = new KeyboardEvent("keydown", { key: "y", code: "KeyY", bubbles: true, cancelable: true });
  document.dispatchEvent(event);

  expect(event.defaultPrevented).toBe(false);
  expect(textarea).not.toHaveFocus();
  expect(useComposerDraftStore.getState().drafts[key].content).toBe(full);
});
it("does not steal focus on touch-first devices", () => {
  gate.touch = true;
  render(<GroupDMChat groupId="group" />);
  const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
  textarea.blur();
  const event = new KeyboardEvent("keydown", { key: "x", code: "KeyX", bubbles: true, cancelable: true });
  document.dispatchEvent(event);

  expect(event.defaultPrevented).toBe(false);
  expect(textarea).not.toHaveFocus();
  expect(textarea).toHaveValue("");
});
it("scrolls to a scoped group unread target without marking it read",async()=>{
  useGroupDMStore.setState({fetchMessages:vi.fn(async()=>false)});
  render(<GroupDMChat groupId="group"/>);
  const article=document.querySelector<HTMLElement>('[data-group-message-id="other-message"]');expect(article).not.toBeNull();
  const scrollIntoView=vi.fn();article!.scrollIntoView=scrollIntoView;
  let request:number|null=null;act(()=>{request=useGroupDMStore.getState().setScrollTarget("group","other-message")});
  await waitFor(()=>expect(scrollIntoView).toHaveBeenCalledWith({block:"center"}));
  expect(useGroupDMStore.getState().scrollTarget).toBeNull();expect(useGroupDMStore.getState().markRead).not.toHaveBeenCalled();expect(request).toEqual(expect.any(Number));
});
it("exposes an explicit jump-to-present action for detached group history",()=>{
  const jumpToPresent=vi.fn();useGroupDMStore.setState({hasMoreAfterByGroup:{group:true},jumpToPresent});
  render(<GroupDMChat groupId="group"/>);
  fireEvent.click(screen.getByRole("button",{name:"jumpToPresent"}));
  expect(jumpToPresent).toHaveBeenCalledWith("group");
});
it("blocks new sends while an operation is unresolved and exposes an explicit result check",async()=>{
  const retry=vi.fn(async()=>false),send=vi.fn(async()=>true);
  useGroupDMStore.setState({send,retryPendingSend:retry,pendingSends:{group:{id:"request-00000001",busy:false,content:"original",payload:{ciphertext:"encrypted",sender_device_id:"d",key_epoch:1,e2ee_metadata:"{}"},current:()=>true,started:0,draftRevision:0}}});
  render(<GroupDMChat groupId="group"/>);fireEvent.change(screen.getByRole("textbox"),{target:{value:"new draft"}});
  expect(screen.getByRole("button",{name:"send"})).toBeDisabled();
  fireEvent.keyDown(screen.getByRole("textbox"),{key:"Enter"});expect(send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{name:"groupSendCheckRetry"}));await waitFor(()=>expect(retry).toHaveBeenCalledWith("group"));
  expect(screen.getByRole("textbox")).toHaveValue("new draft");expect(screen.getByText("groupSendKeepOpen")).toBeInTheDocument();
});
it("starts a group call with Ctrl+Quote only for the active group destination",async()=>{
  render(<GroupDMChat groupId="group"/>);
  expect(executeVoiceShortcut("group-call-start",new KeyboardEvent("keydown",{key:"'",code:"Quote",ctrlKey:true,bubbles:true,cancelable:true}))).toBe(true);
  await waitFor(()=>expect(callApi.getToken).toHaveBeenCalledExactlyOnceWith("group",expect.objectContaining({timeoutMs:15000,isCurrent:expect.any(Function),signal:expect.any(AbortSignal)})));
  await waitFor(()=>expect(screen.getByRole("button",{name:"leaveCall"})).toBeInTheDocument());
});
it("does not start a call for a background group or while a modal/input/capture owns the key",()=>{
  const view=render(<GroupDMChat groupId="group"/>);
  useUIStore.setState({destination:{type:"group-dm",channelId:"another-group",label:"Other"} as never});
  const key=()=>new KeyboardEvent("keydown",{key:"'",code:"Quote",ctrlKey:true,bubbles:true,cancelable:true});
  expect(executeVoiceShortcut("group-call-start",key())).toBe(false);
  useUIStore.setState({destination:{type:"group-dm",channelId:"group",label:"Test group"} as never});
  const input=screen.getByRole("textbox");input.focus();
  expect(executeVoiceShortcut("group-call-start",key())).toBe(false);
  input.blur();
  useShortcutCaptureStore.setState({active:true});
  expect(executeVoiceShortcut("group-call-start",key())).toBe(false);
  useShortcutCaptureStore.setState({active:false});
  const dialog=document.createElement("dialog");dialog.setAttribute("open","");document.body.append(dialog);
  expect(executeVoiceShortcut("group-call-start",key())).toBe(false);
  dialog.remove();view.unmount();
  expect(callApi.getToken).not.toHaveBeenCalled();
});
it("keeps an explicitly requested pending call when the destination changes",async()=>{
  let resolve!:(value:unknown)=>void;
  callApi.getToken.mockReturnValueOnce(new Promise(done=>{resolve=done}));
  render(<GroupDMChat groupId="group"/>);
  expect(executeVoiceShortcut("group-call-start",new KeyboardEvent("keydown",{key:"'",code:"Quote",ctrlKey:true,bubbles:true,cancelable:true}))).toBe(true);
  await waitFor(()=>expect(callApi.getToken).toHaveBeenCalledTimes(1));
  useUIStore.setState({destination:{type:"friends",channelId:"friends",label:"Friends"} as never});
  await act(async()=>resolve({success:true,data:{url:"wss://voice.test",token:"late",channel_id:"group",e2ee_passphrase:"key",e2ee_key_context:"context",e2ee_key_epoch:1,e2ee_key_index:1}}));
  expect(screen.getByRole("button",{name:"leaveCall"})).toBeInTheDocument();
});
it("does not cancel a replacement operation after a delayed confirmation",async()=>{
  const cancel=vi.fn(async()=>true);let confirm!:(value:boolean)=>void;gate.confirm.mockReturnValueOnce(new Promise(resolve=>{confirm=resolve}));
  const pending={id:"original-request-01",busy:false,content:"original",payload:{ciphertext:"encrypted",sender_device_id:"d",key_epoch:1,e2ee_metadata:"{}"},current:()=>true,started:0,draftRevision:0};
  useGroupDMStore.setState({cancelPendingSend:cancel,pendingSends:{group:pending}});render(<GroupDMChat groupId="group"/>);
  fireEvent.click(screen.getByRole("button",{name:"groupSendCancel"}));expect(gate.confirm).toHaveBeenCalled();
  act(()=>useGroupDMStore.setState({pendingSends:{group:{...pending,id:"replacement-request"}}}));await act(async()=>confirm(true));
  expect(cancel).not.toHaveBeenCalled();
});
it("distinguishes known delivery from unresolved sends and exposes result checking without cancellation",()=>{
  useGroupDMStore.setState({pendingSends:{group:{id:"confirmed-request",busy:false,content:"delivered",payload:{ciphertext:"encrypted",sender_device_id:"d",key_epoch:1,e2ee_metadata:"{}"},current:()=>true,started:0,draftRevision:0,resultConfirmed:true,lookupOnly:true,stored:true}}});
  render(<GroupDMChat groupId="group"/>);expect(screen.getByText("groupSendCommittedRecovery")).toBeInTheDocument();expect(screen.queryByText("groupSendUncertain")).not.toBeInTheDocument();expect(screen.getByRole("button",{name:"groupSendCheckOnly"})).toBeInTheDocument();expect(screen.queryByRole("button",{name:"groupSendCancel"})).not.toBeInTheDocument();
});
it("opens forwarding only from revealed group content and closes it when the source changes",()=>{
 gate.hidden=false;render(<GroupDMChat groupId="group"/>);fireEvent.click(screen.getAllByRole("button",{name:"chat:forwardMessage"})[0]);expect(screen.getByRole("dialog",{name:"forward-source"})).toBeInTheDocument();expect(gate.forward.mock.calls.at(-1)?.[0]).toMatchObject({id:"own",content:"private decrypted body",encryption_version:1});
 act(()=>useGroupDMStore.setState(state=>({messages:{...state.messages,group:state.messages.group.map(item=>item.id==="own"?{...item,content:"edited"}:item)}})));expect(screen.queryByRole("dialog",{name:"forward-source"})).not.toBeInTheDocument();
});
it("does not expose forwarding for quarantined or undecryptable group content",()=>{
 const view=render(<GroupDMChat groupId="group"/>);expect(screen.queryByRole("button",{name:"chat:forwardMessage"})).not.toBeInTheDocument();gate.hidden=false;act(()=>useGroupDMStore.setState(state=>({messages:{...state.messages,group:[{...state.messages.group[0],content:null}]}})));view.rerender(<GroupDMChat groupId="group"/>);expect(screen.getByRole("button",{name:"chat:forwardMessage"})).toBeDisabled();
});
it("offers a visible failed-files-only retry without consuming a newer composer draft",async()=>{
  const file=new File(["retry"],"failed.txt"),send=vi.fn(async()=>true);
  useGroupDMStore.setState({send,uploadRecoveries:{group:[{id:"r",messageId:"saved",files:[file],replyToId:"reply",retrying:false,retryable:true}]}});
  render(<GroupDMChat groupId="group"/>);
  fireEvent.change(screen.getByRole("textbox"),{target:{value:"new draft"}});
  const recovery=screen.getByRole("region",{name:"groupUploadRecovery"});
  expect(within(recovery).getByText("failed.txt")).toBeInTheDocument();
  fireEvent.click(within(recovery).getByRole("button",{name:"groupRetryFailedFiles"}));
  await waitFor(()=>expect(send).toHaveBeenCalledWith("group","","reply",[file]));
  await waitFor(()=>expect(screen.queryByRole("region",{name:"groupUploadRecovery"})).not.toBeInTheDocument());
  expect(screen.getByRole("textbox")).toHaveValue("new draft");
});
it("requires review of uncertain outcomes and allows removing individual restored files",()=>{
  const files=[new File(["a"],"one.txt"),new File(["b"],"two.txt")];
  useGroupDMStore.setState({uploadRecoveries:{group:[{id:"r",messageId:"saved",files,retrying:false,retryable:false}]}});
  render(<GroupDMChat groupId="group"/>);
  expect(screen.queryByRole("button",{name:"groupRetryFailedFiles"})).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole("textbox"),{target:{value:"new draft"}});
  fireEvent.click(screen.getByRole("button",{name:"groupReviewFiles"}));
  expect(screen.queryByRole("region",{name:"groupUploadRecovery"})).not.toBeInTheDocument();
  expect(screen.getByRole("textbox")).toHaveValue("new draft");
  expect(screen.getByText("one.txt")).toBeInTheDocument();expect(screen.getByText("two.txt")).toBeInTheDocument();
  fireEvent.click(screen.getAllByRole("button",{name:"groupRemoveFile"})[1]);
  expect(screen.queryByText("two.txt")).not.toBeInTheDocument();
  expect(screen.getByText("one.txt")).toBeInTheDocument();
});
it("preserves a newer draft typed while a group send is pending",async()=>{
  let finish!:(success:boolean)=>void;
  const send=vi.fn(()=>new Promise<boolean>(resolve=>{finish=resolve}));
  useGroupDMStore.setState({send});
  render(<GroupDMChat groupId="group"/>);
  fireEvent.change(screen.getByRole("textbox"),{target:{value:"first message"}});
  fireEvent.click(screen.getByRole("button",{name:"send"}));
  expect(send).toHaveBeenCalledWith("group","first message",undefined,[]);
  fireEvent.change(screen.getByRole("textbox"),{target:{value:"next draft"}});
  await act(async()=>finish(true));
  expect(screen.getByRole("textbox")).toHaveValue("next draft");
  expect(screen.getByRole("button",{name:"send"})).toBeEnabled();
});
it("keeps drafts scoped to the group and restores them when returning",()=>{
  const current=useGroupDMStore.getState().groups[0];
  useGroupDMStore.setState({groups:[current,{...current,id:"second-group",name:"Second"}]});
  const {rerender}=render(<GroupDMChat groupId="group"/>);
  fireEvent.change(screen.getByRole("textbox"),{target:{value:"first group draft"}});
  rerender(<GroupDMChat groupId="second-group"/>);
  expect(screen.getByRole("textbox")).toHaveValue("");
  fireEvent.change(screen.getByRole("textbox"),{target:{value:"second group draft"}});
  rerender(<GroupDMChat groupId="group"/>);
  expect(screen.getByRole("textbox")).toHaveValue("first group draft");
});
it("retains the draft when the server refuses a send",async()=>{
  useGroupDMStore.setState({send:vi.fn(async()=>false)});
  render(<GroupDMChat groupId="group"/>);
  fireEvent.change(screen.getByRole("textbox"),{target:{value:"retry me"}});
  fireEvent.click(screen.getByRole("button",{name:"send"}));
  await waitFor(()=>expect(screen.getByRole("button",{name:"send"})).toBeEnabled());
  expect(screen.getByRole("textbox")).toHaveValue("retry me");
});
it.each(["cancel","success"])("restores pre-edit text, files and reply after %s",async(outcome)=>{
  gate.hidden=false;
  const edit=vi.fn(async()=>true);useGroupDMStore.setState({edit});
  render(<GroupDMChat groupId="group"/>);
  const file=new File(["unsent"],"draft.txt");
  fireEvent.change(screen.getByRole("textbox"),{target:{value:"saved draft"}});
  fireEvent.change(screen.getByLabelText("groupAttachFiles"),{target:{files:[file]}});
  fireEvent.click(screen.getAllByRole("button",{name:"reply"})[1]);
  fireEvent.click(screen.getByRole("button",{name:"edit"}));
  expect(screen.getByRole("textbox")).toHaveValue("private decrypted body");
  expect(screen.getByRole("textbox")).toHaveFocus();
  expect(screen.queryByLabelText("groupAttachFiles")).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole("textbox"),{target:{value:"new edit"}});
  if(outcome==="cancel")fireEvent.click(screen.getByRole("button",{name:"groupCancelEdit"}));
  else {fireEvent.click(screen.getByRole("button",{name:"send"}));await waitFor(()=>expect(edit).toHaveBeenCalledWith("group","own","new edit"));}
  await waitFor(()=>expect(screen.getByRole("textbox")).toHaveValue("saved draft"));
  const draft=Object.values(useComposerDraftStore.getState().drafts)[0];
  expect(draft).toMatchObject({content:"saved draft",files:[file],groupReplyToId:"other-message"});
  expect(draft.groupEditBackup).toBeUndefined();
  expect(screen.getByRole("button",{name:"groupCancelReply"})).toBeInTheDocument();
});
it("Escape restores a pre-edit draft, and cancelling a reply does not erase it",()=>{
  gate.hidden=false;
  render(<GroupDMChat groupId="group"/>);
  fireEvent.change(screen.getByRole("textbox"),{target:{value:"keep this draft"}});
  fireEvent.click(screen.getAllByRole("button",{name:"reply"})[1]);
  fireEvent.click(screen.getByRole("button",{name:"groupCancelReply"}));
  expect(screen.getByRole("textbox")).toHaveValue("keep this draft");
  expect(screen.getByRole("textbox")).toHaveFocus();
  fireEvent.click(screen.getByRole("button",{name:"edit"}));
  fireEvent.change(screen.getByRole("textbox"),{target:{value:"discarded edit"}});
  fireEvent.keyDown(screen.getByRole("textbox"),{key:"Escape",code:"Escape"});
  expect(screen.getByRole("textbox")).toHaveValue("keep this draft");
  expect(screen.queryByRole("button",{name:"groupCancelEdit"})).not.toBeInTheDocument();
});
it("does not send text during IME composition",()=>{
  const send=vi.fn(async()=>true);useGroupDMStore.setState({send});
  render(<GroupDMChat groupId="group"/>);
  fireEvent.change(screen.getByRole("textbox"),{target:{value:"composing"}});
  fireEvent.keyDown(screen.getByRole("textbox"),{key:"Enter",code:"Enter",isComposing:true});
  expect(send).not.toHaveBeenCalled();expect(screen.getByRole("textbox")).toHaveValue("composing");
});
it("keeps failed edit text retryable and restores the original draft when cancelled",async()=>{
  gate.hidden=false;useGroupDMStore.setState({edit:vi.fn(async()=>false)});
  render(<GroupDMChat groupId="group"/>);
  fireEvent.change(screen.getByRole("textbox"),{target:{value:"original unsent"}});
  fireEvent.click(screen.getByRole("button",{name:"edit"}));
  fireEvent.change(screen.getByRole("textbox"),{target:{value:"retry this edit"}});
  fireEvent.click(screen.getByRole("button",{name:"send"}));
  await waitFor(()=>expect(screen.getByRole("button",{name:"groupCancelEdit"})).toBeEnabled());
  expect(screen.getByRole("textbox")).toHaveValue("retry this edit");
  fireEvent.click(screen.getByRole("button",{name:"groupCancelEdit"}));
  expect(screen.getByRole("textbox")).toHaveValue("original unsent");
});
it("copies and speaks readable group messages through the shared pointer actions", async()=>{
  gate.hidden=false;
  render(<GroupDMChat groupId="group"/>);
  fireEvent.click(screen.getAllByRole("button",{name:"chat:copyMessage"})[1]);
  await waitFor(()=>expect(copyToClipboard).toHaveBeenCalledWith("private decrypted body"));
  fireEvent.click(screen.getAllByRole("button",{name:"shortcutMessageSpeak"})[1]);
  expect(speakMessage).toHaveBeenCalledWith("","private decrypted body");
});
it("shows actual copy/speech failures without a success notice",async()=>{
  gate.hidden=false;
  vi.mocked(copyToClipboard).mockRejectedValueOnce(new Error("clipboard denied"));
  vi.mocked(speakMessage).mockReturnValueOnce(false);
  const toast=vi.spyOn(useToastStore.getState(),"addToast");
  render(<GroupDMChat groupId="group"/>);
  fireEvent.click(screen.getAllByRole("button",{name:"chat:copyMessage"})[0]);
  await waitFor(()=>expect(toast).toHaveBeenCalledWith("error","shortcutCopyFailed"));
  fireEvent.click(screen.getAllByRole("button",{name:"shortcutMessageSpeak"})[0]);
  expect(toast).toHaveBeenCalledWith("error","shortcutSpeechUnavailable");
  toast.mockRestore();
});
it("does not offer plaintext operations or destructive empty edits for undecrypted messages",()=>{
  gate.hidden=false;
  useGroupDMStore.setState({messages:{group:[{...message("own","me"),content:null}]}});
  render(<GroupDMChat groupId="group"/>);
  expect(screen.queryByRole("button",{name:"chat:copyMessage"})).not.toBeInTheDocument();
  expect(screen.queryByRole("button",{name:"shortcutMessageSpeak"})).not.toBeInTheDocument();
  expect(screen.queryByRole("button",{name:"edit"})).not.toBeInTheDocument();
});
it("explains an unavailable encrypted revision without displaying an old cached body",()=>{
  gate.hidden=false;
  useGroupDMStore.setState({messages:{group:[{...message("other","other"),content:null,decryption_error:"version_unavailable"}]}});
  render(<GroupDMChat groupId="group"/>);
  expect(screen.getByText("encryptedMessageVersionUnavailable")).toBeInTheDocument();
  expect(screen.queryByRole("button",{name:"chat:copyMessage"})).not.toBeInTheDocument();
});
it("marks the chosen message unread and prevents a pending initial fetch from clearing it",async()=>{
  gate.hidden=false;
  let finish!:(loaded:boolean)=>void;
  useGroupDMStore.setState({fetchMessages:vi.fn(()=>new Promise<boolean>(resolve=>{finish=resolve}))});
  render(<GroupDMChat groupId="group"/>);
  fireEvent.click(screen.getAllByRole("button",{name:"chat:markUnread"})[1]);
  await waitFor(()=>expect(useGroupDMStore.getState().markUnread).toHaveBeenCalledWith("group","other-message"));
  await act(async()=>finish(false));
  expect(useGroupDMStore.getState().markRead).not.toHaveBeenCalled();
});
it("uses confirmation before deleting a group message and preserves cancellation", async () => {
  gate.hidden = false; const removeMessage = vi.fn(async () => true);
  useGroupDMStore.setState({ removeMessage });
  gate.confirm.mockResolvedValueOnce(false);
  render(<GroupDMChat groupId="group" />);
  fireEvent.click(screen.getByRole("button", {name:"delete"}));
  await waitFor(() => expect(gate.confirm).toHaveBeenCalledOnce());
  expect(removeMessage).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", {name:"delete"}));
  await waitFor(() => expect(removeMessage).toHaveBeenCalledWith("group", "own"));
});
it("does not submit a pending deletion under a different account", async () => {
  gate.hidden = false; const removeMessage = vi.fn(async () => true);
  useGroupDMStore.setState({ removeMessage });
  let finish!: (accepted: boolean) => void;
  gate.confirm.mockReturnValueOnce(new Promise<boolean>((resolve) => { finish = resolve; }));
  render(<GroupDMChat groupId="group" />);
  fireEvent.click(screen.getByRole("button", {name:"delete"}));
  act(() => useAuthStore.setState({ user: { id: "another" } as NonNullable<ReturnType<typeof useAuthStore.getState>["user"]> }));
  await act(async () => { finish(true); });
  expect(removeMessage).not.toHaveBeenCalled();
});
it("opens pins only after the scoped pin helper confirms persistence", async () => {
  gate.hidden = false;
  let finish!: (ok: boolean) => void;
  vi.mocked(pinCurrentGroupDMMessage).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  render(<GroupDMChat groupId="group" />);
  fireEvent.click(screen.getAllByRole("button", { name: "chat:pinMessage" })[0]);
  expect(pinCurrentGroupDMMessage).toHaveBeenCalledWith("group", "own", expect.objectContaining({ ownerId: "me", isCurrent: expect.any(Function) }));
  expect(screen.queryByLabelText("group-pins")).not.toBeInTheDocument();
  await act(async () => finish(true));
  expect(screen.getByLabelText("group-pins")).toBeInTheDocument();
});

it("does not reopen pins after navigating away while a pin request is pending", async () => {
  gate.hidden = false;
  let finish!: (ok: boolean) => void;
  vi.mocked(pinCurrentGroupDMMessage).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  render(<GroupDMChat groupId="group" />);
  fireEvent.click(screen.getAllByRole("button", { name: "chat:pinMessage" })[0]);
  act(() => useUIStore.setState((state) => ({ navigationRevision: state.navigationRevision + 1 })));
  await act(async () => finish(true));
  expect(screen.queryByLabelText("group-pins")).not.toBeInTheDocument();
});

it("handles active group search, members and persistent pins shortcuts", () => {
  useUIStore.setState({destination:{type:"group-dm",channelId:"group",label:"Group"}});
  render(<GroupDMChat groupId="group" />);
  expect(dispatchConversationCommand("search")).toBe(true);
  expect(screen.getByRole("searchbox")).toHaveFocus();
  act(()=>{expect(dispatchConversationCommand("members")).toBe(true);});
  expect(screen.getByRole("heading",{name:"members"})).toBeInTheDocument();
  act(() => { expect(dispatchConversationCommand("pins")).toBe(true); });
  expect(screen.getByLabelText("group-pins")).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "members" })).not.toBeInTheDocument();
  act(() => { expect(dispatchConversationCommand("members")).toBe(true); });
  expect(screen.queryByLabelText("group-pins")).not.toBeInTheDocument();
  act(() => { expect(dispatchConversationCommand("pins")).toBe(true); });
  fireEvent.click(screen.getByRole("button", { name: "close-pins" }));
  expect(screen.queryByLabelText("group-pins")).not.toBeInTheDocument();
});
it.each([false, true])("reports the selected quarantined group message with consent=%s", async (consent) => {
  render(<GroupDMChat groupId="group" />);
  expect(screen.queryByText("private decrypted body")).not.toBeInTheDocument();
  // Own messages have no report action.
  expect(screen.getAllByRole("button", { name: "chat:reportMessage" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "chat:reportMessage" }));
  if (consent) fireEvent.click(screen.getByRole("checkbox", { name: "reportShareMessageContent" }));
  fireEvent.click(screen.getByRole("button", { name: "reportReasonSpam" }));
  fireEvent.change(screen.getByPlaceholderText("reportDescriptionPlaceholder"), { target: { value: "This group message is unwanted spam" } });
  fireEvent.click(screen.getByRole("button", { name: "reportSubmit" }));
  await waitFor(() => expect(reportUser).toHaveBeenCalledWith("other", expect.objectContaining({ source_kind: "group", source_channel_id: "group", source_message_id: "other-message", evidence_consent: consent, evidence_content: consent ? "private decrypted body" : undefined }), undefined));
});
it("shows a failed member removal and lets the owner retry it", async () => {
  const group = useGroupDMStore.getState().groups[0];
  useGroupDMStore.setState({ groups: [{ ...group, members: [{ id: "friend", username: "friend", display_name: "Friend", avatar_url: null, status: "online", custom_status: null, created_at: "2026-10-24T00:00:00Z" }] }] });
  const removeMember = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  useGroupDMStore.setState({ removeMember });
  render(<GroupDMChat groupId="group" />);
  fireEvent.click(screen.getByRole("button", { name: "members" }));
  fireEvent.click(screen.getByRole("button", { name: "remove" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("error");
  fireEvent.click(screen.getByRole("button", { name: "errorBoundary.retry" }));
  await waitFor(() => expect(removeMember).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
});

it("bounds mounted rows in a long history without removing store messages", () => {
  gate.hidden = false;
  const history = Array.from({ length: 2000 }, (_, i) => message(`long-${i}`, "me"));
  useGroupDMStore.setState({ messages: { group: history } });
  const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  const rowHeight = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(140);
  const { container, unmount } = render(<GroupDMChat groupId="group" />);
  const rows = container.querySelectorAll("article[data-index]");
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.length).toBeLessThan(80);
  expect(useGroupDMStore.getState().messages.group).toHaveLength(2000);
  unmount(); height.mockRestore(); width.mockRestore(); rowHeight.mockRestore();
});

it.skipIf(!process.env.HICHAT_GROUP_BENCHMARK)("measures long group history rendering", () => {
  gate.hidden=false;
  const height=vi.spyOn(HTMLElement.prototype,"clientHeight","get").mockReturnValue(600);
  const width=vi.spyOn(HTMLElement.prototype,"clientWidth","get").mockReturnValue(800);
  const rowHeight=vi.spyOn(HTMLElement.prototype,"offsetHeight","get").mockReturnValue(140);
  useGroupDMStore.setState({messages:{group:Array.from({length:2000},(_,i)=>message(`bench-${i}`,"me"))}});
  const samples=[];
  for(let run=0;run<3;run++){
    const start=performance.now();const view=render(<GroupDMChat groupId="group"/>);
    samples.push({milliseconds:performance.now()-start,articles:view.container.querySelectorAll("article").length,nodes:view.container.querySelectorAll("*").length});view.unmount();
  }
  console.log("GROUP_BENCHMARK",JSON.stringify(samples));
  height.mockRestore();width.mockRestore();rowHeight.mockRestore();
});
