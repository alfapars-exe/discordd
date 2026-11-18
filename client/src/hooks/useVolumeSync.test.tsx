import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RoomEvent, Track, type Room } from "livekit-client";

vi.mock("../stores/voiceStore", async () => {
  const { create } = await import("zustand");
  return { useVoiceStore: create(() => ({ userVolumes: {} as Record<string, number>, screenShareVolumes: {} as Record<string, number>, masterVolume: 100, isDeafened: false, isServerDeafened: false })) };
});
import { useVoiceStore } from "../stores/voiceStore";
import { useVolumeSync } from "./useVolumeSync";

function fixture(identity = "peer") {
  const events = new Map<string, Set<(...args: unknown[]) => void>>();
  const participant = { identity, setVolume: vi.fn() };
  const model = {
    remoteParticipants: new Map([[identity, participant]]),
    on: (event: string, callback: (...args: unknown[]) => void) => { const handlers = events.get(event) ?? new Set(); handlers.add(callback); events.set(event, handlers); },
    off: (event: string, callback: (...args: unknown[]) => void) => events.get(event)?.delete(callback),
  };
  return { room: model as unknown as Room, participant,
    emit: (event: string, ...args: unknown[]) => events.get(event)?.forEach(callback => callback(...args)),
    listeners: () => [...events.values()].reduce((sum, handlers) => sum + handlers.size, 0),
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  useVoiceStore.setState({ userVolumes: {}, screenShareVolumes: {}, masterVolume: 100, isDeafened: false, isServerDeafened: false });
});
afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers(); });

it.each(["toString", "hasOwnProperty", "valueOf"])("uses default finite gains for an unconfigured peer %s", identity => {
  const f = fixture(identity);
  renderHook(() => useVolumeSync(f.room));
  expect(f.participant.setVolume).toHaveBeenCalledWith(1, Track.Source.Microphone);
  expect(f.participant.setVolume).toHaveBeenCalledWith(1, Track.Source.ScreenShareAudio);
});

it("preserves explicit zero, screen amplification and both deafen overrides", () => {
  useVoiceStore.setState({ userVolumes: { peer: 0 }, screenShareVolumes: { peer: 150 }, masterVolume: 50 });
  const f = fixture(); renderHook(() => useVolumeSync(f.room));
  expect(f.participant.setVolume).toHaveBeenCalledWith(0, Track.Source.Microphone);
  expect(f.participant.setVolume).toHaveBeenCalledWith(0.75, Track.Source.ScreenShareAudio);
  for (const state of [{ isServerDeafened: true }, { isServerDeafened: false, isDeafened: true }]) {
    act(() => useVoiceStore.setState({ isServerDeafened: false, isDeafened: false }));
    f.participant.setVolume.mockClear();
    act(() => useVoiceStore.setState(state));
    expect(f.participant.setVolume).toHaveBeenCalledWith(0, Track.Source.Microphone);
    expect(f.participant.setVolume).toHaveBeenCalledWith(0, Track.Source.ScreenShareAudio);
  }
});

it("uses latest settings in both delayed paths and cancels callbacks on unmount", () => {
  const f = fixture(); const mounted = renderHook(() => useVolumeSync(f.room));
  f.participant.setVolume.mockClear();
  act(() => f.emit(RoomEvent.TrackSubscribed, { kind: Track.Kind.Video }, {}, f.participant));
  expect(vi.getTimerCount()).toBe(0);
  expect(f.participant.setVolume).not.toHaveBeenCalled();
  act(() => {
    f.emit(RoomEvent.TrackSubscribed, { kind: Track.Kind.Audio }, {}, f.participant);
    f.emit(RoomEvent.ParticipantConnected, f.participant);
    useVoiceStore.setState({ userVolumes: { peer: 25 }, screenShareVolumes: { peer: 175 }, masterVolume: 50 });
  });
  f.participant.setVolume.mockClear();
  act(() => vi.advanceTimersByTime(300));
  expect(f.participant.setVolume).toHaveBeenCalledWith(0.125, Track.Source.Microphone);
  expect(f.participant.setVolume).toHaveBeenCalledWith(0.875, Track.Source.ScreenShareAudio);
  act(() => useVoiceStore.setState({ masterVolume: 100 }));
  f.participant.setVolume.mockClear();
  act(() => vi.advanceTimersByTime(200));
  expect(f.participant.setVolume).toHaveBeenCalledWith(0.25, Track.Source.Microphone);
  expect(f.participant.setVolume).toHaveBeenCalledWith(1.75, Track.Source.ScreenShareAudio);
  act(() => {
    f.emit(RoomEvent.TrackSubscribed, { kind: Track.Kind.Audio }, {}, f.participant);
    f.emit(RoomEvent.ParticipantConnected, f.participant);
  });
  f.participant.setVolume.mockClear(); mounted.unmount();
  expect(vi.getTimerCount()).toBe(0);
  expect(f.listeners()).toBe(0);
  act(() => vi.advanceTimersByTime(1000));
  expect(f.participant.setVolume).not.toHaveBeenCalled();
});
