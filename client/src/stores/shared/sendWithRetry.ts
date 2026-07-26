/**
 * sendWithRetryAndToast — Wraps a message-send API call with one retry
 * on transient network errors and a user-facing toast on final failure.
 *
 * Retry policy:
 *   - Network error (fetch threw, offline, DNS): retry once after 1.5s.
 *   - HF cold-boot sentinel (502/503/504 → "service_unavailable:"): retry
 *     once after 2.5s — the Space is waking, not rejecting the request.
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

const RETRY_DELAY_MS = 1500;
const COLD_BOOT_RETRY_DELAY_MS = 2500;

export type SendWithRetryOptions = {
  /** Suppress toast on final failure — caller wants to show its own UI. */
  silent?: boolean;
};

function isRateLimited(res: APIResponse<unknown>): boolean {
  if (res.status === 429) return true;
  return typeof res.error === "string" && res.error.toLowerCase().includes("too many");
}

/**
 * HF Space asleep/booting: apiClient collapses edge 502/503/504 (HTML error
 * pages) into this stable sentinel. Transient infra state, not an app
 * rejection — a retry a couple of seconds later usually lands.
 */
function isColdBoot(res: APIResponse<unknown>): boolean {
  return typeof res.error === "string" && res.error.startsWith("service_unavailable:");
}

function shouldRetry(res: APIResponse<unknown>): boolean {
  if (res.success) return false;
  // Timed-out sends are deliberately NOT retried — the request may have
  // been persisted server-side and there is no idempotency key to dedupe.
  if (res.isTimeout) return false;
  // Network failures and cold-boot 5xx are retryable. Other deterministic
  // HTTP errors won't change on retry and would just double the latency.
  return res.isNetworkError === true || isColdBoot(res);
}

export async function sendWithRetryAndToast<T>(
  send: () => Promise<APIResponse<T>>,
  options: SendWithRetryOptions = {}
): Promise<APIResponse<T>> {
  let res = await send();

  if (shouldRetry(res)) {
    const delay = isColdBoot(res) ? COLD_BOOT_RETRY_DELAY_MS : RETRY_DELAY_MS;
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
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
