/**
 * useWebSocket — offline/online detection.
 *
 * Two kinds of coverage live here:
 *
 *   1. Compile-time pins on the ConnectionStatus union. If a future edit
 *      drops "offline", this file stops type-checking — otherwise the UI
 *      branch that renders the "You're offline" chip would silently fall
 *      back to the generic "disconnected" spinner and the regression
 *      would only surface via a user report.
 *   2. Behavioral tests that mount the real hook. They assert that the
 *      connect effect registers window "offline"/"online" listeners, that
 *      unmount removes those exact handler references (a mismatched
 *      cleanup leaks a dead hook that keeps setting state), and — the
 *      part a user actually feels — that a window "offline" event drives
 *      connectionStatus to "offline" and eagerly tears the socket down
 *      instead of waiting out the heartbeat, while a following "online"
 *      event reconnects immediately.
 *
 * Mounting the hook for real means stubbing everything it reaches for:
 * the API client, the client logger, native plugins, the p2p/voice
 * stores, constants, the four ws/*EventHandlers modules, and the
 * WebSocket global. That is the price of testing the effect rather than
 * asserting around it — an earlier version of this file only checked
 * that window.dispatchEvent didn't throw, which passed even with the
 * whole effect deleted.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";

import type { ConnectionStatus } from "./useWebSocket";
import { useWebSocket } from "./useWebSocket";

// ─── Module stubs ───
// The hook's connect effect is the unit under test; every collaborator it
// imports is replaced with the smallest shape that lets the effect run to
// the point where it constructs a socket and wires the window listeners.

vi.mock("../api/client", () => ({
  ensureFreshToken: vi.fn(async () => "test-token"),
  // success:false keeps the hook on the legacy `?token=` URL branch —
  // which URL it picks is irrelevant here, only that it gets to `new
  // WebSocket(...)` without a network call.
  apiClient: vi.fn(async () => ({ success: false })),
}));

vi.mock("../api/clientLog", () => ({ logToServer: vi.fn() }));

vi.mock("../utils/nativePlugins", () => ({
  APP_RESUME_EVENT: "mqvi:app-resume",
}));

vi.mock("../stores/p2pCallStore", () => ({
  useP2PCallStore: { getState: () => ({ registerSendWS: vi.fn() }) },
}));

vi.mock("../stores/voiceStore", () => ({
  useVoiceStore: { getState: () => ({ isMuted: false, isDeafened: false }) },
}));

vi.mock("../utils/constants", () => ({
  WS_URL: "ws://test.local/ws",
  WS_HEARTBEAT_INTERVAL: 30_000,
  WS_HEARTBEAT_MAX_MISS: 3,
}));

vi.mock("./ws/channelEventHandlers", () => ({
  handleChannelEvent: vi.fn(async () => false),
}));
vi.mock("./ws/dmEventHandlers", () => ({
  handleDMEvent: vi.fn(async () => false),
}));
vi.mock("./ws/voiceEventHandlers", () => ({
  handleVoiceEvent: vi.fn(async () => false),
}));
vi.mock("./ws/systemEventHandlers", () => ({
  handleSystemEvent: vi.fn(async () => false),
}));

/**
 * Minimal WebSocket stand-in. jsdom's implementation would attempt a real
 * connection to WS_URL; this one just records what the hook did to it.
 */
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  /** Every socket the hook has constructed in this test, oldest first. */
  static instances: FakeWebSocket[] = [];

  url: string;
  // Start "open": the hook never fires our onopen, but the offline path
  // needs a live socket to tear down for that assertion to mean anything.
  readyState = FakeWebSocket.OPEN;
  closeCount = 0;
  send = vi.fn();

  // Callback slots the connect effect assigns to.
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  close() {
    this.closeCount += 1;
    this.readyState = FakeWebSocket.CLOSED;
  }
}

function spyOnWindowListeners() {
  // vi.spyOn calls through by default, so real dispatchEvent still works —
  // these only observe.
  return {
    add: vi.spyOn(window, "addEventListener"),
    remove: vi.spyOn(window, "removeEventListener"),
  };
}

let listeners: ReturnType<typeof spyOnWindowListeners>;

/**
 * Handlers currently registered for `type`: everything passed to
 * addEventListener minus everything passed to removeEventListener, matched
 * by function identity. A cleanup that removes a *different* closure — the
 * classic listener leak — leaves an entry behind here.
 */
function liveHandlersFor(type: string) {
  const added = listeners.add.mock.calls
    .filter((call) => call[0] === type)
    .map((call) => call[1]);
  const removed = listeners.remove.mock.calls
    .filter((call) => call[0] === type)
    .map((call) => call[1]);
  return added.filter((handler) => !removed.includes(handler));
}

function lastSocket() {
  const socket = FakeWebSocket.instances.at(-1);
  if (!socket) throw new Error("the hook never constructed a WebSocket");
  return socket;
}

/**
 * Mount the hook and drain doConnect's microtasks (token refresh, then the
 * ws-ticket POST) so the socket exists before a test acts on it.
 */
async function mountHook() {
  const view = renderHook(() => useWebSocket());
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return view;
}

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

describe("useWebSocket offline/online handling", () => {
  const realWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    listeners = spyOnWindowListeners();
  });

  afterEach(() => {
    listeners.add.mockRestore();
    listeners.remove.mockRestore();
    globalThis.WebSocket = realWebSocket;
  });

  it("registers exactly one window listener for 'offline' and one for 'online'", async () => {
    await mountHook();

    expect(liveHandlersFor("offline")).toHaveLength(1);
    expect(liveHandlersFor("online")).toHaveLength(1);
  });

  it("removes both listeners on unmount, by the same reference it added", async () => {
    const { unmount } = await mountHook();
    const offlineHandler = liveHandlersFor("offline")[0];
    const onlineHandler = liveHandlersFor("online")[0];

    unmount();

    expect(liveHandlersFor("offline")).toHaveLength(0);
    expect(liveHandlersFor("online")).toHaveLength(0);
    expect(listeners.remove).toHaveBeenCalledWith("offline", offlineHandler);
    expect(listeners.remove).toHaveBeenCalledWith("online", onlineHandler);
  });

  it("drives connectionStatus to 'offline' when the window goes offline", async () => {
    // The user-visible payoff: ConnectionBanner renders "You're offline"
    // for this status instead of the reconnecting spinner it would show
    // for "disconnected".
    const { result } = await mountHook();
    expect(result.current.connectionStatus).toBe("connecting");

    act(() => {
      window.dispatchEvent(new Event("offline"));
    });

    expect(result.current.connectionStatus).toBe("offline");
  });

  it("closes the live socket on 'offline' instead of waiting for the heartbeat", async () => {
    await mountHook();
    const socket = lastSocket();
    expect(socket.closeCount).toBe(0);

    act(() => {
      window.dispatchEvent(new Event("offline"));
    });

    expect(socket.closeCount).toBe(1);
  });

  it("reconnects on 'online' rather than sitting in the offline state", async () => {
    const { result } = await mountHook();
    const socketsAfterMount = FakeWebSocket.instances.length;

    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(result.current.connectionStatus).toBe("offline");

    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.connectionStatus).toBe("connecting");
    expect(FakeWebSocket.instances.length).toBe(socketsAfterMount + 1);
  });

  it("stops reacting to window events after unmount", async () => {
    const { result, unmount } = await mountHook();
    unmount();
    const socketsAtUnmount = FakeWebSocket.instances.length;

    await act(async () => {
      window.dispatchEvent(new Event("offline"));
      window.dispatchEvent(new Event("online"));
      await Promise.resolve();
      await Promise.resolve();
    });

    // A leaked "online" handler would open a fresh socket for a hook that
    // no longer exists — the leak this cleanup is guarding against.
    expect(FakeWebSocket.instances.length).toBe(socketsAtUnmount);
    expect(result.current.connectionStatus).toBe("connecting");
  });
});
