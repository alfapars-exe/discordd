import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { P2PScreenCodecPolicy, preferScreenCodec } from "./p2pScreenCodec";
import { P2PMediaController } from "./p2pMediaController";
import { startScreenShare, stopScreenShare } from "./p2pScreenShare";

const codecs: RTCRtpCodec[] = [
  { mimeType: "video/VP8", clockRate: 90000 },
  { mimeType: "video/rtx", clockRate: 90000 },
  { mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: "profile-level-id=42e01f" },
  { mimeType: "video/VP9", clockRate: 90000 },
  { mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: "profile-level-id=64001f" },
  { mimeType: "video/red", clockRate: 90000 },
  { mimeType: "video/ulpfec", clockRate: 90000 },
];
const controllers: P2PMediaController[] = [];
const sdp = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\na=sendrecv\r\n";
function rawTrack() { return Object.assign(new EventTarget(), { kind: "video", enabled: true, readyState: "live", contentHint: "", stop: vi.fn(), applyConstraints: vi.fn().mockResolvedValue(undefined) }) as unknown as MediaStreamTrack; }
function fixture() {
  const camera = rawTrack();
  let parameters = { encodings: [{}], degradationPreference: "balanced" } as RTCRtpSendParameters;
  const sender = { track: camera as MediaStreamTrack | null, getParameters: () => ({ ...parameters, encodings: parameters.encodings.map(value => ({ ...value })) }),
    setParameters: vi.fn(async (value: RTCRtpSendParameters) => { parameters = value; }),
    replaceTrack: vi.fn(async (value: MediaStreamTrack | null) => { sender.track = value; }) };
  const transceiver = { sender, receiver: { track: { kind: "video" } }, mid: "0", currentDirection: "sendrecv", setCodecPreferences: vi.fn(), stopped: false };
  const pc = {
    signalingState: "stable", localDescription: null as RTCSessionDescriptionInit | null,
    getTransceivers: () => [transceiver], getSenders: () => [sender],
    createOffer: vi.fn(async () => ({ type: "offer" as const, sdp })),
    setLocalDescription: vi.fn(async (value: RTCSessionDescriptionInit) => { pc.localDescription = value; pc.signalingState = "have-local-offer"; }),
    setRemoteDescription: vi.fn(async () => { pc.signalingState = "stable"; }),
  };
  let revision = 0;
  const onError = vi.fn();
  const controller = new P2PMediaController(pc as unknown as RTCPeerConnection, {
    callId: "call", polite: false, isCaller: true, isCurrent: () => true, onError, onMedia: vi.fn(),
    send: (_op, data) => {
      const request = data as { description_id: string };
      void controller.applyRemoteDescription({ call_id: "call", type: "answer", sdp, media_protocol: 1,
        description_revision: ++revision, description_id: crypto.randomUUID(), reply_to_description_id: request.description_id,
        capabilities: [], sources: [] });
    },
  });
  controllers.push(controller);
  return { policy: new P2PScreenCodecPolicy(pc as unknown as RTCPeerConnection, sender as unknown as RTCRtpSender), pc, transceiver, sender, camera, onError };
}
beforeEach(() => { vi.stubGlobal("RTCRtpReceiver", { getCapabilities: () => ({ codecs }) }); vi.stubGlobal("RTCRtpSender", { getCapabilities: () => ({ codecs }) }); });
afterEach(() => { controllers.splice(0).forEach(value => value.dispose()); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("prefers all H264 profiles while retaining retransmission, FEC and fallback codecs", () => {
  const ordered = preferScreenCodec(codecs, "h264")!;
  expect(ordered.slice(0, 2)).toEqual([codecs[2], codecs[4]]);
  expect(new Set(ordered)).toEqual(new Set(codecs));
  expect(preferScreenCodec([codecs[0]], "h264")).toBeNull();
});

it("negotiates H264 and live VP9 preferences once each, then restores camera defaults", async () => {
  const h = fixture();
  expect(await h.policy.apply("h264", true, () => true)).toBe(true);
  expect(h.transceiver.setCodecPreferences.mock.lastCall![0][0].mimeType).toBe("video/H264");
  expect(await h.policy.apply("h264", true, () => true)).toBe(true);
  expect(h.pc.createOffer).toHaveBeenCalledOnce();
  expect(await h.policy.apply("vp9", false, () => true)).toBe(true);
  expect(h.transceiver.setCodecPreferences.mock.lastCall![0][0].mimeType).toBe("video/VP9");
  expect(await h.policy.restore(() => true)).toBe(true);
  expect(h.transceiver.setCodecPreferences).toHaveBeenLastCalledWith([]);
  expect(h.onError).not.toHaveBeenCalled();
});

it("rejects unavailable explicit low latency before changing a working sender", async () => {
  vi.stubGlobal("RTCRtpReceiver", { getCapabilities: () => ({ codecs: [codecs[0]] }) });
  const h = fixture();
  await expect(h.policy.apply("h264", true, () => true)).rejects.toMatchObject({ name: "NotSupportedError" });
  expect(h.transceiver.setCodecPreferences).not.toHaveBeenCalled();
  expect(h.pc.createOffer).not.toHaveBeenCalled();
  expect(await h.policy.apply("vp9", false, () => true)).toBe(true);
});

it("rolls back codec preferences after an offer failure without closing the call", async () => {
  const h = fixture();await h.policy.apply("vp9", false, () => true);
  h.pc.createOffer.mockRejectedValueOnce(new Error("offer failed"));
  await expect(h.policy.apply("h264", true, () => true)).rejects.toMatchObject({ name: "OperationError" });
  expect(h.transceiver.setCodecPreferences.mock.lastCall![0][0].mimeType).toBe("video/VP9");
  expect(h.onError).not.toHaveBeenCalled();
});

it("retired source cannot set or restore transceiver preferences", async () => {
  const h = fixture();expect(await h.policy.apply("h264", true, () => false)).toBe(false);
  expect(await h.policy.restore(() => false)).toBe(false);expect(h.transceiver.setCodecPreferences).not.toHaveBeenCalled();
});

it("rejects a codec that is only advertised for decoding", async () => {
  vi.stubGlobal("RTCRtpSender", { getCapabilities: () => ({ codecs: [codecs[0]] }) });
  const h = fixture();await expect(h.policy.apply("h264", true, () => true)).rejects.toMatchObject({ name: "NotSupportedError" });
  expect(h.transceiver.setCodecPreferences).not.toHaveBeenCalled();
});

it("only prioritizes H264 profiles that the local sender can encode", () => {
  const ordered = preferScreenCodec(codecs, "h264", [codecs[2]])!;
  expect(ordered[0]).toBe(codecs[2]);expect(ordered.indexOf(codecs[4])).toBeGreaterThan(ordered.indexOf(codecs[0]));
});

it("rejects a reported negotiated codec list that excludes required H264", async () => {
  const h = fixture();await h.sender.setParameters({ encodings: [{}], codecs: [{ mimeType: "video/VP8", clockRate: 90000, payloadType: 96 }] } as RTCRtpSendParameters);
  await expect(h.policy.apply("h264", true, () => true)).rejects.toMatchObject({ name: "NotSupportedError" });
  expect(h.transceiver.setCodecPreferences).toHaveBeenLastCalledWith([]);expect(h.onError).not.toHaveBeenCalled();
});

function report(mime: string, frames: number, timestamp: number) {
  return new Map<string, object>([['out', { id: 'out', type: 'outbound-rtp', kind: 'video', codecId: 'codec', framesEncoded: frames, timestamp }], ['codec', { id: 'codec', type: 'codec', mimeType: mime }]]) as unknown as RTCStatsReport;
}

it("does not reject required H264 based on stale pre-transition frames", async () => {
  vi.useFakeTimers();const h = fixture();Object.assign(h.sender, { getStats: vi.fn().mockResolvedValue(report("video/VP8", 10, 10)) });
  const pending = h.policy.apply("h264", true, () => true);await vi.advanceTimersByTimeAsync(30);expect(await pending).toBe(true);expect(h.onError).not.toHaveBeenCalled();
});

it("rolls back when fresh frames persistently report a fallback codec", async () => {
  vi.useFakeTimers();const h = fixture();let frames = 0;Object.assign(h.sender, { getStats: vi.fn(async () => report("video/VP8", ++frames, frames)) });
  const pending = h.policy.apply("h264", true, () => true);const failed = expect(pending).rejects.toMatchObject({ name: "NotSupportedError" });await vi.advanceTimersByTimeAsync(800);await failed;
  expect(h.transceiver.setCodecPreferences).toHaveBeenLastCalledWith([]);expect(h.onError).not.toHaveBeenCalled();
});

it("applies initial and live codec choices on the same captured P2P source and restores camera policy", async () => {
  const h = fixture(), raw = rawTrack(), capture = vi.fn().mockResolvedValue({ getVideoTracks: () => [raw], getTracks: () => [raw] });
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getDisplayMedia: capture } });
  const result = await startScreenShare(h.pc as unknown as RTCPeerConnection, { isCurrent: () => true,
    settings: { screenShareQuality: "1080p", screenShareFps: 60, screenShareLowLatency: true, screenShareMode: "motion" } });
  expect(result?.track).toBe(raw);expect(h.transceiver.setCodecPreferences.mock.lastCall![0][0].mimeType).toBe("video/H264");
  expect(await result!.update({ screenShareQuality: "1080p", screenShareFps: 60, screenShareLowLatency: false, screenShareMode: "detail" })).toBe(true);
  expect(h.transceiver.setCodecPreferences.mock.lastCall![0][0].mimeType).toBe("video/VP9");expect(raw.contentHint).toBe("detail");
  expect(h.sender.getParameters().degradationPreference).toBe("maintain-resolution");expect(capture).toHaveBeenCalledOnce();expect(raw.stop).not.toHaveBeenCalled();
  result!.dispose();expect(await stopScreenShare(h.sender as unknown as RTCRtpSender, h.camera, () => true)).toBe(true);
  expect(h.transceiver.setCodecPreferences).toHaveBeenLastCalledWith([]);expect(h.sender.track).toBe(h.camera);expect(h.sender.getParameters()).toEqual({ encodings: [{}], degradationPreference: "balanced" });
});
