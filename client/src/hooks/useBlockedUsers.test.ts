import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("../api/block", () => ({ listBlocked: vi.fn(), blockUser: vi.fn(), unblockUser: vi.fn() }));
import * as api from "../api/block";
import { useAuthStore } from "../stores/authStore";
import { useBlockStore } from "../stores/blockStore";
import { clearTokens } from "../api/client";
import { useBlockedUsers } from "./useBlockedUsers";
const bob = { user_id: "bob", username: "bob" } as never;
beforeEach(() => {
  vi.resetAllMocks();
  useAuthStore.setState({ user: { id: "alice" } as never });
  useBlockStore.setState({ blockedUserIds: [] });
});
afterEach(cleanup);
it("refreshes rows after a WebSocket block change", async () => {
  vi.mocked(api.listBlocked).mockResolvedValueOnce({ success: true, data: [] }).mockResolvedValueOnce({ success: true, data: [bob] });
  const { result } = renderHook(useBlockedUsers);
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  act(() => useBlockStore.getState().handleUserBlock({ user_id: "alice", blocked_user_id: "bob" }));
  await waitFor(() => expect(result.current.blockedUsers).toEqual([bob]));
});
it("hides prior account rows and ignores its pending response", async () => {
  let finish!: (value: { success: boolean; data: never[] }) => void;
  vi.mocked(api.listBlocked).mockResolvedValueOnce({ success: true, data: [bob] }).mockReturnValueOnce(new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce({ success: true, data: [] });
  const { result } = renderHook(useBlockedUsers);
  await waitFor(() => expect(result.current.blockedUsers).toEqual([bob]));
  act(() => useBlockStore.setState({ blockedUserIds: ["bob"] }));
  act(() => useAuthStore.setState({ user: { id: "other" } as never }));
  expect(result.current.blockedUsers).toEqual([]);
  await act(async () => finish({ success: true, data: [bob] }));
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  expect(result.current.blockedUsers).toEqual([]);
});
it("clears rows when the same account starts a new session", async () => {
  vi.mocked(api.listBlocked).mockResolvedValueOnce({ success: true, data: [bob] }).mockResolvedValueOnce({ success: true, data: [] });
  const { result } = renderHook(useBlockedUsers);
  await waitFor(() => expect(result.current.blockedUsers).toEqual([bob]));
  act(() => clearTokens());
  expect(result.current.blockedUsers).toEqual([]);
  await waitFor(() => expect(result.current.isLoading).toBe(false));
});
it("ends loading on network rejection", async () => {
  vi.mocked(api.listBlocked).mockRejectedValueOnce(new Error("offline"));
  const { result } = renderHook(useBlockedUsers);
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  expect(result.current.blockedUsers).toEqual([]);
});
