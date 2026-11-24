import { describe, expect, it } from "vitest";
import { resolveVoiceChannelTransition } from "./voiceChannelTransition";

/** Replays store states through the function the way AppLayout's effect does. */
function layout() {
  let previous: string | null | undefined;
  let deferredFrom: string | null = null;
  const closed: string[] = [];
  let refetches = 0;
  return {
    closed,
    get refetches() { return refetches; },
    see(current: string | null, pending: string | null = null) {
      const transition = resolveVoiceChannelTransition({ previous, current, pending, deferredFrom });
      previous = current;
      deferredFrom = transition.deferredFrom;
      if (transition.closeTabsFor) closed.push(transition.closeTabsFor);
      if (transition.refetchChannels) refetches++;
      return transition;
    },
  };
}

describe("resolveVoiceChannelTransition", () => {
  it.each([null, "a"])("does nothing on the initial mount with channel %s", channel => {
    const ui = layout();
    ui.see(channel, channel ? null : "joining");
    expect(ui.closed).toEqual([]);
    expect(ui.refetches).toBe(0);
  });

  it("a plain join refetches once and closes nothing", () => {
    const ui = layout();
    ui.see(null);
    ui.see(null, "a");
    expect(ui.refetches).toBe(0);
    ui.see("a", "a");
    ui.see("a");
    expect(ui.closed).toEqual([]);
    expect(ui.refetches).toBe(1);
  });

  it("a plain join that fails does nothing", () => {
    const ui = layout();
    ui.see(null);
    ui.see(null, "a");
    ui.see(null);
    expect(ui.closed).toEqual([]);
    expect(ui.refetches).toBe(0);
  });

  it("a plain leave closes the channel's tabs and refetches at once", () => {
    const ui = layout();
    ui.see("a");
    expect(ui.see(null)).toEqual({ closeTabsFor: "a", refetchChannels: true, deferredFrom: null });
    expect(ui.closed).toEqual(["a"]);
    expect(ui.refetches).toBe(1);
  });

  it("a switch defers through the transient gap, then closes the previous tab and refetches once", () => {
    const ui = layout();
    ui.see("a");
    expect(ui.see(null, "b")).toEqual({ closeTabsFor: null, refetchChannels: false, deferredFrom: "a" });
    expect(ui.closed).toEqual([]);
    expect(ui.refetches).toBe(0);
    ui.see("b", "b");
    ui.see("b");
    expect(ui.closed).toEqual(["a"]);
    expect(ui.refetches).toBe(1);
  });

  it("a move whose commit lands in the same render behaves like the deferred switch", () => {
    const ui = layout();
    ui.see("a");
    expect(ui.see("b")).toEqual({ closeTabsFor: "a", refetchChannels: true, deferredFrom: null });
    expect(ui.closed).toEqual(["a"]);
    expect(ui.refetches).toBe(1);
  });

  it("rejoining the channel that was left keeps its tab and refetches once", () => {
    const ui = layout();
    ui.see("a");
    ui.see(null, "a");
    ui.see("a", "a");
    ui.see("a");
    expect(ui.closed).toEqual([]);
    expect(ui.refetches).toBe(1);
  });

  // A refused join and a leave during the join reach the layout as the same
  // store states: the pending channel is cleared and none is current.
  it("runs the deferred close and refetch when the pending join fails or is cancelled by a leave", () => {
    const ui = layout();
    ui.see("a");
    ui.see(null, "b");
    expect(ui.see(null)).toEqual({ closeTabsFor: "a", refetchChannels: true, deferredFrom: null });
    expect(ui.closed).toEqual(["a"]);
    expect(ui.refetches).toBe(1);
  });

  it("keeps deferring while one pending join supersedes another", () => {
    const ui = layout();
    ui.see("a");
    ui.see(null, "b");
    ui.see(null, "c");
    expect(ui.refetches).toBe(0);
    ui.see("c", "c");
    expect(ui.closed).toEqual(["a"]);
    expect(ui.refetches).toBe(1);
  });

  it("owes nothing to later joins once the deferred work has run", () => {
    const ui = layout();
    ui.see("a");
    ui.see(null, "b");
    ui.see(null);
    ui.see(null, "c");
    ui.see("c", "c");
    expect(ui.closed).toEqual(["a"]);
    expect(ui.refetches).toBe(2);
  });

  it("falls back to the immediate close when the gap is seen before the pending join", () => {
    const ui = layout();
    ui.see("a");
    ui.see(null);
    ui.see(null, "b");
    ui.see("b", "b");
    expect(ui.closed).toEqual(["a"]);
    expect(ui.refetches).toBe(2);
  });

  it("does nothing when only the pending join changes", () => {
    const ui = layout();
    ui.see("a");
    expect(ui.see("a", "b")).toEqual({ closeTabsFor: null, refetchChannels: false, deferredFrom: null });
    expect(ui.see("a")).toEqual({ closeTabsFor: null, refetchChannels: false, deferredFrom: null });
  });
});
