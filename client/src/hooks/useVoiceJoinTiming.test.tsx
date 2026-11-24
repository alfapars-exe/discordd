import { renderHook } from "@testing-library/react";
import { ConnectionState, RoomEvent, Track, type Room } from "livekit-client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  voice: { _joinGeneration: 4, currentVoiceChannelId: "voice" as string | null },
  timing: { markVoiceJoinConnected: vi.fn(), markVoiceJoinMicrophone: vi.fn(), markVoiceJoinReady: vi.fn(), abandonVoiceJoinTiming: vi.fn() },
}));
vi.mock("../stores/voiceStore", () => ({ useVoiceStore: { getState: () => h.voice } }));
vi.mock("../audio/voiceJoinTiming", () => h.timing);

import { useVoiceJoinTiming } from "./useVoiceJoinTiming";

function fakeRoom(state = ConnectionState.Connecting) {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const room = {
    state,
    on: (event: string, handler: (...args: unknown[]) => void) => {
      const handlers = listeners.get(event) ?? new Set();
      handlers.add(handler); listeners.set(event, handlers); return room;
    },
    off: (event: string, handler: (...args: unknown[]) => void) => { listeners.get(event)?.delete(handler); return room; },
    emit: (event: string, ...args: unknown[]) => listeners.get(event)?.forEach(handler => handler(...args)),
    count: () => [...listeners.values()].reduce((total, handlers) => total + handlers.size, 0),
  };
  return room;
}
const asRoom = (room: ReturnType<typeof fakeRoom>) => room as unknown as Room;

beforeEach(() => {
  h.voice = { _joinGeneration: 4, currentVoiceChannelId: "voice" };
  Object.values(h.timing).forEach(mark => mark.mockReset());
});

describe("useVoiceJoinTiming", () => {
  it("marks the room connection and the microphone publication for its generation", () => {
    const room = fakeRoom();
    renderHook(() => useVoiceJoinTiming(4, asRoom(room), false));
    expect(h.timing.markVoiceJoinConnected).not.toHaveBeenCalled();
    room.emit(RoomEvent.Connected);
    expect(h.timing.markVoiceJoinConnected).toHaveBeenCalledExactlyOnceWith(4);

    room.emit(RoomEvent.LocalTrackPublished, { source: Track.Source.Camera });
    room.emit(RoomEvent.LocalTrackPublished, { source: Track.Source.ScreenShareAudio });
    expect(h.timing.markVoiceJoinMicrophone).not.toHaveBeenCalled();
    room.emit(RoomEvent.LocalTrackPublished, { source: Track.Source.Microphone });
    expect(h.timing.markVoiceJoinMicrophone).toHaveBeenCalledExactlyOnceWith(4);
    expect(h.timing.markVoiceJoinReady).not.toHaveBeenCalled();
  });

  it("marks a room that was already connected when it was handed over", () => {
    renderHook(() => useVoiceJoinTiming(4, asRoom(fakeRoom(ConnectionState.Connected)), false));
    expect(h.timing.markVoiceJoinConnected).toHaveBeenCalledExactlyOnceWith(4);
  });

  it("marks ready when encrypted admission becomes ready", () => {
    const view = renderHook(({ ready }) => useVoiceJoinTiming(4, null, ready), { initialProps: { ready: false } });
    expect(h.timing.markVoiceJoinReady).not.toHaveBeenCalled();
    view.rerender({ ready: true });
    expect(h.timing.markVoiceJoinReady).toHaveBeenCalledExactlyOnceWith(4);
  });

  it("stops listening when the room is replaced or the provider unmounts", () => {
    const first = fakeRoom(), second = fakeRoom();
    const view = renderHook(({ room }) => useVoiceJoinTiming(4, asRoom(room), false), { initialProps: { room: first } });
    expect(first.count()).toBe(2);
    view.rerender({ room: second });
    expect(first.count()).toBe(0);
    first.emit(RoomEvent.Connected);
    expect(h.timing.markVoiceJoinConnected).not.toHaveBeenCalled();
    view.unmount();
    expect(second.count()).toBe(0);
  });

  it("keeps the attempt open when the provider remounts during a live session", () => {
    const view = renderHook(() => useVoiceJoinTiming(4, null, true));
    view.unmount();
    expect(h.timing.abandonVoiceJoinTiming).not.toHaveBeenCalled();
  });

  it.each(["left", "superseded"])("closes the attempt when the session was %s", ended => {
    const view = renderHook(() => useVoiceJoinTiming(4, null, false));
    h.voice = ended === "left" ? { _joinGeneration: 5, currentVoiceChannelId: null } : { _joinGeneration: 6, currentVoiceChannelId: "other" };
    view.unmount();
    expect(h.timing.abandonVoiceJoinTiming).toHaveBeenCalledExactlyOnceWith(4);
  });

  it("closes the attempt after a server-side removal that keeps the generation", () => {
    const view = renderHook(() => useVoiceJoinTiming(4, null, false));
    h.voice = { _joinGeneration: 4, currentVoiceChannelId: null };
    view.unmount();
    expect(h.timing.abandonVoiceJoinTiming).toHaveBeenCalledExactlyOnceWith(4);
  });
});
