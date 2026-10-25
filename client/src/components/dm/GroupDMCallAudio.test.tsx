import {act,fireEvent,render,screen,waitFor}from "@testing-library/react";
import {beforeEach,describe,expect,it,vi}from "vitest";
const h=vi.hoisted(()=>({controller:{setEnabled:vi.fn(async()=>{}),refresh:vi.fn(async()=>{})},release:vi.fn(),playback:vi.fn(()=>vi.fn())}));
vi.mock("../../audio/liveMicrophone",()=>({liveMicrophone:()=>h.controller,releaseLiveMicrophone:h.release}));
vi.mock("../../audio/privateRoomPlayback",()=>({privateRoomPlayback:h.playback}));
vi.mock("react-i18next",async(importOriginal)=>({...await importOriginal<typeof import("react-i18next")>(),useTranslation:()=>({t:(key:string)=>key})}));
import GroupDMCallAudio from "./GroupDMCallAudio";
import {useVoiceStore}from "../../stores/voiceStore";
import {useP2PCallStore}from "../../stores/p2pCallStore";
import {useShortcutCaptureStore}from "../../stores/shortcutCaptureStore";
import {publishAuthOwnerChange,publishAuthGenerationChange}from "../../api/authSessionEvents";
import type{Room}from "livekit-client";
const room={localParticipant:{}}as Room;
beforeEach(()=>{vi.restoreAllMocks();vi.clearAllMocks();vi.spyOn(document,"hasFocus").mockReturnValue(true);publishAuthOwnerChange("owner");publishAuthGenerationChange(1);useVoiceStore.setState({isMuted:false,isDeafened:false,isServerMuted:true,isServerDeafened:true,currentVoiceChannelId:null,inputMode:"voice_activity",pttKey:"Space"});useP2PCallStore.setState({activeCall:null});useShortcutCaptureStore.setState({active:false});});
describe("private group microphone controls",()=>{
 it("routes explicit private intent to the shared controller without guild moderation state",async()=>{
  const change=vi.fn();const view=render(<GroupDMCallAudio room={room} microphoneEnabled onMicrophoneChange={change} conflict={false}/>);
  await waitFor(()=>expect(h.controller.setEnabled).toHaveBeenLastCalledWith(true));
  act(()=>useVoiceStore.setState({isDeafened:true}));expect(h.controller.setEnabled).toHaveBeenLastCalledWith(false);
  fireEvent.click(screen.getByRole("button",{name:"mute"}));expect(change).toHaveBeenCalledWith(false);view.unmount();expect(h.release).toHaveBeenCalledWith(room.localParticipant);
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
  act(()=>publishAuthGenerationChange(2));expect(h.release).toHaveBeenCalledWith(room.localParticipant);view.unmount();
 });
});
