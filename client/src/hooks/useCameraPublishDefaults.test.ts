/**
 * useCameraPublishDefaults — per-tier config tests.
 *
 * The hook's value is the object it hands to
 * `localParticipant.setCameraEnabled(enabled, capture, publish)`. Before this
 * existed the call was a bare `setCameraEnabled(isCameraEnabled)` and the
 * camera ran on whatever livekit-client defaulted to, with no simulcast ladder
 * we controlled. These tests pin the ladder per quality/fps combo.
 */

import { describe, it, expect, vi } from "vitest";
import { VideoPresets } from "livekit-client";

// The module imports the voice store only to read the two settings; stub it so
// the test doesn't drag in the store's API client / native-plugin imports.
vi.mock("../stores/voiceStore", () => ({
  useVoiceStore: () => undefined,
}));

import {
  CAMERA_QUALITIES,
  CAMERA_FPS_OPTIONS,
  cameraPublishDefaultsFor,
} from "./useCameraPublishDefaults";

describe("cameraPublishDefaultsFor — capture side", () => {
  it("maps each quality to its VideoPresets resolution", () => {
    expect(cameraPublishDefaultsFor("360p", 30).cameraCapture.resolution).toMatchObject({
      width: 640,
      height: 360,
    });
    expect(cameraPublishDefaultsFor("720p", 30).cameraCapture.resolution).toMatchObject({
      width: 1280,
      height: 720,
    });
    expect(cameraPublishDefaultsFor("1080p", 30).cameraCapture.resolution).toMatchObject({
      width: 1920,
      height: 1080,
    });
  });

  it("overrides the preset's own frameRate with the user's choice", () => {
    // VideoPresets.h360 ships frameRate 20 and h720/h1080 ship 30 — neither
    // tracks the user's fps setting, so the capture hint must be rewritten.
    expect(cameraPublishDefaultsFor("360p", 15).cameraCapture.resolution.frameRate).toBe(15);
    expect(cameraPublishDefaultsFor("360p", 30).cameraCapture.resolution.frameRate).toBe(30);
    expect(cameraPublishDefaultsFor("1080p", 15).cameraCapture.resolution.frameRate).toBe(15);
  });
});

describe("cameraPublishDefaultsFor — encoding", () => {
  it("takes maxBitrate from the matching VideoPreset", () => {
    expect(cameraPublishDefaultsFor("360p", 30).cameraPublish.videoEncoding.maxBitrate).toBe(
      VideoPresets.h360.encoding.maxBitrate,
    );
    expect(cameraPublishDefaultsFor("720p", 30).cameraPublish.videoEncoding.maxBitrate).toBe(
      VideoPresets.h720.encoding.maxBitrate,
    );
    expect(cameraPublishDefaultsFor("1080p", 30).cameraPublish.videoEncoding.maxBitrate).toBe(
      VideoPresets.h1080.encoding.maxBitrate,
    );
  });

  it("pins the concrete bitrate ladder so a preset bump is a visible diff", () => {
    expect(cameraPublishDefaultsFor("360p", 30).cameraPublish.videoEncoding.maxBitrate).toBe(450_000);
    expect(cameraPublishDefaultsFor("720p", 30).cameraPublish.videoEncoding.maxBitrate).toBe(1_700_000);
    expect(cameraPublishDefaultsFor("1080p", 30).cameraPublish.videoEncoding.maxBitrate).toBe(3_000_000);
  });

  it("carries the chosen fps into maxFramerate, not the preset's", () => {
    expect(cameraPublishDefaultsFor("720p", 15).cameraPublish.videoEncoding.maxFramerate).toBe(15);
    expect(cameraPublishDefaultsFor("720p", 30).cameraPublish.videoEncoding.maxFramerate).toBe(30);
  });

  it("keeps the bitrate ceiling constant across fps (lower fps buys sharper frames)", () => {
    for (const quality of CAMERA_QUALITIES) {
      const at15 = cameraPublishDefaultsFor(quality, 15).cameraPublish.videoEncoding.maxBitrate;
      const at30 = cameraPublishDefaultsFor(quality, 30).cameraPublish.videoEncoding.maxBitrate;
      expect(at15).toBe(at30);
    }
  });
});

describe("cameraPublishDefaultsFor — simulcast ladder", () => {
  it("gives 720p and 1080p a two-layer ladder (h180 + h360)", () => {
    for (const quality of ["720p", "1080p"] as const) {
      const layers = cameraPublishDefaultsFor(quality, 30).cameraPublish.videoSimulcastLayers;
      expect(layers).toHaveLength(2);
      expect(layers[0]).toBe(VideoPresets.h180);
      expect(layers[1]).toBe(VideoPresets.h360);
    }
  });

  it("gives 360p a single h180 layer and no h360 layer", () => {
    // An h360 simulcast layer under a 360p primary would be a duplicate of
    // the primary encode — wasted CPU and upstream for zero added choice.
    const layers = cameraPublishDefaultsFor("360p", 30).cameraPublish.videoSimulcastLayers;
    expect(layers).toHaveLength(1);
    expect(layers[0]).toBe(VideoPresets.h180);
    expect(layers).not.toContain(VideoPresets.h360);
  });

  it("orders layers lowest-quality-first, as the SDK requires", () => {
    for (const quality of CAMERA_QUALITIES) {
      const layers = cameraPublishDefaultsFor(quality, 30).cameraPublish.videoSimulcastLayers;
      for (let i = 1; i < layers.length; i += 1) {
        expect(layers[i].height).toBeGreaterThan(layers[i - 1].height);
      }
    }
  });

  it("never emits a simulcast layer at or above the primary resolution", () => {
    const primaryHeight = { "360p": 360, "720p": 720, "1080p": 1080 } as const;
    for (const quality of CAMERA_QUALITIES) {
      for (const layer of cameraPublishDefaultsFor(quality, 30).cameraPublish.videoSimulcastLayers) {
        expect(layer.height).toBeLessThan(primaryHeight[quality]);
      }
    }
  });
});

describe("cameraPublishDefaultsFor — codec", () => {
  it("uses VP8 for every combination", () => {
    // Deliberately NOT the screen share's VP9+SVC stack: camera frames are
    // small and motion-heavy, VP9 SVC buys little there, and VP8 is the one
    // codec with universal hardware acceleration.
    for (const quality of CAMERA_QUALITIES) {
      for (const fps of CAMERA_FPS_OPTIONS) {
        expect(cameraPublishDefaultsFor(quality, fps).cameraPublish.videoCodec).toBe("vp8");
      }
    }
  });

  it("produces a defined config for every quality/fps combination", () => {
    for (const quality of CAMERA_QUALITIES) {
      for (const fps of CAMERA_FPS_OPTIONS) {
        const opts = cameraPublishDefaultsFor(quality, fps);
        expect(opts.cameraCapture.resolution.width).toBeGreaterThan(0);
        expect(opts.cameraPublish.videoEncoding.maxBitrate).toBeGreaterThan(0);
        expect(opts.cameraPublish.videoSimulcastLayers.length).toBeGreaterThan(0);
      }
    }
  });
});
