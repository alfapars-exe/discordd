import { afterEach,beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { P2PCall } from "../../types";
import UserBar from "./UserBar";
import {registerCaptureAdmission}from "../../audio/microphoneAdmission";
import type {LocalParticipant}from "livekit-client";
import GroupDMCall from "../dm/GroupDMCall";
import {useP2PCallStore}from "../../stores/p2pCallStore";
import {useP2PCall}from "../../hooks/useP2PCall";
import {useVoiceStore}from "../../stores/voiceStore";
import {publishAuthOwnerChange,publishAuthGenerationChange}from "../../api/authSessionEvents";
import {useMicrophoneCaptureViewStore}from "../../stores/microphoneCaptureViewStore";
import {useGroupCallAudioControlStore}from "../../stores/groupCallAudioControlStore";
const audio=vi.hoisted(()=>({sources:[]as EventTarget[],createTrack:vi.fn(),room:null as unknown,tracks:[] as Array<{isMuted:boolean;mute:ReturnType<typeof vi.fn>;unmute:ReturnType<typeof vi.fn>;stop:ReturnType<typeof vi.fn>}>}));
vi.mock("../../audio/captureOwnedMicrophone",()=>({captureOwnedMicrophone:async(_settings:unknown,current:()=>boolean)=>{const track=await audio.createTrack();if(!current()){track.stop();throw new DOMException("obsolete","AbortError");}const source=Object.assign(new EventTarget(),{readyState:"live",stop:vi.fn()});audio.sources.push(source);return{track,source};}}));
vi.mock("livekit-client",async(importOriginal)=>({...await importOriginal<typeof import("livekit-client")>(),createLocalAudioTrack:audio.createTrack}));
vi.mock("../../audio/MicrophoneTrackProcessor",()=>({MicrophoneTrackProcessor:class{processedTrack={enabled:true};update=vi.fn(async()=>{});destroy=vi.fn(async()=>{});cancel=vi.fn();activate=vi.fn();}}));
vi.mock("../../audio/privateRoomPlayback",()=>({privateRoomPlayback:()=>()=>{}}));
vi.mock("../../hooks/useE2EEKeyProvider",()=>({useE2EEKeyProvider:()=>({keyProvider:{},e2eeWorker:{},keyReady:true,keyError:null,keyScope:"key",ownerScope:"owner"})}));
vi.mock("../../hooks/useEncryptedRoomAdmission",()=>({useEncryptedRoomAdmission:()=>({room:audio.room,connect:true,publishReady:true,error:null})}));
vi.mock("../../stores/groupDMStore",()=>({useGroupDMStore:Object.assign(()=>1,{subscribe:()=>()=>{},getState:()=>({groups:[]})})}));
vi.mock("@livekit/components-react",()=>({LiveKitRoom:({children}:{children:React.ReactNode})=><>{children}</>,TrackToggle:()=>null,DisconnectButton:()=>null}));


const state = vi.hoisted(() => ({
  auth: { user: { id: "me", username: "me", display_name: "Me", avatar_url: null }, manualStatus: "online" },
  voice: { currentVoiceChannelId: "voice-a" as string | null, currentVoiceServerId: "server-a", isMuted: false, isDeafened: false, muteBeforeDeafen:null as boolean|null,
    isStreaming: false, isCameraEnabled: false, setCameraEnabled: vi.fn(), noiseReduction: true, setNoiseReduction: vi.fn(), rtt: 25 },
  server: { servers: [{ id: "server-a", name: "Server A", icon_url: null }, { id: "server-b", name: "Server B", icon_url: null }], activeServerId: "server-b" },
  channel: { categories: [{ channels: [{ id: "voice-b", name: "Voice B" }] }], categoriesByServer: { "server-a": [{ channels: [{ id: "voice-a", name: "Voice A" }] }] } },
  p2p: { activeCall: null as P2PCall | null },
  settings: { openSettings: vi.fn() },
  ui: { openTab: vi.fn(),destination:{type:"group-dm",channelId:"group"},closeDestination:vi.fn() },
  soundboard: { isPanelOpen: false, togglePanel: vi.fn(), closePanel: vi.fn() },
}));
vi.mock("../../stores/authStore", () => { const getState = () => state.auth; return { useAuthStore: Object.assign((select: (value: typeof state.auth) => unknown) => select(state.auth), { getState }) }; });
vi.mock("../../stores/serverStore", () => ({ useServerStore: Object.assign((select: (value: typeof state.server) => unknown) => select(state.server), { getState: () => state.server }) }));
vi.mock("../../stores/channelStore", () => ({ useChannelStore: (select: (value: typeof state.channel) => unknown) => select(state.channel) }));
vi.mock("../../stores/settingsStore", () => ({ useSettingsStore: (select: (value: typeof state.settings) => unknown) => select(state.settings) }));
vi.mock("../../stores/uiStore", () => ({ useUIStore:Object.assign((select:(value:typeof state.ui)=>unknown)=>select(state.ui),{getState:()=>state.ui}) }));
vi.mock("../../stores/soundboardStore", () => ({ useSoundboardStore: Object.assign((select: (value: typeof state.soundboard) => unknown) => select(state.soundboard), { getState: () => state.soundboard }) }));
vi.mock("../../utils/uiShell", () => ({ UI_SHELL_V2: true }));
vi.mock("../../hooks/useDismissablePopup", () => ({ useDismissablePopup: () => {} }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }), initReactI18next: { type: "3rdParty", init: () => {} } }));
vi.mock("../shared/Avatar", () => ({ default: () => <span>Avatar</span> }));
vi.mock("../members/MemberCard", () => ({ default: () => null }));
vi.mock("./AudioDevicePopup", () => ({ default: () => null }));
vi.mock("../voice/ScreenShareQualityPopup", () => ({ default: () => null }));
vi.mock("../voice/VoiceConnectionStatus", () => ({ default: () => <span>Connected</span> }));
vi.mock("../soundboard/SoundboardPanel", () => ({ default: () => null }));
vi.mock("../p2p/P2PCallControls", () => ({ default: ({minimal}:{minimal?:boolean}) => <span>{minimal?"Ringing actions":"Real P2P controls"}</span> }));


const credentials={token:"token",url:"wss://local",channel_id:"group",e2ee_passphrase:"key",e2ee_key_index:1,e2ee_key_epoch:1,e2ee_key_context:"context"};
const actions={onToggleMute:vi.fn(),onToggleDeafen:()=>useVoiceStore.getState().toggleDeafen(),onToggleScreenShare:vi.fn(),onDisconnect:vi.fn()};
beforeEach(()=>{
 vi.clearAllMocks();publishAuthOwnerChange("me");publishAuthGenerationChange(10);useGroupCallAudioControlStore.setState({control:null});useMicrophoneCaptureViewStore.setState({view:null,privateFailure:null,failedCall:null});
 useVoiceStore.setState({currentVoiceChannelId:null,currentVoiceServerId:null,isMuted:false,isDeafened:false,muteBeforeDeafen:null,isServerMuted:true,isServerDeafened:true,inputMode:"voice_activity"});audio.tracks=[];audio.sources=[];
 const publications=new Map();audio.room={state:"connected",on:vi.fn(),off:vi.fn(),localParticipant:{permissions:{canPublish:true},trackPublications:publications,getTrackPublication:()=>[...publications.values()][0],publishTrack:vi.fn(async(track:unknown)=>{publications.set("mic",{track});}),unpublishTrack:vi.fn(async(track:unknown)=>{if(publications.get("mic")?.track===track)publications.delete("mic");})}};
 registerCaptureAdmission((audio.room as {localParticipant:LocalParticipant}).localParticipant,()=>true).open();
 audio.createTrack.mockImplementation(async()=>{const track={isMuted:false,setProcessor:vi.fn(async()=>{}),mute:vi.fn(async()=>{track.isMuted=true;}),unmute:vi.fn(async()=>{track.isMuted=false;}),stop:vi.fn()};audio.tracks.push(track);return track;});
});

const originalStart=useP2PCallStore.getState().startWebRTC;
const call=(caller:boolean):P2PCall=>({id:"ring",caller_id:caller?"me":"friend",receiver_id:caller?"friend":"me",caller_username:"caller",caller_display_name:null,caller_avatar:null,receiver_username:"receiver",receiver_display_name:null,receiver_avatar:null,status:"ringing",call_type:"voice",created_at:"2026-10-25T00:00:00Z"});
function Orchestration(){useP2PCall();return null;}
afterEach(()=>{useP2PCallStore.getState().cleanup();useP2PCallStore.setState({startWebRTC:originalStart});});
describe("ringing signals do not own group capture",()=>{
 it.each([false,true])("leaves group mic/dock/command ownership intact for unaccepted outgoing=%s signaling",async(caller)=>{
  const start=vi.fn(async()=>{});useP2PCallStore.setState({activeCall:null,incomingCall:null,startWebRTC:start});const gum=vi.fn();vi.stubGlobal("navigator",{...navigator,mediaDevices:{getUserMedia:gum}});
  const view=render(<><Orchestration/><UserBar {...actions}/><GroupDMCall credentials={credentials} onLeave={vi.fn()}/></>);await waitFor(()=>expect(audio.tracks[0]?.unmute).toHaveBeenCalled());
  act(()=>useP2PCallStore.getState().handleCallInitiate(call(caller)));expect(start).not.toHaveBeenCalled();expect(screen.getByText("Ringing actions")).toBeTruthy();expect(gum).not.toHaveBeenCalled();expect(audio.createTrack).toHaveBeenCalledOnce();expect(useGroupCallAudioControlStore.getState().control?.manualMuted).toBe(false);
  const dock=screen.getAllByRole("button",{name:"mute"}).find(element=>element.classList.contains("ub-ctrl"))!;expect(dock).toHaveAttribute("aria-pressed","false");fireEvent.click(dock);await waitFor(()=>expect(audio.tracks[0].mute).toHaveBeenCalled());expect(actions.onToggleMute).not.toHaveBeenCalled();view.unmount();
 });
 it("hands capture ownership over only on acceptance and requires explicit group unmute after the accepted call ends",async()=>{
  const start=vi.fn(async()=>{});useP2PCallStore.setState({activeCall:null,incomingCall:null,startWebRTC:start});const view=render(<><Orchestration/><UserBar {...actions}/><GroupDMCall credentials={credentials} onLeave={vi.fn()}/></>);await waitFor(()=>expect(audio.tracks[0]?.unmute).toHaveBeenCalled());
  act(()=>useP2PCallStore.getState().handleCallInitiate(call(false)));expect(useGroupCallAudioControlStore.getState().control?.manualMuted).toBe(false);
  act(()=>useP2PCallStore.getState().handleCallAccept({call_id:"ring"}));expect(start).toHaveBeenCalledWith(false);await waitFor(()=>expect(useGroupCallAudioControlStore.getState().control?.manualMuted).toBe(true));expect(screen.getByText("Real P2P controls")).toBeTruthy();
  act(()=>useP2PCallStore.getState().cleanup());expect(audio.createTrack).toHaveBeenCalledOnce();const dock=screen.getAllByRole("button",{name:"unmute"}).find(element=>element.classList.contains("ub-ctrl"))!;expect(dock).toHaveAttribute("aria-pressed","true");fireEvent.click(dock);await waitFor(()=>expect(audio.createTrack).toHaveBeenCalledTimes(2));view.unmount();
 });
});
