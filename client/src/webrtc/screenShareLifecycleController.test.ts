import { expect, it, vi } from "vitest";
import { ScreenShareLifecycleController } from "./screenShareLifecycleController";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

it("drains the cancelled picker and explicit stop before starting another capture", async () => {
  const controller = new ScreenShareLifecycleController(), picker = gate(), entered = gate();
  const calls: string[] = [];
  const failed = vi.fn();
  const old = controller.transition({ streaming: true, failed, stop: async () => {}, start: async cancelled => {
    calls.push("old-start"); entered.resolve(); await picker.promise;
    expect(cancelled()).toBe(true); calls.push("old-retired");
  } });
  await entered.promise;
  old.cancel();
  const stop = controller.transition({ streaming: false, failed, start: async () => {}, stop: async () => { calls.push("stop"); } });
  stop.cancel();
  const next = controller.transition({ streaming: true, failed, stop: async () => {}, start: async () => { calls.push("new-start"); } });
  expect(calls).toEqual(["old-start"]);
  picker.resolve(); await next.settled;
  expect(calls).toEqual(["old-start", "old-retired", "stop", "new-start"]);
  expect(failed).not.toHaveBeenCalled();
});

it("skips a start retired before its turn without skipping later transitions", async () => {
  const controller = new ScreenShareLifecycleController(), start = vi.fn(async () => {}), failed = vi.fn();
  const old = controller.transition({ streaming: true, start, stop: async () => {}, failed });
  old.cancel(); await old.settled;
  expect(start).not.toHaveBeenCalled();
  await controller.transition({ streaming: true, start, stop: async () => {}, failed }).settled;
  expect(start).toHaveBeenCalledTimes(1);
});

it("reports a current failure once and continues the queue", async () => {
  const controller = new ScreenShareLifecycleController(), failure = new Error("capture failed"), failed = vi.fn(), stop = vi.fn(async () => {});
  await controller.transition({ streaming: true, start: async () => { throw failure; }, stop, failed }).settled;
  expect(failed).toHaveBeenCalledExactlyOnceWith(failure);
  await controller.transition({ streaming: false, start: async () => {}, stop, failed }).settled;
  expect(stop).toHaveBeenCalledTimes(1);
});

it("does not deliver an in-flight old owner's failure to its replacement", async () => {
  const controller = new ScreenShareLifecycleController(), pending = gate(), entered = gate(), failed = vi.fn();
  const old = controller.transition({ streaming: true, stop: async () => {}, failed, start: async () => {
    entered.resolve(); await pending.promise; throw new Error("old failure");
  } });
  await entered.promise; old.cancel(); pending.resolve(); await old.settled;
  expect(failed).not.toHaveBeenCalled();
});
