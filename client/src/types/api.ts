/**
 * Generic API + WebSocket envelope shapes.
 */

export type APIResponse<T = unknown> = {
  success: boolean;
  data?: T;
  error?: string;
};

export type WSMessage = {
  op: string;
  d: unknown;
  seq?: number;
  /** Server ID — injected by BroadcastToServer for server-scoped events */
  server_id?: string;
};
