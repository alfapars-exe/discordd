import { beforeEach, describe, expect, it, vi } from "vitest";
import {registerCaptureAdmission}from "./microphoneAdmission";
import {useMicrophoneCaptureViewStore}from "../stores/microphoneCaptureViewStore";
import {publishAuthOwnerChange,publishAuthGenerationChange}from "../api/authSessionEvents";
import type { LocalParticipant } from "livekit-client";
import type { MicrophoneSettings } from "./microphoneSettings";
import { liveMicrophone, releaseLiveMicrophone } from "./liveMicrophone";

const mock = vi.hoisted(() => ({
  sound:vi.fn(), storeListeners:new Set<()=>void>(),sources: [] as EventTarget[], createTrack: vi.fn(), getState: vi.fn(), processors: [] as Array<{
    processedTrack: { enabled: boolean }; update: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn>; activate: ReturnType<typeof vi.fn>;
  }>,
}));
vi.mock("../utils/sounds",()=>({playVoiceEventSound:mock.sound}));
vi.mock("./captureOwnedMicrophone",()=>({captureOwnedMicrophone:async(settings:{micProfile:string},current:()=>boolean)=>{
 const music=settings.micProfile==="muzik";const track=await mock.createTrack({echoCancellation:!music,autoGainControl:!music,noiseSuppression:!music,channelCount:music?2:1});
 if(!current()){track.stop();throw new DOMException("Obsolete capture","AbortError");}
 const source=Object.assign(new EventTarget(),{readyState:"live",stop:vi.fn()});mock.sources.push(source);return{track,source};
}}));
vi.mock("livekit-client", () => ({ Track: { Source: { Microphone: "microphone" } }, createLocalAudioTrack: mock.createTrack }));
vi.mock("../stores/voiceStore", () => ({ useVoiceStore: { getState: mock.getState,subscribe:(fn:()=>void)=>{mock.storeListeners.add(fn);return()=>mock.storeListeners.delete(fn);} } }));
vi.mock("./MicrophoneTrackProcessor", () => ({
  MicrophoneTrackProcessor: class {
    processedTrack = { enabled: true };
    update = vi.fn(async () => {});
    destroy = vi.fn(async () => {});
    cancel = vi.fn();
    activate = vi.fn();
    constructor() { mock.processors.push(this); }
  },
}));
const defaults: MicrophoneSettings = {
  noiseReduction: true, noiseReductionEngine: "rnnoise", noiseSuppressionLevel: "medium",
  micSensitivity: 50, inputVolume: 100, deepfilterSuppression: 70, micProfile: "konusma", inputDevice: "",
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
function harness() {
  const state = { ...defaults, isMuted: false, isServerMuted: false };
  mock.getState.mockImplementation(() => state);
  const events: string[] = [];
  const tracks: ReturnType<typeof makeTrack>[] = [];
  function makeTrack() {
    const id: number = tracks.length;
    return {
      id, isMuted: false,
      setProcessor: vi.fn(async () => { events.push(`ready:${id}`); }),
      mute: vi.fn(async () => { events.push(`mute:${id}`); }),
      unmute: vi.fn(async () => { events.push(`unmute:${id}`); }),
      stop: vi.fn(),
    };
  }
  mock.createTrack.mockImplementation(async () => { const track = makeTrack(); tracks.push(track); return track; });
  const participant = {
    getTrackPublication: vi.fn(),
    publishTrack: vi.fn(async (track: { id: number }, _options?: Record<string, unknown>) => { events.push(`publish:${track.id}`); }),
    unpublishTrack: vi.fn(async (track: { id: number }) => { events.push(`unpublish:${track.id}`); }),
  };
  const sdkParticipant = participant as unknown as LocalParticipant;
  const admission=registerCaptureAdmission(sdkParticipant,()=>true);admission.open();
  return { state, events, tracks, participant, sdkParticipant, admission, controller: liveMicrophone(sdkParticipant) };
}
beforeEach(() => { publishAuthOwnerChange("mic-owner");publishAuthGenerationChange(1);vi.clearAllMocks(); mock.processors = [];mock.sources=[];mock.storeListeners.clear();useMicrophoneCaptureViewStore.setState({failedCall:null,privateFailure:null,view:null}); });

describe("live microphone publication ownership", () => {
  it("does not publish before the selected processor is ready", async () => {
    const h = harness();
    const ready = deferred();
    const captured = deferred();
    mock.createTrack.mockImplementationOnce(async () => {
      await captured.promise;
      return { setProcessor: vi.fn(() => ready.promise), mute: vi.fn(), unmute: vi.fn(), stop: vi.fn() };
    });
    const enabling = h.controller.setEnabled(true);
    await flush();
    expect(h.participant.publishTrack).not.toHaveBeenCalled();
    captured.resolve();
    await flush();
    expect(h.participant.publishTrack).not.toHaveBeenCalled();
    ready.resolve();
    await enabling;
    expect(h.participant.publishTrack).toHaveBeenCalledOnce();
    expect(mock.processors[0].update).toHaveBeenCalledWith(defaults);
    expect(mock.processors[0].activate).toHaveBeenCalledOnce();
    await releaseLiveMicrophone(h.sdkParticipant);
  });

  it("cancels a pending initial capture when muted and disposes its late result", async () => {
    const h = harness();
    const capture = deferred();
    const lateTrack = { setProcessor: vi.fn(), stop: vi.fn() };
    mock.createTrack.mockImplementationOnce(async () => { await capture.promise; return lateTrack; });
    const enabling = h.controller.setEnabled(true);
    await flush();
    const muting = h.controller.setEnabled(false);
    capture.resolve();
    await Promise.all([enabling, muting]);
    expect(h.participant.publishTrack).not.toHaveBeenCalled();
    expect(lateTrack.setProcessor).not.toHaveBeenCalled();
    expect(lateTrack.stop).toHaveBeenCalledOnce();
    expect(mock.processors).toHaveLength(0);
    await releaseLiveMicrophone(h.sdkParticipant);
  });

  it("mutes processed output immediately while a slow settings update is pending", async () => {
    const h = harness();
    await h.controller.setEnabled(true);
    const update = deferred();
    mock.processors[0].update.mockImplementation(() => update.promise);
    const refreshing = h.controller.refresh();
    const muting = h.controller.setEnabled(false);
    expect(mock.processors[0].processedTrack.enabled).toBe(false);
    expect(h.tracks[0].mute).toHaveBeenCalled();
    update.resolve();
    await Promise.all([refreshing, muting]);
    expect(mock.processors[0].processedTrack.enabled).toBe(false);
    expect(h.participant.publishTrack).toHaveBeenCalledOnce();
    await releaseLiveMicrophone(h.sdkParticipant);
  });

  it("prepares a music graph then explicitly unpublishes and republishes with music options", async () => {
    const h = harness();
    await h.controller.setEnabled(true);
    h.state.micProfile = "muzik";
    await h.controller.refresh();
    expect(mock.createTrack.mock.calls[1][0]).toMatchObject({ echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 });
    expect(h.participant.publishTrack.mock.calls[1][1]).toMatchObject({ source: "microphone", forceStereo: true, dtx: false, red: false });
    expect(h.events.indexOf("ready:1")).toBeLessThan(h.events.indexOf("unpublish:0"));
    expect(h.events.indexOf("unpublish:0")).toBeLessThan(h.events.indexOf("publish:1"));
    expect(mock.processors[0].destroy).toHaveBeenCalledOnce();
    await releaseLiveMicrophone(h.sdkParticipant);
  });

  it("unpublishes a candidate whose publication completed after cancellation", async () => {
    const h = harness();
    const publishing = deferred();
    h.participant.publishTrack.mockImplementationOnce(async () => publishing.promise);
    const enabling = h.controller.setEnabled(true);
    await flush();
    expect(h.participant.publishTrack).toHaveBeenCalledOnce();
    const releasing = releaseLiveMicrophone(h.sdkParticipant);
    publishing.resolve();
    await Promise.all([enabling, releasing]);
    expect(h.participant.unpublishTrack).toHaveBeenCalledWith(h.tracks[0], true);
    expect(h.tracks[0].stop).toHaveBeenCalledOnce();
    expect(mock.processors[0].activate).not.toHaveBeenCalled();
  });

  it("reuses a controller per participant and does not create a microphone when server-muted", async () => {
    const h = harness();
    expect(liveMicrophone(h.sdkParticipant)).toBe(h.controller);
    h.state.isServerMuted = true;
    await h.controller.setEnabled(true);
    expect(mock.createTrack).not.toHaveBeenCalled();
    await releaseLiveMicrophone(h.sdkParticipant);
    expect(liveMicrophone(h.sdkParticipant)).not.toBe(h.controller);
    await releaseLiveMicrophone(h.sdkParticipant);
  });
});

it("never enables a deafened or server-muted microphone even with an explicit stale enable request",async()=>{
 const h=harness();Object.assign(h.state,{isDeafened:true});await h.controller.setEnabled(true);expect(mock.createTrack).not.toHaveBeenCalled();
 Object.assign(h.state,{isDeafened:false,isServerMuted:true});await h.controller.setEnabled(true);expect(mock.createTrack).not.toHaveBeenCalled();
 await releaseLiveMicrophone(h.sdkParticipant);
});

it("uses explicit private manual intent and local deafen without importing guild moderation",async()=>{
 const h=harness();await releaseLiveMicrophone(h.sdkParticipant);
 Object.assign(h.state,{isMuted:true,isServerMuted:true,isDeafened:false});
 const controller=liveMicrophone(h.sdkParticipant,"private");await controller.setEnabled(true);
 expect(h.participant.publishTrack).toHaveBeenCalledOnce();expect(h.tracks[0].unmute).toHaveBeenCalled();
 Object.assign(h.state,{isDeafened:true});await controller.setEnabled(true);
 expect(h.tracks[0].mute).toHaveBeenCalled();expect(mock.processors[0].processedTrack.enabled).toBe(false);
 expect(()=>liveMicrophone(h.sdkParticipant)).toThrow("scope mismatch");
 await releaseLiveMicrophone(h.sdkParticipant);
});
it("retires a private controller's pending GUM result without publishing or unpublishing a replacement owner's track",async()=>{
 const h=harness();await releaseLiveMicrophone(h.sdkParticipant);
 const gate=deferred();const lateTrack={setProcessor:vi.fn(),stop:vi.fn()};
 mock.createTrack.mockImplementationOnce(async()=>{await gate.promise;return lateTrack;});
 const old=liveMicrophone(h.sdkParticipant,"private");const enabling=old.setEnabled(true);await flush();
 const disposed=releaseLiveMicrophone(h.sdkParticipant);
 const fresh=liveMicrophone(h.sdkParticipant,"private");await fresh.setEnabled(true);
 const replacement=h.tracks[0];expect(h.participant.publishTrack).toHaveBeenCalledWith(replacement,expect.anything());
 gate.resolve();await enabling;await disposed;
 expect(lateTrack.stop).toHaveBeenCalledOnce();expect(h.participant.publishTrack).toHaveBeenCalledOnce();expect(h.participant.unpublishTrack).not.toHaveBeenCalledWith(replacement,true);
 await releaseLiveMicrophone(h.sdkParticipant);
});
it("silences an ended owned source immediately and latches failure until explicit retry",async()=>{
 const h=harness();await h.controller.setEnabled(true);expect(h.controller.getStatus().phase).toBe("ready");
 const source=mock.sources[0]as EventTarget&{readyState:string};source.readyState="ended";source.dispatchEvent(new Event("ended"));
 expect(mock.processors[0].processedTrack.enabled).toBe(false);expect(h.controller.getStatus()).toEqual({phase:"failed",reason:"source_ended"});
 await h.controller.setEnabled(true);await h.controller.refresh();expect(mock.createTrack).toHaveBeenCalledOnce();
 await h.controller.retry(false);expect(mock.createTrack).toHaveBeenCalledOnce();expect(h.controller.getStatus().phase).toBe("idle");
 await h.controller.setEnabled(true);expect(mock.createTrack).toHaveBeenCalledTimes(2);await releaseLiveMicrophone(h.sdkParticipant);
});
it("does not silently retry failed acquisition or fall through to another input device",async()=>{
 const h=harness();mock.createTrack.mockRejectedValueOnce(new DOMException("device missing","NotFoundError"));
 await expect(h.controller.setEnabled(true)).rejects.toMatchObject({name:"NotFoundError"});expect(h.controller.getStatus().phase).toBe("failed");
 await h.controller.refresh();await h.controller.setEnabled(true);expect(mock.createTrack).toHaveBeenCalledOnce();
 await h.controller.retry(true);expect(mock.createTrack).toHaveBeenCalledTimes(2);expect(h.controller.getStatus().phase).toBe("ready");await releaseLiveMicrophone(h.sdkParticipant);
});
it("retires pending raw capture synchronously on auth change and never publishes it into a replacement owner",async()=>{
 const h=harness();const ready=deferred();mock.createTrack.mockImplementationOnce(async()=>({setProcessor:vi.fn(()=>ready.promise),stop:vi.fn(),mute:vi.fn(async()=>{}),unmute:vi.fn(async()=>{})}));
 const old=h.controller.setEnabled(true);await flush();const raw=mock.sources[0]as EventTarget&{stop:ReturnType<typeof vi.fn>};expect(raw).toBeTruthy();
 publishAuthGenerationChange(2);expect(raw.stop).toHaveBeenCalledOnce();expect(mock.processors[0].cancel).toHaveBeenCalled();
 const replacement=harness();await replacement.controller.setEnabled(true);expect(replacement.participant.publishTrack).toHaveBeenCalledOnce();
 ready.resolve();await old;expect(h.participant.publishTrack).not.toHaveBeenCalled();expect(replacement.participant.unpublishTrack).not.toHaveBeenCalled();await releaseLiveMicrophone(replacement.sdkParticipant);
});
it("does not publish a raw source that ends during slow processor initialization",async()=>{
 const h=harness();const ready=deferred();mock.createTrack.mockImplementationOnce(async()=>({setProcessor:vi.fn(()=>ready.promise),stop:vi.fn(),mute:vi.fn(async()=>{}),unmute:vi.fn(async()=>{})}));
 const pending=h.controller.setEnabled(true);await flush();const source=mock.sources[0]as EventTarget&{readyState:string};source.readyState="ended";source.dispatchEvent(new Event("ended"));expect(h.controller.getStatus().phase).toBe("failed");
 ready.resolve();await pending;expect(h.participant.publishTrack).not.toHaveBeenCalled();expect(h.controller.getStatus().phase).toBe("failed");await releaseLiveMicrophone(h.sdkParticipant);
});

it("retains guild failure across controller replacement/rekey until explicit microphone retry",async()=>{
 const h=harness();await releaseLiveMicrophone(h.sdkParticipant);Object.assign(h.state,{currentVoiceChannelId:"guild",_joinGeneration:4});
 const first=liveMicrophone(h.sdkParticipant);await first.setEnabled(true);const raw=mock.sources[0]as EventTarget&{readyState:string};raw.readyState="ended";raw.dispatchEvent(new Event("ended"));await releaseLiveMicrophone(h.sdkParticipant);
 const replacement=liveMicrophone(h.sdkParticipant);expect(replacement.getStatus().phase).toBe("failed");await replacement.setEnabled(true);expect(mock.createTrack).toHaveBeenCalledOnce();
 await replacement.retry(false);expect(mock.createTrack).toHaveBeenCalledOnce();await replacement.setEnabled(true);expect(mock.createTrack).toHaveBeenCalledTimes(2);await releaseLiveMicrophone(h.sdkParticipant);
});
it("closes pending raw preparation synchronously on an admission lease change without poisoning the logical call or replacement",async()=>{
 const h=harness();await releaseLiveMicrophone(h.sdkParticipant);Object.assign(h.state,{currentVoiceChannelId:"guild",_joinGeneration:9});h.controller=liveMicrophone(h.sdkParticipant);const ready=deferred();mock.createTrack.mockImplementationOnce(async()=>({setProcessor:vi.fn(()=>ready.promise),stop:vi.fn(),mute:vi.fn(async()=>{}),unmute:vi.fn(async()=>{})}));
 const pending=h.controller.setEnabled(true);await flush();const raw=mock.sources[0]as EventTarget&{stop:ReturnType<typeof vi.fn>};h.admission.close();expect(raw.stop).toHaveBeenCalledOnce();expect(useMicrophoneCaptureViewStore.getState().failedCall).toBeNull();
 const replacementLease=registerCaptureAdmission(h.sdkParticipant,()=>true);replacementLease.open();const replacement=liveMicrophone(h.sdkParticipant);await replacement.setEnabled(true);expect(h.participant.publishTrack).toHaveBeenCalledOnce();
 h.admission.close();await releaseLiveMicrophone(h.sdkParticipant,h.controller);expect(h.participant.unpublishTrack).not.toHaveBeenCalled();ready.resolve();await pending;expect(h.participant.publishTrack).toHaveBeenCalledOnce();await releaseLiveMicrophone(h.sdkParticipant,replacement);
});
it("fails closed for a participant without a current admission lease",async()=>{
 const h=harness();h.admission.retire();const controller=liveMicrophone(h.sdkParticipant);await controller.setEnabled(true);expect(mock.createTrack).not.toHaveBeenCalled();await releaseLiveMicrophone(h.sdkParticipant);
});

it("stops known pending raw immediately when guild channel ownership retires before React cleanup",async()=>{
 const h=harness();await releaseLiveMicrophone(h.sdkParticipant);Object.assign(h.state,{currentVoiceChannelId:"guild",_joinGeneration:12});h.controller=liveMicrophone(h.sdkParticipant);const ready=deferred();mock.createTrack.mockImplementationOnce(async()=>({setProcessor:vi.fn(()=>ready.promise),stop:vi.fn(),mute:vi.fn(async()=>{}),unmute:vi.fn(async()=>{})}));
 const pending=h.controller.setEnabled(true);await flush();const raw=mock.sources[0]as EventTarget&{stop:ReturnType<typeof vi.fn>};Object.assign(h.state,{currentVoiceChannelId:null});mock.storeListeners.forEach(fn=>fn());expect(raw.stop).toHaveBeenCalledOnce();ready.resolve();await pending;expect(h.participant.publishTrack).not.toHaveBeenCalled();await releaseLiveMicrophone(h.sdkParticipant,h.controller);
});

it("re-registering an exact participant lease retires old pending raw before opening the replacement",async()=>{
 const h=harness();const ready=deferred();mock.createTrack.mockImplementationOnce(async()=>({setProcessor:vi.fn(()=>ready.promise),stop:vi.fn(),mute:vi.fn(async()=>{}),unmute:vi.fn(async()=>{})}));
 const pending=h.controller.setEnabled(true);await flush();const raw=mock.sources[0]as EventTarget&{stop:ReturnType<typeof vi.fn>};const next=registerCaptureAdmission(h.sdkParticipant,()=>true);expect(raw.stop).toHaveBeenCalledOnce();next.open();
 const replacement=liveMicrophone(h.sdkParticipant);await replacement.setEnabled(true);h.admission.close();h.admission.retire();expect(h.participant.unpublishTrack).not.toHaveBeenCalled();ready.resolve();await pending;expect(h.participant.publishTrack).toHaveBeenCalledOnce();await releaseLiveMicrophone(h.sdkParticipant,replacement);
});

it("emits only current successful manual controller commits, not failed unmute",async()=>{
 const h=harness();await h.controller.setEnabled(true);expect(mock.sound).not.toHaveBeenCalled();h.state.isMuted=true;await h.controller.setEnabled(false);expect(mock.sound).toHaveBeenLastCalledWith("mute");h.state.isMuted=false;h.tracks[0].unmute.mockRejectedValueOnce(new Error("SDKunmute failed"));await expect(h.controller.setEnabled(true)).rejects.toThrow();expect(mock.sound.mock.calls).toEqual([["mute"]]);await releaseLiveMicrophone(h.sdkParticipant);
});
