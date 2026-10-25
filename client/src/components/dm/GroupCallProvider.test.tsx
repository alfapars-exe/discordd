import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const api=vi.hoisted(()=>({list:vi.fn(),token:vi.fn()}));
const runtime=vi.hoisted(()=>({mounts:0,cleanups:0,leave:null as (()=>void)|null,token:"",crash:false,initials:[] as (boolean|undefined)[]}));
vi.mock("../../api/groupDM",()=>({listGroupDMs:api.list,getGroupDMCallToken:api.token}));
vi.mock("../../api/clientLog",()=>({logToServer:vi.fn()}));
vi.mock("../../monitoring/sentry",()=>({captureBoundaryError:vi.fn()}));
vi.mock("react-i18next",async(original)=>({...await original<typeof import("react-i18next")>(),useTranslation:()=>({t:(key:string)=>key})}));
vi.mock("./GroupDMCall",async()=>{const React=await import("react");return {default:function MockGroupRoom({credentials,onLeave,initialMicrophoneEnabled}:{credentials:{token:string};onLeave:()=>void;initialMicrophoneEnabled?:boolean}){
 const [initial]=React.useState(initialMicrophoneEnabled);React.useEffect(()=>{runtime.mounts++;runtime.initials.push(initial);return()=>{runtime.cleanups++}},[initial]);runtime.leave=onLeave;runtime.token=credentials.token;if(runtime.crash)throw new Error("owned group SDK render failure");return <div data-testid="owned-room">{credentials.token}</div>;
}}});
import GroupCallProvider from "./GroupCallProvider";
import { bindGroupCallAudioControl,releaseGroupCallAudioControl } from "../../stores/groupCallAudioControlStore";
import { latchPrivateCaptureFailure,useMicrophoneCaptureViewStore } from "../../stores/microphoneCaptureViewStore";
import { useGroupCallStore } from "../../stores/groupCallStore";
import { useGroupDMStore } from "../../stores/groupDMStore";
import { useAuthStore } from "../../stores/authStore";
import { useE2EEStore } from "../../stores/e2eeStore";
import { useUIStore } from "../../stores/uiStore";
import { useComposerDraftStore,composerKey } from "../../stores/composerDraftStore";
import { getAuthGeneration,setTokens } from "../../api/client";
import { publishAuthOwnerChange } from "../../api/authSessionEvents";
import type { GroupDM } from "../../types/groupDM";
const group=(epoch=1,id="group"):GroupDM=>({id,owner_id:"me",name:id,members:[{id:"me",username:"me",display_name:null,avatar_url:null,custom_status:null,status:"online",created_at:"2026-01-01"}],icon_url:null,key_epoch:epoch,call_room_key:"room",unread_count:0,created_at:"2026-01-01",updated_at:"2026-01-01"});
const credentials=(epoch=1,token="token")=>({url:"wss://voice.test",token,channel_id:"group",e2ee_passphrase:"key",e2ee_key_epoch:epoch,e2ee_key_index:epoch%256,e2ee_key_context:"context"});
async function ready(){act(()=>{expect(useGroupCallStore.getState().join("group")).toBe(true)});await waitFor(()=>expect(useGroupCallStore.getState().session?.phase).toBe("ready"))}
beforeEach(()=>{
 const old=useGroupCallStore.getState().session;if(old)useGroupCallStore.getState().leave(old.nonce);
 vi.clearAllMocks();runtime.mounts=0;runtime.cleanups=0;runtime.leave=null;runtime.crash=false;runtime.initials=[];
 setTokens("access","refresh");useAuthStore.setState({user:{id:"me"} as never});publishAuthOwnerChange("me");useE2EEStore.setState({initStatus:"ready",localDeviceId:"device"});
 useGroupDMStore.setState({ownerId:"me",authGeneration:getAuthGeneration(),groupsReady:true,loading:false,groups:[group()],messages:{}});
 api.list.mockResolvedValue({success:true,data:{group_dms:[group()]}});api.token.mockResolvedValue({success:true,data:credentials()});
 useComposerDraftStore.getState().reset();
});
afterEach(()=>{const s=useGroupCallStore.getState().session;if(s)act(()=>useGroupCallStore.getState().leave(s.nonce))});
it("keeps one real store/provider runtime across navigation and preserves composer/call source",async()=>{
 const file=new File(["private"],"draft.txt"),key=composerKey("me","group","group");useComposerDraftStore.getState().patch(key,{content:"keep draft",files:[file],groupReplyToId:"reply"});
 const view=render(<><div>group route</div><GroupCallProvider/></>);await ready();await screen.findByTestId("owned-room");
 const nonce=useGroupCallStore.getState().session!.nonce;expect(runtime.mounts).toBe(1);
 act(()=>useUIStore.setState({destination:{type:"friends",channelId:"friends",label:"Friends"} as never}));
 view.rerender(<><section><div>mobile/guild wrapper route</div></section><GroupCallProvider/></>);expect(runtime.mounts).toBe(1);expect(runtime.cleanups).toBe(0);expect(useGroupCallStore.getState().session?.nonce).toBe(nonce);
 expect(useComposerDraftStore.getState().drafts[key]).toMatchObject({content:"keep draft",files:[file],groupReplyToId:"reply"});
 fireEvent.click(screen.getByRole("button",{name:"returnToCall"}));expect(useUIStore.getState().destination).toMatchObject({type:"group-dm",channelId:"group"});
 fireEvent.click(screen.getByRole("button",{name:"leaveCall"}));expect(runtime.cleanups).toBe(1);expect(useGroupCallStore.getState().session).toBeNull();
});
it("does not replace another group or reissue credentials when the provider remounts in StrictMode",async()=>{
 render(<StrictMode><GroupCallProvider/></StrictMode>);await ready();await screen.findByTestId("owned-room");
 expect(api.list).toHaveBeenCalledTimes(1);expect(api.token).toHaveBeenCalledTimes(1);expect(useGroupCallStore.getState().join("other")).toBe(false);
 const nonce=useGroupCallStore.getState().session!.nonce;expect(runtime.mounts-runtime.cleanups).toBe(1);act(()=>useGroupCallStore.getState().leave(nonce));expect(runtime.mounts-runtime.cleanups).toBe(0);
});
it("rejects pending credentials after explicit cancellation and keeps replacement ownership",async()=>{
 let resolve!:(value:unknown)=>void;api.token.mockReturnValueOnce(new Promise(done=>{resolve=done}));
 act(()=>{useGroupCallStore.getState().join("group")});await waitFor(()=>expect(api.token).toHaveBeenCalledTimes(1));
 const old=useGroupCallStore.getState().session!.nonce,scope=api.token.mock.calls[0][1];expect(scope.timeoutMs).toBe(15000);expect(scope.isCurrent()).toBe(true);
 act(()=>useGroupCallStore.getState().leave(old));expect(scope.signal.aborted).toBe(true);expect(scope.isCurrent()).toBe(false);
 await ready();const replacement=useGroupCallStore.getState().session!.nonce;await act(async()=>resolve({success:true,data:credentials(1,"stale")}));
 expect(useGroupCallStore.getState().session?.nonce).toBe(replacement);expect(useGroupCallStore.getState().session?.credentials?.token).toBe("token");useGroupCallStore.getState().leave(old);expect(useGroupCallStore.getState().session?.nonce).toBe(replacement);
});
it.each(["account","device","membership"])("retires media on %s change without an automatic join",async(kind)=>{
 render(<GroupCallProvider/>);await ready();await screen.findByTestId("owned-room");
 act(()=>{if(kind==="account")setTokens("new-access","new-refresh");else if(kind==="device")useE2EEStore.setState({localDeviceId:"replacement-device"});else useGroupDMStore.getState().handleDelete("group")});
 expect(useGroupCallStore.getState().session).toBeNull();expect(screen.queryByTestId("owned-room")).toBeNull();expect(runtime.cleanups).toBe(1);expect(api.token).toHaveBeenCalledTimes(1);
});
it("refreshes actual membership and rejects older epoch responses while retaining one owner",async()=>{
 render(<GroupCallProvider/>);await ready();await screen.findByTestId("owned-room");const nonce=useGroupCallStore.getState().session!.nonce;
 let resolve!:(value:unknown)=>void;api.list.mockResolvedValue({success:true,data:{group_dms:[group(2)]}});api.token.mockReturnValueOnce(new Promise(done=>{resolve=done}));
 act(()=>useGroupDMStore.getState().handleCreateOrUpdate(group(2)));await waitFor(()=>expect(api.token).toHaveBeenCalledTimes(2));
 expect(useGroupCallStore.getState().session).toMatchObject({nonce,keyEpoch:2,phase:"requesting"});expect(runtime.mounts).toBe(1);
 api.list.mockResolvedValue({success:true,data:{group_dms:[group(3)]}});api.token.mockResolvedValueOnce({success:true,data:credentials(3,"latest")});
 act(()=>useGroupDMStore.getState().handleCreateOrUpdate(group(3)));await waitFor(()=>expect(useGroupCallStore.getState().session?.credentials?.token).toBe("latest"));
 await act(async()=>resolve({success:true,data:credentials(2,"old-epoch")}));expect(useGroupCallStore.getState().session?.credentials?.token).toBe("latest");expect(runtime.mounts).toBe(1);
});
it("shows explicit retry after token failure and refuses malformed epoch tokens",async()=>{
 api.token.mockResolvedValueOnce({success:false,error:"network"});render(<GroupCallProvider/>);act(()=>{useGroupCallStore.getState().join("group")});await screen.findByRole("alert");expect(api.token).toHaveBeenCalledTimes(1);
 api.token.mockResolvedValueOnce({success:true,data:credentials(2,"wrong")});fireEvent.click(screen.getByRole("button",{name:"retry"}));await waitFor(()=>expect(useGroupCallStore.getState().session?.phase).toBe("error"));expect(screen.queryByTestId("owned-room")).toBeNull();
 api.token.mockResolvedValueOnce({success:true,data:credentials()});fireEvent.click(screen.getByRole("button",{name:"retry"}));await screen.findByTestId("owned-room");
 const ended=runtime.leave!;act(()=>ended());expect(useGroupCallStore.getState().session).toBeNull();expect(runtime.cleanups).toBe(1);expect(api.token).toHaveBeenCalledTimes(3);
});
it("fresh authoritative membership denial prevents connection even if the cached group remains",async()=>{
 api.list.mockResolvedValue({success:true,data:{group_dms:[]}});act(()=>{useGroupCallStore.getState().join("group")});await waitFor(()=>expect(useGroupCallStore.getState().session).toBeNull());expect(api.token).not.toHaveBeenCalled();
});

it("isolates a group runtime render failure and keeps explicit leave available",async()=>{
 const error=vi.spyOn(console,"error").mockImplementation(()=>{});
 try{
 render(<><div>main chat remains</div><GroupCallProvider/></>);await ready();await screen.findByTestId("owned-room");
 runtime.crash=true;act(()=>useGroupDMStore.getState().handleCreateOrUpdate({...group(),name:"Renamed group"}));
 expect(screen.getByText("main chat remains")).toBeInTheDocument();expect(screen.queryByTestId("owned-room")).toBeNull();expect(runtime.cleanups).toBe(1);
 expect(screen.getByRole("button",{name:"leaveCall"})).toBeEnabled();fireEvent.click(screen.getByRole("button",{name:"leaveCall"}));expect(useGroupCallStore.getState().session).toBeNull();expect(api.token).toHaveBeenCalledTimes(1);
 }finally{error.mockRestore()}
});

it.each(["account","device","membership"])("ignores a late token after pending %s retirement",async(kind)=>{
 let resolve!:(value:unknown)=>void;api.token.mockReturnValueOnce(new Promise(done=>{resolve=done}));
 act(()=>{useGroupCallStore.getState().join("group")});await waitFor(()=>expect(api.token).toHaveBeenCalledTimes(1));const scope=api.token.mock.calls[0][1];
 act(()=>{if(kind==="account")setTokens("replacement-access","replacement-refresh");else if(kind==="device")useE2EEStore.setState({localDeviceId:"new-device"});else useGroupDMStore.getState().handleDelete("group")});
 expect(scope.signal.aborted).toBe(true);expect(scope.isCurrent()).toBe(false);await act(async()=>resolve({success:true,data:credentials()}));expect(useGroupCallStore.getState().session).toBeNull();
});
it("a retained room disconnect callback cannot stop a replacement call",async()=>{
 render(<GroupCallProvider/>);await ready();await screen.findByTestId("owned-room");const oldLeave=runtime.leave!;act(()=>oldLeave());
 await ready();await screen.findByTestId("owned-room");const current=useGroupCallStore.getState().session!.nonce;act(()=>oldLeave());expect(useGroupCallStore.getState().session?.nonce).toBe(current);expect(runtime.mounts-runtime.cleanups).toBe(1);
});

it("preserves the latest private mute intent when a boundary retry remounts the SDK",async()=>{
 const error=vi.spyOn(console,"error").mockImplementation(()=>{});
 try{
 render(<GroupCallProvider/>);await ready();await screen.findByTestId("owned-room");const session=useGroupCallStore.getState().session!;
 act(()=>bindGroupCallAudioControl({nonce:"fresh-mount-control",callSessionNonce:session.nonce,accountId:session.ownerId,generation:session.generation,groupId:session.groupId,manualMuted:true,effectiveMuted:true,blocked:false,toggle:vi.fn()}));
 expect(useGroupCallStore.getState().session?.manualMuted).toBe(true);act(()=>releaseGroupCallAudioControl("fresh-mount-control"));expect(useGroupCallStore.getState().session?.manualMuted).toBe(true);
 runtime.crash=true;act(()=>useGroupDMStore.getState().handleCreateOrUpdate({...group(),name:"Another name"}));expect(screen.queryByTestId("owned-room")).toBeNull();
 runtime.crash=false;const retry=screen.getAllByRole("button").find(button=>!['returnToCall','leaveCall'].includes(button.textContent??''))!;fireEvent.click(retry);await screen.findByTestId("owned-room");expect(runtime.initials.at(-1)).toBe(false);expect(useGroupCallStore.getState().session?.manualMuted).toBe(true);
 }finally{error.mockRestore()}
});

it("retires only the exact logical call's capture failure and preserves it through rekey",async()=>{
 await ready();const session=useGroupCallStore.getState().session!;act(()=>latchPrivateCaptureFailure(session.nonce,session.ownerId,session.generation));
 expect(useMicrophoneCaptureViewStore.getState().privateFailure?.nonce).toBe(session.nonce);
 api.list.mockResolvedValue({success:true,data:{group_dms:[group(2)]}});api.token.mockResolvedValue({success:true,data:credentials(2)});act(()=>useGroupDMStore.getState().handleCreateOrUpdate(group(2)));await waitFor(()=>expect(useGroupCallStore.getState().session?.phase).toBe("ready"));
 expect(useMicrophoneCaptureViewStore.getState().privateFailure?.nonce).toBe(session.nonce);act(()=>useGroupCallStore.getState().leave("retired-other-source"));expect(useMicrophoneCaptureViewStore.getState().privateFailure?.nonce).toBe(session.nonce);
 act(()=>useGroupCallStore.getState().leave(session.nonce));expect(useMicrophoneCaptureViewStore.getState().privateFailure).toBeNull();
});
