import { expect, it, vi } from "vitest";
import { isMissingOutputDevice, routeAudioOutput } from "./outputRouting";

it("retries a missing selected device once using the adapter's default", async () => {
  const apply = vi.fn().mockRejectedValueOnce(new DOMException("removed", "NotFoundError")).mockResolvedValue(undefined);
  expect(await routeAudioOutput("usb", apply, { defaultSink: "", isCurrent: () => true })).toBe(true);
  expect(apply.mock.calls).toEqual([["usb"], [""]]);
});

it("does not hide denied access or repeatedly retry a missing default", async () => {
  for (const [selected, name] of [["usb", "NotAllowedError"], ["default", "NotFoundError"]]) {
    const error = new DOMException("unavailable", name);
    const apply = vi.fn().mockRejectedValue(error);
    await expect(routeAudioOutput(selected, apply, { defaultSink: "default", isCurrent: () => true })).rejects.toBe(error);
    expect(apply).toHaveBeenCalledOnce();
  }
});

it("a late failure after retirement cannot change the new owner's output", async () => {
  let current = true;
  let reject!: (error: Error) => void;
  const apply = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  const pending = routeAudioOutput("usb", apply, { defaultSink: "", isCurrent: () => current });
  current = false;
  reject(new DOMException("removed", "NotFoundError"));
  await pending;
  expect(apply).toHaveBeenCalledOnce();
});

it("a retired owner never starts routing and blank/default preferences use the adapter default", async () => {
  const apply = vi.fn().mockResolvedValue(undefined);
  await routeAudioOutput("usb", apply, { defaultSink: "", isCurrent: () => false });
  expect(apply).not.toHaveBeenCalled();
  await routeAudioOutput("", apply, { defaultSink: "default", isCurrent: () => true });
  await routeAudioOutput("default", apply, { defaultSink: "default", isCurrent: () => true });
  expect(apply.mock.calls).toEqual([["default"], ["default"]]);
  for (const failure of [null, undefined, "NotFoundError", {}, new Error("unavailable")]) {
    expect(isMissingOutputDevice(failure)).toBe(false);
  }
});
