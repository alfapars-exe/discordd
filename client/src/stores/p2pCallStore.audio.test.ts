import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { P2PCall } from "../types";
import type { MicrophonePipeline } from "../audio/microphonePipeline";
import { useP2PCallStore } from "./p2pCallStore";
import { P2PMicrophoneSession } from "../webrtc/p2pMicrophone";

const mocks = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>, listeners: new Set<() => void>(),
  capture: vi.fn(), createPipeline: vi.fn(), register: vi.fn(), createPeer: vi.fn(), ws: vi.fn(),
}));
vi.mock("./voiceStore", () => ({ useVoiceStore: {
  getState: () => mocks.settings,
  subscribe: (listener: () => void) => { mocks.listeners.add(listener); return () => mocks.listeners.delete(listener); },
} }));
vi.mock("../audio/microphonePipeline", () => ({ createMicrophonePipeline: mocks.createPipeline }));
vi.mock("../audio/pipelineStatus", () => ({ registerMicrophonePipeline: mocks.register }));
vi.mock("../webrtc/p2pPeerConnection", () => ({ createPeerConnection: mocks.createPeer, applyDegradationPreference: vi.fn() }));
vi.mock("../i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("./toastStore", () => ({ useToastStore: { getState: () => ({ addToast: vi.fn() }) } }));
vi.mock("./preferencesStore", () => ({ usePreferencesStore: { getState: () => ({ set: vi.fn() }) } }));

class Stream {
  tracks: MediaStreamTrack[];
  constructor(tracks: MediaStreamTrack[] = []) { this.tracks = [...tracks]; }
  getTracks() { return [...this.tracks]; }
  getAudioTracks() { return this.tracks.filter((track) => track.kind === "audio"); }
  getVideoTracks() { return this.tracks.filter((track) => track.kind === "video"); }
  addTrack(track: MediaStreamTrack) { this.tracks.push(track); }
  removeTrack(track: MediaStreamTrack) { this.tracks = this.tracks.filter((candidate) => candidate !== track); }
}
const track = (id: string, kind = "audio") => ({ id, kind, enabled: true, stop: vi.fn() }) as unknown as MediaStreamTrack;
function pipeline(output: MediaStreamTrack): MicrophonePipeline {
  return { processedTrack: output, update: vi.fn().mockResolvedValue(undefined), dispose: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn(), subscribe: vi.fn(() => () => {}) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function changeSettings(patch: Record<string, unknown>) {
  Object.assign(mocks.settings, patch);
  mocks.listeners.forEach((listener) => listener());
}
function peer() {
  const senders: { track: MediaStreamTrack; replaceTrack: ReturnType<typeof vi.fn> }[] = [];
  const pc = {
    addTrack: vi.fn((output: MediaStreamTrack) => {
      const sender = { track: output, replaceTrack: vi.fn(async (next: MediaStreamTrack) => { sender.track = next; }) };
      senders.push(sender);
      return sender;
    }),
    getSenders: () => senders, getReceivers: () => [], close: vi.fn(),
    setRemoteDescription: vi.fn().mockResolvedValue(undefined), createAnswer: vi.fn().mockResolvedValue({ sdp: "answer" }),
    setLocalDescription: vi.fn().mockResolvedValue(undefined), addIceCandidate: vi.fn().mockResolvedValue(undefined),
  };
  mocks.createPeer.mockReturnValue(pc);
  return pc;
}
function setCall(video = false) {
  useP2PCallStore.setState({ activeCall: { id: "call", call_type: video ? "video" : "voice", status: "active" } as P2PCall, _sendWS: mocks.ws });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listeners.clear();
  mocks.settings = { noiseReduction: true, noiseReductionEngine: "deepfilter", noiseSuppressionLevel: "medium",
    micSensitivity: 50, inputVolume: 100, deepfilterSuppression: 70, micProfile: "konusma", inputDevice: "mic-1",
    cameraQuality: "720p", cameraFps: 30, cameraDevice: "camera-1" };
  mocks.register.mockImplementation(() => vi.fn());
  vi.stubGlobal("MediaStream", Stream);
  vi.stubGlobal("RTCSessionDescription", class { constructor(value: unknown) { Object.assign(this, value); } });
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: mocks.capture } });
  vi.spyOn(console, "error").mockImplementation(() => {});
  setCall();
});
afterEach(() => {
  useP2PCallStore.getState().cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("processed P2P microphones", () => {
  it.each(["caller", "receiver"])("publishes only ready processed audio for the %s while leaving video intact", async (role) => {
    setCall(true);
    const raw = track("raw");
    const camera = track("camera", "video");
    const output = track("processed");
    const ready = deferred<MicrophonePipeline>();
    mocks.capture.mockResolvedValue(new Stream([raw, camera]));
    mocks.createPipeline.mockReturnValue(ready.promise);
    const pc = peer();
    const start = role === "caller" ? useP2PCallStore.getState().startWebRTC(true)
      : useP2PCallStore.getState().handleSignal({ call_id: "call", type: "offer", sdp: "offer" });
    await vi.waitFor(() => expect(mocks.createPipeline).toHaveBeenCalledOnce());
    expect(pc.addTrack).not.toHaveBeenCalled();
    ready.resolve(pipeline(output));
    await start;
    expect(pc.addTrack.mock.calls.map(([item]) => item)).toEqual([output, camera]);
    expect(useP2PCallStore.getState().localStream?.getAudioTracks()).toEqual([output]);
    expect(mocks.capture.mock.calls[0][0].audio).toMatchObject({ deviceId: { exact: "mic-1" }, echoCancellation: true, noiseSuppression: false });
    expect(mocks.register).toHaveBeenCalledWith(expect.objectContaining({ processedTrack: output }), "call");
  });

  it("updates engine/gain/gate without capturing a second microphone", async () => {
    const raw = track("raw");
    const filter = pipeline(track("output"));
    mocks.capture.mockResolvedValue(new Stream([raw]));
    mocks.createPipeline.mockResolvedValue(filter);
    peer();
    await useP2PCallStore.getState().startWebRTC(true);
    changeSettings({ noiseReductionEngine: "gtcrn", inputVolume: 130, noiseSuppressionLevel: "high" });
    await vi.waitFor(() => expect(filter.update).toHaveBeenLastCalledWith(expect.objectContaining({ noiseReductionEngine: "gtcrn", inputVolume: 130, noiseSuppressionLevel: "high" })));
    expect(mocks.capture).toHaveBeenCalledOnce();
  });

  it("prepares device/profile replacements before swapping and preserves mute and video", async () => {
    setCall(true);
    const raw = track("raw");
    const camera = track("camera", "video");
    const oldFilter = pipeline(track("old-output"));
    mocks.capture.mockResolvedValueOnce(new Stream([raw, camera]));
    mocks.createPipeline.mockResolvedValueOnce(oldFilter);
    const pc = peer();
    await useP2PCallStore.getState().startWebRTC(true);
    const initialSignal = mocks.createPipeline.mock.calls[0][2].signal as AbortSignal;
    useP2PCallStore.getState().toggleMute();
    const nextRaw = track("next-raw");
    const nextFilter = pipeline(track("next-output"));
    const ready = deferred<MicrophonePipeline>();
    mocks.capture.mockResolvedValueOnce(new Stream([nextRaw]));
    mocks.createPipeline.mockReturnValueOnce(ready.promise);
    changeSettings({ inputDevice: "mic-2", micProfile: "muzik" });
    await vi.waitFor(() => expect(mocks.createPipeline).toHaveBeenCalledTimes(2));
    expect(initialSignal.aborted).toBe(false);
    expect(pc.getSenders()[0].track).toBe(oldFilter.processedTrack);
    expect(oldFilter.dispose).not.toHaveBeenCalled();
    ready.resolve(nextFilter);
    await vi.waitFor(() => expect(pc.getSenders()[0].track).toBe(nextFilter.processedTrack));
    expect(nextFilter.processedTrack.enabled).toBe(false);
    expect(raw.stop).toHaveBeenCalled();
    expect(oldFilter.dispose).toHaveBeenCalledOnce();
    expect(camera.stop).not.toHaveBeenCalled();
    expect(pc.getSenders()[1].track).toBe(camera);
    expect(mocks.capture.mock.calls[1][0]).toEqual({ audio: { deviceId: { exact: "mic-2" }, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 }, video: false });
    useP2PCallStore.getState().toggleMute();
    expect(nextFilter.processedTrack.enabled).toBe(true);
  });

  it("keeps the previous processed microphone after replacement failure", async () => {
    const raw = track("raw");
    const filter = pipeline(track("output"));
    mocks.capture.mockResolvedValueOnce(new Stream([raw]));
    mocks.createPipeline.mockResolvedValueOnce(filter);
    const pc = peer();
    await useP2PCallStore.getState().startWebRTC(true);
    mocks.capture.mockRejectedValueOnce(new Error("device unavailable"));
    changeSettings({ inputDevice: "missing" });
    await vi.waitFor(() => expect(console.error).toHaveBeenCalled());
    expect(pc.getSenders()[0].track).toBe(filter.processedTrack);
    expect(filter.dispose).not.toHaveBeenCalled();
    expect(useP2PCallStore.getState().activeCall).not.toBeNull();
  });

  it("releases a late capture after cancellation without publishing any audio", async () => {
    const capture = deferred<Stream>();
    mocks.capture.mockReturnValueOnce(capture.promise);
    const pc = peer();
    const start = useP2PCallStore.getState().startWebRTC(true);
    useP2PCallStore.getState().cleanup();
    const raw = track("late-raw");
    capture.resolve(new Stream([raw]));
    await start;
    expect(raw.stop).toHaveBeenCalled();
    expect(mocks.createPipeline).not.toHaveBeenCalled();
    expect(pc.addTrack).not.toHaveBeenCalled();
  });

  it("rejects failed initialization without sending the raw microphone", async () => {
    const raw = track("raw");
    mocks.capture.mockResolvedValue(new Stream([raw]));
    mocks.createPipeline.mockRejectedValueOnce(new Error("all processing paths failed"));
    const pc = peer();
    await useP2PCallStore.getState().startWebRTC(true);
    expect(raw.stop).toHaveBeenCalled();
    expect(pc.addTrack).not.toHaveBeenCalled();
    expect(useP2PCallStore.getState().activeCall).toBeNull();
  });

  it("discards stale device acquisition when a newer choice completes first", async () => {
    const initial = pipeline(track("initial"));
    mocks.capture.mockResolvedValueOnce(new Stream([track("raw")]));
    mocks.createPipeline.mockResolvedValueOnce(initial);
    const pc = peer();
    await useP2PCallStore.getState().startWebRTC(true);
    const staleCapture = deferred<Stream>();
    mocks.capture.mockReturnValueOnce(staleCapture.promise);
    changeSettings({ inputDevice: "mic-2" });
    const latest = pipeline(track("latest"));
    mocks.capture.mockResolvedValueOnce(new Stream([track("latest-raw")]));
    mocks.createPipeline.mockResolvedValueOnce(latest);
    changeSettings({ inputDevice: "mic-3" });
    await vi.waitFor(() => expect(pc.getSenders()[0].track).toBe(latest.processedTrack));
    const stale = track("stale");
    staleCapture.resolve(new Stream([stale]));
    await vi.waitFor(() => expect(stale.stop).toHaveBeenCalled());
    expect(pc.getSenders()[0].track).toBe(latest.processedTrack);
    expect(mocks.createPipeline).toHaveBeenCalledTimes(2);
  });

  it("preserves a mute change made while sender replacement is pending", async () => {
    const initial = pipeline(track("initial"));
    mocks.capture.mockResolvedValueOnce(new Stream([track("raw")]));
    mocks.createPipeline.mockResolvedValueOnce(initial);
    const pc = peer();
    await useP2PCallStore.getState().startWebRTC(true);
    const latest = pipeline(track("latest"));
    mocks.capture.mockResolvedValueOnce(new Stream([track("latest-raw")]));
    mocks.createPipeline.mockResolvedValueOnce(latest);
    const replace = deferred<void>();
    const sender = pc.getSenders()[0];
    sender.replaceTrack.mockImplementationOnce(async (next: MediaStreamTrack) => { await replace.promise; sender.track = next; });
    changeSettings({ inputDevice: "mic-2" });
    await vi.waitFor(() => expect(sender.replaceTrack).toHaveBeenCalled());
    useP2PCallStore.getState().toggleMute();
    replace.resolve();
    await vi.waitFor(() => expect(useP2PCallStore.getState().localStream?.getAudioTracks()).toEqual([latest.processedTrack]));
    expect(latest.processedTrack.enabled).toBe(false);
  });

  it("disposes model initialization that resolves after cleanup", async () => {
    const raw = track("raw");
    const filter = pipeline(track("late-output"));
    const ready = deferred<MicrophonePipeline>();
    mocks.capture.mockResolvedValue(new Stream([raw]));
    mocks.createPipeline.mockReturnValue(ready.promise);
    const pc = peer();
    const start = useP2PCallStore.getState().startWebRTC(true);
    await vi.waitFor(() => expect(mocks.createPipeline).toHaveBeenCalledOnce());
    useP2PCallStore.getState().cleanup();
    ready.resolve(filter);
    await start;
    expect(filter.dispose).toHaveBeenCalled();
    expect(raw.stop).toHaveBeenCalled();
    expect(pc.addTrack).not.toHaveBeenCalled();
  });

  it("releases prepared ownership when the session ends between capture and start continuations", async () => {
    const raw = track("raw");
    const camera = track("camera", "video");
    const filter = pipeline(track("output"));
    mocks.capture.mockResolvedValueOnce(new Stream([raw, camera]));
    mocks.createPipeline.mockResolvedValueOnce(filter);
    // Capture's checks succeed; the owning call disappears before start resumes.
    const isCurrent = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValue(false);
    const session = new P2PMicrophoneSession({ isCurrent, isMuted: () => false, replaceTrack: vi.fn(), onError: vi.fn() });
    await expect(session.start(true)).rejects.toMatchObject({ name: "AbortError" });
    expect(raw.stop).toHaveBeenCalled();
    expect(camera.stop).toHaveBeenCalled();
    expect(filter.processedTrack.stop).toHaveBeenCalled();
    expect(filter.dispose).toHaveBeenCalledOnce();
    session.dispose();
    expect(filter.dispose).toHaveBeenCalledOnce();
  });

  it("cleans raw capture, pipeline, status registration and settings subscription", async () => {
    const raw = track("raw");
    const filter = pipeline(track("output"));
    const unregister = vi.fn();
    mocks.register.mockReturnValue(unregister);
    mocks.capture.mockResolvedValue(new Stream([raw]));
    mocks.createPipeline.mockResolvedValue(filter);
    const pc = peer();
    await useP2PCallStore.getState().startWebRTC(true);
    expect(mocks.listeners.size).toBe(1);
    useP2PCallStore.getState().cleanup();
    expect(raw.stop).toHaveBeenCalled();
    expect(filter.dispose).toHaveBeenCalledOnce();
    expect(unregister).toHaveBeenCalledOnce();
    expect(mocks.listeners.size).toBe(0);
    expect(pc.close).toHaveBeenCalledOnce();
  });
});

it("gates private capture immediately for local deafen while retaining private manual mute intent",async()=>{
 const output=track("deafen-output");mocks.capture.mockResolvedValue(new Stream([track("raw")]));mocks.createPipeline.mockResolvedValue(pipeline(output));const pc=peer();await useP2PCallStore.getState().startWebRTC(true);
 expect(output.enabled).toBe(true);changeSettings({isDeafened:true});expect(output.enabled).toBe(false);expect(useP2PCallStore.getState().isMuted).toBe(false);
 useP2PCallStore.getState().toggleMute();expect(output.enabled).toBe(false);useP2PCallStore.getState().toggleMute();expect(output.enabled).toBe(false);
 changeSettings({isDeafened:false});expect(output.enabled).toBe(true);
 useP2PCallStore.getState().toggleMute();changeSettings({isDeafened:true});changeSettings({isDeafened:false});expect(output.enabled).toBe(false);expect(useP2PCallStore.getState().isMuted).toBe(true);
 useP2PCallStore.getState().toggleMute();changeSettings({isServerMuted:true});expect(output.enabled).toBe(true);expect(pc.addTrack).toHaveBeenCalled();
});
it("never publishes an enabled private microphone when local deafen arrives during preparation",async()=>{
 const output=track("prepared-deaf"),ready=deferred<MicrophonePipeline>();mocks.capture.mockResolvedValue(new Stream([track("raw")]));mocks.createPipeline.mockReturnValueOnce(ready.promise);const pc=peer();const start=useP2PCallStore.getState().startWebRTC(true);
 await vi.waitFor(()=>expect(mocks.createPipeline).toHaveBeenCalled());changeSettings({isDeafened:true});ready.resolve(pipeline(output));await start;
 expect(pc.addTrack).toHaveBeenCalled();expect(output.enabled).toBe(false);expect(useP2PCallStore.getState().isMuted).toBe(false);
});
it("keeps both old and staged replacement output disabled when deafened during sender replacement",async()=>{
 const first=pipeline(track("old"));mocks.capture.mockResolvedValueOnce(new Stream([track("raw-old")]));mocks.createPipeline.mockResolvedValueOnce(first);const pc=peer();await useP2PCallStore.getState().startWebRTC(true);
 const next=pipeline(track("next"));mocks.capture.mockResolvedValueOnce(new Stream([track("raw-next")]));mocks.createPipeline.mockResolvedValueOnce(next);const replace=deferred<void>(),sender=pc.getSenders()[0];sender.replaceTrack.mockImplementationOnce(async(track:MediaStreamTrack)=>{await replace.promise;sender.track=track;});
 changeSettings({inputDevice:"deaf-switch"});await vi.waitFor(()=>expect(sender.replaceTrack).toHaveBeenCalled());changeSettings({isDeafened:true});expect(first.processedTrack.enabled).toBe(false);expect(next.processedTrack.enabled).toBe(false);
 replace.resolve();await vi.waitFor(()=>expect(useP2PCallStore.getState().localStream?.getAudioTracks()).toEqual([next.processedTrack]));expect(next.processedTrack.enabled).toBe(false);
});
