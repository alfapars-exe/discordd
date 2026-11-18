import { act, renderHook } from "@testing-library/react";
import { RoomEvent, Track, type Room } from "livekit-client";
import { expect, it, vi } from "vitest";
import { useScreenShareReceiverStats } from "./useScreenShareReceiverStats";
import { logOptionalTelemetry } from "../api/clientLog";

const { grade } = vi.hoisted(() => ({ grade: vi.fn() }));
vi.mock("../stores/voiceStore", () => ({
  useVoiceStore: { getState: () => ({ setScreenShareQualityGrade: grade, clearScreenShareQualityGrade: vi.fn(), pushScreenShareQualityHistoryPoint: vi.fn() }) },
}));
vi.mock("../api/clientLog", () => ({ logOptionalTelemetry: vi.fn() }));

it.each([RoomEvent.TrackUnsubscribed, RoomEvent.ParticipantDisconnected])(
  "ignores a delayed report after %s when the track SID is reused", async event => {
  vi.useFakeTimers();
  grade.mockClear();
  let resolveOld!: (report: Map<string, unknown>) => void;
  const oldTrack = { receiver: { getStats: () => new Promise<Map<string, unknown>>(resolve => { resolveOld = resolve; }) } };
  const publication = { trackSid: "sid", source: Track.Source.ScreenShare, isSubscribed: true, track: oldTrack };
  const participant = { identity: "publisher", trackPublications: new Map([["sid", publication]]) };
  const room = { remoteParticipants: new Map([["publisher", participant]]), on: vi.fn(), off: vi.fn() };
  const hook = renderHook(() => useScreenShareReceiverStats(room as unknown as Room));
  try {
    const listener = room.on.mock.calls.find(([registeredEvent]) => registeredEvent === event)![1];
    if (event === RoomEvent.ParticipantDisconnected) listener(participant);
    else listener(oldTrack, publication, participant);
    publication.track = { receiver: { getStats: async () => new Map() } };
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    await act(async () => { vi.advanceTimersByTime(1000); resolveOld(new Map()); });
    expect(grade).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(grade).toHaveBeenCalledTimes(1);
  } finally {
    hook.unmount();
    vi.useRealTimers();
  }
});

const firstCounters = {
  bytesReceived: 100, framesDecoded: 100, framesDropped: 10,
  freezeCount: 4, totalFreezesDuration: 1, pauseCount: 2, totalPausesDuration: 0.5,
  jitterBufferDelay: 12, jitterBufferEmittedCount: 300,
  packetsLost: 5, packetsReceived: 1000, nackCount: 2, firCount: 3, pliCount: 4,
  frameWidth: 1280, frameHeight: 720,
};
const laterCounters = {
  bytesReceived: 1250100, framesDecoded: 400, framesDropped: 12,
  freezeCount: 5, totalFreezesDuration: 1.25, pauseCount: 3, totalPausesDuration: 0.6,
  jitterBufferDelay: 21, jitterBufferEmittedCount: 600,
  packetsLost: 15, packetsReceived: 1490, nackCount: 5, firCount: 4, pliCount: 6,
  frameWidth: 1920, frameHeight: 1080,
};

function receiverFixture(counters: Array<Record<string, number>>) {
  const reports = counters.map(row => new Map([["video", { type: "inbound-rtp", kind: "video", ...row }]]));
  const getStats = vi.fn().mockResolvedValue(reports.at(-1));
  for (const report of reports) getStats.mockResolvedValueOnce(report);
  const publication = { trackSid: "sid", source: Track.Source.ScreenShare, isSubscribed: true, track: { receiver: { getStats } } };
  const participant = { identity: "publisher", name: "Publisher", trackPublications: new Map([["sid", publication]]) };
  const room = { remoteParticipants: new Map([["publisher", participant]]), on: vi.fn(), off: vi.fn() };
  return { room, getStats };
}

it.each([
  { name: "normal cumulative counters", next: laterCounters, expected: {
    kbps: 1000, fps: 30, framesDropped: 2, freezeCount: 1, freezeMs: 250,
    pauseCount: 1, pauseMs: 100, jitterBufferDelayMs: 30, packetLossPct: 2,
    nackDelta: 3, firDelta: 1, pliDelta: 2, quality: "fair", frameWidth: 1920, frameHeight: 1080,
  } },
  { name: "counter reset and zero denominators", next: Object.fromEntries(Object.keys(firstCounters).map(key => [key, 0])), expected: {
    kbps: 0, fps: 0, framesDropped: 0, freezeCount: 0, freezeMs: 0,
    pauseCount: 0, pauseMs: 0, jitterBufferDelayMs: 0, packetLossPct: 0,
    nackDelta: 0, firDelta: 0, pliDelta: 0, quality: "poor", frameWidth: 0, frameHeight: 0,
  } },
])("publishes window deltas for $name", async ({ next, expected }) => {
  vi.useFakeTimers();
  vi.setSystemTime(1000000);
  grade.mockClear(); vi.mocked(logOptionalTelemetry).mockClear();
  const { room, getStats } = receiverFixture([firstCounters, next]);
  const hook = renderHook(() => useScreenShareReceiverStats(room as unknown as Room));
  try {
    await act(async () => {});
    expect(logOptionalTelemetry).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(getStats).toHaveBeenCalledTimes(2);
    expect(logOptionalTelemetry).toHaveBeenCalledExactlyOnceWith("screen_share_receiver_stats", expect.objectContaining({ ...expected, intervalSec: 10 }));
    expect(grade).toHaveBeenCalledWith("publisher", expected.quality);
  } finally { hook.unmount(); vi.useRealTimers(); }
});

it("does not advance the baseline when the sample clock has not advanced", async () => {
  vi.useFakeTimers();
  const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
  grade.mockClear(); vi.mocked(logOptionalTelemetry).mockClear();
  const { room } = receiverFixture([firstCounters, { ...laterCounters, bytesReceived: 1000100 }, laterCounters]);
  const hook = renderHook(() => useScreenShareReceiverStats(room as unknown as Room));
  try {
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(logOptionalTelemetry).not.toHaveBeenCalled();
    clock.mockReturnValue(11000);
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(logOptionalTelemetry).toHaveBeenCalledExactlyOnceWith("screen_share_receiver_stats", expect.objectContaining({ kbps: 1000, intervalSec: 10 }));
  } finally { hook.unmount(); clock.mockRestore(); vi.useRealTimers(); }
});
