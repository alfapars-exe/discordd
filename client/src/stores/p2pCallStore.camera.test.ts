import { beforeEach, expect, it, vi } from "vitest";
import { useP2PCallStore } from "./p2pCallStore";

vi.mock("./voiceStore", () => ({ useVoiceStore: { getState: () => ({ cameraDevice: "usb", cameraQuality: "360p", cameraFps: 15 }) } }));
vi.mock("../webrtc/p2pPeerConnection", () => ({ createPeerConnection: vi.fn(), applyDegradationPreference: vi.fn() }));
const capture = vi.fn();
beforeEach(() => {
  capture.mockReset();
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: capture } });
});
function setup(previous?: MediaStreamTrack) {
  const oldTrack = previous;
  const stream = { getVideoTracks: () => oldTrack ? [oldTrack] : [], addTrack: vi.fn(), removeTrack: vi.fn() };
  const sender = { track: oldTrack, replaceTrack: vi.fn().mockResolvedValue(undefined) };
  const pc = { getSenders: () => oldTrack ? [sender] : [], addTrack: vi.fn() };
  type State = ReturnType<typeof useP2PCallStore.getState>;
  useP2PCallStore.setState({ activeCall: { id: "call" } as State["activeCall"], localStream: stream as unknown as MediaStream,
    peerConnection: pc as unknown as RTCPeerConnection, isVideoOn: false });
  return { stream, pc, sender };
}
it("uses saved camera settings and discards capture if the call ended during permission", async () => {
  const { pc } = setup();
  const track = { stop: vi.fn() };
  let resolve!: (value: unknown) => void;
  capture.mockReturnValue(new Promise((done) => { resolve = done; }));
  useP2PCallStore.getState().toggleVideo();
  useP2PCallStore.getState().toggleVideo();
  expect(capture).toHaveBeenCalledOnce();
  expect(capture).toHaveBeenCalledWith({ audio: false, video: { deviceId: { exact: "usb" },
    width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 15 } } });
  useP2PCallStore.setState({ activeCall: null });
  resolve({ getVideoTracks: () => [track] });
  await vi.waitFor(() => expect(track.stop).toHaveBeenCalledOnce());
  expect(pc.addTrack).not.toHaveBeenCalled();
});
it("replaces the disabled camera on reopening so changed settings take effect", async () => {
  const previous = { stop: vi.fn() } as unknown as MediaStreamTrack;
  const { sender, stream } = setup(previous);
  const next = { stop: vi.fn() };
  capture.mockResolvedValue({ getVideoTracks: () => [next] });
  useP2PCallStore.getState().toggleVideo();
  await vi.waitFor(() => expect(useP2PCallStore.getState().isVideoOn).toBe(true));
  expect(sender.replaceTrack).toHaveBeenCalledWith(next);
  expect(stream.removeTrack).toHaveBeenCalledWith(previous);
  expect(previous.stop).toHaveBeenCalledOnce();
});

it("releases initial camera and microphone capture after a cancelled outgoing call", async () => {
  setup();
  useP2PCallStore.setState({ _sendWS: vi.fn() });
  let resolve!: (value: unknown) => void;
  capture.mockReturnValue(new Promise((done) => { resolve = done; }));
  const request = useP2PCallStore.getState().startWebRTC(true);
  useP2PCallStore.setState({ activeCall: null, localStream: null });
  const track = { stop: vi.fn() };
  resolve({ getTracks: () => [track] });
  await request;
  expect(track.stop).toHaveBeenCalledOnce();
  expect(useP2PCallStore.getState().localStream).toBeNull();
});
