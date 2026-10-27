import {act,cleanup,fireEvent,render,screen} from "@testing-library/react";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {ConnectionState,LocalVideoTrack,type Room} from "livekit-client";
import GroupScreenShareControl from "./GroupScreenShareControl";
import {useGroupDMStore} from "../../stores/groupDMStore";
import {useVoiceStore} from "../../stores/voiceStore";
import {publishAuthOwnerChange,publishAuthGenerationChange} from "../../api/authSessionEvents";
import {registerCaptureAdmission} from "../../audio/microphoneAdmission";
vi.mock("react-i18next",async original=>({...await original<typeof import("react-i18next")>(),useTranslation:()=>({t:(key:string)=>key})}));
vi.mock("../../hooks/useDisplayInfo",()=>({useDisplayInfo:()=>({width:1920,height:1080,refreshRate:0})}));
function fixture(){const raw=Object.assign(new EventTarget(),{kind:"video",id:"screen",enabled:true,readyState:"live",getSettings:()=>({width:1920,height:1080}),getConstraints:()=>({}),applyConstraints:vi.fn().mockResolvedValue(undefined),stop:vi.fn()});const track=new LocalVideoTrack(raw as unknown as MediaStreamTrack);const participant={permissions:{canPublish:true},createScreenTracks:vi.fn().mockResolvedValue([track]),publishTrack:vi.fn().mockResolvedValue({}),unpublishTrack:vi.fn().mockResolvedValue(undefined)};const room={state:ConnectionState.Connected,localParticipant:participant,on:vi.fn(),off:vi.fn()} as unknown as Room;const admission=registerCaptureAdmission(room.localParticipant,()=>true);admission.open();return{raw,track,participant,room,admission};}
beforeEach(()=>{vi.stubGlobal("MediaStream",class {getTracks(){return [];}});publishAuthOwnerChange("owner");publishAuthGenerationChange(1);useGroupDMStore.setState({ownerId:"owner",authGeneration:1,groups:[{id:"group",key_epoch:1} as never]});useVoiceStore.setState({screenShareQuality:"720p",screenShareFps:30,screenShareLowLatency:false,screenShareMode:"motion"});});
afterEach(cleanup);
it("updates current publishing quality with device preferences and leaves the picker closed",async()=>{const f=fixture();render(<GroupScreenShareControl room={f.room} groupId="group" keyEpoch={1}/>);fireEvent.click(screen.getByRole("button",{name:"screenShare"}));await vi.waitFor(()=>expect(screen.getByRole("button",{name:"screenShare"})).toHaveAttribute("aria-pressed","true"));act(()=>useVoiceStore.setState({screenShareQuality:"1440p",screenShareFps:120}));await vi.waitFor(()=>expect(f.raw.applyConstraints).toHaveBeenLastCalledWith({width:{ideal:2560},height:{ideal:1440},frameRate:{ideal:120,max:120}}));expect(f.participant.createScreenTracks).toHaveBeenCalledOnce();});
it.each(["account","membership"])("stops a late picker after %s changes without publishing",async kind=>{const f=fixture();let finish!:(tracks:LocalVideoTrack[])=>void;f.participant.createScreenTracks.mockReturnValueOnce(new Promise(done=>{finish=done;}));render(<GroupScreenShareControl room={f.room} groupId="group" keyEpoch={1}/>);fireEvent.click(screen.getByRole("button",{name:"screenShare"}));act(()=>{if(kind==="account")publishAuthGenerationChange(2);else useGroupDMStore.setState({groups:[{id:"group",key_epoch:2} as never]});});await act(async()=>{finish([f.track]);});expect(f.raw.stop).toHaveBeenCalled();expect(f.participant.publishTrack).not.toHaveBeenCalled();});
it("does not capture if current room admission closes before the click",()=>{const f=fixture();render(<GroupScreenShareControl room={f.room} groupId="group" keyEpoch={1}/>);act(()=>f.admission.close());fireEvent.click(screen.getByRole("button",{name:"screenShare"}));expect(f.participant.createScreenTracks).not.toHaveBeenCalled();});

it("requires explicit audio choice and reports source-provided video-only as partial success",async()=>{
 const f=fixture();render(<GroupScreenShareControl room={f.room} groupId="group" keyEpoch={1}/>);const consent=screen.getByRole("checkbox",{name:"privateScreenAudioBrowserConsent"});expect(consent).not.toBeChecked();fireEvent.click(consent);fireEvent.click(screen.getByRole("button",{name:"screenShare"}));await vi.waitFor(()=>expect(screen.getByRole("button",{name:"screenShare"})).toHaveAttribute("aria-pressed","true"));expect(screen.getByText("privateScreenAudioNotReturned")).toBeInTheDocument();expect(screen.queryByText("privateScreenAudioShared")).toBeNull();expect(f.participant.createScreenTracks).toHaveBeenCalledWith(expect.objectContaining({audio:expect.objectContaining({channelCount:2})}));
});

it("dispatches live codec and content-priority choices from the private quality controls", async () => {
  const f = fixture();
  render(<GroupScreenShareControl room={f.room} groupId="group" keyEpoch={1} />);
  fireEvent.click(screen.getByRole("button", { name: "screenShare" }));
  await vi.waitFor(() => expect(screen.getByRole("button", { name: "screenShare" })).toHaveAttribute("aria-pressed", "true"));
  const lowLatency = screen.getByRole("checkbox", { name: "screenShareLowLatency" });
  expect(lowLatency).not.toBeChecked();
  fireEvent.click(lowLatency);
  expect(useVoiceStore.getState().screenShareLowLatency).toBe(true);
  await vi.waitFor(() => expect(f.participant.publishTrack).toHaveBeenLastCalledWith(f.track, expect.objectContaining({ videoCodec: "h264" })));
  expect(f.participant.unpublishTrack).toHaveBeenCalledExactlyOnceWith(f.track, false);
  const publishCount = f.participant.publishTrack.mock.calls.length;
  fireEvent.change(screen.getByRole("combobox", { name: "screenShareMode" }), { target: { value: "detail" } });
  expect(useVoiceStore.getState().screenShareMode).toBe("detail");
  await vi.waitFor(() => expect(f.track.publishOptions?.degradationPreference).toBe("maintain-resolution"));
  expect(f.participant.publishTrack).toHaveBeenCalledTimes(publishCount);
  expect(f.participant.createScreenTracks).toHaveBeenCalledOnce();
  expect(f.raw.stop).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "screenShare" })).toHaveAttribute("aria-pressed", "true");
});
