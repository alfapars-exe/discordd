import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const fixture=vi.hoisted(()=>({ admission:{room:{} as object|null,connect:true,publishReady:false,error:null as unknown}, room:vi.fn(), admissionInput:vi.fn(), native:false }));
vi.mock("../../hooks/useE2EEKeyProvider",()=>({useE2EEKeyProvider:()=>({keyProvider:{},e2eeWorker:{},keyReady:true,keyError:null,keyScope:"key",ownerScope:"owner"})}));
vi.mock("../../hooks/useEncryptedRoomAdmission",()=>({useEncryptedRoomAdmission:(input:unknown)=>{fixture.admissionInput(input);return fixture.admission;}}));
vi.mock("../../hooks/useVoiceAutoRejoin",()=>({useVoiceAutoRejoin:()=>({handleDisconnected:vi.fn()})}));
vi.mock("../../utils/nativePlugins",()=>({isNativeVoice:()=>fixture.native}));
vi.mock("../../audio/micProfile",()=>({micCaptureFor:()=>({}),micPublishFor:()=>({})}));
vi.mock("../../audio/microphoneSettings",()=>({microphoneSettings:()=>({})}));
vi.mock("../../stores/voiceStore",()=>{const state={livekitUrl:"wss://local",livekitToken:"token",currentVoiceChannelId:"channel"};return {useVoiceStore:Object.assign((select:(state:unknown)=>unknown)=>select(state),{getState:()=>state})};});
vi.mock("../../stores/channelStore",()=>({useChannelStore:(select:(state:unknown)=>unknown)=>select({categories:[]})}));
vi.mock("react-i18next",()=>({useTranslation:()=>({t:(key:string)=>key})}));
vi.mock("@livekit/components-react",()=>({LiveKitRoom:(props:{children:React.ReactNode})=>{fixture.room(props);return <div>{props.children}</div>;},RoomAudioRenderer:()=><div data-testid="audio"/>}));
vi.mock("./VoiceStateManager",()=>({default:()=><div data-testid="publishers"/>}));
vi.mock("./StreamerPipPreview",()=>({default:()=><div data-testid="pip"/>}));
import VoiceProvider from "./VoiceProvider";
beforeEach(()=>{fixture.admission={room:{},connect:true,publishReady:false,error:null};fixture.room.mockClear();fixture.admissionInput.mockClear();fixture.native=false;});
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
