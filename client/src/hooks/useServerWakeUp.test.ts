/**
 * useServerWakeUp — retry-loop behaviour tests.
 *
 * The probe module is mocked so the scheduling can be observed in isolation:
 * fake timers drive the setTimeout chain, randomUnit (the CSPRNG-backed
 * Math.random replacement) is pinned wherever a deterministic delay is
 * needed, and pingServer's call count is the ground truth for "a probe
 * happened".
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useServerWakeUp } from "./useServerWakeUp";
import { pingServer } from "../utils/serverProbe";
import * as randomModule from "../utils/random";

vi.mock("../utils/serverProbe", () => ({
  pingServer: vi.fn(),
}));

const pingServerMock = vi.mocked(pingServer);

const SENTINEL = "service_unavailable: 502";
const MAX_ATTEMPTS = 8;

/** Mirrors RETRY_POLICY.backoff — 0-indexed wait before probe N+1. */
const backoff = (attempt: number) => Math.min(2_000 * 2 ** attempt, 30_000);

function renderWake() {
  const onReady = vi.fn();
  const utils = renderHook(
    (props: { error: string | null }) => useServerWakeUp({ error: props.error, onReady }),
    { initialProps: { error: null as string | null } },
  );
  return { ...utils, onReady };
}

/** Advance fake time inside act() so the timer-driven setState calls stay legal. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  pingServerMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useServerWakeUp", () => {
  it("probes immediately when the sentinel error appears", async () => {
    pingServerMock.mockResolvedValue(false);
    const { result, rerender } = renderWake();
    expect(pingServerMock).not.toHaveBeenCalled();

    await act(async () => rerender({ error: SENTINEL }));

    expect(pingServerMock).toHaveBeenCalledTimes(1);
    expect(result.current.state).toEqual({ phase: "waking", attempt: 1, max: MAX_ATTEMPTS });
  });

  it("treats plain network failures as a cold start, not just the sentinel", async () => {
    pingServerMock.mockResolvedValue(false);
    const { rerender } = renderWake();

    await act(async () => rerender({ error: "TypeError: Failed to fetch" }));

    expect(pingServerMock).toHaveBeenCalledTimes(1);
  });

  it("follows the exponential backoff curve (jitter pinned to its midpoint)", async () => {
    vi.spyOn(randomModule, "randomUnit").mockReturnValue(0.5); // jitter factor exactly 1.0
    pingServerMock.mockResolvedValue(false);
    const { rerender } = renderWake();
    await act(async () => rerender({ error: SENTINEL }));
    await advance(0); // settle the first probe so its retry timer is booked
    expect(pingServerMock).toHaveBeenCalledTimes(1);

    // Expected waits between probes: 2s, 4s, 8s, 16s, then capped at 30s.
    for (let fired = 1; fired < MAX_ATTEMPTS; fired++) {
      const delay = backoff(fired - 1);
      await advance(delay - 1);
      expect(pingServerMock).toHaveBeenCalledTimes(fired); // one tick early — not yet
      await advance(1);
      expect(pingServerMock).toHaveBeenCalledTimes(fired + 1); // fires exactly on time
    }
  });

  it("keeps each delay within the +/-20% jitter bounds", async () => {
    // random=0 pins the factor to 0.8 (floor); random=1 pins it to 1.2 (ceiling).
    for (const [random, factor] of [
      [0, 0.8],
      [1, 1.2],
    ] as const) {
      vi.spyOn(randomModule, "randomUnit").mockReturnValue(random);
      pingServerMock.mockReset();
      pingServerMock.mockResolvedValue(false);
      const { rerender, unmount } = renderWake();
      await act(async () => rerender({ error: SENTINEL }));
      await advance(0);
      expect(pingServerMock).toHaveBeenCalledTimes(1);

      const delay = backoff(0) * factor;
      await advance(delay - 1);
      expect(pingServerMock).toHaveBeenCalledTimes(1); // strictly inside the bound
      await advance(1);
      expect(pingServerMock).toHaveBeenCalledTimes(2);
      unmount();
    }
  });

  it("transitions to failed once maxAttempts is exhausted and stops probing", async () => {
    vi.spyOn(randomModule, "randomUnit").mockReturnValue(0.5);
    pingServerMock.mockResolvedValue(false);
    const { result, rerender } = renderWake();
    await act(async () => rerender({ error: SENTINEL }));

    // Every gap is <=30s, so 7x30s walks through all remaining probes.
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
      await advance(30_000);
    }

    expect(pingServerMock).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(result.current.state).toEqual({ phase: "failed" });

    // Exhaustion must end the chain — no zombie timer keeps probing.
    await advance(120_000);
    expect(pingServerMock).toHaveBeenCalledTimes(MAX_ATTEMPTS);
  });

  it("clears the pending retry timer on unmount — no probes after cleanup", async () => {
    pingServerMock.mockResolvedValue(false);
    const { rerender, unmount } = renderWake();
    await act(async () => rerender({ error: SENTINEL }));
    await advance(0); // first probe failed, the retry timer is now pending
    expect(pingServerMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
    await advance(120_000);
    expect(pingServerMock).toHaveBeenCalledTimes(1);
  });

  it("does not schedule a new probe when unmounted mid-flight", async () => {
    let resolveProbe: ((alive: boolean) => void) | undefined;
    pingServerMock.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveProbe = resolve;
        }),
    );
    const { rerender, unmount } = renderWake();
    await act(async () => rerender({ error: SENTINEL }));
    expect(pingServerMock).toHaveBeenCalledTimes(1);

    unmount(); // probe promise still unresolved here

    await act(async () => {
      resolveProbe?.(false);
    });
    await advance(0);

    // The late resolution must not book a timer the cleanup can't reach.
    expect(vi.getTimerCount()).toBe(0);
    await advance(120_000);
    expect(pingServerMock).toHaveBeenCalledTimes(1);
  });

  it("transitions to ready and fires onReady exactly once on success", async () => {
    pingServerMock.mockResolvedValue(true);
    const { result, rerender, onReady } = renderWake();
    await act(async () => rerender({ error: SENTINEL }));
    await advance(0);

    expect(result.current.state).toEqual({ phase: "ready" });
    expect(onReady).toHaveBeenCalledTimes(1);

    // Once the server answered there is nothing left to probe or retry.
    await advance(120_000);
    expect(pingServerMock).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledTimes(1);
  });
});
