type Listener = (generation: number) => void;
const listeners = new Set<Listener>();
let ownerId: string | null = null;
let currentGeneration = 0;
const ownerListeners = new Set<(owner: string | null) => void>();

/** Credential-free identity seam; avoids auth-store/crypto/store import cycles. */
export function getAuthSessionOwner(): string | null { return ownerId; }
export function getAuthSessionSnapshot(): { ownerId: string | null; generation: number } {
  return { ownerId, generation: currentGeneration };
}
export function subscribeAuthOwnerChanges(listener: (owner: string | null) => void): () => void {
  ownerListeners.add(listener);
  return () => { ownerListeners.delete(listener); };
}
export function publishAuthOwnerChange(owner: string | null): void {
  if (owner === ownerId) return;
  ownerId = owner;
  for (const listener of [...ownerListeners]) {
    try { listener(owner); }
    catch { console.error("[auth] Identity observer failed"); }
  }
}

/** Login/logout boundary only, not ordinary access-token renewal. No credentials. */
export function subscribeAuthGenerationChanges(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function publishAuthGenerationChange(generation: number): void {
  currentGeneration = generation;
  // An observer failure must not leave other account-owned caches uncleared.
  for (const listener of [...listeners]) {
    try { listener(generation); }
    catch { console.error("[auth] Session observer failed"); }
  }
}
