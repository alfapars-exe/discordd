import { describe, expect, it, vi } from "vitest";
import { getAuthSessionOwner, publishAuthOwnerChange, subscribeAuthOwnerChanges, publishAuthGenerationChange, subscribeAuthGenerationChanges } from "./authSessionEvents";

describe("auth session boundaries", () => {
  it("publishes identity changes synchronously with a cycle-free current-owner accessor", () => {
    publishAuthOwnerChange(null);
    const seen: Array<string | null> = [];
    const stop = subscribeAuthOwnerChanges((owner) => {
      expect(getAuthSessionOwner()).toBe(owner);
      seen.push(owner);
    });
    try {
      publishAuthOwnerChange("first");
      publishAuthOwnerChange("first");
      publishAuthOwnerChange("second");
      publishAuthOwnerChange(null);
      expect(seen).toEqual(["first", "second", null]);
    } finally { stop(); publishAuthOwnerChange(null); }
  });
  it("notifies synchronously, supports unsubscribe, and isolates observer failures", () => {
    const received: number[] = [];
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stopBroken = subscribeAuthGenerationChanges(() => { throw new Error("observer"); });
    const stop = subscribeAuthGenerationChanges((generation) => received.push(generation));
    try {
      publishAuthGenerationChange(2);
      expect(received).toEqual([2]);
      stop();
      publishAuthGenerationChange(3);
      expect(received).toEqual([2]);
      expect(error).toHaveBeenCalledTimes(2);
    } finally { stopBroken(); stop(); error.mockRestore(); }
  });
});
