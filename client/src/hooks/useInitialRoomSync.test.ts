/**
 * Regression tests for the QA round-2 leak in useInitialRoomSync: a
 * Reconnected event queued a 1s-delayed setMicrophoneEnabled that kept
 * firing after the hook unmounted (stale closures → PublishTrackError
 * noise), and the Connected/Reconnected listeners accumulated across
 * mount cycles. The effect cleanup now drains pendingTimeouts and
 * removes both listeners — these tests pin that behaviour.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type { RefObject } from "react";
import {
  ConnectionState,
  RoomEvent,
  type LocalParticipant,
  type Room,
} from "livekit-client";

import { useInitialRoomSync } from "./useInitialRoomSync";

// The hook only reads voice state via getState() — stub the slice it uses
// so the test doesn't drag in the real store's API/native-plugin imports.
vi.mock("../stores/voiceStore", () => ({
  useVoiceStore: {
    getState: () => ({
      isMuted: false,
      inputMode: "voice_activity",
      isServerMuted: false,
      isDeafened: false,
      isServerDeafened: false,
      watchingScreenShares: {},
      userVolumes: {},
      screenShareVolumes: {},
      masterVolume: 100,
    }),
  },
}));

type Handler = (...args: unknown[]) => void;

/**
 * Minimal EventEmitter-shaped Room. Counts every on()/off() so the tests
 * can assert that registrations and removals balance exactly — the shape
 * the QA leak took was an off() that never happened.
 */
function makeStubRoom(initialState: ConnectionState) {
  const listeners = new Map<string, Set<Handler>>();
  const counts = { on: 0, off: 0 };
  const stub = {
    state: initialState,
    remoteParticipants: new Map<string, never>(),
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
    emit(event: string) {
      listeners.get(event)?.forEach((handler) => handler());
    },
  };
  const registeredCount = () =>
    [...listeners.values()].reduce((sum, set) => sum + set.size, 0);
  return { stub, counts, registeredCount };
}

function makeLocalParticipant() {
  return { setMicrophoneEnabled: vi.fn(() => Promise.resolve()) };
}

function renderRoomSync(
  stub: ReturnType<typeof makeStubRoom>["stub"],
  lp: ReturnType<typeof makeLocalParticipant>,
  ref: RefObject<boolean>,
) {
  return renderHook(() =>
    useInitialRoomSync(
      stub as unknown as Room,
      lp as unknown as LocalParticipant,
      ref,
    ),
  );
}

describe("useInitialRoomSync — QA bug #2 (reconnect timer / listener leak)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not touch the mic after unmount even when Reconnected queued the delayed reapply", () => {
    const { stub, counts, registeredCount } = makeStubRoom(
      ConnectionState.Connected,
    );
    const lp = makeLocalParticipant();
    const ref = { current: false };

    const { unmount } = renderRoomSync(stub, lp, ref);

    // Mount applies initial state once (room already Connected).
    expect(lp.setMicrophoneEnabled).toHaveBeenCalledTimes(1);
    expect(ref.current).toBe(true);

    // SDK-internal reconnect schedules the ~1s-delayed reapply.
    stub.emit(RoomEvent.Reconnected);

    // Unmount BEFORE the timer fires — cleanup must drain it.
    unmount();
    vi.advanceTimersByTime(5_000);

    expect(lp.setMicrophoneEnabled).toHaveBeenCalledTimes(1);
    // Every listener registered by the effect was removed again.
    expect(registeredCount()).toBe(0);
    expect(counts.off).toBe(counts.on);
    // Cleanup also resets the gate so dependent hooks stop firing.
    expect(ref.current).toBe(false);
  });

  it("control: the delayed reapply does fire when the hook stays mounted", () => {
    // Guards the first test against going vacuous — if a refactor ever
    // removes the Reconnected timer entirely, this control fails first.
    const { stub, registeredCount } = makeStubRoom(ConnectionState.Connected);
    const lp = makeLocalParticipant();
    const ref = { current: false };

    const { unmount } = renderRoomSync(stub, lp, ref);
    expect(lp.setMicrophoneEnabled).toHaveBeenCalledTimes(1);

    stub.emit(RoomEvent.Reconnected);
    vi.advanceTimersByTime(1_000);

    expect(lp.setMicrophoneEnabled).toHaveBeenCalledTimes(2);

    unmount();
    expect(registeredCount()).toBe(0);
  });
});
