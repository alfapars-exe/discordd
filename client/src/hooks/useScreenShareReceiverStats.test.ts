import { act, renderHook } from "@testing-library/react";
import { RoomEvent, Track, type Room } from "livekit-client";
import { expect, it, vi } from "vitest";
import { useScreenShareReceiverStats } from "./useScreenShareReceiverStats";

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
