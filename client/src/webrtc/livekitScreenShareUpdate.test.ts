import { afterEach, describe, expect, it, vi } from "vitest";
import { Track, type LocalParticipant, type LocalVideoTrack, type TrackPublishOptions } from "livekit-client";
import { registerCaptureAdmission } from "../audio/microphoneAdmission";
import { LiveKitScreenShareUpdater, isScreenShareReconfiguring, type ScreenShareUpdate } from "./livekitScreenShareUpdate";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function config(codec: "h264" | "vp9" = "vp9", detail = false): ScreenShareUpdate {
  return {
    settings: { screenShareQuality: "1080p", screenShareFps: 60, screenShareLowLatency: codec === "h264", screenShareMode: detail ? "detail" : "motion" },
    publish: {
      source: Track.Source.ScreenShare,
      stream: "screenshare",
      videoCodec: codec,
      screenShareEncoding: { maxBitrate: 8_000_000, maxFramerate: 60 },
      degradationPreference: detail ? "maintain-resolution" : "maintain-framerate",
      backupCodec: codec === "vp9" ? { codec: "h264", encoding: { maxBitrate: 4_000_000, maxFramerate: 30 } } : undefined,
    },
    contentHint: detail ? "detail" : "motion",
  };
}

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach(dispose => dispose()); });

function fixture(initial = config()) {
  let constraints: MediaTrackConstraints = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60, max: 60 } };
  const raw = Object.assign(new EventTarget(), {
    enabled: true,
    readyState: "live" as MediaStreamTrackState,
    contentHint: initial.contentHint,
    getConstraints: vi.fn(() => constraints),
    applyConstraints: vi.fn(async (next: MediaTrackConstraints) => { constraints = next; }),
    stop: vi.fn(() => { raw.readyState = "ended"; raw.enabled = false; }),
  });
  const video = {
    source: Track.Source.ScreenShare,
    mediaStreamTrack: raw as unknown as MediaStreamTrack,
    publishOptions: { ...initial.publish },
    setDegradationPreference: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(() => raw.stop()),
  } as unknown as LocalVideoTrack;
  const audio = { source: Track.Source.ScreenShareAudio, stop: vi.fn() };
  let published = true;
  const participant = {
    publishTrack: vi.fn(async (track: LocalVideoTrack, options: TrackPublishOptions) => {
      expect(track).toBe(video);
      published = true;
      track.publishOptions = options;
      if (options.videoCodec === "vp9") raw.contentHint = "motion";
      return { track };
    }),
    unpublishTrack: vi.fn(async (track: LocalVideoTrack, stop = true) => {
      expect(track).toBe(video);
      published = false;
      if (stop) track.stop();
      return { track: undefined };
    }),
  };
  const local = participant as unknown as LocalParticipant;
  let active = true;
  const admission = registerCaptureAdmission(local, () => true);
  admission.open();
  const updater = new LiveKitScreenShareUpdater(local, video, () => active, initial);
  cleanup.push(() => { updater.dispose(); admission.retire(); });
  return {
    raw, video, audio, participant, admission, updater,
    get published() { return published; },
    unpublishRemoved: () => { published = false; },
    finishPublish: (options: TrackPublishOptions) => { published = true; video.publishOptions = options; return { track: video }; },
    retireScope: () => { active = false; },
    endSource: () => { raw.readyState = "ended"; raw.dispatchEvent(new Event("ended")); },
  };
}

describe("LiveKitScreenShareUpdater", () => {
  it("republishes the same captured video with the selected codec and leaves screen audio alone", async () => {
    const f = fixture();
    const unpublish = f.participant.unpublishTrack.getMockImplementation()!;
    f.participant.unpublishTrack.mockImplementationOnce(async (...args) => {
      expect(isScreenShareReconfiguring(f.video)).toBe(true);
      expect(f.raw.enabled).toBe(false);
      return unpublish(...args);
    });
    expect(await f.updater.update(config("h264"))).toBe(true);
    expect(f.participant.unpublishTrack).toHaveBeenCalledExactlyOnceWith(f.video, false);
    expect(f.participant.publishTrack).toHaveBeenCalledExactlyOnceWith(f.video, expect.objectContaining({ videoCodec: "h264", source: Track.Source.ScreenShare, stream: "screenshare" }));
    expect(f.video.mediaStreamTrack).toBe(f.raw);
    expect(f.raw.stop).not.toHaveBeenCalled();
    expect(f.audio.stop).not.toHaveBeenCalled();
    expect(f.raw.enabled).toBe(true);
    expect(isScreenShareReconfiguring(f.video)).toBe(false);
  });

  it("changes only the detail policy in place and preserves the SDK VP9 motion workaround", async () => {
    const f = fixture();
    expect(await f.updater.update(config("vp9", true))).toBe(true);
    expect(f.video.setDegradationPreference).toHaveBeenCalledExactlyOnceWith("maintain-resolution");
    expect(f.raw.contentHint).toBe("motion");
    expect(f.raw.applyConstraints).not.toHaveBeenCalled();
    expect(f.participant.publishTrack).not.toHaveBeenCalled();
    expect(f.participant.unpublishTrack).not.toHaveBeenCalled();
  });

  it("applies the detail content hint with H264 without rebuilding a publication", async () => {
    const f = fixture(config("h264"));
    expect(await f.updater.update(config("h264", true))).toBe(true);
    expect(f.raw.contentHint).toBe("detail");
    expect(f.video.setDegradationPreference).toHaveBeenCalledWith("maintain-resolution");
    expect(f.participant.publishTrack).not.toHaveBeenCalled();
  });

  it("does not reuse the SDK's inferred VP9 scalability mode as an explicit mode after a codec switch", async () => {
    const f = fixture();
    f.video.publishOptions = { ...f.video.publishOptions, simulcast: true, scalabilityMode: "L1T3" };
    expect(await f.updater.update(config("h264"))).toBe(true);
    expect(f.participant.publishTrack.mock.calls[0][1].scalabilityMode).toBeUndefined();
    expect(await f.updater.update(config("vp9"))).toBe(true);
    // An explicit L1T3 together with simulcast opts into a different SDK path.
    expect(f.participant.publishTrack.mock.calls[1][1].scalabilityMode).toBeUndefined();
  });

  it("keeps SDK default simulcast metadata out of the requested profile fingerprint", async () => {
    const f = fixture();
    f.video.publishOptions = { ...f.video.publishOptions, simulcast: true, scalabilityMode: "L1T3" };
    expect(await f.updater.update(config())).toBe(true);
    expect(await f.updater.update(config())).toBe(true);
    expect(await f.updater.update(config("vp9", true))).toBe(true);
    expect(f.video.setDegradationPreference).toHaveBeenLastCalledWith("maintain-resolution");
    expect(f.participant.publishTrack).not.toHaveBeenCalled();
    expect(f.participant.unpublishTrack).not.toHaveBeenCalled();
    expect(f.raw.applyConstraints).not.toHaveBeenCalled();
  });

  it("preserves negotiated SDK publication options instead of replacing them with the request", async () => {
    const f = fixture(config("h264"));
    f.participant.publishTrack.mockImplementationOnce(async (_track, options) => {
      return f.finishPublish({ ...options, videoCodec: "vp8", simulcast: false });
    });
    expect(await f.updater.update(config("vp9"))).toBe(true);
    expect(f.video.publishOptions?.videoCodec).toBe("vp8");
    expect(f.video.publishOptions?.simulcast).toBe(false);
    // Changing only the content profile must not turn the request into an
    // ineffective retry or corrupt the SDK's negotiated codec metadata.
    expect(await f.updater.update(config("vp9", true))).toBe(true);
    expect(f.participant.publishTrack).toHaveBeenCalledTimes(1);
    expect(f.video.publishOptions?.videoCodec).toBe("vp8");
  });

  it("rolls back a failed codec publication to the previous codec on the same live source", async () => {
    const f = fixture();
    const originalConstraints = f.raw.getConstraints();
    f.participant.publishTrack.mockRejectedValueOnce(new Error("codec rejected"));
    await expect(f.updater.update(config("h264"))).rejects.toThrow("codec rejected");
    expect(f.participant.publishTrack.mock.calls.map(([, options]) => options.videoCodec)).toEqual(["h264", "vp9"]);
    expect(f.participant.publishTrack.mock.calls.every(([track]) => track === f.video)).toBe(true);
    expect(f.raw.getConstraints()).toEqual(originalConstraints);
    expect(f.raw.enabled).toBe(true);
    expect(f.raw.stop).not.toHaveBeenCalled();
    expect(f.published).toBe(true);
    expect(f.video.publishOptions?.videoCodec).toBe("vp9");
    expect(isScreenShareReconfiguring(f.video)).toBe(false);
  });

  it("restores the old publication when unpublish removes it before negotiation rejects", async () => {
    const f = fixture();
    f.participant.unpublishTrack.mockImplementationOnce(async () => {
      f.unpublishRemoved();
      throw new Error("unpublish negotiation failed");
    });
    await expect(f.updater.update(config("h264"))).rejects.toThrow("unpublish negotiation failed");
    expect(f.participant.publishTrack).toHaveBeenCalledWith(f.video, expect.objectContaining({ videoCodec: "vp9" }));
    expect(f.published).toBe(true);
    expect(f.raw.enabled).toBe(true);
  });

  it("stops its retained source if both publication and rollback fail", async () => {
    const f = fixture();
    f.participant.publishTrack.mockRejectedValue(new Error("transport unavailable"));
    await expect(f.updater.update(config("h264"))).rejects.toThrow("transport unavailable");
    expect(f.raw.enabled).toBe(false);
    expect(f.raw.readyState).toBe("ended");
    expect(f.raw.stop).toHaveBeenCalled();
    expect(f.published).toBe(false);
  });

  it("coalesces superseded requests before work begins", async () => {
    const f = fixture();
    const superseded = f.updater.update(config("h264"));
    const latest = f.updater.update(config("vp9", true));
    expect(await superseded).toBe(false);
    expect(await latest).toBe(true);
    expect(f.participant.publishTrack).not.toHaveBeenCalled();
    expect(f.video.setDegradationPreference).toHaveBeenLastCalledWith("maintain-resolution");
  });

  it("finishes an in-flight codec transition before applying the newest pending preference", async () => {
    const f = fixture();
    const gate = deferred();
    f.participant.publishTrack.mockImplementationOnce(async (_track, options) => {
      await gate.promise;
      return f.finishPublish(options);
    });
    const first = f.updater.update(config("h264"));
    await vi.waitFor(() => expect(f.participant.publishTrack).toHaveBeenCalledTimes(1));
    const superseded = f.updater.update(config("h264", true));
    const latest = f.updater.update(config("vp9", true));
    expect(f.raw.enabled).toBe(false);
    gate.resolve();
    expect(await first).toBe(true);
    expect(await superseded).toBe(false);
    expect(await latest).toBe(true);
    expect(f.participant.publishTrack.mock.calls.map(([, options]) => options.videoCodec)).toEqual(["h264", "vp9"]);
    expect(f.video.publishOptions?.degradationPreference).toBe("maintain-resolution");
    expect(f.raw.enabled).toBe(true);
  });

  it.each(["stop", "admission", "ended"] as const)("does not publish after %s during the unpublish gap", async (reason) => {
    const f = fixture();
    const gate = deferred();
    f.participant.unpublishTrack.mockImplementationOnce(async () => {
      f.unpublishRemoved();
      await gate.promise;
      return { track: undefined };
    });
    const pending = f.updater.update(config("h264"));
    await vi.waitFor(() => expect(f.participant.unpublishTrack).toHaveBeenCalledTimes(1));
    if (reason === "stop") f.updater.dispose();
    else if (reason === "admission") f.admission.close();
    else f.endSource();
    expect(f.raw.enabled).toBe(false);
    expect(f.raw.readyState).toBe("ended");
    gate.resolve();
    expect(await pending).toBe(false);
    expect(f.participant.publishTrack).not.toHaveBeenCalled();
    expect(f.raw.enabled).toBe(false);
    expect(isScreenShareReconfiguring(f.video)).toBe(false);
  });

  it.each(["stop", "admission"] as const)("removes a late publication after %s and never re-enables the source", async (reason) => {
    const f = fixture();
    const gate = deferred();
    f.participant.publishTrack.mockImplementationOnce(async (_track, options) => {
      await gate.promise;
      return f.finishPublish(options);
    });
    const pending = f.updater.update(config("h264"));
    await vi.waitFor(() => expect(f.participant.publishTrack).toHaveBeenCalledTimes(1));
    if (reason === "stop") f.updater.dispose();
    else f.admission.close();
    expect(f.raw.enabled).toBe(false);
    gate.resolve();
    expect(await pending).toBe(false);
    expect(f.participant.publishTrack).toHaveBeenCalledTimes(1);
    expect(f.participant.unpublishTrack).toHaveBeenLastCalledWith(f.video);
    expect(f.published).toBe(false);
    expect(f.raw.enabled).toBe(false);
  });

  it("retires the retained source when the owning session changes while constraints are pending", async () => {
    const f = fixture();
    const gate = deferred();
    f.raw.applyConstraints.mockImplementationOnce(async () => gate.promise);
    const pending = f.updater.update(config("h264"));
    await vi.waitFor(() => expect(f.raw.applyConstraints).toHaveBeenCalledTimes(1));
    f.retireScope();
    gate.resolve();
    expect(await pending).toBe(false);
    expect(f.raw.enabled).toBe(false);
    expect(f.raw.readyState).toBe("ended");
    expect(f.participant.publishTrack).not.toHaveBeenCalled();
  });
});
