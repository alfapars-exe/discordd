import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useReplyNavigation } from "./useReplyNavigation";

it("scrolls after loading a missing target and skips loading a visible target", async () => {
  const scroll = vi.fn();
  const load = vi.fn().mockResolvedValue(true);
  const { result } = renderHook(() => useReplyNavigation("dm", id => id === "recent", load, scroll));
  act(() => result.current("recent"));
  expect(load).not.toHaveBeenCalled();
  expect(scroll).toHaveBeenCalledWith("recent");
  await act(async () => { result.current("old"); });
  expect(load).toHaveBeenCalledOnce();
  expect(scroll).toHaveBeenLastCalledWith("old");
});

it("invalidates a pending reply when the conversation changes", async () => {
  let finish!: (found: boolean) => void;
  const load = vi.fn((_id: string, _context: { isCurrent: () => boolean }) =>
    new Promise<boolean>(resolve => { finish = resolve; }));
  const scroll = vi.fn();
  const { result, rerender } = renderHook(({ key }) =>
    useReplyNavigation(key, () => false, load, scroll), { initialProps: { key: "first" } });
  act(() => result.current("old"));
  const context = load.mock.calls[0][1];
  expect(context.isCurrent()).toBe(true);
  rerender({ key: "second" });
  expect(context.isCurrent()).toBe(false);
  await act(async () => finish(true));
  expect(scroll.mock.calls).toEqual([[null]]);
});

it("clears a mounted target before fetching a newer reply and ignores an older response", async () => {
  const scroll = vi.fn();
  let finishFirst!: (found: boolean) => void;
  let finishSecond!: (found: boolean) => void;
  const load = vi.fn()
    .mockImplementationOnce(() => new Promise<boolean>(resolve => { finishFirst = resolve; }))
    .mockImplementationOnce(() => new Promise<boolean>(resolve => { finishSecond = resolve; }));
  const { result } = renderHook(() => useReplyNavigation("channel", id => id === "mounted", load, scroll));

  act(() => result.current("mounted"));
  act(() => result.current("first"));
  expect(scroll).toHaveBeenLastCalledWith(null);
  act(() => result.current("second"));
  await act(async () => finishSecond(true));
  await act(async () => finishFirst(true));
  expect(scroll).toHaveBeenLastCalledWith("second");
  expect(scroll).not.toHaveBeenCalledWith("first");
});
