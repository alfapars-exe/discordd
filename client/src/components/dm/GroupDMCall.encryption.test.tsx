vi.mock("./GroupDMCallCamera",()=>({default:()=>null}));
vi.mock("./GroupScreenShareControl",()=>({default:()=> <button>screenShare</button>}));
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ admission: { room: {} as object | null, connect: true, publishReady: false, error: null as unknown }, room: vi.fn(), toggle: vi.fn(), admissionInput:vi.fn(), epoch:0 }));
vi.mock("../../stores/voiceStore",()=>{const state={isMuted:false,currentVoiceChannelId:null};return {useVoiceStore:Object.assign((select:(value:unknown)=>unknown)=>select(state),{getState:()=>state,subscribe:()=>()=>{}})};});
vi.mock("../../stores/p2pCallStore",()=>{const state={activeCall:null};return {useP2PCallStore:Object.assign((select:(value:unknown)=>unknown)=>select(state),{getState:()=>state,subscribe:()=>()=>{}})};});
vi.mock("./GroupDMCallAudio",()=>({default:()=> <div data-testid="audio"/>,privateCaptureConflict:()=>false}));
vi.mock("../../hooks/useE2EEKeyProvider", () => ({ useE2EEKeyProvider: () => ({ keyProvider: {}, e2eeWorker: {}, keyReady: true, keyError: null, keyScope: "key", ownerScope: "owner" }) }));
vi.mock("../../hooks/useEncryptedRoomAdmission", () => ({ useEncryptedRoomAdmission: (input:unknown) => { fixture.admissionInput(input); return fixture.admission; } }));
vi.mock("../../stores/groupDMStore", () => ({ useGroupDMStore: () => fixture.epoch }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@livekit/components-react", () => ({
 LiveKitRoom: (props: { children: React.ReactNode }) => { fixture.room(props); return <div>{props.children}</div>; },
 RoomAudioRenderer: () => <div data-testid="audio" />,
 TrackToggle: (props: { children: React.ReactNode }) => { fixture.toggle(props); return <button>{props.children}</button>; },
 DisconnectButton: (props: { children: React.ReactNode }) => <button>{props.children}</button>,
}));
import GroupDMCall from "./GroupDMCall";
const credentials = { token:"token", url:"wss://local", channel_id:"group", e2ee_passphrase:"key", e2ee_key_index:0, e2ee_key_epoch:0, e2ee_key_context:"context" };
beforeEach(() => { fixture.admission = { room:{}, connect:true, publishReady:false, error:null }; fixture.room.mockClear(); fixture.toggle.mockClear(); fixture.admissionInput.mockClear(); fixture.epoch=0; });
describe("group encrypted publication wiring", () => {
 it("connects transport without any auto-capture or direct capture controls until actual owner ACK", () => {
  const view = render(<GroupDMCall credentials={credentials} onLeave={vi.fn()} />);
  expect(fixture.room.mock.lastCall?.[0]).toMatchObject({ connect:true, audio:false, video:false, screen:false });
  expect(fixture.toggle).not.toHaveBeenCalled(); expect(screen.queryByTestId("audio")).toBeNull();
  fixture.admission.publishReady = true; view.rerender(<GroupDMCall credentials={credentials} onLeave={vi.fn()} />);
  expect(fixture.toggle).not.toHaveBeenCalled(); expect(screen.getByTestId("audio")).toBeTruthy();
  fixture.admission.publishReady = false; view.rerender(<GroupDMCall credentials={credentials} onLeave={vi.fn()} />);
  expect(screen.queryByText("microphone")).toBeNull(); expect(screen.queryByTestId("audio")).toBeNull();
  expect(fixture.room.mock.lastCall?.[0]).toMatchObject({ audio:false, video:false, screen:false });
 });
 it("shows a truthful fatal error with exit rather than constructing a fallback capture room", () => {
  fixture.admission = { room:null, connect:false, publishReady:false, error:new Error("worker") };
  render(<GroupDMCall credentials={credentials} onLeave={vi.fn()} />);
  expect(screen.getByRole("alert").textContent).toContain("voiceE2eeError"); expect(fixture.room).not.toHaveBeenCalled(); expect(fixture.toggle).not.toHaveBeenCalled();
 });
 it("closes material readiness as soon as the authoritative group epoch advances before token refresh",()=>{
  const view=render(<GroupDMCall credentials={credentials} onLeave={vi.fn()}/>);
  expect(fixture.admissionInput.mock.lastCall?.[0]).toMatchObject({keyReady:true});
  fixture.epoch=1;view.rerender(<GroupDMCall credentials={credentials} onLeave={vi.fn()}/>);
  expect(fixture.admissionInput.mock.lastCall?.[0]).toMatchObject({keyReady:false});
 });

});
