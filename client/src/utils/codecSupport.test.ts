import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  canSendAV1,
  canSendH264,
  canSendVP9,
  preferredScreenShareCodec,
} from "./codecSupport";

// jsdom does not ship RTCRtpSender. Every test explicitly installs (or
// leaves absent) the global so the "no browser" branch is exercised too.
type CapsShape = { codecs: { mimeType: string }[] };

function installGetCapabilities(caps: CapsShape | null): void {
  const fake = {
    getCapabilities: caps === null ? undefined : vi.fn(() => caps),
  };
  // The helper only ever asks for `getCapabilities`, so a stub that
  // exposes that single method is enough to match the runtime shape
  // without pulling in the full WebRTC surface.
  (globalThis as unknown as { RTCRtpSender: typeof fake }).RTCRtpSender = fake;
}

function uninstallRTC(): void {
  delete (globalThis as unknown as { RTCRtpSender?: unknown }).RTCRtpSender;
}

beforeEach(() => {
  uninstallRTC();
});

afterEach(() => {
  uninstallRTC();
});

describe("canSendAV1 / canSendVP9 / canSendH264", () => {
  it("all return false when RTCRtpSender is absent (Node / old browser)", () => {
    expect(canSendAV1()).toBe(false);
    expect(canSendVP9()).toBe(false);
    expect(canSendH264()).toBe(false);
  });

  it("returns false when getCapabilities exists but returns null", () => {
    installGetCapabilities(null);
    expect(canSendAV1()).toBe(false);
  });

  it("detects a codec by MIME suffix (case-insensitive)", () => {
    installGetCapabilities({
      codecs: [
        { mimeType: "video/VP9" },
        { mimeType: "video/H264" },
        { mimeType: "video/AV1" },
      ],
    });
    expect(canSendAV1()).toBe(true);
    expect(canSendVP9()).toBe(true);
    expect(canSendH264()).toBe(true);
  });

  it("returns false when the codec is missing from capabilities", () => {
    installGetCapabilities({
      codecs: [{ mimeType: "video/VP8" }, { mimeType: "video/H264" }],
    });
    expect(canSendAV1()).toBe(false);
  });

  it("ignores MIME-type parameters — 'video/AV1; profile=0' still matches AV1", () => {
    installGetCapabilities({
      codecs: [{ mimeType: "video/AV1; profile=0" }],
    });
    expect(canSendAV1()).toBe(true);
  });

  it("swallows a throwing getCapabilities — capability probes must not crash", () => {
    (globalThis as unknown as { RTCRtpSender: unknown }).RTCRtpSender = {
      getCapabilities: () => {
        throw new Error("permission denied");
      },
    };
    expect(canSendAV1()).toBe(false);
    expect(canSendVP9()).toBe(false);
  });
});

describe("preferredScreenShareCodec", () => {
  it("prefers VP9 when available (best quality/bitrate for text content)", () => {
    installGetCapabilities({
      codecs: [
        { mimeType: "video/VP9" },
        { mimeType: "video/H264" },
        { mimeType: "video/AV1" },
      ],
    });
    expect(preferredScreenShareCodec()).toBe("vp9");
  });

  it("falls back to H264 when VP9 is absent", () => {
    installGetCapabilities({
      codecs: [{ mimeType: "video/H264" }],
    });
    expect(preferredScreenShareCodec()).toBe("h264");
  });

  it("returns undefined when neither VP9 nor H264 is available", () => {
    installGetCapabilities({ codecs: [{ mimeType: "video/VP8" }] });
    expect(preferredScreenShareCodec()).toBeUndefined();
  });

  it("returns undefined without RTCRtpSender at all", () => {
    expect(preferredScreenShareCodec()).toBeUndefined();
  });

  it("does NOT return AV1 even when available — AV1 is opt-in only", () => {
    // Rationale pin: AV1's software encoder is expensive; auto-selecting
    // it would tank framerate on users without hardware AV1. Only the
    // opt-in path (future settings toggle) should route to AV1.
    installGetCapabilities({ codecs: [{ mimeType: "video/AV1" }] });
    expect(preferredScreenShareCodec()).toBeUndefined();
  });
});
