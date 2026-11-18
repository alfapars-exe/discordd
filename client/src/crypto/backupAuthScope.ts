import { getAuthSessionSnapshot } from "../api/authSessionEvents";

export type AuthScope = Readonly<{ ownerId: string; generation: number }>;

export function captureScope(): AuthScope {
  const snapshot = getAuthSessionSnapshot();
  if (!snapshot.ownerId || !snapshot.ownerId.trim() || snapshot.ownerId.length > 256) {
    throw new Error("e2ee_account_scope_unavailable");
  }
  return { ownerId: snapshot.ownerId, generation: snapshot.generation };
}

export function isCurrent(scope: AuthScope): boolean {
  const snapshot = getAuthSessionSnapshot();
  return snapshot.ownerId === scope.ownerId && snapshot.generation === scope.generation;
}

export function assertCurrent(scope: AuthScope): void {
  if (!isCurrent(scope)) throw new Error("e2ee_account_scope_changed");
}

export async function awaitScoped<T>(scope: AuthScope, operation: () => Promise<T>): Promise<T> {
  assertCurrent(scope);
  const result = await operation();
  assertCurrent(scope);
  return result;
}

