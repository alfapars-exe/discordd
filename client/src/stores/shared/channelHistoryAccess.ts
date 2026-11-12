// Keep a revocation generation even after a later grant, so a decrypt already
// running when access was lost cannot complete in the new permission context.
const access = new Map<string, { denied: boolean }>();

export function revokeHistoryAccess(channelId: string): void {
  access.set(channelId, { denied: true });
}

export function grantHistoryAccess(channelId: string): void {
  if (access.get(channelId)?.denied) access.set(channelId, { denied: false });
}

export function resetHistoryAccess(): void {
  access.clear();
}

export function historyAccessDenied(channelId: string): boolean {
  return access.get(channelId)?.denied ?? false;
}

export function captureHistoryAccess(channelId: string): () => boolean {
  const original = access.get(channelId);
  return () => !original?.denied && access.get(channelId) === original;
}
