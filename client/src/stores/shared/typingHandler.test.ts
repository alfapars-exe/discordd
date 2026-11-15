import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTypingHandler } from "./messageUtils";

function harness() {
  let state = { typingUsers: {} as Record<string, string[]> };
  let notify: (() => void) | undefined;
  const handle = createTypingHandler(update => { state = update(state); notify?.(); });
  return { handle, read: () => state.typingUsers, notify: (next?: () => void) => { notify = next; }, remove: (channel: string) => { delete state.typingUsers[channel]; } };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.restoreAllMocks(); vi.clearAllTimers(); vi.useRealTimers(); });

it("renews the same user's expiry without duplicate typing entries", () => {
  const h = harness();
  h.handle("channel", "User");
  vi.advanceTimersByTime(4000);
  h.handle("channel", "User");
  vi.advanceTimersByTime(1000);
  expect(h.read().channel).toEqual(["User"]);
  vi.advanceTimersByTime(4000);
  expect(h.read().channel).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

it("clears only the retired channel's work", () => {
  const h = harness();
  h.handle("one", "User"); h.handle("two", "Other");
  h.handle.clear("one"); h.remove("one");
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(5000);
  expect(h.read()).toEqual({ two: [] });
});

it("ignores a canceled callback even if it was already queued", () => {
  const h = harness();
  const clock = vi.spyOn(globalThis, "setTimeout");
  h.handle("channel", "User");
  const callback = clock.mock.calls[0][0];
  h.handle.clear(); h.remove("channel");
  if (typeof callback !== "function") throw new Error("expected timer callback");
  callback();
  expect(h.read()).toEqual({});
});

it("keeps the successor timer installed by an expiry subscriber", () => {
  const h = harness();
  h.handle("channel", "User");
  h.notify(() => { h.notify(); h.handle("channel", "User"); });
  vi.advanceTimersByTime(5000);
  expect(h.read().channel).toEqual(["User"]);
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(5000);
  expect(h.read().channel).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

it("retains owned expiry after an observer throws on the committed update", () => {
  const h = harness();
  const failure = new Error("observer");
  h.notify(() => { h.notify(); throw failure; });
  expect(() => h.handle("channel", "User")).toThrow(failure);
  expect(h.read().channel).toEqual(["User"]);
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(5000);
  expect(h.read().channel).toEqual([]);
});
