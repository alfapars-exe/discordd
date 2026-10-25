import {act,fireEvent,render,screen,waitFor}from "@testing-library/react";
import {afterEach,beforeEach,expect,it,vi}from "vitest";
import type {Room}from "livekit-client";
import GroupDMCallCamera from "./GroupDMCallCamera";
import {registerCaptureAdmission}from "../../audio/microphoneAdmission";
import {publishAuthOwnerChange,publishAuthGenerationChange}from "../../api/authSessionEvents";
import {useVoiceStore}from "../../stores/voiceStore";
import {useGroupCallStore}from "../../stores/groupCallStore";
import i18n from "../../i18n";
let capture:ReturnType<typeof vi.fn>;
function raw(){let state="live";const source=Object.assign(new EventTarget(),{id:crypto.randomUUID(),kind:"video",enabled:true,muted:false,getSettings:()=>({width:640,height:360}),getConstraints:()=>({}),stop:vi.fn(()=>{state="ended";}),applyConstraints:vi.fn(async()=>{})});Object.defineProperty(source,"readyState",{get:()=>state});return source as unknown as MediaStreamTrack;}
function stream(track:MediaStreamTrack){return{getTracks:()=>[track],getVideoTracks:()=>[track]}as MediaStream;}
beforeEach(async()=>{await i18n.changeLanguage("en");publishAuthOwnerChange("owner");publishAuthGenerationChange(1);useVoiceStore.setState({cameraDevice:"usb",cameraQuality:"720p",cameraFps:30});capture=vi.fn();Object.defineProperty(navigator,"mediaDevices",{configurable:true,value:{getUserMedia:capture}});vi.stubGlobal("MediaStream",class extends EventTarget{tracks:MediaStreamTrack[];constructor(tracks:MediaStreamTrack[]=[]){super();this.tracks=tracks;}getTracks(){return this.tracks;}getVideoTracks(){return this.tracks;}getAudioTracks(){return[];}});});
afterEach(()=>vi.unstubAllGlobals());
function fixture(){const room={localParticipant:{publishTrack:vi.fn(async()=>({})),unpublishTrack:vi.fn(async()=>{})}}as unknown as Room;registerCaptureAdmission(room.localParticipant,()=>true).open();return room;}
it("waits for admitted explicit camera intent, uses live saved settings and retires raw capture on logical call loss",async()=>{
 const room=fixture(),first=raw(),second=raw();capture.mockResolvedValueOnce(stream(first)).mockResolvedValueOnce(stream(second));let current=true;const view=render(<GroupDMCallCamera room={room} admitted={false} current={()=>current}/>);expect(capture).not.toHaveBeenCalled();expect(screen.queryByRole("button")).toBeNull();view.rerender(<GroupDMCallCamera room={room} admitted current={()=>current}/>);fireEvent.click(screen.getByRole("button",{name:i18n.t("voice:camera")}));await waitFor(()=>expect(screen.getByRole("button",{name:i18n.t("voice:camera")})).toHaveAttribute("aria-pressed","true"));expect(capture).toHaveBeenCalledWith({audio:false,video:expect.objectContaining({deviceId:{exact:"usb"},frameRate:{ideal:30}})});
 act(()=>useVoiceStore.setState({cameraFps:15,cameraQuality:"360p"}));await waitFor(()=>expect(room.localParticipant.publishTrack).toHaveBeenCalledTimes(2));await waitFor(()=>expect(screen.getByRole("button",{name:i18n.t("voice:camera")})).toHaveAttribute("aria-pressed","true"));expect(first.stop).toHaveBeenCalled();expect(capture).toHaveBeenLastCalledWith({audio:false,video:expect.objectContaining({width:{ideal:640},frameRate:{ideal:15}})});
 act(()=>{current=false;useGroupCallStore.setState({});});expect(second.stop).toHaveBeenCalled();expect(second.enabled).toBe(false);view.unmount();
});
it("shows actual permission error and Retry without claiming camera active",async()=>{
 const room=fixture(),next=raw();capture.mockRejectedValueOnce(new DOMException("denied","NotAllowedError")).mockResolvedValueOnce(stream(next));const view=render(<GroupDMCallCamera room={room} admitted/>);fireEvent.click(screen.getByRole("button",{name:i18n.t("voice:camera")}));expect(await screen.findByRole("alert")).toHaveTextContent(i18n.t("settings:cameraPermissionDenied"));expect(screen.getByRole("button",{name:i18n.t("voice:camera")})).toHaveAttribute("aria-pressed","false");fireEvent.click(screen.getByRole("button",{name:i18n.t("settings:cameraRetry")}));await waitFor(()=>expect(screen.getByRole("button",{name:i18n.t("voice:camera")})).toHaveAttribute("aria-pressed","true"));expect(screen.queryByRole("alert")).toBeNull();view.unmount();
});
