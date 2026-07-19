/**
 * sendWithRetryAndToast — Wraps a message-send API call with one retry
 * on transient network errors and a user-facing toast on final failure.
 *
 * Retry policy:
 *   - Network error (fetch threw, offline, DNS): retry once after 1.5s.
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

const RETRY_DELAY_MS = 1500;

export type SendWithRetryOptions = {
  /** Suppress toast on final failure — caller wants to show its own UI. */
  silent?: boolean;
};

function isRateLimited(res: APIResponse<unknown>): boolean {
  if (res.status === 429) return true;
  return typeof res.error === "string" && res.error.toLowerCase().includes("too many");
}

function shouldRetry(res: APIResponse<unknown>): boolean {
  if (res.success) return false;
  // Only network failures are retryable. Deterministic HTTP errors won't
  // change on retry and would just double the perceived latency.
  return res.isNetworkError === true;
}

export async function sendWithRetryAndToast<T>(
  send: () => Promise<APIResponse<T>>,
  options: SendWithRetryOptions = {}
): Promise<APIResponse<T>> {
  let res = await send();

  if (shouldRetry(res)) {
    await new Promise<void>((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    res = await send();
  }

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
