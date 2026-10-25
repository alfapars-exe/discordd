vi.mock("./GroupDMCallCamera",()=>({default:()=>null}));
vi.mock("./GroupScreenShareControl",()=>({default:()=> <button>screenShare</button>}));
import { act,render } from "@testing-library/react";
import { beforeEach,expect,it,vi } from "vitest";
const h=vi.hoisted(()=>({room:{} as object,callbacks:[] as (()=>void)[],audio:vi.fn()}));
vi.mock("../../stores/voiceStore",()=>{const state={isMuted:false,isDeafened:false,currentVoiceChannelId:null};return {useVoiceStore:Object.assign((select:(s:typeof state)=>unknown)=>select(state),{getState:()=>state,subscribe:()=>()=>{}})}});
vi.mock("../../stores/p2pCallStore",()=>{const state={activeCall:null};return {useP2PCallStore:Object.assign((select:(s:typeof state)=>unknown)=>select(state),{getState:()=>state,subscribe:()=>()=>{}})}});
vi.mock("../../stores/groupDMStore",()=>({useGroupDMStore:()=>1}));
vi.mock("../../hooks/useE2EEKeyProvider",()=>({useE2EEKeyProvider:()=>({keyProvider:{},e2eeWorker:{},keyReady:true,keyError:null,keyScope:"key",ownerScope:"owner"})}));
vi.mock("../../hooks/useEncryptedRoomAdmission",()=>({useEncryptedRoomAdmission:()=>({room:h.room,connect:true,publishReady:true,error:null})}));
vi.mock("./GroupDMCallAudio",()=>({default:(props:unknown)=>{h.audio(props);return null}}));
vi.mock("react-i18next",()=>({useTranslation:()=>({t:(key:string)=>key})}));
vi.mock("@livekit/components-react",()=>({LiveKitRoom:({onDisconnected,children}:{onDisconnected:()=>void;children:React.ReactNode})=>{h.callbacks.push(onDisconnected);return <>{children}</>},TrackToggle:()=>null,DisconnectButton:()=>null}));
import GroupDMCall from "./GroupDMCall";
import { publishAuthGenerationChange,publishAuthOwnerChange } from "../../api/authSessionEvents";
import { useGroupCallAudioControlStore,toggleGroupCallMicrophone } from "../../stores/groupCallAudioControlStore";
const credentials={token:"token",url:"wss://voice.test",channel_id:"group",e2ee_passphrase:"key",e2ee_key_epoch:1,e2ee_key_index:1,e2ee_key_context:"context"};
beforeEach(()=>{publishAuthGenerationChange(1);publishAuthOwnerChange("me");useGroupCallAudioControlStore.setState({control:null});h.callbacks=[];h.audio.mockClear();h.room={}});
it("keeps manual intent as a mount initializer and treats session association as metadata",()=>{
 const view=render(<GroupDMCall credentials={credentials} onLeave={vi.fn()} callSessionNonce="session" initialMicrophoneEnabled={false}/>);
 const first=useGroupCallAudioControlStore.getState().control!;expect(first.manualMuted).toBe(true);expect(first.callSessionNonce).toBe("session");
 view.rerender(<GroupDMCall credentials={credentials} onLeave={vi.fn()} callSessionNonce="session" initialMicrophoneEnabled/>);expect(useGroupCallAudioControlStore.getState().control?.manualMuted).toBe(true);
 view.unmount();expect(useGroupCallAudioControlStore.getState().control).toBeNull();
 render(<GroupDMCall credentials={credentials} onLeave={vi.fn()} callSessionNonce="session" initialMicrophoneEnabled={false}/>);
 const replacement=useGroupCallAudioControlStore.getState().control!;expect(replacement.nonce).not.toBe(first.nonce);act(()=>toggleGroupCallMicrophone(first.nonce));expect(useGroupCallAudioControlStore.getState().control?.manualMuted).toBe(true);
});
it("rejects old Room and retired mount disconnect callbacks while admitting the current lease",()=>{
 const leave=vi.fn();const view=render(<GroupDMCall credentials={credentials} onLeave={leave} callSessionNonce="session"/>);const oldRoom=h.callbacks.at(-1)!;
 h.room={};view.rerender(<GroupDMCall credentials={credentials} onLeave={leave} callSessionNonce="session"/>);const current=h.callbacks.at(-1)!;
 act(()=>oldRoom());expect(leave).not.toHaveBeenCalled();act(()=>current());expect(leave).toHaveBeenCalledTimes(1);leave.mockClear();
 view.unmount();render(<GroupDMCall credentials={credentials} onLeave={leave} callSessionNonce="session"/>);act(()=>current());expect(leave).not.toHaveBeenCalled();act(()=>h.callbacks.at(-1)!());expect(leave).toHaveBeenCalledTimes(1);
});
it("does not execute a retained microphone/disconnect callback after its session loses authority",()=>{
 let current=true;const leave=vi.fn();render(<GroupDMCall credentials={credentials} onLeave={leave} callSessionNonce="session" isCurrentSession={()=>current} initialMicrophoneEnabled={false}/>);
 const control=useGroupCallAudioControlStore.getState().control!;const disconnected=h.callbacks.at(-1)!;current=false;act(()=>{control.toggle();disconnected()});expect(leave).not.toHaveBeenCalled();expect(useGroupCallAudioControlStore.getState().control?.manualMuted).toBe(true);
});
