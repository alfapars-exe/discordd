import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { clearTokens, getAuthGeneration } from "../api/client";
import { useAuthStore } from "../stores/authStore";
import { nativeGameJoinScope, revokeNativeGameJoinScope } from "./nativeGameJoinScope";
const sync = vi.fn();
beforeEach(() => {
  clearTokens(); useAuthStore.setState({ user: { id: "owner" } as never });
  sync.mockReset(); window.electronAPI = { syncGameJoinContext: sync } as never;
  sync.mockResolvedValue({ accepted: true, scopeNonce: "native-nonce" });
  revokeNativeGameJoinScope(); sync.mockClear();
});
afterEach(() => { revokeNativeGameJoinScope(); delete window.electronAPI; });
it("shares one stable auth scope across parallel explicit joins", async () => {
  const generation = getAuthGeneration();
  expect(await Promise.all([nativeGameJoinScope("owner", generation), nativeGameJoinScope("owner", generation)])).toEqual(["native-nonce", "native-nonce"]);
  expect(sync).toHaveBeenCalledTimes(1);
});
it("retries a rejected transient ACK instead of caching null permanently", async () => {
  sync.mockResolvedValueOnce({ accepted: false, scopeNonce: null });
  expect(await nativeGameJoinScope("owner", getAuthGeneration())).toBeNull();
  expect(await nativeGameJoinScope("owner", getAuthGeneration())).toBe("native-nonce");
  expect(sync).toHaveBeenCalledTimes(2);
});
it("old null ACK cannot clear a replacement identity's pending scope", async () => {
  let done!: (value: { accepted: boolean; scopeNonce: string | null }) => void;
  sync.mockImplementationOnce(() => new Promise(resolve => { done = resolve; }));
  const old = nativeGameJoinScope("owner", getAuthGeneration());
  clearTokens(); useAuthStore.setState({ user: { id: "new-owner" } as never });
  const current = nativeGameJoinScope("new-owner", getAuthGeneration());
  done({ accepted: false, scopeNonce: null });
  expect(await old).toBeNull(); expect(await current).toBe("native-nonce");
  const count = sync.mock.calls.length;
  expect(await nativeGameJoinScope("new-owner", getAuthGeneration())).toBe("native-nonce");
  expect(sync).toHaveBeenCalledTimes(count);
});
