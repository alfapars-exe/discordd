type TokenResponse = {
  success: boolean;
  data?: { url: string; token: string };
  error?: string;
};

type NativeShareOperations = {
  getServerId: () => string | null;
  getChannelId: () => string | null;
  getToken: (serverId: string, channelId: string) => Promise<TokenResponse>;
  start: (url: string, token: string) => Promise<unknown>;
  stop: () => Promise<unknown>;
  tokenFailed: (error: string | undefined) => void;
  channelChanged: () => void;
  started: () => void;
};

/** Native capture orchestration; React/store/platform adapters stay at the caller. */
export function createNativeScreenShareController(operations: NativeShareOperations) {
  return {
    async start(shouldCancel: () => boolean): Promise<void> {
      if (shouldCancel()) return;
      const serverId = operations.getServerId(), channelId = operations.getChannelId();
      if (!serverId || !channelId) return;
      const response = await operations.getToken(serverId, channelId);
      if (shouldCancel()) return;
      if (!response.success || !response.data) {
        operations.tokenFailed(response.error);
        return;
      }
      if (operations.getChannelId() !== channelId) {
        operations.channelChanged();
        return;
      }
      await operations.start(response.data.url, response.data.token);
      if (!shouldCancel()) operations.started();
    },
    async stop(): Promise<void> { await operations.stop(); },
  };
}
