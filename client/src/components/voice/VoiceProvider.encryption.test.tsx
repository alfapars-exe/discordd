vi.mock("../../video/useAuthorizedRoomVideos",()=>({useAuthorizedRoomVideos:()=>{},manualNativeVideo:()=>false}));
vi.mock("../../video/videoPresentation",()=>({isPresentedVideoContext:()=>false,subscribeVideoPresentation:()=>()=>{}}));
import { act, fireEvent, render, screen } from "@testing-library/react";
import { RoomEvent } from "livekit-client";
import { beforeEach, describe, expect, it, vi } from "vitest";
const fixture=vi.hoisted(()=>({ admission:{room:{} as object|null,connect:true,publishReady:false,error:null as unknown}, room:vi.fn(), failure:vi.fn(), admissionInput:vi.fn(), native:false, suspended:false }));
vi.mock("../../hooks/useE2EEKeyProvider",()=>({useE2EEKeyProvider:()=>({keyProvider:{},e2eeWorker:{},keyReady:true,keyError:null,keyScope:"key",ownerScope:"owner"})}));
vi.mock("../../hooks/useEncryptedRoomAdmission",()=>({useEncryptedRoomAdmission:(input:unknown)=>{fixture.admissionInput(input);return fixture.admission;}}));
vi.mock("../../hooks/useVoiceAutoRejoin",()=>({useVoiceAutoRejoin:()=>({handleDisconnected:vi.fn(), handleFailure:fixture.failure, handleConnectionError:vi.fn(), markReady:vi.fn(), restartId:0, suspended:fixture.suspended})}));
vi.mock("../../utils/nativePlugins",()=>({isNativeVoice:()=>fixture.native}));
vi.mock("../../audio/micProfile",()=>({micCaptureFor:()=>({}),micPublishFor:()=>({})}));
vi.mock("../../audio/microphoneSettings",()=>({microphoneSettings:()=>({})}));
vi.mock("../../stores/voiceStore",()=>{const state={livekitUrl:"wss://local",livekitToken:"token",currentVoiceChannelId:"channel"};return {useVoiceStore:Object.assign((select:(state:unknown)=>unknown)=>select(state),{getState:()=>state})};});
vi.mock("../../stores/channelStore",()=>({useChannelStore:(select:(state:unknown)=>unknown)=>select({categories:[]})}));
vi.mock("react-i18next",()=>({useTranslation:()=>({t:(key:string)=>key})}));
vi.mock("@livekit/components-react",async(importOriginal)=>{
 const actual=await importOriginal<typeof import("@livekit/components-react")>();
 return {...actual, LiveKitRoom:(props:import("@livekit/components-react").LiveKitRoomProps)=>{
  // Exercise the installed SDK's real event listener registration, not an
  // approximation that preserves participant information the SDK drops.
  actual.useLiveKitRoom(props);
  fixture.room(props);
  return <div>{props.children}</div>;
 }, RoomAudioRenderer:()=><div data-testid="audio"/>};
});
vi.mock("./VoiceStateManager",()=>({default:()=><div data-testid="publishers"/>}));
vi.mock("./StreamerPipPreview",()=>({default:()=><div data-testid="pip"/>}));
import VoiceProvider from "./VoiceProvider";
beforeEach(()=>{fixture.admission={room:eventRoom(),connect:true,publishReady:false,error:null};fixture.room.mockClear();fixture.failure.mockClear();fixture.admissionInput.mockClear();fixture.native=false;fixture.suspended=false;});
describe("main encrypted publication wiring",()=>{
 it("leaves SDK auto-capture off and mounts no publication owners until the actual-owner ACK",()=>{
  const view=render(<VoiceProvider><p>app</p></VoiceProvider>);
  expect(fixture.room.mock.lastCall?.[0]).toMatchObject({audio:false,video:false,screen:false,connect:true});
  expect(screen.queryByTestId("publishers")).toBeNull();expect(screen.queryByTestId("audio")).toBeNull();expect(screen.getByText("app")).toBeTruthy();
  expect((fixture.admissionInput.mock.lastCall![0] as {allowRestore:(source:string)=>boolean}).allowRestore("microphone")).toBe(false);
  fixture.admission.publishReady=true;view.rerender(<VoiceProvider><p>app</p></VoiceProvider>);
  expect(screen.getByTestId("publishers")).toBeTruthy();
  fixture.admission.publishReady=false;view.rerender(<VoiceProvider><p>app</p></VoiceProvider>);expect(screen.queryByTestId("publishers")).toBeNull();
 });
 it("does not connect the JS room or mount JS publishers in native mode",()=>{
  fixture.native=true;render(<VoiceProvider><p>app</p></VoiceProvider>);
  expect(fixture.room.mock.lastCall?.[0]).toMatchObject({audio:false,video:false,screen:false,connect:false});expect(screen.queryByTestId("publishers")).toBeNull();
 });
});

it("disposes the failed room and publishers while keeping the application visible during recovery",()=>{
 fixture.admission.publishReady=true;
 const view=render(<VoiceProvider><p>app</p><input aria-label="draft" defaultValue="" /></VoiceProvider>);
 fireEvent.change(screen.getByLabelText("draft"), {target:{value:"unsent message"}});
 expect(screen.getByTestId("publishers")).toBeTruthy();
 fixture.suspended=true;
 view.rerender(<VoiceProvider><p>app</p><input aria-label="draft" defaultValue="" /></VoiceProvider>);
 expect((screen.getByLabelText("draft") as HTMLInputElement).value).toBe("unsent message");
 expect(screen.queryByTestId("publishers")).toBeNull();expect(screen.queryByTestId("audio")).toBeNull();
 expect(screen.getByText("app")).toBeTruthy();
 expect(fixture.admissionInput.mock.lastCall![0]).toMatchObject({enabled:false});
});

function eventRoom() {
 const listeners=new Map<string,Set<(...args:unknown[])=>void>>();
 const room={
  on:(event:string,handler:(...args:unknown[])=>void)=>{
   const handlers=listeners.get(event)??new Set();handlers.add(handler);listeners.set(event,handlers);return room;
  },
  off:(event:string,handler:(...args:unknown[])=>void)=>{listeners.get(event)?.delete(handler);return room;},
  emit:(event:string,...args:unknown[])=>listeners.get(event)?.forEach(handler=>handler(...args)),
  connect:vi.fn(async()=>{}),disconnect:vi.fn(async()=>{}),
 };
 return room;
}

it("does not route remote decrypt errors through the real SDK wrapper into global recovery",()=>{
 fixture.admission.publishReady=true;
 const room=fixture.admission.room as ReturnType<typeof eventRoom>;
 render(<VoiceProvider><p>app</p></VoiceProvider>);
 expect(fixture.room.mock.lastCall![0].onEncryptionError).toBeUndefined();
 act(()=>room.emit(RoomEvent.EncryptionError,new Error("InvalidKey"),{identity:"__music_bot__:channel"}));
 expect(fixture.failure).not.toHaveBeenCalled();
 expect(room.disconnect).not.toHaveBeenCalled();
 expect(screen.getByTestId("publishers")).toBeTruthy();
 expect(screen.getByTestId("audio")).toBeTruthy();
 const error=new Error("local worker failed");
 act(()=>(fixture.admissionInput.mock.lastCall![0] as {onError:(error:unknown)=>void}).onError(error));
 expect(fixture.failure).toHaveBeenCalledExactlyOnceWith(error);
});
