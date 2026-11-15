import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useMessageStore } from "./messageStore";
import { useDMStore } from "./dmStore";
import { publishAuthOwnerChange, publishAuthGenerationChange } from "../api/authSessionEvents";

const fixtures = [
  { name: "channel", store: useMessageStore, type: (channel: string, user: string) => useMessageStore.getState().handleTypingStart(channel, user) },
  { name: "dm", store: useDMStore, type: (channel: string, user: string) => useDMStore.getState().handleDMTypingStart(channel, user) },
];
let generation = 20;
beforeEach(() => {
  vi.useFakeTimers();
  publishAuthOwnerChange("typing-owner-a");
  publishAuthGenerationChange(++generation);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

for (const fixture of fixtures) {
  it.each(["owner", "generation"])(`${fixture.name}: cancels retired typing work on %s replacement`, boundary => {
    fixture.type("old-channel", "Old User");
    expect(fixture.store.getState().typingUsers["old-channel"]).toEqual(["Old User"]);
    if (boundary === "owner") publishAuthOwnerChange("typing-owner-b");
    else publishAuthGenerationChange(++generation);
    expect(fixture.store.getState().typingUsers).toEqual({});
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(fixture.store.getState().typingUsers).toEqual({});
  });

  it(`${fixture.name}: does not register a timer after a subscriber replaces the owner`, () => {
    let stop = () => {};
    stop = fixture.store.subscribe(() => {
      stop();
      publishAuthOwnerChange("typing-owner-b");
      publishAuthGenerationChange(++generation);
    });
    try { fixture.type("old-channel", "Old User"); }
    finally { stop(); }
    expect(fixture.store.getState().typingUsers).toEqual({});
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(fixture.store.getState().typingUsers).toEqual({});
  });

  it(`${fixture.name}: preserves the replacement owner's full renewed expiry`, () => {
    fixture.type("shared-channel", "User");
    vi.advanceTimersByTime(1000);
    publishAuthOwnerChange("typing-owner-b");
    publishAuthGenerationChange(++generation);
    fixture.type("shared-channel", "User");
    vi.advanceTimersByTime(4000);
    expect(fixture.store.getState().typingUsers["shared-channel"]).toEqual(["User"]);
    vi.advanceTimersByTime(1000);
    expect(fixture.store.getState().typingUsers["shared-channel"]).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
}
