/**
 * sendWithRetryAndToast — Wraps a message-send API call
 * with a user-facing toast on failure. The historical name is retained for callers.
 *
 * Retry policy:
 *   - Network error or gateway 502/503/504: NO retry. A lost response or
 *     proxy error does not prove that the underlying write did not commit.
 *   - Timeout (isTimeout): NO retry. The POST may have been persisted
 *     server-side; without an idempotency key a retry risks a duplicate.
 *   - 429 rate limit: no retry, warning toast pointing at chat:tooManyMessages.
 *   - Other 4xx/5xx (deterministic): no retry, error toast.
 *   - Success: no toast, return the response.
 *
 * Refresh flow untouched — apiClient handles 401 → refresh → retry internally
 * before this helper ever sees the response.
 */

import i18n from "../../i18n";
import { useToastStore } from "../toastStore";
import type { APIResponse } from "../../types";

export type SendWithRetryOptions = {
  /** Suppress toast on final failure — caller wants to show its own UI. */
  silent?: boolean;
  /** Fence abandoned sessions before dispatch and before user-visible effects. */
  isCurrent?:()=>boolean;
};

function isRateLimited(res: APIResponse<unknown>): boolean {
  if (res.status === 429) return true;
  return typeof res.error === "string" && res.error.toLowerCase().includes("too many");
}

export async function sendWithRetryAndToast<T>(
  send: () => Promise<APIResponse<T>>,
  options: SendWithRetryOptions = {}
): Promise<APIResponse<T>> {
  // Only a persisted server-side idempotency contract can make retries safe.
  // Keep the caller's draft on failure; never silently replay this write.
  if(options.isCurrent&&!options.isCurrent())return {success:false,error:"send_context_changed"};
  const res = await send();
  if(options.isCurrent&&!options.isCurrent())return {success:false,error:"send_context_changed"};

  if (res.success) return res;

  if (options.silent) return res;

  const toast = useToastStore.getState().addToast;
  if (isRateLimited(res)) {
    toast("warning", i18n.t("chat:tooManyMessages"));
  } else {
    toast("error", i18n.t("chat:sendFailed"));
  }
  return res;
}
