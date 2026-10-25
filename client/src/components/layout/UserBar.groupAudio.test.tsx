import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { P2PCall } from "../../types";
import UserBar from "./UserBar";
import {registerCaptureAdmission}from "../../audio/microphoneAdmission";
import type {LocalParticipant}from "livekit-client";
import GroupDMCall from "../dm/GroupDMCall";
import {useVoiceStore}from "../../stores/voiceStore";
import {publishAuthOwnerChange,publishAuthGenerationChange}from "../../api/authSessionEvents";
import {activateMicrophoneCaptureView,useMicrophoneCaptureViewStore}from "../../stores/microphoneCaptureViewStore";
import {useGroupCallAudioControlStore}from "../../stores/groupCallAudioControlStore";
const audio=vi.hoisted(()=>({sources:[]as EventTarget[],createTrack:vi.fn(),room:null as unknown,tracks:[] as Array<{isMuted:boolean;mute:ReturnType<typeof vi.fn>;unmute:ReturnType<typeof vi.fn>;stop:ReturnType<typeof vi.fn>}>}));
vi.mock("../../audio/captureOwnedMicrophone",()=>({captureOwnedMicrophone:async(_settings:unknown,current:()=>boolean)=>{const track=await audio.createTrack();if(!current()){track.stop();throw new DOMException("obsolete","AbortError");}const source=Object.assign(new EventTarget(),{readyState:"live",stop:vi.fn()});audio.sources.push(source);return{track,source};}}));
vi.mock("livekit-client",async(importOriginal)=>({...await importOriginal<typeof import("livekit-client")>(),createLocalAudioTrack:audio.createTrack}));
vi.mock("../../audio/MicrophoneTrackProcessor",()=>({MicrophoneTrackProcessor:class{processedTrack={enabled:true};update=vi.fn(async()=>{});destroy=vi.fn(async()=>{});cancel=vi.fn();activate=vi.fn();}}));
vi.mock("../../audio/privateRoomPlayback",()=>({privateRoomPlayback:()=>()=>{}}));
vi.mock("../../hooks/useE2EEKeyProvider",()=>({useE2EEKeyProvider:()=>({keyProvider:{},e2eeWorker:{},keyReady:true,keyError:null,keyScope:"key",ownerScope:"owner"})}));
vi.mock("../../hooks/useEncryptedRoomAdmission",()=>({useEncryptedRoomAdmission:()=>({room:audio.room,connect:true,publishReady:true,error:null})}));
vi.mock("../../stores/groupDMStore",()=>{const getState=()=>({ownerId:"me",authGeneration:10,groupsReady:true,groups:[{id:"group",name:"Audio test group",key_epoch:1,members:[{id:"me"}]}]});return{useGroupDMStore:Object.assign((select:(state:ReturnType<typeof getState>)=>unknown)=>select(getState()),{subscribe:()=>()=>{},getState})};});
vi.mock("@livekit/components-react",()=>({LiveKitRoom:({children}:{children:React.ReactNode})=><>{children}</>,TrackToggle:()=>null,DisconnectButton:()=>null,useTracks:()=>[]}));


const state = vi.hoisted(() => ({
  auth: { user: { id: "me", username: "me", display_name: "Me", avatar_url: null }, manualStatus: "online" },
  voice: { currentVoiceChannelId: "voice-a" as string | null, currentVoiceServerId: "server-a", isMuted: false, isDeafened: false, muteBeforeDeafen:null as boolean|null,
    isStreaming: false, isCameraEnabled: false, setCameraEnabled: vi.fn(), noiseReduction: true, setNoiseReduction: vi.fn(), rtt: 25 },
  server: { servers: [{ id: "server-a", name: "Server A", icon_url: null }, { id: "server-b", name: "Server B", icon_url: null }], activeServerId: "server-b" },
  channel: { categories: [{ channels: [{ id: "voice-b", name: "Voice B" }] }], categoriesByServer: { "server-a": [{ channels: [{ id: "voice-a", name: "Voice A" }] }] } },
  p2p: { activeCall: null as P2PCall | null },
  settings: { openSettings: vi.fn() },
  ui: { openTab: vi.fn() },
  soundboard: { isPanelOpen: false, togglePanel: vi.fn(), closePanel: vi.fn() },
}));
vi.mock("../../stores/authStore", () => { const getState = () => state.auth; return { useAuthStore: Object.assign((select: (value: typeof state.auth) => unknown) => select(state.auth), { getState }) }; });
vi.mock("../../stores/serverStore", () => ({ useServerStore: Object.assign((select: (value: typeof state.server) => unknown) => select(state.server), { getState: () => state.server }) }));
vi.mock("../../stores/channelStore", () => ({ useChannelStore: (select: (value: typeof state.channel) => unknown) => select(state.channel) }));
vi.mock("../../stores/p2pCallStore",async()=>{const {create}=await import("zustand");return{useP2PCallStore:create(()=>({activeCall:null}))};});
vi.mock("../../stores/settingsStore", () => ({ useSettingsStore: (select: (value: typeof state.settings) => unknown) => select(state.settings) }));
vi.mock("../../stores/uiStore", () => ({ useUIStore: Object.assign((select: (value: typeof state.ui) => unknown) => select(state.ui), {getState:()=>state.ui,subscribe:()=>()=>{}}) }));
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
vi.mock("../p2p/P2PCallControls", () => ({ default: () => <span>Real P2P controls</span> }));


const credentials={token:"token",url:"wss://local",channel_id:"group",e2ee_passphrase:"key",e2ee_key_index:1,e2ee_key_epoch:1,e2ee_key_context:"context"};
const actions={onToggleMute:vi.fn(),onToggleDeafen:()=>useVoiceStore.getState().toggleDeafen(),onToggleScreenShare:vi.fn(),onDisconnect:vi.fn()};
beforeEach(()=>{
 vi.clearAllMocks();publishAuthOwnerChange("me");publishAuthGenerationChange(10);useGroupCallAudioControlStore.setState({control:null});useMicrophoneCaptureViewStore.setState({view:null,privateFailure:null,failedCall:null});
 useVoiceStore.setState({currentVoiceChannelId:null,currentVoiceServerId:null,isMuted:false,isDeafened:false,muteBeforeDeafen:null,isServerMuted:true,isServerDeafened:true,inputMode:"voice_activity"});audio.tracks=[];audio.sources=[];
 const publications=new Map();audio.room={state:"connected",remoteParticipants:new Map(),on:vi.fn(),off:vi.fn(),localParticipant:{permissions:{canPublish:true},trackPublications:publications,getTrackPublication:()=>[...publications.values()][0],publishTrack:vi.fn(async(track:unknown)=>{publications.set("mic",{track});}),unpublishTrack:vi.fn(async(track:unknown)=>{if(publications.get("mic")?.track===track)publications.delete("mic");})}};
 registerCaptureAdmission((audio.room as {localParticipant:LocalParticipant}).localParticipant,()=>true).open();
 audio.createTrack.mockImplementation(async()=>{const track={isMuted:false,setProcessor:vi.fn(async()=>{}),mute:vi.fn(async()=>{track.isMuted=true;}),unmute:vi.fn(async()=>{track.isMuted=false;}),stop:vi.fn()};audio.tracks.push(track);return track;});
});
describe("UserBar actual private group microphone owner",()=>{
 it("routes dock mute to the real shared group controller and reflects local-button intent",async()=>{
  const view=render(<><UserBar {...actions}/><GroupDMCall credentials={credentials} onLeave={vi.fn()}/></>);
  await waitFor(()=>expect(audio.tracks[0]?.unmute).toHaveBeenCalled());
  const dockMute=screen.getAllByRole("button",{name:"mute"}).find(element=>element.classList.contains("ub-ctrl"))!;
  fireEvent.click(dockMute);
  await waitFor(()=>expect(useGroupCallAudioControlStore.getState().control?.manualMuted).toBe(true));
  await waitFor(()=>expect(audio.tracks[0].mute).toHaveBeenCalled());expect(actions.onToggleMute).not.toHaveBeenCalled();
  const groupUnmute=screen.getAllByRole("button",{name:"unmute"}).find(element=>!element.classList.contains("ub-ctrl"))!;
  fireEvent.click(groupUnmute);await waitFor(()=>expect(useGroupCallAudioControlStore.getState().control?.manualMuted).toBe(false));
  expect(screen.getAllByRole("button",{name:"mute"}).some(element=>element.classList.contains("ub-ctrl"))).toBe(true);view.unmount();
 });
 it("does not inherit a global queued unmute when the group manual microphone stays muted",async()=>{
  const view=render(<><UserBar {...actions}/><GroupDMCall credentials={credentials} onLeave={vi.fn()}/></>);
  await waitFor(()=>expect(audio.tracks[0]?.unmute).toHaveBeenCalled());
  fireEvent.click(screen.getAllByRole("button",{name:"mute"}).find(element=>element.classList.contains("ub-ctrl"))!);
  await waitFor(()=>expect(useGroupCallAudioControlStore.getState().control?.manualMuted).toBe(true));
  act(()=>{useVoiceStore.getState().toggleDeafen();});expect(screen.getByRole("button",{name:"unmuteAfterUndeafen"})).toHaveAttribute("aria-pressed","true");
  act(()=>useVoiceStore.getState().toggleDeafen());expect(useVoiceStore.getState().isMuted).toBe(false);
  expect(useGroupCallAudioControlStore.getState().control?.manualMuted).toBe(true);expect(screen.getAllByRole("button",{name:"unmute"}).find(element=>element.classList.contains("ub-ctrl"))).toHaveAttribute("aria-pressed","true");view.unmount();
 });
 it("keeps the dock and actual group microphone muted after a conflicting guild capture ends until explicit dock unmute",async()=>{
  const view=render(<><UserBar {...actions}/><GroupDMCall credentials={credentials} onLeave={vi.fn()}/></>);
  await waitFor(()=>expect(audio.tracks[0]?.unmute).toHaveBeenCalled());
  act(()=>useVoiceStore.setState({currentVoiceChannelId:"guild"}));await waitFor(()=>expect(useGroupCallAudioControlStore.getState().control?.manualMuted).toBe(true));
  act(()=>useVoiceStore.setState({currentVoiceChannelId:null}));
  const dock=screen.getAllByRole("button",{name:"unmute"}).find(element=>element.classList.contains("ub-ctrl"))!;expect(dock).toHaveAttribute("aria-pressed","true");
  expect(audio.createTrack).toHaveBeenCalledTimes(1);fireEvent.click(dock);
  await waitFor(()=>expect(audio.createTrack).toHaveBeenCalledTimes(2));await waitFor(()=>expect(audio.tracks[1].unmute).toHaveBeenCalled());view.unmount();
 });

 it("never republishes an old component's control binding after account-generation retirement",async()=>{
  const view=render(<><UserBar {...actions}/><GroupDMCall credentials={credentials} onLeave={vi.fn()}/></>);await waitFor(()=>expect(audio.tracks[0]?.unmute).toHaveBeenCalled());
  act(()=>publishAuthGenerationChange(11));expect(useGroupCallAudioControlStore.getState().control).toBeNull();
  view.rerender(<><UserBar {...actions}/><GroupDMCall credentials={{...credentials,channel_id:"replacement"}} onLeave={vi.fn()}/></>);
  expect(useGroupCallAudioControlStore.getState().control).toBeNull();expect(audio.createTrack).toHaveBeenCalledTimes(1);view.unmount();
 });

 it("shows actual guild capture failure as effectively muted without overwriting manual intent",()=>{
  useVoiceStore.setState({currentVoiceChannelId:"guild",isMuted:false});activateMicrophoneCaptureView({nonce:"capture",owner:"me",generation:10,channelId:"guild",joinGeneration:useVoiceStore.getState()._joinGeneration,failed:true});
  const view=render(<UserBar {...actions}/>);expect(screen.getByRole("button",{name:"mute"})).toHaveAttribute("aria-pressed","true");expect(useVoiceStore.getState().isMuted).toBe(false);view.unmount();
 });

 it("retains logical group failure across render-boundary remount and retries only after explicit microphone recovery",async()=>{
  const view=render(<><UserBar {...actions}/><GroupDMCall key="first" callSessionNonce="logical" credentials={credentials} onLeave={vi.fn()}/></>);await waitFor(()=>expect(audio.tracks[0]?.unmute).toHaveBeenCalled());
  act(()=>audio.sources[0].dispatchEvent(new Event("ended")));await waitFor(()=>expect(useMicrophoneCaptureViewStore.getState().privateFailure?.nonce).toBe("logical"));
  view.rerender(<><UserBar {...actions}/><GroupDMCall key="boundary-retry" callSessionNonce="logical" credentials={credentials} onLeave={vi.fn()}/></>);
  expect(audio.createTrack).toHaveBeenCalledOnce();expect(screen.getByText("microphoneCaptureStopped")).toBeTruthy();
  fireEvent.click(screen.getByText("p2pAudioRetry"));await waitFor(()=>expect(audio.createTrack).toHaveBeenCalledTimes(2));view.unmount();
 });

});
