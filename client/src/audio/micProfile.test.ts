/**
 * micProfile — mapping tests.
 *
 * These are the "config is the product" tests: livekit-client is a runtime
 * SDK, so the thing worth pinning is the exact option object we hand it for
 * each profile. A regression here is inaudible in CI but very audible in a
 * real call.
 */

import { describe, it, expect } from "vitest";

import {
  MIC_PROFILES,
  MUSIC_MIC_BITRATE,
  micCaptureFor,
  micPublishFor,
  shouldRunNoiseProcessor,
} from "./micProfile";

describe("micCaptureFor", () => {
  it("konusma captures mono with the full voice DSP chain on", () => {
    expect(micCaptureFor("konusma", "")).toEqual({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    });
  });

  it("muzik captures stereo with every voice DSP stage off", () => {
    expect(micCaptureFor("muzik", "")).toEqual({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 2,
    });
  });

  it("threads the selected input device through both profiles", () => {
    expect(micCaptureFor("konusma", "mic-a")).toMatchObject({ deviceId: "mic-a" });
    expect(micCaptureFor("muzik", "mic-a")).toMatchObject({ deviceId: "mic-a" });
  });

  it("omits deviceId entirely when no device is pinned", () => {
    // `deviceId: ""` is not the same as "browser default" — an empty exact
    // constraint makes getUserMedia throw OverconstrainedError on some builds.
    expect(micCaptureFor("konusma", "")).not.toHaveProperty("deviceId");
    expect(micCaptureFor("muzik", "")).not.toHaveProperty("deviceId");
  });
});

describe("micPublishFor", () => {
  it("konusma keeps the speech Opus profile: dtx + red on, mono", () => {
    const publish = micPublishFor("konusma");
    expect(publish.dtx).toBe(true);
    expect(publish.red).toBe(true);
    expect(publish.forceStereo).toBe(false);
  });

  it("konusma does not pin a bitrate, so the per-channel Opus preset survives", () => {
    // publishOptions are merged OVER RoomOptions.publishDefaults by the SDK
    // (LocalParticipant.publish: Object.assign({}, publishDefaults, options)).
    // Leaving audioPreset unset is what lets the per-channel bitrate from
    // VoiceProvider keep applying on the speech path.
    expect(micPublishFor("konusma")).not.toHaveProperty("audioPreset");
  });

  it("muzik disables dtx and red and forces stereo at 256 kbps", () => {
    expect(micPublishFor("muzik")).toEqual({
      audioPreset: { maxBitrate: MUSIC_MIC_BITRATE },
      dtx: false,
      red: false,
      forceStereo: true,
    });
    expect(MUSIC_MIC_BITRATE).toBe(256_000);
  });

  it("RED is off on any stereo mic profile", () => {
    // RED (RFC 2198 redundancy) roughly doubles audio bitrate. That is
    // trivial at speech rates but means ~512 kbps upstream for a 256 kbps
    // stereo music feed, which a mic-sourced music path doesn't justify.
    // LiveKit also defaults it off for stereo, so this matches the SDK.
    // Not a correctness rule — the screen-share profile opts INTO stereo+RED
    // on purpose, where loss resilience is worth the bandwidth.
    for (const profile of MIC_PROFILES) {
      const publish = micPublishFor(profile);
      if (publish.forceStereo) {
        expect(publish.red, `${profile} forces stereo, so RED must be off`).toBe(false);
      }
    }
  });

  it("DTX is off on any stereo mic profile", () => {
    // This one IS about audible quality: DTX gates low-level passages as
    // silence, which on music is pumping/warble on reverb tails and
    // sustained notes. LiveKit also defaults it off for stereo.
    for (const profile of MIC_PROFILES) {
      const publish = micPublishFor(profile);
      if (publish.forceStereo) {
        expect(publish.dtx, `${profile} forces stereo, so DTX must be off`).toBe(false);
      }
    }
  });
});

describe("shouldRunNoiseProcessor", () => {
  it("runs the RNNoise / DeepFilter chain on the speech profile", () => {
    expect(shouldRunNoiseProcessor("konusma")).toBe(true);
  });

  it("bypasses the processor chain on the music profile", () => {
    // RNNoise / DeepFilterNet3 / DTLN are all speech-trained: they treat
    // sustained instrument tone as noise and gut it. The music profile must
    // reach the encoder unprocessed.
    expect(shouldRunNoiseProcessor("muzik")).toBe(false);
  });

  it("covers every declared profile", () => {
    // Guards against a new profile being added without a processor decision.
    for (const profile of MIC_PROFILES) {
      expect(typeof shouldRunNoiseProcessor(profile)).toBe("boolean");
    }
  });
});
