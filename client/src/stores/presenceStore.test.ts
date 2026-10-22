/**
 * presenceStore — overlay + forwarding to friendStore.
 *
 * The spy is created INSIDE the vi.mock factory (hoisting/TDZ: a top-level
 * `const spy = vi.fn()` is not initialised when the factory runs).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./friendStore", () => {
  const handlePresenceUpdate = vi.fn();
  return { useFriendStore: { getState: () => ({ handlePresenceUpdate }) } };
});

import { usePresenceStore, presenceDotColor } from "./presenceStore";
import { useFriendStore } from "./friendStore";

beforeEach(() => {
  vi.clearAllMocks();
  usePresenceStore.setState({ statusByUserId: {} });
});

describe("presenceStore.handlePresenceUpdate", () => {
  it("writes the overlay and forwards to friendStore", () => {
    usePresenceStore.getState().handlePresenceUpdate("u-1", "idle");

    expect(usePresenceStore.getState().statusByUserId).toEqual({ "u-1": "idle" });
    expect(useFriendStore.getState().handlePresenceUpdate).toHaveBeenCalledWith("u-1", "idle");
  });

  it("keeps other users' entries when one changes", () => {
    usePresenceStore.getState().handlePresenceUpdate("u-1", "online");
    usePresenceStore.getState().handlePresenceUpdate("u-2", "dnd");
    usePresenceStore.getState().handlePresenceUpdate("u-1", "offline");

    expect(usePresenceStore.getState().statusByUserId).toEqual({ "u-1": "offline", "u-2": "dnd" });
  });
});

describe("presenceStore.handleReady", () => {
  it("clears the overlay (ready refetches bring fresh DB state)", () => {
    usePresenceStore.setState({ statusByUserId: { "u-1": "online" } });

    usePresenceStore.getState().handleReady(["u-1"]);

    expect(usePresenceStore.getState().statusByUserId).toEqual({});
    expect(useFriendStore.getState().handlePresenceUpdate).not.toHaveBeenCalled();
  });
});

describe("presenceDotColor", () => {
  it("maps every status to the sidebar colour set", () => {
    expect(presenceDotColor("online")).toBe("var(--green)");
    expect(presenceDotColor("idle")).toBe("var(--yellow, #f0b232)");
    expect(presenceDotColor("dnd")).toBe("var(--red)");
    expect(presenceDotColor("offline")).toBe("var(--t3)");
  });
});
