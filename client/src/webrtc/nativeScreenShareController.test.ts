import { describe, expect, it, vi } from "vitest";
import { createNativeScreenShareController } from "./nativeScreenShareController";

function harness() {
  const state = { server: "server" as string | null, channel: "channel" as string | null, cancelled: false };
  const operations = {
    getServerId: () => state.server, getChannelId: () => state.channel,
    getToken: vi.fn(async () => ({ success: true, data: { url: "wss://media", token: "token" } })),
    start: vi.fn(async () => true), stop: vi.fn(async () => {}),
    tokenFailed: vi.fn(), channelChanged: vi.fn(), started: vi.fn(),
  };
  return { state, operations, controller: createNativeScreenShareController(operations) };
}

describe("native screen share controller", () => {
  it("starts only after token retrieval and announces only after native completion", async () => {
    const h = harness();
    let finish!: (value: boolean) => void;
    h.operations.start.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const task = h.controller.start(() => h.state.cancelled);
    await Promise.resolve();
    expect(h.operations.getToken).toHaveBeenCalledWith("server", "channel");
    expect(h.operations.start).toHaveBeenCalledWith("wss://media", "token");
    expect(h.operations.started).not.toHaveBeenCalled();
    finish(true); await task;
    expect(h.operations.started).toHaveBeenCalledTimes(1);
    await h.controller.stop();
    expect(h.operations.stop).toHaveBeenCalledTimes(1);
  });

  it("does not fetch without ownership or when already cancelled", async () => {
    const h = harness();
    await h.controller.start(() => true);
    h.state.server = null;
    await h.controller.start(() => false);
    h.state.server = "server"; h.state.channel = null;
    await h.controller.start(() => false);
    expect(h.operations.getToken).not.toHaveBeenCalled();
  });

  it("rejects a token for a channel left during fetch without starting native capture", async () => {
    const h = harness();
    h.operations.getToken.mockImplementation(async () => {
      h.state.channel = "another";
      return { success: true, data: { url: "wss://old", token: "old" } };
    });
    await h.controller.start(() => false);
    expect(h.operations.start).not.toHaveBeenCalled();
    expect(h.operations.channelChanged).toHaveBeenCalledTimes(1);
    expect(h.operations.started).not.toHaveBeenCalled();
  });

  it("propagates native failures to the owner's error boundary", async () => {
    const h = harness(), failure = new Error("permission denied");
    h.operations.start.mockRejectedValue(failure);
    await expect(h.controller.start(() => false)).rejects.toBe(failure);
    expect(h.operations.started).not.toHaveBeenCalled();
  });
});
