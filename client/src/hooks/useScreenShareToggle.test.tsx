import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalAudioTrack, LocalVideoTrack, RoomEvent, Track, type LocalParticipant, type Room, type ScreenShareCaptureOptions, type TrackPublishOptions } from "livekit-client";
import type { StoreApi, UseBoundStore } from "zustand";
import { registerCaptureAdmission } from "../audio/microphoneAdmission";
import { useVoiceStore } from "../stores/voiceStore";
import { useScreenShareToggle } from "./useScreenShareToggle";

type VoiceState = {
  isStreaming: boolean;
  currentVoiceChannelId: string;
  screenShareQuality: string;
  screenShareFps: number;
  screenShareLowLatency: boolean;
  screenShareMode: "motion" | "detail";
  screenShareAudio: boolean;
  screenShareShowCursor: boolean;
  setStreaming: (value: boolean) => void;
  _wsSend: ReturnType<typeof vi.fn>;
};
const h = vi.hoisted(() => ({
  electron: false,
  display: { width: 2560, height: 1440, refreshRate: 144, monitorCount: 1 },
  startAudio: vi.fn(), stopAudio: vi.fn(), toast: vi.fn(), log: vi.fn(),
}));
vi.mock("../stores/voiceStore", async () => {
  const { create } = await import("zustand");
  return { useVoiceStore: create<VoiceState>((set) => ({
    isStreaming: true, currentVoiceChannelId: "channel", screenShareQuality: "1080p", screenShareFps: 60,
    screenShareLowLatency: false, screenShareMode: "motion", screenShareAudio: true, screenShareShowCursor: true,
    setStreaming: (value) => set({ isStreaming: value }), _wsSend: vi.fn(),
  })) };
});
vi.mock("../stores/serverStore", () => ({ useServerStore: { getState: () => ({ activeServerId: "server" }) } }));
vi.mock("../stores/toastStore", () => ({ useToastStore: { getState: () => ({ addToast: h.toast }) } }));
vi.mock("./useDisplayInfo", () => ({ useDisplayInfo: () => h.display }));
vi.mock("./useSystemAudioCapture", () => ({
  useSystemAudioCapture: () => ({ start: h.startAudio, stop: h.stopAudio, isCapturing: h.electron }),
}));
vi.mock("../utils/constants", () => ({
  isElectron: () => h.electron, isCapacitor: () => false, isMobileBrowser: () => false, canBrowserScreenShare: () => true,
}));
vi.mock("../utils/nativePlugins", () => ({ startNativeScreenShare: vi.fn(), stopNativeScreenShare: vi.fn(), onNativeScreenShareStopped: vi.fn() }));
vi.mock("../api/voice", () => ({ getScreenShareToken: vi.fn() }));
vi.mock("../api/clientLog", () => ({ logToServer: h.log }));
vi.mock("../i18n", () => ({ default: { t: (key: string) => key } }));

const voice = useVoiceStore as unknown as UseBoundStore<StoreApi<VoiceState>>;
const retireAdmissions: (() => void)[] = [];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function rawTrack(kind: "video" | "audio") {
  let constraints: MediaTrackConstraints = {};
  const raw = Object.assign(new EventTarget(), {
    id: `raw-${kind}`, kind, label: kind, enabled: true, muted: false,
    readyState: "live" as MediaStreamTrackState, contentHint: "motion",
    getSettings: () => kind === "video" ? { width: 1920, height: 1080, frameRate: 60 } : { channelCount: 2 },
    getConstraints: () => constraints,
    applyConstraints: vi.fn(async (next: MediaTrackConstraints) => { constraints = next; }),
    stop: vi.fn(() => { raw.readyState = "ended"; raw.enabled = false; }),
  });
  return raw;
}

type Publication = { source: Track.Source; track?: LocalVideoTrack | LocalAudioTrack; trackSid: string; options?: TrackPublishOptions };
function fixture({ pickerGate, republishGate }: { pickerGate?: ReturnType<typeof deferred>; republishGate?: ReturnType<typeof deferred> } = {}) {
  const raw = rawTrack("video"), audioRaw = rawTrack("audio");
  const video = new LocalVideoTrack(raw as unknown as MediaStreamTrack);
  video.source = Track.Source.ScreenShare;
  const browserAudio = new LocalAudioTrack(audioRaw as unknown as MediaStreamTrack);
  browserAudio.source = Track.Source.ScreenShareAudio;
  const captures = [{ raw, audioRaw, video, browserAudio }];
  let captureStarts = 0;
  let pendingCapture: Promise<Publication> | undefined;
  const degradation = vi.spyOn(video, "setDegradationPreference");
  const publications = new Map<Track.Source, Publication>();
  const listeners = new Map<string, Set<(publication: Publication) => void>>();
  const room = {
    on: vi.fn((event: string, handler: (publication: Publication) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
      return room;
    }),
    off: vi.fn((event: string, handler: (publication: Publication) => void) => { listeners.get(event)?.delete(handler); return room; }),
  };
  const participant = {
    trackPublications: publications,
    getTrackPublication: vi.fn((source: Track.Source) => publications.get(source)),
    publishTrack: vi.fn(async (track: LocalVideoTrack | LocalAudioTrack, options: TrackPublishOptions): Promise<Publication> => {
      if (track === video && republishGate) await republishGate.promise;
      if (track === video) {
        video.publishOptions = options;
        if (options.videoCodec === "vp9") raw.contentHint = "motion";
      }
      const publication = { source: options.source!, track, trackSid: `${options.source}-sid`, options };
      publications.set(options.source!, publication);
      return publication;
    }),
    unpublishTrack: vi.fn(async (track: LocalVideoTrack | LocalAudioTrack, stop = true): Promise<Publication | undefined> => {
      const publication = publications.get(track.source);
      if (publication?.track === track) {
        publications.delete(track.source);
        listeners.get(RoomEvent.LocalTrackUnpublished)?.forEach(handler => handler(publication));
        // LiveKit emits the event before clearing the publication's track.
        publication.track = undefined;
      }
      if (stop) track.stop();
      return publication;
    }),
    setScreenShareEnabled: vi.fn(async (enabled: boolean, capture?: ScreenShareCaptureOptions, options?: TrackPublishOptions): Promise<Publication | undefined> => {
      if (!enabled) {
        // Match the SDK: the screen-audio cleanup is under the video-publication
        // branch. A caller must retire audio itself during a republish gap.
        if (!publications.has(Track.Source.ScreenShare)) return undefined;
        for (const source of [Track.Source.ScreenShare, Track.Source.ScreenShareAudio]) {
          const track = publications.get(source)?.track;
          if (track) await participant.unpublishTrack(track);
        }
        return undefined;
      }
      const existing = publications.get(Track.Source.ScreenShare);
      if (existing) return existing;
      // A second SDK enable during a pending picker waits for/reuses that
      // publication. The hook must drain the canceled start before enabling B.
      if (pendingCapture) return pendingCapture;
      const index = captureStarts++;
      if (index > 0) {
        const nextRaw = rawTrack("video"), nextAudioRaw = rawTrack("audio");
        const nextVideo = new LocalVideoTrack(nextRaw as unknown as MediaStreamTrack);
        nextVideo.source = Track.Source.ScreenShare;
        const nextAudio = new LocalAudioTrack(nextAudioRaw as unknown as MediaStreamTrack);
        nextAudio.source = Track.Source.ScreenShareAudio;
        captures.push({ raw: nextRaw, audioRaw: nextAudioRaw, video: nextVideo, browserAudio: nextAudio });
      }
      const next = captures[index];
      const pending = (async () => {
        if (index === 0 && pickerGate) await pickerGate.promise;
        next.video.publishOptions = { ...options, source: Track.Source.ScreenShare };
        next.raw.contentHint = options?.videoCodec === "vp9" ? "motion" : capture?.contentHint ?? "motion";
        const publication = { source: Track.Source.ScreenShare, track: next.video, trackSid: `video-sid-${index}`, options };
        publications.set(Track.Source.ScreenShare, publication);
        if (capture?.audio) publications.set(Track.Source.ScreenShareAudio, { source: Track.Source.ScreenShareAudio, track: next.browserAudio, trackSid: `audio-sid-${index}`, options });
        return publication;
      })();
      pendingCapture = pending;
      try { return await pending; }
      finally { if (pendingCapture === pending) pendingCapture = undefined; }
    }),
  };
  const admission = registerCaptureAdmission(participant as unknown as LocalParticipant, () => true);
  admission.open();
  retireAdmissions.push(admission.retire);
  h.startAudio.mockResolvedValue(audioRaw);
  const syncRef = { current: true };
  const view = renderHook(() => useScreenShareToggle(room as unknown as Room, participant as unknown as LocalParticipant, syncRef));
  return { raw, audioRaw, video, browserAudio, captures, degradation, participant, publications, room, admission, view };
}

async function tick(ms = 0) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
function change(patch: Partial<VoiceState>) { act(() => voice.setState(patch)); }

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("MediaStream", class {
    private tracks: MediaStreamTrack[];
    constructor(tracks: MediaStreamTrack[] = []) { this.tracks = tracks; }
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter(track => track.kind === "audio"); }
    getVideoTracks() { return this.tracks.filter(track => track.kind === "video"); }
  });
  vi.spyOn(LocalAudioTrack.prototype, "checkForSilence").mockResolvedValue(false);
  h.electron = false;
  h.startAudio.mockReset(); h.stopAudio.mockReset(); h.toast.mockReset(); h.log.mockReset();
  voice.setState({
    isStreaming: true, currentVoiceChannelId: "channel", screenShareQuality: "1080p", screenShareFps: 60,
    screenShareLowLatency: false, screenShareMode: "motion", screenShareAudio: true, screenShareShowCursor: true, _wsSend: vi.fn(),
  });
});
afterEach(async () => {
  cleanup();
  retireAdmissions.splice(0).forEach(retire => retire());
  await act(async () => {});
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("guild screen-share profile lifecycle", () => {
  it.each([[false, true], [true, false]])("uses Electron audio intent changed in the picker from %s to %s", async (initial, chosen) => {
    h.electron = true;
    voice.setState({ screenShareAudio: initial });
    const pickerGate = deferred();
    const f = fixture({ pickerGate });
    await tick();
    expect(h.startAudio).not.toHaveBeenCalled();
    change({ screenShareAudio: chosen });
    await act(async () => { pickerGate.resolve(); });
    await tick();
    expect(f.participant.setScreenShareEnabled).toHaveBeenCalledTimes(1);
    expect(f.participant.setScreenShareEnabled.mock.calls[0][1]?.audio).toBe(false);
    expect(h.startAudio).toHaveBeenCalledTimes(chosen ? 1 : 0);
    expect(f.publications.has(Track.Source.ScreenShareAudio)).toBe(chosen);
    expect(f.raw.stop).not.toHaveBeenCalled();
  });

  it("starts browser video with the current content/codec/rate and separate screen-audio policy", async () => {
    voice.setState({ screenShareQuality: "1440p", screenShareFps: 120, screenShareLowLatency: true, screenShareMode: "detail" });
    const f = fixture();
    await tick();
    expect(f.participant.setScreenShareEnabled).toHaveBeenCalledExactlyOnceWith(true,
      expect.objectContaining({ resolution: { width: 2560, height: 1440, frameRate: 120 }, contentHint: "detail", audio: expect.objectContaining({ channelCount: 2, echoCancellation: false }) }),
      expect.objectContaining({ videoCodec: "h264", degradationPreference: "maintain-resolution", screenShareEncoding: { maxBitrate: 18_000_000, maxFramerate: 120 }, forceStereo: true, dtx: false }));
    expect(f.publications.get(Track.Source.ScreenShare)?.track).toBe(f.video);
    expect(f.raw.contentHint).toBe("detail");
    expect(voice.getState()._wsSend).toHaveBeenCalledWith("voice_state_update_request", { is_streaming: true });
  });

  it("starts Electron native audio and keeps it alive through a video-only codec change", async () => {
    h.electron = true;
    const f = fixture();
    await tick();
    const stream = f.participant.setScreenShareEnabled.mock.calls[0][2]?.stream;
    expect(stream).toMatch(/^screenshare-/);
    expect(f.participant.setScreenShareEnabled).toHaveBeenCalledWith(true, expect.objectContaining({ audio: false }), expect.objectContaining({ stream, videoCodec: "vp9" }));
    expect(h.startAudio).toHaveBeenCalledOnce();
    const audioPublication = f.publications.get(Track.Source.ScreenShareAudio)!;
    expect(audioPublication.track).toBeInstanceOf(LocalAudioTrack);
    expect(f.participant.publishTrack).toHaveBeenCalledWith(audioPublication.track, expect.objectContaining({ source: Track.Source.ScreenShareAudio, forceStereo: true, dtx: false, stream }));
    change({ screenShareLowLatency: true });
    await tick(200);
    expect(f.participant.setScreenShareEnabled).toHaveBeenCalledTimes(1);
    expect(f.participant.unpublishTrack).toHaveBeenCalledExactlyOnceWith(f.video, false);
    expect(f.participant.publishTrack).toHaveBeenLastCalledWith(f.video, expect.objectContaining({ videoCodec: "h264", stream }));
    expect(f.publications.get(Track.Source.ScreenShareAudio)).toBe(audioPublication);
    expect(f.raw.stop).not.toHaveBeenCalled();
    expect(f.audioRaw.stop).not.toHaveBeenCalled();
    expect(h.stopAudio).not.toHaveBeenCalled();
    expect(f.raw.enabled).toBe(true);
    expect(voice.getState().isStreaming).toBe(true);
    change({ screenShareLowLatency: false });
    await tick(200);
    expect(f.participant.publishTrack).toHaveBeenLastCalledWith(f.video, expect.objectContaining({ videoCodec: "vp9", backupCodec: expect.objectContaining({ codec: "h264" }), stream }));
    expect(f.participant.setScreenShareEnabled).toHaveBeenCalledTimes(1);
    expect(f.publications.get(Track.Source.ScreenShareAudio)).toBe(audioPublication);
    expect(f.audioRaw.stop).not.toHaveBeenCalled();
    expect(h.stopAudio).not.toHaveBeenCalled();
  });

  it.each([false, true])("updates only the content priority in place with low latency %s", async (lowLatency) => {
    voice.setState({ screenShareLowLatency: lowLatency });
    const f = fixture();
    await tick();
    f.degradation.mockClear();
    change({ screenShareMode: "detail" });
    await tick(200);
    expect(f.participant.setScreenShareEnabled).toHaveBeenCalledTimes(1);
    expect(f.participant.publishTrack).not.toHaveBeenCalled();
    expect(f.participant.unpublishTrack).not.toHaveBeenCalled();
    expect(f.degradation).toHaveBeenCalledWith("maintain-resolution");
    expect(f.raw.contentHint).toBe(lowLatency ? "detail" : "motion");
    expect(f.raw.applyConstraints).not.toHaveBeenCalled();
  });

  it("applies a resolution/FPS change to the same source without reopening the picker or audio", async () => {
    voice.setState({ screenShareLowLatency: true });
    const f = fixture();
    await tick();
    const audioPublication = f.publications.get(Track.Source.ScreenShareAudio);
    change({ screenShareQuality: "1440p", screenShareFps: 120 });
    await tick(200);
    expect(f.participant.setScreenShareEnabled).toHaveBeenCalledTimes(1);
    expect(f.raw.applyConstraints).toHaveBeenCalledWith({ width: { ideal: 2560 }, height: { ideal: 1440 }, frameRate: { ideal: 120, max: 120 } });
    expect(f.participant.publishTrack).toHaveBeenCalledExactlyOnceWith(f.video, expect.objectContaining({ screenShareEncoding: { maxBitrate: 18_000_000, maxFramerate: 120 } }));
    expect(f.video.mediaStreamTrack).toBe(f.raw);
    expect(f.publications.get(Track.Source.ScreenShareAudio)).toBe(audioPublication);
    expect(f.video.publishOptions?.screenShareSimulcastLayers?.every(layer => (layer.encoding.maxFramerate ?? 0) <= 30)).toBe(true);
    expect(f.raw.stop).not.toHaveBeenCalled();
    expect(f.audioRaw.stop).not.toHaveBeenCalled();
  });

  it("applies preferences changed while the original picker is pending", async () => {
    const pickerGate = deferred();
    const f = fixture({ pickerGate });
    await tick();
    expect(f.participant.setScreenShareEnabled).toHaveBeenCalledTimes(1);
    change({ screenShareQuality: "1440p", screenShareFps: 120, screenShareLowLatency: true, screenShareMode: "detail" });
    await tick(200);
    await act(async () => pickerGate.resolve());
    await tick();
    expect(f.participant.setScreenShareEnabled).toHaveBeenCalledTimes(1);
    expect(f.participant.publishTrack).toHaveBeenCalledExactlyOnceWith(f.video, expect.objectContaining({ videoCodec: "h264", degradationPreference: "maintain-resolution", screenShareEncoding: { maxBitrate: 18_000_000, maxFramerate: 120 } }));
    expect(f.raw.contentHint).toBe("detail");
    expect(f.raw.enabled).toBe(true);
    expect(voice.getState().isStreaming).toBe(true);
  });

  it.each(["stop", "unmount"] as const)("never revives a source when %s occurs during video republishing", async (reason) => {
    const republishGate = deferred();
    const f = fixture({ republishGate });
    await tick();
    change({ screenShareLowLatency: true });
    await tick(200);
    expect(f.participant.publishTrack).toHaveBeenCalledOnce();
    expect(f.raw.enabled).toBe(false);
    if (reason === "stop") change({ isStreaming: false }); else f.view.unmount();
    await tick();
    expect(f.raw.readyState).toBe("ended");
    await act(async () => republishGate.resolve());
    await tick(500);
    expect(f.raw.enabled).toBe(false);
    expect(f.publications.has(Track.Source.ScreenShare)).toBe(false);
    expect(f.participant.setScreenShareEnabled.mock.calls.filter(([enabled]) => enabled)).toHaveLength(1);
    expect(f.participant.publishTrack).toHaveBeenCalledTimes(1);
  });

  it.each(["stop", "unmount"] as const)("retires a late initial capture after %s while the picker is pending", async (reason) => {
    const pickerGate = deferred();
    const f = fixture({ pickerGate });
    await tick();
    if (reason === "stop") change({ isStreaming: false }); else f.view.unmount();
    await tick();
    await act(async () => pickerGate.resolve());
    await tick(500);
    expect(f.raw.enabled).toBe(false);
    expect(f.raw.readyState).toBe("ended");
    expect(f.publications.has(Track.Source.ScreenShare)).toBe(false);
    expect(f.publications.has(Track.Source.ScreenShareAudio)).toBe(false);
    expect(f.audioRaw.readyState).toBe("ended");
    expect(voice.getState()._wsSend).not.toHaveBeenCalledWith("voice_state_update_request", { is_streaming: true });
  });

  it("drains a canceled pending picker before a rapid off/on starts a fresh source", async () => {
    const pickerGate = deferred();
    const f = fixture({ pickerGate });
    await tick();
    expect(f.participant.setScreenShareEnabled).toHaveBeenCalledTimes(1);
    change({ isStreaming: false });
    change({ isStreaming: true });
    await tick(200);
    expect(f.participant.setScreenShareEnabled.mock.calls.filter(([enabled]) => enabled)).toHaveLength(1);
    await act(async () => pickerGate.resolve());
    await tick(1);
    expect(f.captures).toHaveLength(2);
    expect(f.raw.readyState).toBe("ended");
    expect(f.audioRaw.readyState).toBe("ended");
    expect(f.captures[1].raw.readyState).toBe("live");
    expect(f.captures[1].raw.enabled).toBe(true);
    expect(f.publications.get(Track.Source.ScreenShare)?.track).toBe(f.captures[1].video);
    expect(f.publications.get(Track.Source.ScreenShareAudio)?.track).toBe(f.captures[1].browserAudio);
    expect(voice.getState().isStreaming).toBe(true);
    expect(voice.getState()._wsSend.mock.calls.filter(([, payload]) => payload.is_streaming === true)).toHaveLength(1);
  });

  it("retires browser audio immediately when stopping inside a video republish gap", async () => {
    const republishGate = deferred();
    const f = fixture({ republishGate });
    await tick();
    change({ screenShareLowLatency: true });
    await tick(200);
    expect(f.publications.has(Track.Source.ScreenShare)).toBe(false);
    expect(f.publications.has(Track.Source.ScreenShareAudio)).toBe(true);
    change({ isStreaming: false });
    expect(f.audioRaw.enabled).toBe(false);
    expect(f.audioRaw.readyState).toBe("ended");
    expect(f.participant.unpublishTrack).toHaveBeenCalledWith(f.browserAudio);
    await tick();
    await act(async () => republishGate.resolve());
    await tick(500);
    expect(f.publications.has(Track.Source.ScreenShare)).toBe(false);
    expect(f.publications.has(Track.Source.ScreenShareAudio)).toBe(false);
    expect(f.audioRaw.enabled).toBe(false);
    expect(f.raw.enabled).toBe(false);
  });
});
