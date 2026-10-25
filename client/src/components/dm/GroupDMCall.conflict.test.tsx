vi.mock("../../stores/groupCallStore",()=>({useGroupCallStore:{getState:()=>({session:null})}}));
vi.mock("../../video/GroupRemoteVideos",()=>({default:()=>null}));
vi.mock("../../video/useAuthorizedRoomVideos",()=>({useAuthorizedRoomVideos:()=>{},manualNativeVideo:()=>false}));
vi.mock("../../video/videoPresentation",()=>({isPresentedVideoContext:()=>false,subscribeVideoPresentation:()=>()=>{}}));
vi.mock("./GroupDMCallCamera",()=>({default:()=>null}));
vi.mock("./GroupScreenShareControl",()=>({default:()=> <button>screenShare</button>}));
import {act,render,waitFor}from "@testing-library/react";
import {beforeEach,describe,expect,it,vi}from "vitest";
const h=vi.hoisted(()=>({audio:vi.fn()}));
vi.mock("../../hooks/useE2EEKeyProvider",()=>({useE2EEKeyProvider:()=>({keyProvider:{},e2eeWorker:{},keyReady:true,keyError:null,keyScope:"key",ownerScope:"owner"})}));
vi.mock("../../hooks/useEncryptedRoomAdmission",()=>({useEncryptedRoomAdmission:()=>({room:{},connect:true,publishReady:true,error:null})}));
vi.mock("./GroupDMCallAudio",()=>({default:(props:unknown)=>{h.audio(props);return null;},privateCaptureConflict:()=>!!useVoiceStore.getState().currentVoiceChannelId||!!useP2PCallStore.getState().activeCall}));
vi.mock("../../stores/groupDMStore",()=>({useGroupDMStore:()=>1}));
vi.mock("@livekit/components-react",()=>({LiveKitRoom:({children}:{children:React.ReactNode})=><>{children}</>,TrackToggle:()=>null,DisconnectButton:()=>null}));
vi.mock("react-i18next",async(importOriginal)=>({...await importOriginal<typeof import("react-i18next")>(),useTranslation:()=>({t:(key:string)=>key})}));
import GroupDMCall from "./GroupDMCall";
import {useVoiceStore}from "../../stores/voiceStore";
import {useP2PCallStore}from "../../stores/p2pCallStore";
const credentials={token:"token",url:"wss://local",channel_id:"group",e2ee_passphrase:"key",e2ee_key_index:1,e2ee_key_epoch:1,e2ee_key_context:"context"};
beforeEach(()=>{vi.clearAllMocks();useVoiceStore.setState({isMuted:false,currentVoiceChannelId:null});useP2PCallStore.setState({activeCall:null});});
describe("group capture conflict intent",()=>{
 it("latches group mic off on another call and requires a new explicit unmute after it ends",async()=>{
  const view=render(<GroupDMCall credentials={credentials} onLeave={vi.fn()}/>);
  expect(h.audio.mock.lastCall?.[0]).toMatchObject({microphoneEnabled:true,conflict:false});
  act(()=>useVoiceStore.setState({currentVoiceChannelId:"guild"}));await waitFor(()=>expect(h.audio.mock.lastCall?.[0]).toMatchObject({microphoneEnabled:false,conflict:true}));
  act(()=>useVoiceStore.setState({currentVoiceChannelId:null}));expect(h.audio.mock.lastCall?.[0]).toMatchObject({microphoneEnabled:false,conflict:false});
  act(()=>(h.audio.mock.lastCall![0] as {onMicrophoneChange:(enabled:boolean)=>void}).onMicrophoneChange(true));expect(h.audio.mock.lastCall?.[0]).toMatchObject({microphoneEnabled:true});view.unmount();
 });
});
