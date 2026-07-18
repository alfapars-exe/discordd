/**
 * Generic API + WebSocket envelope shapes.
 */

export type APIResponse<T = unknown> = {
  success: boolean;
  data?: T;
  error?: string;
  /**
   * True when the failure came from the network layer (fetch threw, DNS,
   * offline). Callers use this to decide "worth retrying" vs "give up" —
   * a 4xx is deterministic and shouldn't retry, a network flake often
   * succeeds on the second attempt.
   */
  isNetworkError?: boolean;
  /**
   * HTTP status when the server actually responded. Undefined for network
   * errors and 2xx wraps. Used by rate-limit UI to distinguish 429 from
   * a generic 5xx.
   */
  status?: number;
};

export type WSMessage = {
  op: string;
  d: unknown;
  seq?: number;
  /** Server ID — injected by BroadcastToServer for server-scoped events */
  server_id?: string;
};
