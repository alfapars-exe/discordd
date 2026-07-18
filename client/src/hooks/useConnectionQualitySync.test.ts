/**
 * useConnectionQualitySync — room-level ConnectionQualityChanged fan-in.
 *
 * The hook must (a) register exactly one listener per event on the room,
 * (b) write every participant's quality into voiceStore keyed by identity,
 * (c) drop an entry when its participant disconnects, and (d) remove both
 * listeners on unmount. The stub Room below counts on()/off() so the last
 * point is asserted structurally rather than by inspection — the same
 * approach useInitialRoomSync.test.ts takes for its listener-leak guard.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  ConnectionQuality,
  RoomEvent,
  type Participant,
  type Room,
} from "livekit-client";

import { useConnectionQualitySync } from "./useConnectionQualitySync";

// The hook only writes through getState() — stub the two setters so the
// test doesn't drag in the real store's API/native-plugin imports.
const store = vi.hoisted(() => ({
  setConnectionQuality: vi.fn(),
  clearConnectionQuality: vi.fn(),
}));

vi.mock("../stores/voiceStore", () => ({
  useVoiceStore: { getState: () => store },
}));

type Handler = (...args: unknown[]) => void;

function makeStubRoom() {
  const listeners = new Map<string, Set<Handler>>();
  const counts = { on: 0, off: 0 };
  const stub = {
    on(event: string, handler: Handler) {
      counts.on += 1;
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(handler);
      return stub;
    },
    off(event: string, handler: Handler) {
      counts.off += 1;
      listeners.get(event)?.delete(handler);
      return stub;
    },
    emit(event: string, ...args: unknown[]) {
      listeners.get(event)?.forEach((handler) => handler(...args));
    },
  };
  const registeredCount = () =>
    [...listeners.values()].reduce((sum, set) => sum + set.size, 0);
  const hasListener = (event: string) => (listeners.get(event)?.size ?? 0) > 0;
  return { stub, counts, registeredCount, hasListener };
}

function participant(identity: string): Participant {
  return { identity } as Participant;
}

function renderSync(stub: ReturnType<typeof makeStubRoom>["stub"]) {
  return renderHook(() => useConnectionQualitySync(stub as unknown as Room));
}

describe("useConnectionQualitySync", () => {
  beforeEach(() => {
    store.setConnectionQuality.mockClear();
    store.clearConnectionQuality.mockClear();
  });

  it("registers room-level listeners for quality changes and disconnects", () => {
    const { stub, hasListener } = makeStubRoom();
    renderSync(stub);

    expect(hasListener(RoomEvent.ConnectionQualityChanged)).toBe(true);
    expect(hasListener(RoomEvent.ParticipantDisconnected)).toBe(true);
  });

  it("writes each participant's quality into the store, keyed by identity", () => {
    const { stub } = makeStubRoom();
    renderSync(stub);

    stub.emit(
      RoomEvent.ConnectionQualityChanged,
      ConnectionQuality.Excellent,
      participant("u1"),
    );
    stub.emit(
      RoomEvent.ConnectionQualityChanged,
      ConnectionQuality.Poor,
      participant("u2"),
    );

    expect(store.setConnectionQuality).toHaveBeenCalledWith("u1", "excellent");
    expect(store.setConnectionQuality).toHaveBeenCalledWith("u2", "poor");
  });

  it("covers the local participant too — one room listener, not per-participant", () => {
    // RoomEvent.ConnectionQualityChanged fires for the local participant as
    // well; nothing about the handler may special-case isLocal.
    const { stub } = makeStubRoom();
    renderSync(stub);

    const local = { identity: "me", isLocal: true } as Participant;
    stub.emit(RoomEvent.ConnectionQualityChanged, ConnectionQuality.Good, local);

    expect(store.setConnectionQuality).toHaveBeenCalledWith("me", "good");
  });

  it("clears the entry when quality goes Unknown instead of storing it", () => {
    // "unknown" is not a renderable level — keeping it would make the tile
    // paint an indicator it has no data for.
    const { stub } = makeStubRoom();
    renderSync(stub);

    stub.emit(
      RoomEvent.ConnectionQualityChanged,
      ConnectionQuality.Unknown,
      participant("u1"),
    );

    expect(store.setConnectionQuality).not.toHaveBeenCalled();
    expect(store.clearConnectionQuality).toHaveBeenCalledWith("u1");
  });

  it("ignores events that carry no participant", () => {
    const { stub } = makeStubRoom();
    renderSync(stub);

    stub.emit(RoomEvent.ConnectionQualityChanged, ConnectionQuality.Good, undefined);

    expect(store.setConnectionQuality).not.toHaveBeenCalled();
    expect(store.clearConnectionQuality).not.toHaveBeenCalled();
  });

  it("removes the entry when a participant disconnects", () => {
    const { stub } = makeStubRoom();
    renderSync(stub);

    stub.emit(
      RoomEvent.ConnectionQualityChanged,
      ConnectionQuality.Good,
      participant("u1"),
    );
    stub.emit(RoomEvent.ParticipantDisconnected, participant("u1"));

    expect(store.clearConnectionQuality).toHaveBeenCalledWith("u1");
  });

  it("removes both listeners on unmount", () => {
    const { stub, counts, registeredCount } = makeStubRoom();
    const { unmount } = renderSync(stub);

    expect(counts.on).toBe(2);
    unmount();

    expect(registeredCount()).toBe(0);
    expect(counts.off).toBe(counts.on);
  });

  it("does not write to the store after unmount", () => {
    const { stub } = makeStubRoom();
    const { unmount } = renderSync(stub);
    unmount();

    stub.emit(
      RoomEvent.ConnectionQualityChanged,
      ConnectionQuality.Poor,
      participant("u1"),
    );

    expect(store.setConnectionQuality).not.toHaveBeenCalled();
  });
});
