import { expect, it, vi } from "vitest";
import { runScreenShareRestart } from "./screenShareRestartController";

function harness() {
  const state = { current: true, streaming: true, channel: "channel" };
  const operations = {
    isCurrent: () => state.current, isStreaming: () => state.streaming, getChannelId: () => state.channel,
    setRestarting: vi.fn(), beforeRestart: vi.fn(), stop: vi.fn(async () => {}),
    start: vi.fn(async (_cancel: () => boolean) => {}), failed: vi.fn(),
  };
  return { state, operations };
}

it("orders suppression, diagnostics, stop and start, then clears suppression", async () => {
  const h = harness(), calls: string[] = [];
  h.operations.setRestarting.mockImplementation(value => { calls.push(`suppress:${value}`); });
  h.operations.beforeRestart.mockImplementation(() => { calls.push("log"); });
  h.operations.stop.mockImplementation(async () => { calls.push("stop"); });
  h.operations.start.mockImplementation(async cancelled => { expect(cancelled()).toBe(false); calls.push("start"); });
  await runScreenShareRestart(h.operations);
  expect(calls).toEqual(["suppress:true", "log", "stop", "start", "suppress:false"]);
});

it.each(["current", "streaming"] as const)("skips a restart without %s ownership", async field => {
  const h = harness(); h.state[field] = false;
  await runScreenShareRestart(h.operations);
  expect(h.operations.setRestarting).not.toHaveBeenCalled();
  expect(h.operations.stop).not.toHaveBeenCalled();
});

it.each(["current", "streaming", "channel"] as const)("does not restart after %s changes during stop", async field => {
  const h = harness();
  h.operations.stop.mockImplementation(async () => {
    if (field === "channel") h.state.channel = "new";
    else h.state[field] = false;
  });
  await runScreenShareRestart(h.operations);
  expect(h.operations.start).not.toHaveBeenCalled();
  expect(h.operations.failed).not.toHaveBeenCalled();
  expect(h.operations.setRestarting.mock.calls).toEqual(field === "current" ? [[true]] : [[true], [false]]);
});

it("reports stop failure without starting and restores current suppression", async () => {
  const h = harness(), failure = new Error("native stop failed");
  h.operations.stop.mockRejectedValue(failure);
  await runScreenShareRestart(h.operations);
  expect(h.operations.failed).toHaveBeenCalledExactlyOnceWith(failure);
  expect(h.operations.start).not.toHaveBeenCalled();
  expect(h.operations.setRestarting.mock.calls).toEqual([[true], [false]]);
});

it("suppresses an old restart's failure and preserves a newer owner's suppression", async () => {
  const h = harness();
  h.operations.start.mockImplementation(async cancelled => {
    h.state.current = false;
    expect(cancelled()).toBe(true);
    throw new Error("old native failure");
  });
  await runScreenShareRestart(h.operations);
  expect(h.operations.failed).not.toHaveBeenCalled();
  expect(h.operations.setRestarting.mock.calls).toEqual([[true]]);
});
