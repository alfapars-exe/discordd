import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { create } from "zustand";

const mocks = vi.hoisted(() => ({ initialize: vi.fn(), generation: 1 }));
vi.mock("../stores/authStore", () => ({ useAuthStore: create(() => ({ user: { id: "owner" } })) }));
vi.mock("../stores/e2eeStore", () => ({ useE2EEStore: create(() => ({ initStatus: "uninitialized", initialize: mocks.initialize })) }));
vi.mock("../api/authSessionEvents", () => ({ getAuthSessionSnapshot: () => ({ ownerId: "owner", generation: mocks.generation }) }));
import { useE2EEStore } from "../stores/e2eeStore";
import { useE2EE } from "./useE2EE";

beforeEach(() => { mocks.generation = 1; mocks.initialize.mockClear(); useE2EEStore.setState({ initStatus: "uninitialized" }); });

it("initializes again after same-owner reauthentication, not merely after a user-id change", () => {
  const view = renderHook(useE2EE);
  expect(mocks.initialize).toHaveBeenCalledTimes(1);
  act(() => useE2EEStore.setState({ initStatus: "ready" }));
  mocks.generation = 2;
  act(() => useE2EEStore.setState({ initStatus: "uninitialized" }));
  expect(mocks.initialize).toHaveBeenCalledTimes(2);
  view.unmount();
});

it("does not auto-initialize past a pending legacy recovery choice", () => {
  const view = renderHook(useE2EE);
  act(() => useE2EEStore.setState({ initStatus: "legacy-recovery" }));
  view.rerender();
  expect(mocks.initialize).toHaveBeenCalledTimes(1);
});

it("limits retries per session and resets that budget for same-owner reauthentication", () => {
  vi.useFakeTimers();
  const view = renderHook(useE2EE);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      act(() => useE2EEStore.setState({ initStatus: "error" }));
      act(() => vi.advanceTimersByTime(3000));
    }
    expect(mocks.initialize).toHaveBeenCalledTimes(3);
    mocks.generation = 2;
    act(() => useE2EEStore.setState({ initStatus: "uninitialized" }));
    act(() => useE2EEStore.setState({ initStatus: "error" }));
    act(() => vi.advanceTimersByTime(3000));
    expect(mocks.initialize).toHaveBeenCalledTimes(5);
  } finally { view.unmount(); vi.useRealTimers(); }
});
