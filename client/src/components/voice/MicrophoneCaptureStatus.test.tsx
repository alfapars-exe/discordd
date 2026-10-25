import {act,fireEvent,render,screen}from "@testing-library/react";
import {beforeEach,describe,expect,it,vi}from "vitest";
const h=vi.hoisted(()=>({status:{phase:"failed"}as {phase:"idle"|"failed"},listeners:new Set<()=>void>(),canRecover:vi.fn(()=>true),retry:vi.fn(async()=>{}),state:{currentVoiceChannelId:"guild",inputMode:"voice_activity",isMuted:false,isServerMuted:false,isDeafened:false,isServerDeafened:false,inputDevice:"missing",setInputDevice:vi.fn()}}));
vi.mock("../../audio/liveMicrophone",()=>({liveMicrophone:()=>({subscribe:(fn:()=>void)=>{h.listeners.add(fn);return()=>h.listeners.delete(fn);},getStatus:()=>h.status,canRecover:h.canRecover,retry:h.retry})}));
vi.mock("../../stores/voiceStore",()=>({useVoiceStore:{getState:()=>h.state}}));
vi.mock("react-i18next",()=>({useTranslation:()=>({t:(key:string)=>key})}));
import MicrophoneCaptureStatus from "./MicrophoneCaptureStatus";
import {publishAuthOwnerChange,publishAuthGenerationChange}from "../../api/authSessionEvents";
import {activateMicrophoneCaptureView,bindMicrophoneCaptureView,releaseMicrophoneCaptureView,useMicrophoneCaptureViewStore}from "../../stores/microphoneCaptureViewStore";
import type{LocalParticipant}from "livekit-client";
beforeEach(()=>{vi.clearAllMocks();h.canRecover.mockReturnValue(true);h.listeners.clear();h.status={phase:"failed"};Object.assign(h.state,{currentVoiceChannelId:"guild",inputMode:"voice_activity",isMuted:false,isServerMuted:false,isDeafened:false,isServerDeafened:false,inputDevice:"missing"});h.state.setInputDevice.mockImplementation(value=>{h.state.inputDevice=value;});publishAuthOwnerChange("owner");publishAuthGenerationChange(1);useMicrophoneCaptureViewStore.setState({view:null});});
describe("truthful explicit microphone recovery",()=>{
 it("shows failure and changes the selected device only on explicit default action",()=>{
  const view=render(<MicrophoneCaptureStatus participant={{}as LocalParticipant}/>);expect(screen.getByRole("alert")).toBeTruthy();expect(h.retry).not.toHaveBeenCalled();expect(h.state.setInputDevice).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("microphoneUseDefault"));expect(h.state.setInputDevice).toHaveBeenCalledWith("");expect(h.retry).toHaveBeenCalledWith(true);view.unmount();
 });
 it.each(["muted","deafened","PTT"])("retry never secretly opens capture while %s",condition=>{
  if(condition==="muted")h.state.isMuted=true;if(condition==="deafened")h.state.isDeafened=true;if(condition==="PTT")h.state.inputMode="push_to_talk";
  const view=render(<MicrophoneCaptureStatus participant={{}as LocalParticipant}/>);fireEvent.click(screen.getByText("microphoneCaptureRetry"));expect(h.retry).toHaveBeenCalledWith(false);view.unmount();
 });
 it("keeps the effective failure indicator owner/channel scoped and clears only its own binding",()=>{
  const view=render(<MicrophoneCaptureStatus participant={{}as LocalParticipant}/>);expect(useMicrophoneCaptureViewStore.getState().view).toMatchObject({failed:true,channelId:"guild"});
  act(()=>publishAuthGenerationChange(2));expect(useMicrophoneCaptureViewStore.getState().view).toBeNull();act(()=>{h.status={phase:"idle"};h.listeners.forEach(fn=>fn());});expect(useMicrophoneCaptureViewStore.getState().view).toBeNull();view.unmount();
 });
 it("rejects old mount updates/releases and retained recovery actions after owner retirement",()=>{
  const view=render(<MicrophoneCaptureStatus participant={{}as LocalParticipant}/>);const first=useMicrophoneCaptureViewStore.getState().view!;
  activateMicrophoneCaptureView({...first,nonce:"replacement",failed:false});bindMicrophoneCaptureView({...first,failed:true});releaseMicrophoneCaptureView(first.nonce);expect(useMicrophoneCaptureViewStore.getState().view).toMatchObject({nonce:"replacement",failed:false});
  fireEvent.click(screen.getByText("microphoneUseDefault"));expect(h.state.setInputDevice).not.toHaveBeenCalled();expect(h.retry).not.toHaveBeenCalled();
  act(()=>publishAuthGenerationChange(2));fireEvent.click(screen.getByText("microphoneUseDefault"));expect(h.state.setInputDevice).not.toHaveBeenCalled();view.unmount();
 });

 it("does not change recovery preferences after its participant admission closes even before the view unmounts",()=>{
  const view=render(<MicrophoneCaptureStatus participant={{}as LocalParticipant}/>);h.canRecover.mockReturnValue(false);fireEvent.click(screen.getByText("microphoneUseDefault"));expect(h.state.setInputDevice).not.toHaveBeenCalled();expect(h.retry).not.toHaveBeenCalled();view.unmount();
 });

});
