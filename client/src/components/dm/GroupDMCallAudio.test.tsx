import {act,fireEvent,render,screen,waitFor}from "@testing-library/react";
import {afterEach,beforeEach,describe,expect,it,vi}from "vitest";
const h=vi.hoisted(()=>({sound:vi.fn(),controller:{subscribe:vi.fn(()=>()=>{}),getStatus:vi.fn(()=>({phase:"idle"})),setEnabled:vi.fn(async(enabled:boolean)=>{void enabled;}),refresh:vi.fn(async()=>{})},release:vi.fn(),playback:vi.fn(()=>vi.fn())}));
vi.mock("../../utils/sounds",()=>({playVoiceEventSound:h.sound}));
vi.mock("../../audio/liveMicrophone",()=>({liveMicrophone:()=>h.controller,releaseLiveMicrophone:h.release}));
vi.mock("../../audio/privateRoomPlayback",()=>({privateRoomPlayback:h.playback}));
vi.mock("react-i18next",async(importOriginal)=>({...await importOriginal<typeof import("react-i18next")>(),useTranslation:()=>({t:(key:string)=>key})}));
import GroupDMCallAudio from "./GroupDMCallAudio";
import {useVoiceStore}from "../../stores/voiceStore";
import {useP2PCallStore}from "../../stores/p2pCallStore";
import {useShortcutCaptureStore}from "../../stores/shortcutCaptureStore";
import {publishAuthOwnerChange,publishAuthGenerationChange}from "../../api/authSessionEvents";
import {registerCaptureAdmission,captureAdmissionCurrent}from "../../audio/microphoneAdmission";
import {useGroupCallStore}from "../../stores/groupCallStore";
import type{Room}from "livekit-client";
const room={localParticipant:{}}as Room;
beforeEach(()=>{vi.restoreAllMocks();vi.clearAllMocks();vi.spyOn(document,"hasFocus").mockReturnValue(true);publishAuthOwnerChange("owner");publishAuthGenerationChange(1);useVoiceStore.setState({isMuted:false,isDeafened:false,isServerMuted:true,isServerDeafened:true,currentVoiceChannelId:null,inputMode:"voice_activity",pttKey:"Space"});useP2PCallStore.setState({activeCall:null});useShortcutCaptureStore.setState({active:false});});
afterEach(()=>{window.electronAPI=undefined;});

describe("private group microphone controls",()=>{
 it("routes explicit private intent to the shared controller without guild moderation state",async()=>{
  const change=vi.fn();const view=render(<GroupDMCallAudio room={room} microphoneEnabled onMicrophoneChange={change} conflict={false}/>);
  await waitFor(()=>expect(h.controller.setEnabled).toHaveBeenLastCalledWith(true));
  act(()=>useVoiceStore.setState({isDeafened:true}));expect(h.controller.setEnabled).toHaveBeenLastCalledWith(false);
  fireEvent.click(screen.getByRole("button",{name:"mute"}));expect(change).toHaveBeenCalledWith(false);view.unmount();expect(h.release).toHaveBeenCalledWith(room.localParticipant,h.controller);
 });
 it("closes on another capture owner and keeps explicit disabled intent after that owner leaves",()=>{
  const view=render(<GroupDMCallAudio room={room} microphoneEnabled onMicrophoneChange={vi.fn()} conflict={false}/>);
  act(()=>useVoiceStore.setState({currentVoiceChannelId:"guild"}));expect(h.controller.setEnabled).toHaveBeenLastCalledWith(false);
  act(()=>useVoiceStore.setState({currentVoiceChannelId:null}));expect(h.controller.setEnabled).toHaveBeenLastCalledWith(false);
  act(()=>useVoiceStore.setState({currentVoiceChannelId:"guild"}));
  view.rerender(<GroupDMCallAudio room={room} microphoneEnabled={false} onMicrophoneChange={vi.fn()} conflict/>);
  expect(screen.getByRole("button",{name:"unmute"})).toBeDisabled();expect(screen.getByText("groupCaptureConflict")).toBeTruthy();
  act(()=>useVoiceStore.setState({currentVoiceChannelId:null}));view.rerender(<GroupDMCallAudio room={room} microphoneEnabled={false} onMicrophoneChange={vi.fn()} conflict={false}/>);
  expect(h.controller.setEnabled).toHaveBeenLastCalledWith(false);view.unmount();
 });
 it("uses focused PTT only, releases on blur/capture guard, and closes old auth ownership",()=>{
  useVoiceStore.setState({inputMode:"push_to_talk"});const view=render(<GroupDMCallAudio room={room} microphoneEnabled onMicrophoneChange={vi.fn()} conflict={false}/>);
  expect(h.controller.setEnabled).toHaveBeenLastCalledWith(false);expect(screen.getByText("groupFocusedPTT")).toBeTruthy();
  fireEvent.keyDown(document,{code:"Space"});expect(h.controller.setEnabled).toHaveBeenLastCalledWith(true);
  const visible=vi.spyOn(document,"visibilityState","get");visible.mockReturnValue("hidden");fireEvent(document,new Event("visibilitychange"));expect(h.controller.setEnabled).toHaveBeenLastCalledWith(false);
  h.controller.setEnabled.mockClear();fireEvent.keyDown(document,{code:"Space"});expect(h.controller.setEnabled).not.toHaveBeenCalled();visible.mockReturnValue("visible");
  fireEvent.keyDown(document,{code:"Space"});const input=document.createElement("textarea");document.body.append(input);fireEvent.focusIn(input);expect(h.controller.setEnabled).toHaveBeenLastCalledWith(false);input.remove();
  fireEvent.blur(window);expect(h.controller.setEnabled).toHaveBeenLastCalledWith(false);
  fireEvent.keyDown(document,{code:"Space"});act(()=>useShortcutCaptureStore.setState({active:true}));expect(h.controller.setEnabled).toHaveBeenLastCalledWith(false);
  act(()=>useShortcutCaptureStore.setState({active:false}));fireEvent.keyDown(document,{code:"Space"});act(()=>useVoiceStore.setState({pttKey:"KeyV"}));expect(h.controller.setEnabled).toHaveBeenLastCalledWith(false);
  act(()=>publishAuthGenerationChange(2));expect(h.release).toHaveBeenCalledWith(room.localParticipant,h.controller);view.unmount();
 });
 it("closes exact microphone admission and owned playback synchronously when persistent session metadata retires",()=>{
  let current=true;registerCaptureAdmission(room.localParticipant,()=>current).open();const view=render(<GroupDMCallAudio room={room} microphoneEnabled onMicrophoneChange={vi.fn()} conflict={false} isCurrentSession={()=>current}/>);
  expect(captureAdmissionCurrent(room.localParticipant)).toBe(true);const stop=h.playback.mock.results.at(-1)!.value;
  act(()=>{current=false;useGroupCallStore.setState({});});expect(captureAdmissionCurrent(room.localParticipant)).toBe(false);expect(h.controller.setEnabled).toHaveBeenLastCalledWith(false);expect(stop).toHaveBeenCalledOnce();view.unmount();
 });

 it("uses a scoped native lease while hidden, releases immediately on key admission closure and ignores stale native down",async()=>{
  const listeners=new Set<(signal:{leaseId:string;pressed:boolean})=>void>();let counter=0;
  const acquire=vi.fn(async()=>`lease${++counter}`),release=vi.fn(async()=>{});
  window.electronAPI={acquirePTTLease:acquire,releasePTTLease:release,onPTTLeaseSignal:(cb:(signal:{leaseId:string;pressed:boolean})=>void)=>{listeners.add(cb);return()=>{listeners.delete(cb);};}}as unknown as Window["electronAPI"];
  const admission=registerCaptureAdmission(room.localParticipant,()=>true);admission.open();useVoiceStore.setState({inputMode:"push_to_talk"});vi.spyOn(document,"hasFocus").mockReturnValue(false);vi.spyOn(document,"visibilityState","get").mockReturnValue("hidden");
  const view=render(<GroupDMCallAudio room={room} microphoneEnabled onMicrophoneChange={vi.fn()} conflict={false}/>);await act(async()=>{});
  expect(acquire).toHaveBeenCalledWith(expect.objectContaining({kind:"group",keyCode:"Space"}));expect(screen.queryByText("groupFocusedPTT")).toBeNull();
  const old=[...listeners][0];act(()=>old({leaseId:"lease1",pressed:true}));expect(h.controller.setEnabled).toHaveBeenLastCalledWith(true);
  fireEvent.blur(window);fireEvent(document,new Event("visibilitychange"));expect(h.controller.setEnabled).toHaveBeenLastCalledWith(true);
  act(()=>admission.close());expect(release).toHaveBeenCalledWith("lease1");expect(h.controller.setEnabled).toHaveBeenLastCalledWith(false);expect(listeners.size).toBe(0);
  h.controller.setEnabled.mockClear();act(()=>old({leaseId:"lease1",pressed:true}));expect(h.controller.setEnabled).not.toHaveBeenCalled();view.unmount();
 });
 it("releases native lease on deafen/key capture and does not reuse a stale source on auth replacement",async()=>{
  const listeners=new Set<(signal:{leaseId:string;pressed:boolean})=>void>();let counter=0;
  const acquire=vi.fn(async()=>`lease${++counter}`),release=vi.fn(async()=>{});window.electronAPI={acquirePTTLease:acquire,releasePTTLease:release,onPTTLeaseSignal:(cb:(signal:{leaseId:string;pressed:boolean})=>void)=>{listeners.add(cb);return()=>{listeners.delete(cb);};}}as unknown as Window["electronAPI"];
  registerCaptureAdmission(room.localParticipant,()=>true).open();useVoiceStore.setState({inputMode:"push_to_talk"});const view=render(<GroupDMCallAudio room={room} microphoneEnabled onMicrophoneChange={vi.fn()} conflict={false}/>);await act(async()=>{});
  act(()=>{for(const listener of listeners)listener({leaseId:"lease1",pressed:true});});expect(h.controller.setEnabled).toHaveBeenLastCalledWith(true);
  act(()=>useVoiceStore.setState({isDeafened:true}));expect(release).toHaveBeenCalledWith("lease1");expect(h.controller.setEnabled).toHaveBeenLastCalledWith(false);
  act(()=>useVoiceStore.setState({isDeafened:false,pttKey:"KeyV"}));await act(async()=>{});expect(acquire).toHaveBeenLastCalledWith(expect.objectContaining({keyCode:"KeyV"}));
  act(()=>publishAuthGenerationChange(2));expect(listeners.size).toBe(0);view.unmount();
 });

 it("reports failed native registration and retries without claiming an enabled microphone",async()=>{
  const acquire=vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce("recovered"),release=vi.fn(async()=>{}),listeners=new Set<(signal:{leaseId:string;pressed:boolean})=>void>();window.electronAPI={acquirePTTLease:acquire,releasePTTLease:release,onPTTLeaseSignal:(cb:(signal:{leaseId:string;pressed:boolean})=>void)=>{listeners.add(cb);return()=>{listeners.delete(cb);};}}as unknown as Window["electronAPI"];
  registerCaptureAdmission(room.localParticipant,()=>true).open();useVoiceStore.setState({inputMode:"push_to_talk"});const view=render(<GroupDMCallAudio room={room} microphoneEnabled onMicrophoneChange={vi.fn()} conflict={false}/>);expect(await screen.findByText("backgroundPTTUnavailable")).toBeTruthy();expect(h.controller.setEnabled).toHaveBeenLastCalledWith(false);
  fireEvent.click(screen.getByRole("button",{name:"p2pAudioRetry"}));await act(async()=>{});expect(acquire).toHaveBeenCalledTimes(2);expect(screen.queryByText("backgroundPTTUnavailable")).toBeNull();act(()=>{for(const listener of listeners)listener({leaseId:"recovered",pressed:true});});expect(h.controller.setEnabled).toHaveBeenLastCalledWith(true);view.unmount();
 });

});

it("group manual cues wait for successful current controller commits and ignore late/failed changes",async()=>{
 const change=vi.fn();h.controller.getStatus.mockReturnValue({phase:"ready"});const view=render(<GroupDMCallAudio room={room} microphoneEnabled onMicrophoneChange={change} conflict={false}/>);await waitFor(()=>expect(h.controller.setEnabled).toHaveBeenCalled());expect(h.sound).not.toHaveBeenCalled();h.controller.getStatus.mockReturnValue({phase:"idle"});view.rerender(<GroupDMCallAudio room={room} microphoneEnabled={false} onMicrophoneChange={change} conflict={false}/>);await waitFor(()=>expect(h.sound).toHaveBeenLastCalledWith("mute"));h.controller.setEnabled.mockImplementation(async(enabled:boolean)=>{if(enabled)throw new Error("capture")});view.rerender(<GroupDMCallAudio room={room} microphoneEnabled onMicrophoneChange={change} conflict={false}/>);await waitFor(()=>expect(screen.getByText("microphoneCaptureStopped")).toBeInTheDocument());expect(h.sound.mock.calls).toEqual([["mute"]]);view.unmount();
});

it("failed group controller status is not a successful mute acknowledgement",async()=>{
 const change=vi.fn();h.controller.setEnabled.mockResolvedValue(undefined);h.controller.getStatus.mockReturnValue({phase:"failed"});const view=render(<GroupDMCallAudio room={room} microphoneEnabled onMicrophoneChange={change} conflict={false}/>);await waitFor(()=>expect(h.controller.setEnabled).toHaveBeenCalled());view.rerender(<GroupDMCallAudio room={room} microphoneEnabled={false} onMicrophoneChange={change} conflict={false}/>);await waitFor(()=>expect(h.controller.setEnabled).toHaveBeenLastCalledWith(false));expect(h.sound).not.toHaveBeenCalled();view.unmount();
});
