import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalParticipant } from "livekit-client";
import type { MicrophoneSettings } from "./microphoneSettings";
import { liveMicrophone, releaseLiveMicrophone } from "./liveMicrophone";

const mock = vi.hoisted(() => ({
  createTrack: vi.fn(), getState: vi.fn(), processors: [] as Array<{
    processedTrack: { enabled: boolean }; update: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn>; activate: ReturnType<typeof vi.fn>;
  }>,
}));
vi.mock("livekit-client", () => ({ Track: { Source: { Microphone: "microphone" } }, createLocalAudioTrack: mock.createTrack }));
vi.mock("../stores/voiceStore", () => ({ useVoiceStore: { getState: mock.getState } }));
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
  return { state, events, tracks, participant, sdkParticipant, controller: liveMicrophone(sdkParticipant) };
}
beforeEach(() => { vi.clearAllMocks(); mock.processors = []; });

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
