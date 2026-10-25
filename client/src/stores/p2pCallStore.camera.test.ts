import {startScreenShare}from "../webrtc/p2pScreenShare";
vi.mock("../webrtc/p2pScreenShare",()=>({startScreenShare:vi.fn(),stopScreenShare:vi.fn()}));
import { afterEach,beforeEach, expect, it, vi } from "vitest";
import {setTokens,clearTokens} from "../api/client";
import {useAuthStore} from "./authStore";
import { useP2PCallStore } from "./p2pCallStore";

vi.mock("./voiceStore", () => ({ useVoiceStore: { getState: () => ({ cameraDevice: "usb", cameraQuality: "360p", cameraFps: 15 }),subscribe:()=>()=>{} } }));
vi.mock("../webrtc/p2pPeerConnection", () => ({ createPeerConnection: vi.fn(), applyDegradationPreference: vi.fn() }));
const capture = vi.fn();
beforeEach(() => {
  setTokens("local-camera-test","","owner");useAuthStore.setState({user:{id:"owner"}as never});
  capture.mockReset();
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: capture } });
});
afterEach(()=>{useP2PCallStore.getState().cleanup();clearTokens();});
function raw(){const target=new EventTarget();return Object.assign(target,{kind:"video",enabled:true,readyState:"live",stop:vi.fn()})as unknown as MediaStreamTrack;}
function setup(previous?: MediaStreamTrack) {
  const oldTrack = previous;
  const stream = {getTracks:()=>oldTrack?[oldTrack]:[], getVideoTracks: () => oldTrack ? [oldTrack] : [], addTrack: vi.fn(), removeTrack: vi.fn() };
  const sender = { track: oldTrack??null, replaceTrack: vi.fn(async(next:MediaStreamTrack|null)=>{sender.track=next;}) };
  let added=false;const pc = {getReceivers:()=>[],close:vi.fn(), getSenders: () => oldTrack||added ? [sender] : [], addTrack: vi.fn((track:MediaStreamTrack)=>{added=true;sender.track=track;return sender;}) };
  type State = ReturnType<typeof useP2PCallStore.getState>;
  useP2PCallStore.setState({ activeCall: { id: "call",caller_id:"owner",receiver_id:"peer", status:"active" } as State["activeCall"], localStream: stream as unknown as MediaStream,
    peerConnection: pc as unknown as RTCPeerConnection, isVideoOn: false });
  return { stream, pc, sender };
}
it("uses saved camera settings and discards capture if the call ended during permission", async () => {
  const { pc } = setup();
  const track = raw();
  let resolve!: (value: unknown) => void;
  capture.mockReturnValue(new Promise((done) => { resolve = done; }));
  useP2PCallStore.getState().toggleVideo();
  useP2PCallStore.getState().toggleVideo();
  expect(capture).toHaveBeenCalledOnce();
  expect(capture).toHaveBeenCalledWith({ audio: false, video: { deviceId: { exact: "usb" },
    width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 15 } } });
  useP2PCallStore.setState({ activeCall: null });
  resolve({ getVideoTracks: () => [track],getTracks:()=>[track] });
  await vi.waitFor(() => expect(track.stop).toHaveBeenCalledOnce());
  expect(pc.addTrack).not.toHaveBeenCalled();
});
it("replaces the disabled camera on reopening so changed settings take effect", async () => {
  const previous = raw();
  const { sender, stream } = setup(previous);
  const next = raw();
  capture.mockResolvedValue({ getVideoTracks: () => [next],getTracks:()=>[next] });
  useP2PCallStore.getState().toggleVideo();
  await vi.waitFor(() => expect(useP2PCallStore.getState().isVideoOn).toBe(true));
  expect(sender.replaceTrack).toHaveBeenCalledWith(next);
  expect(stream.removeTrack).toHaveBeenCalledWith(previous);
  expect(previous.stop).toHaveBeenCalledOnce();
});

it("releases initial camera and microphone capture after a cancelled outgoing call", async () => {
  useP2PCallStore.setState({activeCall:null,localStream:null,peerConnection:null});
  setTokens("local-camera-test","","owner");useAuthStore.setState({user:{id:"owner"} as never});
  setup();
  useP2PCallStore.setState({ _sendWS: vi.fn() });
  let resolve!: (value: unknown) => void;
  capture.mockReturnValue(new Promise((done) => { resolve = done; }));
  const request = useP2PCallStore.getState().startWebRTC(true);
  useP2PCallStore.setState({ activeCall: null, localStream: null });
  const track = raw();
  resolve({ getTracks: () => [track] });
  await request;
  expect(track.stop).toHaveBeenCalledOnce();
  expect(useP2PCallStore.getState().localStream).toBeNull();
});

it.each(["ringing","ended"])("does not acquire camera for a %s private call",status=>{
 setup();const call=useP2PCallStore.getState().activeCall!;useP2PCallStore.setState({activeCall:{...call,status} as typeof call});useP2PCallStore.getState().toggleVideo();expect(capture).not.toHaveBeenCalled();expect(useP2PCallStore.getState().isVideoOn).toBe(false);
});

it("refuses a screen picker while the exact camera replacement is pending",async()=>{
 setup();vi.mocked(startScreenShare).mockClear();let resolve!:(stream:MediaStream)=>void;capture.mockReturnValue(new Promise<MediaStream>(done=>{resolve=done;}));useP2PCallStore.getState().toggleVideo();expect(capture).toHaveBeenCalledOnce();useP2PCallStore.getState().toggleScreenShare();expect(startScreenShare).not.toHaveBeenCalled();const track=raw();resolve({getTracks:()=>[track],getVideoTracks:()=>[track]}as MediaStream);await vi.waitFor(()=>expect(useP2PCallStore.getState().isVideoOn).toBe(true));
});
