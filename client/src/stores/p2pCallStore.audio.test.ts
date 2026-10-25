import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { P2PCall } from "../types";
import type { MicrophonePipeline } from "../audio/microphonePipeline";
import {setTokens,clearTokens} from "../api/client";
import {useAuthStore} from "./authStore";
import {useShortcutCaptureStore} from "./shortcutCaptureStore";
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
const track = (id: string, kind = "audio") => {
 const target=new EventTarget();let state="live";
 const result=Object.assign(target,{id,kind,enabled:true,stop:vi.fn(()=>{state="ended";}),end:()=>{state="ended";target.dispatchEvent(new Event("ended"));}});Object.defineProperty(result,"readyState",{get:()=>state});return result as unknown as MediaStreamTrack&{end:()=>void};
};
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
  useP2PCallStore.setState({ activeCall: { id: "call", caller_id:"owner",receiver_id:"peer", call_type: video ? "video" : "voice", status: "active" } as P2PCall, _sendWS: mocks.ws });
}

beforeEach(() => {
  vi.clearAllMocks();
  setTokens("local-p2p-test","","owner");useAuthStore.setState({user:{id:"owner"} as never});useShortcutCaptureStore.setState({active:false});
  mocks.listeners.clear();
  Object.defineProperty(document,"hidden",{configurable:true,value:false});
  mocks.settings = { noiseReduction: true, noiseReductionEngine: "deepfilter", noiseSuppressionLevel: "medium",
    micSensitivity: 50, inputVolume: 100, deepfilterSuppression: 70, micProfile: "konusma", inputDevice: "mic-1",
    setInputDevice:vi.fn((value:string)=>changeSettings({inputDevice:value})),
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
  clearTokens();
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

  it("silences and latches a replacement failure until explicit retry", async () => {
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
    expect(filter.processedTrack.enabled).toBe(false);
    expect(filter.dispose).toHaveBeenCalled();
    expect(useP2PCallStore.getState().microphoneFailure?.call).toBe(useP2PCallStore.getState().activeCall);
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
    expect(useP2PCallStore.getState().activeCall).not.toBeNull();
    expect(useP2PCallStore.getState().microphoneFailure).not.toBeNull();
    expect(useP2PCallStore.getState().peerConnection).toBeNull();
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
    expect(mocks.listeners.size).toBe(2); // microphone + accepted-call camera settings owners
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

it("latches raw-ended immediately and never recaptures from settings or queued mute intent",async()=>{
 const raw=track("ended-raw"),out=track("ended-output");mocks.capture.mockResolvedValueOnce(new Stream([raw]));mocks.createPipeline.mockResolvedValueOnce(pipeline(out));peer();await useP2PCallStore.getState().startWebRTC(true);
 raw.end();expect(out.enabled).toBe(false);expect(raw.stop).toHaveBeenCalled();expect(useP2PCallStore.getState().microphoneFailure).not.toBeNull();
 changeSettings({inputDevice:"mic-2",inputVolume:65});useP2PCallStore.getState().toggleMute();useP2PCallStore.getState().toggleMute();expect(out.enabled).toBe(false);expect(mocks.capture).toHaveBeenCalledOnce();
});
it("rejects raw-ended before pipeline initialization completes, retaining truthful initial failure until retry",async()=>{
 const raw=track("pre-init"),out=track("pre-init-output"),ready=deferred<MicrophonePipeline>();mocks.capture.mockResolvedValueOnce(new Stream([raw]));mocks.createPipeline.mockReturnValueOnce(ready.promise);const pc=peer();const starting=useP2PCallStore.getState().startWebRTC(true);
 await vi.waitFor(()=>expect(mocks.createPipeline).toHaveBeenCalled());raw.end();ready.resolve(pipeline(out));await starting;
 expect(out.enabled).toBe(false);expect(pc.addTrack).not.toHaveBeenCalled();expect(useP2PCallStore.getState().peerConnection).toBeNull();expect(useP2PCallStore.getState().activeCall).not.toBeNull();expect(useP2PCallStore.getState().microphoneFailure).not.toBeNull();
 const next=track("retry-initial"),nextOutput=track("retry-initial-output");mocks.capture.mockResolvedValueOnce(new Stream([next]));mocks.createPipeline.mockResolvedValueOnce(pipeline(nextOutput));
 expect(await useP2PCallStore.getState().retryMicrophone(useP2PCallStore.getState().activeCall!)).toBe(true);expect(pc.addTrack).toHaveBeenCalledWith(nextOutput,expect.anything());expect(useP2PCallStore.getState().microphoneFailure).toBeNull();
});
it("retries explicitly while manually muted and changes default preference only on the guarded action",async()=>{
 const raw=track("retry-raw"),out=track("retry-output");mocks.capture.mockResolvedValueOnce(new Stream([raw]));mocks.createPipeline.mockResolvedValueOnce(pipeline(out));const pc=peer();await useP2PCallStore.getState().startWebRTC(true);const call=useP2PCallStore.getState().activeCall!;raw.end();useP2PCallStore.getState().toggleMute();
 const retryOut=track("recovered"),retryRaw=track("recovered-raw");mocks.capture.mockResolvedValueOnce(new Stream([retryRaw]));mocks.createPipeline.mockResolvedValueOnce(pipeline(retryOut));
 expect(await useP2PCallStore.getState().retryMicrophone({...call},true)).toBe(false);expect(mocks.settings.setInputDevice).not.toHaveBeenCalled();
 expect(await useP2PCallStore.getState().retryMicrophone(call,true)).toBe(true);expect(mocks.settings.setInputDevice).toHaveBeenCalledExactlyOnceWith("");expect(mocks.capture.mock.calls[1][0].audio).not.toHaveProperty("deviceId");expect(pc.getSenders()[0].track).toBe(retryOut);expect(retryOut.enabled).toBe(false);expect(useP2PCallStore.getState().isMuted).toBe(true);
 useP2PCallStore.getState().toggleMute();expect(retryOut.enabled).toBe(true);
});
it("stops obsolete pending GUM after failure and refuses account/call replacement retries",async()=>{
 const raw=track("owner-raw"),out=track("owner-output");mocks.capture.mockResolvedValueOnce(new Stream([raw]));mocks.createPipeline.mockResolvedValueOnce(pipeline(out));peer();await useP2PCallStore.getState().startWebRTC(true);const call=useP2PCallStore.getState().activeCall!;
 const late=deferred<Stream>();mocks.capture.mockReturnValueOnce(late.promise);changeSettings({inputDevice:"pending-device"});raw.end();const candidate=track("obsolete");late.resolve(new Stream([candidate]));await vi.waitFor(()=>expect(candidate.stop).toHaveBeenCalled());expect(mocks.createPipeline).toHaveBeenCalledOnce();
 setTokens("other-auth","","other");useAuthStore.setState({user:{id:"other"} as never});useP2PCallStore.setState({activeCall:{...call,id:"replacement"}});
 expect(await useP2PCallStore.getState().retryMicrophone(call,true)).toBe(false);expect(mocks.settings.setInputDevice).not.toHaveBeenCalled();expect(out.enabled).toBe(false);
});
it("keeps a candidate silent through replaceTrack and recovers correct sender ownership after ended during await",async()=>{
 const raw=track("old-ended"),out=track("old-ended-output");mocks.capture.mockResolvedValueOnce(new Stream([raw]));mocks.createPipeline.mockResolvedValueOnce(pipeline(out));const pc=peer();await useP2PCallStore.getState().startWebRTC(true);const call=useP2PCallStore.getState().activeCall!;
 const nextRaw=track("candidate"),nextOut=track("candidate-output"),replace=deferred<void>();mocks.capture.mockResolvedValueOnce(new Stream([nextRaw]));mocks.createPipeline.mockResolvedValueOnce(pipeline(nextOut));const sender=pc.getSenders()[0];sender.replaceTrack.mockImplementationOnce(async(next:MediaStreamTrack)=>{await replace.promise;sender.track=next;});
 changeSettings({inputDevice:"new"});await vi.waitFor(()=>expect(sender.replaceTrack).toHaveBeenCalled());expect(nextOut.enabled).toBe(false);nextRaw.end();expect(out.enabled).toBe(false);replace.resolve();await vi.waitFor(()=>expect(nextOut.stop).toHaveBeenCalled());
 const recoveryOut=track("final-output");mocks.capture.mockResolvedValueOnce(new Stream([track("final-raw")]));mocks.createPipeline.mockResolvedValueOnce(pipeline(recoveryOut));expect(await useP2PCallStore.getState().retryMicrophone(call)).toBe(true);expect(sender.track).toBe(recoveryOut);expect(recoveryOut.enabled).toBe(true);
});
it("focused private PTT gates initial/recovered output and releases for editor/composition/capture/blur/key changes",async()=>{
 mocks.settings.inputMode="push_to_talk";mocks.settings.pttKey="Space";vi.spyOn(document,"hasFocus").mockReturnValue(true);Object.defineProperty(document,"hidden",{configurable:true,value:false});
 const raw=track("ptt-raw"),out=track("ptt-output");mocks.capture.mockResolvedValueOnce(new Stream([raw]));mocks.createPipeline.mockResolvedValueOnce(pipeline(out));peer();await useP2PCallStore.getState().startWebRTC(true);expect(out.enabled).toBe(false);
 document.dispatchEvent(new KeyboardEvent("keydown",{code:"Space",bubbles:true}));expect(out.enabled).toBe(true);window.dispatchEvent(new Event("blur"));expect(out.enabled).toBe(false);
 const input=document.createElement("textarea");document.body.append(input);input.dispatchEvent(new KeyboardEvent("keydown",{code:"Space",bubbles:true}));expect(out.enabled).toBe(false);input.remove();
 document.dispatchEvent(new KeyboardEvent("keydown",{code:"Space",isComposing:true,bubbles:true}));expect(out.enabled).toBe(false);
 document.dispatchEvent(new KeyboardEvent("keydown",{code:"Space",bubbles:true}));expect(out.enabled).toBe(true);useShortcutCaptureStore.setState({active:true});expect(out.enabled).toBe(false);useShortcutCaptureStore.setState({active:false});
 document.dispatchEvent(new KeyboardEvent("keydown",{code:"Space",bubbles:true}));changeSettings({pttKey:"KeyV"});expect(out.enabled).toBe(false);document.dispatchEvent(new KeyboardEvent("keydown",{code:"KeyV",bubbles:true}));expect(out.enabled).toBe(true);
 raw.end();const recovered=track("ptt-recovered");mocks.capture.mockResolvedValueOnce(new Stream([track("ptt-retry-raw")]));mocks.createPipeline.mockResolvedValueOnce(pipeline(recovered));expect(await useP2PCallStore.getState().retryMicrophone(useP2PCallStore.getState().activeCall!)).toBe(true);expect(recovered.enabled).toBe(false);
 document.dispatchEvent(new KeyboardEvent("keydown",{code:"KeyV",bubbles:true}));expect(recovered.enabled).toBe(true);document.dispatchEvent(new KeyboardEvent("keyup",{code:"KeyV",bubbles:true}));expect(recovered.enabled).toBe(false);
});

it("never acquires microphone before authoritative acceptance and ignores duplicate acceptance after capture",async()=>{
 const ringing={...useP2PCallStore.getState().activeCall!,status:"ringing" as const};useP2PCallStore.setState({activeCall:ringing});await useP2PCallStore.getState().startWebRTC(true);await useP2PCallStore.getState().handleSignal({call_id:ringing.id,type:"offer",sdp:"premature"});expect(mocks.capture).not.toHaveBeenCalled();expect(useP2PCallStore.getState().activeCall).toBe(ringing);
 useP2PCallStore.getState().handleCallAccept({call_id:ringing.id});const call=useP2PCallStore.getState().activeCall!;mocks.capture.mockResolvedValueOnce(new Stream([track("accepted-raw")]));const output=track("accepted-output");mocks.createPipeline.mockResolvedValueOnce(pipeline(output));peer();await useP2PCallStore.getState().startWebRTC(true);
 useP2PCallStore.getState().handleCallAccept({call_id:ringing.id});expect(useP2PCallStore.getState().activeCall).toBe(call);expect(output.enabled).toBe(true);expect(output.stop).not.toHaveBeenCalled();
});
it("detects already-ended capture before processor creation",async()=>{
 const raw=track("already-ended");raw.end();mocks.capture.mockResolvedValueOnce(new Stream([raw]));const pc=peer();await useP2PCallStore.getState().startWebRTC(true);expect(mocks.createPipeline).not.toHaveBeenCalled();expect(pc.addTrack).not.toHaveBeenCalled();expect(useP2PCallStore.getState().microphoneFailure).not.toBeNull();
});
it("keeps receiver initial failure truthful and retries only its retained exact-call offer",async()=>{
 mocks.capture.mockRejectedValueOnce(new DOMException("denied","NotAllowedError"));const pc=peer();await useP2PCallStore.getState().handleSignal({call_id:"call",type:"offer",sdp:"original"});expect(pc.setRemoteDescription).not.toHaveBeenCalled();const call=useP2PCallStore.getState().activeCall!;expect(call).not.toBeNull();expect(useP2PCallStore.getState().microphoneFailure).not.toBeNull();
 const output=track("receiver-retry");mocks.capture.mockResolvedValueOnce(new Stream([track("receiver-raw")]));mocks.createPipeline.mockResolvedValueOnce(pipeline(output));expect(await useP2PCallStore.getState().retryMicrophone(call)).toBe(true);expect(pc.setRemoteDescription).toHaveBeenCalledWith(expect.objectContaining({sdp:"original"}));
 expect(mocks.ws).toHaveBeenCalledWith("p2p_signal",expect.objectContaining({call_id:"call",type:"answer"}));
});
it("cancels retry candidates when the selected device changes mid-recovery without recapturing",async()=>{
 const raw=track("recovery-change-raw"),output=track("recovery-change-output");mocks.capture.mockResolvedValueOnce(new Stream([raw]));mocks.createPipeline.mockResolvedValueOnce(pipeline(output));peer();await useP2PCallStore.getState().startWebRTC(true);raw.end();const captured=deferred<Stream>();mocks.capture.mockReturnValueOnce(captured.promise);
 const pending=useP2PCallStore.getState().retryMicrophone(useP2PCallStore.getState().activeCall!);changeSettings({inputDevice:"changed-again"});const obsolete=track("recovery-obsolete");captured.resolve(new Stream([obsolete]));expect(await pending).toBe(false);expect(obsolete.stop).toHaveBeenCalled();expect(mocks.capture).toHaveBeenCalledTimes(2);expect(useP2PCallStore.getState().microphoneFailure).not.toBeNull();
});

it("explicit initial retry can retire a stuck old initializer and its late completion cannot end recovered call",async()=>{
 const raw=track("stuck-initial"),oldOutput=track("stuck-output"),oldReady=deferred<MicrophonePipeline>();mocks.capture.mockResolvedValueOnce(new Stream([raw]));mocks.createPipeline.mockReturnValueOnce(oldReady.promise);const pc=peer();const starting=useP2PCallStore.getState().startWebRTC(true);await vi.waitFor(()=>expect(mocks.createPipeline).toHaveBeenCalled());raw.end();const call=useP2PCallStore.getState().activeCall!;
 const recovered=track("stuck-recovered");mocks.capture.mockResolvedValueOnce(new Stream([track("stuck-retry-raw")]));mocks.createPipeline.mockResolvedValueOnce(pipeline(recovered));expect(await useP2PCallStore.getState().retryMicrophone(call)).toBe(true);oldReady.resolve(pipeline(oldOutput));await starting;
 expect(useP2PCallStore.getState().activeCall).toBe(call);expect(useP2PCallStore.getState().peerConnection).toBe(pc);expect(recovered.enabled).toBe(true);expect(oldOutput.enabled).toBe(false);expect(oldOutput.stop).toHaveBeenCalled();
});

it("retries without overriding local deafen intent",async()=>{
 const raw=track("deaf-retry-raw"),output=track("deaf-retry-output");mocks.capture.mockResolvedValueOnce(new Stream([raw]));mocks.createPipeline.mockResolvedValueOnce(pipeline(output));peer();await useP2PCallStore.getState().startWebRTC(true);raw.end();changeSettings({isDeafened:true});const recovered=track("deaf-recovered");mocks.capture.mockResolvedValueOnce(new Stream([track("deaf-recovered-raw")]));mocks.createPipeline.mockResolvedValueOnce(pipeline(recovered));
 expect(await useP2PCallStore.getState().retryMicrophone(useP2PCallStore.getState().activeCall!)).toBe(true);expect(recovered.enabled).toBe(false);expect(useP2PCallStore.getState().isMuted).toBe(false);changeSettings({isDeafened:false});expect(recovered.enabled).toBe(true);
});

it.each(["visibility","editable focus","composition","key up"])("focused P2P PTT releases immediately on %s",async reason=>{
 mocks.settings.inputMode="push_to_talk";mocks.settings.pttKey="Space";vi.spyOn(document,"hasFocus").mockReturnValue(true);const output=track("release-output");mocks.capture.mockResolvedValueOnce(new Stream([track("release-raw")]));mocks.createPipeline.mockResolvedValueOnce(pipeline(output));peer();await useP2PCallStore.getState().startWebRTC(true);
 document.dispatchEvent(new KeyboardEvent("keydown",{code:"Space",bubbles:true}));expect(output.enabled).toBe(true);
 if(reason==="visibility"){Object.defineProperty(document,"hidden",{configurable:true,value:true});document.dispatchEvent(new Event("visibilitychange"));}
 if(reason==="editable focus"){const input=document.createElement("textarea");document.body.append(input);input.focus();input.remove();}
 if(reason==="composition")document.dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true}));
 if(reason==="key up")document.dispatchEvent(new KeyboardEvent("keyup",{code:"Space",bubbles:true}));
 expect(output.enabled).toBe(false);
});
it("auth replacement retires a pending initial capture and its late rejection cannot clear another account's call",async()=>{
 const pending=deferred<Stream>();mocks.capture.mockReturnValueOnce(pending.promise);peer();const starting=useP2PCallStore.getState().startWebRTC(true);setTokens("new-owner-auth","","other");useAuthStore.setState({user:{id:"other"} as never});const replacement={...useP2PCallStore.getState().activeCall!,id:"other-call",caller_id:"other",receiver_id:"peer",status:"active" as const,call_type:"voice" as const};useP2PCallStore.setState({activeCall:replacement});
 const raw=track("old-account-late");pending.resolve(new Stream([raw]));await starting;expect(raw.stop).toHaveBeenCalled();expect(useP2PCallStore.getState().activeCall).toBe(replacement);expect(mocks.createPipeline).not.toHaveBeenCalled();
});

it("never commits a candidate to localStream when raw ends between sender replacement and resource commit",async()=>{
 const old=track("commit-old"),oldOut=track("commit-old-output");mocks.capture.mockResolvedValueOnce(new Stream([old]));mocks.createPipeline.mockResolvedValueOnce(pipeline(oldOut));const pc=peer();await useP2PCallStore.getState().startWebRTC(true);
 const next=track("commit-candidate"),nextOut=track("commit-candidate-output");mocks.capture.mockResolvedValueOnce(new Stream([next]));mocks.createPipeline.mockResolvedValueOnce(pipeline(nextOut));const sender=pc.getSenders()[0];sender.replaceTrack.mockImplementationOnce((output:MediaStreamTrack)=>Promise.resolve().then(()=>{sender.track=output;queueMicrotask(()=>queueMicrotask(()=>next.end()));}));
 changeSettings({inputDevice:"commit-race-device"});await vi.waitFor(()=>expect(useP2PCallStore.getState().microphoneFailure).not.toBeNull());expect(nextOut.enabled).toBe(false);expect(useP2PCallStore.getState().localStream?.getAudioTracks()).toEqual([oldOut]);
});

it.each(["ended","auth","call"])("accepted private PTT owns native background signals and retires exact leases across settings/%s",async(reason)=>{
 const listeners=new Set<(signal:{leaseId:string;pressed:boolean})=>void>();let id=0;
 const acquire=vi.fn(async()=>`lease${++id}`),release=vi.fn(async()=>{});
 window.electronAPI={acquirePTTLease:acquire,releasePTTLease:release,onPTTLeaseSignal:(cb:(signal:{leaseId:string;pressed:boolean})=>void)=>{listeners.add(cb);return()=>{listeners.delete(cb);};}}as unknown as Window["electronAPI"];
 try{
  const source=track("raw"),output=track("output");mocks.capture.mockResolvedValue(new Stream([source]));mocks.createPipeline.mockResolvedValue(pipeline(output));peer();changeSettings({inputMode:"push_to_talk",pttKey:"Space"});
  Object.defineProperty(document,"hidden",{configurable:true,value:true});vi.spyOn(document,"hasFocus").mockReturnValue(false);
  await useP2PCallStore.getState().startWebRTC(true);await Promise.resolve();expect(output.enabled).toBe(false);expect(acquire).toHaveBeenCalledWith(expect.objectContaining({kind:"p2p",keyCode:"Space"}));
  const old=[...listeners][0];old({leaseId:"lease1",pressed:true});expect(output.enabled).toBe(true);window.dispatchEvent(new Event("blur"));document.dispatchEvent(new Event("visibilitychange"));expect(output.enabled).toBe(true);
  changeSettings({pttKey:"KeyV"});await Promise.resolve();expect(output.enabled).toBe(false);expect(release).toHaveBeenCalledWith("lease1");old({leaseId:"lease1",pressed:true});expect(output.enabled).toBe(false);
  for(const listener of listeners)listener({leaseId:"lease2",pressed:true});expect(output.enabled).toBe(true);if(reason==="ended")source.end();else if(reason==="auth")clearTokens();else useP2PCallStore.getState().cleanup();expect(output.enabled).toBe(false);expect(listeners.size).toBe(0);expect(release).toHaveBeenCalledWith("lease2");
 }finally{window.electronAPI=undefined;}
});
