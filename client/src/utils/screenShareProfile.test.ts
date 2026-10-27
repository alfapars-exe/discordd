import { describe, expect, it } from "vitest";
import {
  resolveScreenSharePublishDefaults,
  SCREEN_SHARE_AUDIO_PUBLISH,
  type ScreenShareDisplayMetrics,
} from "./screenShareProfile";

describe("screen-share publishing policy", () => {
  it.each([false, true])("keeps text resolution priority when low latency is %s", (screenShareLowLatency) => {
    const profile = resolveScreenSharePublishDefaults({
      screenShareQuality: "1080p", screenShareFps: 60, screenShareMode: "detail", screenShareLowLatency,
    });
    expect(profile.screenShareCapture.contentHint).toBe("detail");
    expect(profile.screenSharePublish.degradationPreference).toBe("maintain-resolution");
    expect(profile.screenSharePublish.videoCodec).toBe(screenShareLowLatency ? "h264" : "vp9");
  });

  it("defaults to motion and leaves VP9 layering to the SDK", () => {
    const profile = resolveScreenSharePublishDefaults({ screenShareQuality: "1080p", screenShareFps: 60 });
    expect(profile.screenShareCapture.contentHint).toBe("motion");
    expect(profile.screenSharePublish.degradationPreference).toBe("maintain-framerate");
    expect(profile.screenSharePublish.screenShareSimulcastLayers).toBeUndefined();
    expect(profile.screenSharePublish).not.toHaveProperty("scalabilityMode");
    expect(profile.screenSharePublish.backupCodec).toEqual({
      codec: "h264", encoding: { maxBitrate: 4_000_000, maxFramerate: 30 },
    });
    expect(profile.screenShareAudioPublish).toBe(SCREEN_SHARE_AUDIO_PUBLISH);
    expect(profile.screenShareAudioPublish).toEqual({
      audioPreset: { maxBitrate: 256_000 }, dtx: false, red: true, forceStereo: true,
    });
  });

  it.each([
    ["720p", 30, 1_500_000], ["720p", 60, 2_500_000], ["720p", 120, 4_000_000],
    ["1080p", 30, 5_000_000], ["1080p", 60, 8_000_000], ["1080p", 120, 12_000_000],
    ["1440p", 30, 8_000_000], ["1440p", 60, 12_000_000], ["1440p", 120, 18_000_000],
    ["4k", 30, 14_000_000], ["4k", 60, 20_000_000], ["4k", 120, 30_000_000],
    ["4k", 144, 36_000_000], ["4k", 240, 45_000_000],
  ])("preserves the %s/%i primary ceiling", (screenShareQuality, screenShareFps, maxBitrate) => {
    const { screenSharePublish } = resolveScreenSharePublishDefaults({
      screenShareQuality: screenShareQuality as string, screenShareFps: screenShareFps as number,
    });
    expect(screenSharePublish.screenShareEncoding.maxBitrate).toBe(maxBitrate);
  });

  it.each([
    [Number.NaN, 30], [Number.POSITIVE_INFINITY, 30], [0, 30], [-20, 30], [360, 240],
  ])("sanitizes explicit FPS %s to %s", (screenShareFps, expectedFps) => {
    const { screenSharePublish } = resolveScreenSharePublishDefaults({ screenShareQuality: "1080p", screenShareFps });
    expect(screenSharePublish.screenShareEncoding.maxFramerate).toBe(expectedFps);
  });

  it("resolves native display and refresh rate with bounded fallbacks", () => {
    const settings = { screenShareQuality: "native", screenShareFps: -1 };
    expect(resolveScreenSharePublishDefaults(settings).screenSharePublish.screenShareEncoding)
      .toEqual({ maxBitrate: 8_000_000, maxFramerate: 60 });
    expect(resolveScreenSharePublishDefaults(settings, { width: 3840, height: 2160, refreshRate: 360 })
      .screenSharePublish.screenShareEncoding).toEqual({ maxBitrate: 45_000_000, maxFramerate: 240 });
    expect(resolveScreenSharePublishDefaults(settings, { width: 2560, height: 1440, refreshRate: 0 })
      .screenSharePublish.screenShareEncoding).toEqual({ maxBitrate: 12_000_000, maxFramerate: 60 });
    for (const refreshRate of [Number.POSITIVE_INFINITY, -144]) {
      expect(resolveScreenSharePublishDefaults(settings, { width: 1920, height: 1080, refreshRate })
        .screenSharePublish.screenShareEncoding.maxFramerate).toBe(30);
    }
  });

  it.each([
    { width: Number.POSITIVE_INFINITY, height: 2160, refreshRate: 60 },
    { width: 3840, height: Number.NaN, refreshRate: 60 },
    { width: 3840, height: 0, refreshRate: 60 },
    { width: -1, height: 1080, refreshRate: 60 },
  ])("uses the 1080p fallback for unusable native dimensions %j", (display) => {
    const { screenSharePublish } = resolveScreenSharePublishDefaults({ screenShareQuality: "native", screenShareFps: -1 }, display);
    expect(screenSharePublish.screenShareEncoding).toEqual({ maxBitrate: 8_000_000, maxFramerate: 60 });
  });

  it.each([
    ["720p", 1280, 720, [360]],
    ["1080p", 1920, 1080, [360, 720]],
    ["1440p", 2560, 1440, [720, 1080]],
    ["4k", 3840, 2160, [720, 1440]],
  ] as const)("provides distinct lower layers and bounded overhead for %s", (screenShareQuality, width, height, expectedHeights) => {
    for (const screenShareFps of [15, 30, 60, 120, 240]) {
      const { screenSharePublish } = resolveScreenSharePublishDefaults({ screenShareQuality, screenShareFps, screenShareLowLatency: true });
      const layers = screenSharePublish.screenShareSimulcastLayers!;
      expect(layers.map(layer => layer.height)).toEqual(expectedHeights);
      expect(layers.length).toBeLessThanOrEqual(2);
      expect(new Set(layers.map(layer => `${layer.width}x${layer.height}`)).size).toBe(layers.length);
      for (const layer of layers) {
        expect(layer.width).toBeLessThan(width);
        expect(layer.height).toBeLessThan(height);
        expect(layer.encoding.maxFramerate).toBeLessThanOrEqual(Math.min(screenShareFps, 30));
      }
      expect(layers.reduce((total, layer) => total + layer.encoding.maxBitrate, 0))
        .toBeLessThan(screenSharePublish.screenShareEncoding.maxBitrate);
      expect(screenSharePublish.backupCodec).toBeUndefined();
    }
  });

  it.each([
    { width: 3840, height: 1080, refreshRate: 60 },
    { width: 1080, height: 1920, refreshRate: 60 },
    { width: 640, height: 360, refreshRate: 60 },
  ])("never adds a layer equal to or larger than a native source %j", (display: ScreenShareDisplayMetrics) => {
    const { screenSharePublish } = resolveScreenSharePublishDefaults({
      screenShareQuality: "native", screenShareFps: -1, screenShareLowLatency: true,
    }, display);
    for (const layer of screenSharePublish.screenShareSimulcastLayers!) {
      expect(layer.width).toBeLessThan(display.width);
      expect(layer.height).toBeLessThan(display.height);
    }
  });
});
