import { getAuthGeneration } from "../api/client";
import { subscribeAuthGenerationChanges, subscribeAuthOwnerChanges } from "../api/authSessionEvents";
import { useAuthStore } from "../stores/authStore";
import { SERVER_URL } from "./constants";

let key = "";
let pending: Promise<string | null> | null = null;
// Identity notifications revoke the native capability immediately, before React effects run.
export function revokeNativeGameJoinScope() {
  key = ""; pending = null;
  void window.electronAPI?.syncGameJoinContext?.(null).catch(() => {});
}
subscribeAuthGenerationChanges(revokeNativeGameJoinScope);
subscribeAuthOwnerChanges(revokeNativeGameJoinScope);
export function nativeGameJoinScope(ownerId: string, generation: number): Promise<string | null> {
  const api = window.electronAPI;
  if (!api?.syncGameJoinContext || useAuthStore.getState().user?.id !== ownerId || getAuthGeneration() !== generation) return Promise.resolve(null);
  let origin: string;
  try { origin = new URL(SERVER_URL || window.location.origin).origin; } catch { return Promise.resolve(null); }
  const wanted = JSON.stringify([ownerId, generation, origin]);
  if (key === wanted && pending) return pending;
  key = wanted;
  const attempt = api.syncGameJoinContext({ origin, ownerId, generation, nonce: crypto.randomUUID() })
    .then(result => key === wanted && useAuthStore.getState().user?.id === ownerId && getAuthGeneration() === generation && result.accepted ? result.scopeNonce : null)
    .catch(() => null);
  pending = attempt;
  void attempt.then(result => { if (!result && pending === attempt && key === wanted) pending = null; });
  return attempt;
}
