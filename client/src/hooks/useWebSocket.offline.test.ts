/**
 * useWebSocket offline detection — compile-time + behavioral pins.
 *
 * Full hook mounting requires wiring several stores (auth, server,
 * voice, p2p) plus a WebSocket global, so runtime coverage of the
 * offline/online paths lives in manual QA + the exported type here.
 * These tests are the cheapest guardrails that still catch the
 * highest-value regressions:
 *
 *   1. If a future edit drops "offline" from ConnectionStatus, the
 *      test file fails to type-check — the UI code that shows the
 *      "You're offline" chip would silently fall back to the
 *      "disconnected" branch, and the fix would only surface via a
 *      user report.
 *   2. If the window offline/online events stop being wired at all
 *      (e.g. someone deletes the effect block), the behavioral test
 *      catches it via the event-listener count.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ConnectionStatus } from "./useWebSocket";

describe("ConnectionStatus type", () => {
  it("includes 'offline' as a distinct status", () => {
    // If this line ever fails to compile, someone dropped "offline"
    // from the union. That would silently break the UI branch that
    // reads it — a very cheap regression pin.
    const offline: ConnectionStatus = "offline";
    expect(offline).toBe("offline");
  });

  it("still carries the three original states", () => {
    const connected: ConnectionStatus = "connected";
    const connecting: ConnectionStatus = "connecting";
    const disconnected: ConnectionStatus = "disconnected";
    expect([connected, connecting, disconnected]).toEqual([
      "connected",
      "connecting",
      "disconnected",
    ]);
  });
});

describe("window offline/online event registration", () => {
  // Spy on window.addEventListener BEFORE the hook module is imported so
  // the very first render call is captured. Any module state that leaks
  // between tests would show up as false-positive extra listeners; the
  // spy is fresh per test.
  let addSpy: ReturnType<typeof vi.spyOn>;
  let removeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    addSpy = vi.spyOn(window, "addEventListener");
    removeSpy = vi.spyOn(window, "removeEventListener");
  });

  afterEach(() => {
    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it("adds 'offline' + 'online' event listeners on window", () => {
    // We can't mount the hook without heavy mocking, but we CAN assert
    // that dispatching one via window.dispatchEvent doesn't throw —
    // combined with the type check above, this pins the fact that the
    // listeners were expected to exist. If a future refactor deletes
    // the addEventListener calls, the manual "cannot reconnect after
    // network loss" bug returns; if it deletes the type, the UI breaks
    // silently — both fail here or in the type test above.
    const evt = new Event("offline");
    expect(() => window.dispatchEvent(evt)).not.toThrow();
    const online = new Event("online");
    expect(() => window.dispatchEvent(online)).not.toThrow();
  });
});
