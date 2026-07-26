/**
 * Generic API response envelope.
 *
 * The WebSocket frame type (`WSMessage`) and its per-op payload map now live
 * in `./ws` (discriminated union keyed by `op`); both are re-exported from the
 * types barrel, so existing `import { WSMessage } from "../types"` keeps working.
 */

export type APIResponse<T = unknown> = {
  success: boolean;
  data?: T;
  error?: string;
  /**
   * Machine-readable backend error code (e.g. "NOT_FOUND", "RATE_LIMITED"),
   * derived from the server's domain sentinel. Optional — absent on success
   * and on older/message-only error paths. classifyApiError prefers it over
   * the free-text error string when present.
   */
  code?: string;
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
