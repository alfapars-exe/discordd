import {act,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {beforeEach,expect,it,vi} from "vitest";
import type {ChatMessage} from "../../hooks/useChatContext";
const state=vi.hoisted(()=>({id:"owner",generation:1,authListeners:new Set<(next:{user:{id:string}},previous:{user:{id:string}})=>void>(),generationListeners:new Set<(next:{generation:number},previous:{generation:number})=>void>(),send:vi.fn(),decrypt:vi.fn(),toast:vi.fn(),getChannels:vi.fn(),fetch:vi.fn(async()=>{}),channels:[{id:"dm",status:"accepted",other_user:{username:"Friend",display_name:null}}],servers:[] as Array<{id:string;name:string}>}));
const groupState=vi.hoisted(()=>({groups:[] as Array<{id:string;name:string}>,groupsReady:true,error:null as string|null,pendingSends:{} as Record<string,unknown>,uploadRecoveries:{} as Record<string,unknown[]>,fetchGroups:vi.fn(async()=>{}),restorePendingSends:vi.fn(async()=>{}),send:vi.fn(async()=>true)}));
vi.mock("../../stores/groupDMStore",()=>({useGroupDMStore:Object.assign((select:(s:unknown)=>unknown)=>select(groupState),{getState:()=>groupState})}));
vi.mock("react-i18next",()=>({useTranslation:()=>({t:(key:string)=>key})}));
vi.mock("../../api/channels",()=>({getChannels:state.getChannels}));
vi.mock("../../api/authSessionEvents",()=>({getAuthSessionSnapshot:()=>({ownerId:state.id,generation:state.generation})}));
vi.mock("../../crypto/fileEncryption",()=>({decryptFile:state.decrypt}));
vi.mock("../../stores/authStore",()=>({useAuthStore:{getState:()=>({user:{id:state.id}}),subscribe:(listener:(next:{user:{id:string}},previous:{user:{id:string}})=>void)=>{state.authListeners.add(listener);return()=>state.authListeners.delete(listener)}}}));
vi.mock("../../stores/composerDraftStore",()=>({useComposerDraftStore:{getState:()=>({generation:state.generation}),subscribe:(listener:(next:{generation:number},previous:{generation:number})=>void)=>{state.generationListeners.add(listener);return()=>state.generationListeners.delete(listener)}}}));
vi.mock("../../stores/serverStore",()=>({useServerStore:(select:(s:unknown)=>unknown)=>select({servers:state.servers})}));
vi.mock("../../stores/messageStore",()=>({useMessageStore:{getState:()=>({sendMessage:state.send})}}));
vi.mock("../../stores/dmStore",()=>({useDMStore:Object.assign((select:(s:unknown)=>unknown)=>select({channels:state.channels,fetchChannels:state.fetch}),{getState:()=>({channels:state.channels,sendMessage:state.send})})}));
vi.mock("../../stores/toastStore",()=>({useToastStore:{getState:()=>({addToast:state.toast})}}));
vi.mock("../../utils/constants",()=>({resolveAssetUrl:(url:string)=>url}));
import ForwardMessageModal from "./ForwardMessageModal";
const message={id:"m",content:"private",author:{username:"Author"},encryption_version:1,attachments:[{filename:"encrypted_0.bin",file_url:"/private"}],e2ee_file_keys:[{key:"secret"}]} as unknown as ChatMessage;
beforeEach(()=>{vi.clearAllMocks();state.authListeners.clear();state.generationListeners.clear();groupState.groups=[];groupState.groupsReady=true;groupState.error=null;groupState.pendingSends={};groupState.uploadRecoveries={};groupState.fetchGroups.mockReset().mockResolvedValue(undefined);groupState.restorePendingSends.mockReset().mockResolvedValue(undefined);groupState.send.mockReset().mockResolvedValue(true);state.id="owner";state.generation=1;state.servers=[];state.channels=[{id:"dm",status:"accepted",other_user:{username:"Friend",display_name:null}}];state.fetch.mockReset().mockResolvedValue(undefined);state.getChannels.mockReset();state.send.mockResolvedValue(true)});
function deferred(){let resolve!:(file:File)=>void;const promise=new Promise<File>(r=>{resolve=r});state.decrypt.mockReturnValueOnce(promise);return resolve}
function replaceAccount(id:string){const previous={user:{id:state.id}};state.id=id;act(()=>state.authListeners.forEach(listener=>listener({user:{id}},previous)))}
function resetDraftGeneration(){const previous={generation:state.generation};state.generation++;act(()=>state.generationListeners.forEach(listener=>listener({generation:state.generation},previous)))}
async function begin(){const close=vi.fn(),view=render(<ForwardMessageModal message={message} onClose={close}/>);await screen.findByText("Friend");fireEvent.click(screen.getByText("Friend"));await waitFor(()=>expect(state.decrypt).toHaveBeenCalledOnce());return {...view,close}}
it("closes and fences a stale destination list when the account changes",async()=>{
 const close=vi.fn();render(<ForwardMessageModal message={message} onClose={close}/>);await screen.findByText("Friend");replaceAccount("other");expect(close).toHaveBeenCalledOnce();fireEvent.click(screen.getByText("Friend"));expect(state.decrypt).not.toHaveBeenCalled();expect(state.send).not.toHaveBeenCalled();
});
it("closes on same-account session generation replacement",async()=>{
 const close=vi.fn();render(<ForwardMessageModal message={message} onClose={close}/>);await screen.findByText("Friend");resetDraftGeneration();expect(close).toHaveBeenCalledOnce();
});
it("closes on Escape and only calls the close callback once",async()=>{
 const close=vi.fn();render(<ForwardMessageModal message={message} onClose={close}/>);await screen.findByText("Friend");fireEvent.keyDown(document,{key:"Escape"});fireEvent.keyDown(document,{key:"Escape"});expect(close).toHaveBeenCalledOnce();
});
it("does not forward materialized private attachments under a replacement account",async()=>{
 const resolve=deferred(),view=await begin();state.id="other";await act(async()=>resolve(new File(["private"],"private.txt")));expect(state.send).not.toHaveBeenCalled();expect(state.toast).not.toHaveBeenCalled();expect(view.close).not.toHaveBeenCalled();
});
it("does not forward after same-account logout/login generation replacement",async()=>{
 const resolve=deferred();await begin();state.generation++;await act(async()=>resolve(new File(["private"],"private.txt")));expect(state.send).not.toHaveBeenCalled();
});
it("closing the modal fences late attachment completion even before parent unmount",async()=>{
 const resolve=deferred(),view=await begin();fireEvent.click(screen.getByRole("button",{name:"forwardClose"}));await act(async()=>resolve(new File(["private"],"private.txt")));expect(view.close).toHaveBeenCalledOnce();expect(state.send).not.toHaveBeenCalled();expect(state.toast).not.toHaveBeenCalled();
});
it("does not send an old source after the modal receives a replacement message",async()=>{
 const resolve=deferred(),view=await begin();view.rerender(<ForwardMessageModal message={{...message,id:"replacement",content:"new source"}} onClose={view.close}/>);await act(async()=>resolve(new File(["private"],"private.txt")));expect(state.send).not.toHaveBeenCalled();expect(state.toast).not.toHaveBeenCalled();
 const destination=screen.getByText("Friend").closest("button")!;
 await waitFor(()=>expect(destination).not.toBeDisabled());
 state.decrypt.mockResolvedValueOnce(new File(["replacement"],"replacement.txt"));
 fireEvent.click(destination);
 await waitFor(()=>expect(state.send).toHaveBeenCalledWith("dm",expect.stringContaining("new source"),expect.arrayContaining([expect.objectContaining({name:"replacement.txt"})]),undefined,expect.objectContaining({isCurrent:expect.any(Function)})));
 expect(state.send).toHaveBeenCalledOnce();expect(view.close).toHaveBeenCalledOnce();
});
it("does not send after the modal unmounts",async()=>{
 const resolve=deferred(),view=await begin();view.unmount();await act(async()=>resolve(new File(["private"],"private.txt")));expect(state.send).not.toHaveBeenCalled();expect(state.toast).not.toHaveBeenCalled();
});
it("forwards once and reports success only for the current open session",async()=>{
 const resolve=deferred(),view=await begin();fireEvent.click(screen.getByText("Friend"));await act(async()=>resolve(new File(["private"],"private.txt")));await waitFor(()=>expect(state.send).toHaveBeenCalledOnce());expect(state.send).toHaveBeenCalledWith("dm","forwardedFrom Author:\nprivate",[expect.any(File)],undefined,expect.objectContaining({ownerId:"owner",authGeneration:1,isCurrent:expect.any(Function)}));expect(view.close).toHaveBeenCalledOnce();expect(state.toast).toHaveBeenCalledWith("success","forwardSuccess");
});
it("keeps available targets and reports a partial destination load failure",async()=>{
 state.servers=[{id:"good",name:"Good"},{id:"bad",name:"Bad"}];state.getChannels.mockImplementation(async(id:string)=>{if(id==="bad")throw new Error("offline");return {success:true,data:[{channels:[{id:"text",name:"general",type:"text",effective_permissions:6176}]}]}});
 render(<ForwardMessageModal message={message} onClose={vi.fn()}/>);await screen.findByRole("alert");expect(screen.getByText("#general")).toBeInTheDocument();expect(screen.getByText("Friend")).toBeInTheDocument();expect(screen.queryByText("forwardLoading")).not.toBeInTheDocument();expect(screen.getByRole("button",{name:"forwardTargetsRetry"})).toBeEnabled();
});
it("retries a failed API response and replaces the error with fresh destinations",async()=>{
 state.servers=[{id:"server",name:"Server"}];state.getChannels.mockResolvedValueOnce({success:false,error:"offline"}).mockResolvedValueOnce({success:true,data:[{channels:[{id:"fresh",name:"fresh",type:"text",effective_permissions:6176}]}]});
 render(<ForwardMessageModal message={message} onClose={vi.fn()}/>);await screen.findByRole("alert");fireEvent.click(screen.getByRole("button",{name:"forwardTargetsRetry"}));await screen.findByText("#fresh");expect(screen.queryByRole("alert")).not.toBeInTheDocument();expect(state.getChannels).toHaveBeenCalledTimes(2);expect(state.send).not.toHaveBeenCalled();
});
it("does not strand server destinations when DM discovery throws",async()=>{
 state.channels=[];state.fetch.mockRejectedValueOnce(new Error("offline"));state.servers=[{id:"server",name:"Server"}];state.getChannels.mockResolvedValueOnce({success:true,data:[{channels:[{id:"text",name:"available",type:"text",effective_permissions:6176}]}]});
 render(<ForwardMessageModal message={message} onClose={vi.fn()}/>);await screen.findByText("#available");expect(screen.getByRole("alert")).toHaveTextContent("forwardTargetsFailed");expect(screen.queryByText("forwardEmpty")).not.toBeInTheDocument();expect(screen.queryByText("forwardLoading")).not.toBeInTheDocument();
});
it("hides denied or unknown-permission channels instead of treating them as sendable",async()=>{
 state.servers=[{id:"server",name:"Server"}];state.getChannels.mockResolvedValueOnce({success:true,data:[{channels:[{id:"denied",name:"readonly",type:"text",effective_permissions:6144},{id:"unknown",name:"unknown",type:"text"},{id:"allowed",name:"allowed",type:"text",effective_permissions:6176}]}]});
 render(<ForwardMessageModal message={message} onClose={vi.fn()}/>);await screen.findByText("#allowed");expect(screen.queryByText("#readonly")).not.toBeInTheDocument();expect(screen.queryByText("#unknown")).not.toBeInTheDocument();expect(screen.getByRole("alert")).toHaveTextContent("forwardTargetsFailed");
});
it("rechecks selected channel permissions after decryption and refuses revoked send access",async()=>{
 const resolve=deferred();state.servers=[{id:"server",name:"Server"}];state.getChannels.mockResolvedValueOnce({success:true,data:[{channels:[{id:"target",name:"target",type:"text",effective_permissions:6176}]}]}).mockResolvedValueOnce({success:true,data:[{channels:[{id:"target",name:"target",type:"text",effective_permissions:6144}]}]});
 render(<ForwardMessageModal message={message} onClose={vi.fn()}/>);await screen.findByText("#target");fireEvent.click(screen.getByText("#target"));await waitFor(()=>expect(state.decrypt).toHaveBeenCalledOnce());await act(async()=>resolve(new File(["private"],"private.txt")));await waitFor(()=>expect(state.toast).toHaveBeenCalledWith("error","forwardFailed"));expect(state.send).not.toHaveBeenCalled();expect(state.getChannels).toHaveBeenCalledTimes(2);
});
it("forwards decrypted originals through the existing group encryption/send path",async()=>{
 const resolve=deferred();groupState.groups=[{id:"group",name:"Team"}];const close=vi.fn();render(<ForwardMessageModal message={message} onClose={close}/>);await screen.findByText("Team");fireEvent.click(screen.getByText("Team"));await waitFor(()=>expect(state.decrypt).toHaveBeenCalledOnce());const file=new File(["original"],"original.txt");await act(async()=>resolve(file));await waitFor(()=>expect(groupState.send).toHaveBeenCalledWith("group","forwardedFrom Author:\nprivate",undefined,[file],expect.objectContaining({ownerId:"owner",authGeneration:1,isCurrent:expect.any(Function)})));expect(groupState.fetchGroups).toHaveBeenCalledOnce();expect(groupState.restorePendingSends).toHaveBeenCalledOnce();expect(state.send).not.toHaveBeenCalled();expect(close).toHaveBeenCalledOnce();
});
it("does not forward after refreshed group membership is removed",async()=>{
 const resolve=deferred();groupState.groups=[{id:"group",name:"Team"}];groupState.fetchGroups.mockImplementationOnce(async()=>{groupState.groups=[]});render(<ForwardMessageModal message={message} onClose={vi.fn()}/>);await screen.findByText("Team");fireEvent.click(screen.getByText("Team"));await waitFor(()=>expect(state.decrypt).toHaveBeenCalledOnce());await act(async()=>resolve(new File(["original"],"original.txt")));expect(groupState.send).not.toHaveBeenCalled();expect(state.toast).toHaveBeenCalledWith("error","forwardFailed");
});
it("disables a group with an unresolved operation and warns about partial committed delivery",async()=>{
 groupState.groups=[{id:"blocked",name:"Blocked"},{id:"group",name:"Team"}];groupState.pendingSends.blocked={id:"pending"};state.decrypt.mockResolvedValueOnce(new File(["original"],"original.txt"));groupState.send.mockImplementationOnce(async()=>{groupState.uploadRecoveries.group=[{id:"failed-file"}];return true});render(<ForwardMessageModal message={message} onClose={vi.fn()}/>);await screen.findByText("Team");expect(screen.getByText("Blocked").closest("button")).toBeDisabled();fireEvent.click(screen.getByText("Team"));await waitFor(()=>expect(state.toast).toHaveBeenCalledWith("warning","forwardGroupRecovery"));expect(state.toast).not.toHaveBeenCalledWith("success",expect.anything());
});
it("reports group discovery failure and reloads group destinations explicitly",async()=>{
 groupState.groupsReady=false;groupState.fetchGroups.mockResolvedValueOnce(undefined).mockImplementationOnce(async()=>{groupState.groupsReady=true;groupState.groups=[{id:"group",name:"Recovered team"}]});render(<ForwardMessageModal message={message} onClose={vi.fn()}/>);await screen.findByRole("alert");fireEvent.click(screen.getByRole("button",{name:"forwardTargetsRetry"}));await screen.findByText("Recovered team");expect(screen.queryByRole("alert")).not.toBeInTheDocument();expect(groupState.send).not.toHaveBeenCalled();
});
it("retains an uncertain group operation without claiming delivery or retrying it",async()=>{
 groupState.groups=[{id:"group",name:"Team"}];state.decrypt.mockResolvedValueOnce(new File(["original"],"original.txt"));groupState.send.mockImplementationOnce(async()=>{groupState.pendingSends.group={id:"uncertain"};return false});const close=vi.fn();render(<ForwardMessageModal message={message} onClose={close}/>);await screen.findByText("Team");fireEvent.click(screen.getByText("Team"));await waitFor(()=>expect(state.toast).toHaveBeenCalledWith("warning","forwardGroupPending"));expect(groupState.send).toHaveBeenCalledOnce();expect(close).not.toHaveBeenCalled();expect(screen.getByText("Team").closest("button")).toBeDisabled();
});
it.each(["explicit","legacy"])("decrypts a retained attachment with its original %s key position",async(kind)=>{
 const keys=["zero","one","two"].map(key=>({...message.e2ee_file_keys![0],key}));
 const source={...message,e2ee_file_keys:keys,attachments:[{...message.attachments[0],filename:kind==="legacy"?"encrypted_2.bin":"retained.bin",...(kind==="explicit"?{file_key_index:2}:{})}]};
 state.decrypt.mockResolvedValueOnce(new File(["retained"],"retained.txt"));render(<ForwardMessageModal message={source} onClose={vi.fn()}/>);await screen.findByText("Friend");fireEvent.click(screen.getByText("Friend"));await waitFor(()=>expect(state.send).toHaveBeenCalledOnce());expect(state.decrypt).toHaveBeenCalledWith("/private",keys[2]);
});
it("does not guess an attachment key when the explicit source position is invalid",async()=>{
 const source={...message,attachments:[{...message.attachments[0],file_key_index:-1}]};render(<ForwardMessageModal message={source} onClose={vi.fn()}/>);await screen.findByText("Friend");fireEvent.click(screen.getByText("Friend"));await waitFor(()=>expect(state.toast).toHaveBeenCalledWith("error","forwardFailed"));expect(state.decrypt).not.toHaveBeenCalled();expect(state.send).not.toHaveBeenCalled();
});

it.each(["dm","group","channel"])("fences %s encryption when the forwarding modal closes after store dispatch",async(kind)=>{
 groupState.groups=kind==="group"?[{id:"group",name:"Team"}]:[];
 if(kind==="channel"){
  state.servers=[{id:"server",name:"Server"}];
  state.getChannels.mockResolvedValue({success:true,data:[{channels:[{id:"target",name:"target",type:"text",effective_permissions:6176}]}]});
 }
 let context:{isCurrent:()=>boolean}|undefined;
 let complete!:(ok:boolean)=>void;
 const sending=new Promise<boolean>(resolve=>{complete=resolve});
 const send=kind==="group"?groupState.send:state.send;
 send.mockImplementationOnce(async(...args:unknown[])=>{context=args.at(-1) as typeof context;return sending});
 state.decrypt.mockResolvedValueOnce(new File(["original"],"original.txt"));
 render(<ForwardMessageModal message={message} onClose={vi.fn()}/>);
 const label=kind==="group"?"Team":kind==="channel"?"#target":"Friend";
 await screen.findByText(label);fireEvent.click(screen.getByText(label));
 await waitFor(()=>expect(send).toHaveBeenCalledOnce());
 expect(context?.isCurrent()).toBe(true);
 fireEvent.click(screen.getByRole("button",{name:"forwardClose"}));
 expect(context?.isCurrent()).toBe(false);
 await act(async()=>complete(false));expect(state.toast).not.toHaveBeenCalled();
});
