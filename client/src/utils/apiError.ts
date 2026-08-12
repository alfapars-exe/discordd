/**
 * apiError — centralized classification of failed API responses into
 * i18n-ready toast payloads, plus a showApiError() helper that fires the
 * toast in one call.
 *
 * apiClient() never throws (see src/api/client.ts) — every failure comes
 * back as an `APIResponse` with `success: false`. Historically call sites
 * showed `res.error` (the raw backend string) directly in a toast, which
 * leaks English developer-facing text into the Turkish UI. classifyApiError
 * maps the response shape to a { variant, titleKey?, messageKey, values? }
 * triple instead, so callers render localized copy.
 *
 * Priority order (first match wins):
 *   1. Auth-specific message patterns (regex over res.error, reusing
 *      authErrors.ts) — these are more specific than a generic bucket and
 *      already have dedicated `auth` namespace copy (invalidCredentials,
 *      usernameTaken, sessionExpired, ...).
 *   2. res.code — machine-readable backend error code. Optional: populated
 *      by newer backend handlers only (parallel work), so read defensively
 *      and fall through when absent. When code is "INTERNAL" and
 *      res.correlation_id is present, the message is swapped for a variant
 *      that appends the correlation id as a short support reference.
 *   3. res.status — HTTP status code.
 *   4. res.isNetworkError — fetch threw / offline / DNS failure.
 *   5. Fallback: generic "unknown" error.
 */

import type { APIResponse } from "../types";
import i18n from "../i18n";
import { AUTH_ERROR_PATTERNS } from "./authErrors";
import { useToastStore, type ToastAction } from "../stores/toastStore";

export type ErrorVariant = "success" | "error" | "warning" | "info";

export type ClassifiedError = {
  variant: ErrorVariant;
  /** Namespaced i18n key ("ns:key") for an optional toast title. */
  titleKey?: string;
  /** Namespaced i18n key ("ns:key") for the toast body. */
  messageKey: string;
  /** Interpolation values passed through to t(messageKey, values). */
  values?: Record<string, unknown>;
};

/**
 * i18next's key-type checking only covers the `errors` namespace (see
 * types/resources.d.ts); every other namespace is a loose Record<string,
 * string> specifically so dynamically-computed keys like the ones this
 * module builds (`` `${ns}:${key}` ``) keep compiling. This local alias
 * documents that intentional widening at the one place it's needed instead
 * of sprinkling casts through the file.
 */
const t = i18n.t.bind(i18n) as (key: string, options?: Record<string, unknown>) => string;

/** Toast variant for each auth-specific pattern key in AUTH_ERROR_PATTERNS. */
const AUTH_KEY_VARIANT: Record<string, ErrorVariant> = {
  invalidCredentials: "warning",
  sessionExpired: "error",
  usernameTaken: "warning",
  emailTaken: "warning",
  invalidEmail: "warning",
  passwordTooShort: "warning",
  currentPasswordIncorrect: "warning",
  invalidOrExpiredToken: "warning",
  passwordResetNotConfigured: "error",
  networkError: "warning",
  serverMaintenance: "warning",
};

type Bucket = { variant: ErrorVariant; key: string };

/** Backend error code (optional, see APIResponse.code) → generic bucket. */
function classifyByCode(code: string): Bucket | null {
  switch (code) {
    case "NOT_FOUND":
      return { variant: "warning", key: "notFound" };
    case "UNAUTHORIZED":
      return { variant: "error", key: "unauthorized" };
    case "FORBIDDEN":
      return { variant: "error", key: "forbidden" };
    case "ALREADY_EXISTS":
    case "CONFLICT":
      return { variant: "warning", key: "conflict" };
    case "BAD_REQUEST":
    case "VALIDATION_FAILED":
      return { variant: "warning", key: "validation" };
    case "INVALID_KEY":
      return { variant: "warning", key: "invalidKey" };
    case "RATE_LIMITED":
      return { variant: "warning", key: "rateLimited" };
    case "PAYLOAD_TOO_LARGE":
      return { variant: "warning", key: "payloadTooLarge" };
    case "INTERNAL":
      return { variant: "error", key: "server" };
    default:
      return null;
  }
}

/** HTTP status → generic bucket, used when res.code is absent/unrecognized. */
function classifyByStatus(status: number): Bucket {
  switch (status) {
    case 400:
    case 422:
      return { variant: "warning", key: "validation" };
    case 401:
      return { variant: "error", key: "unauthorized" };
    case 403:
      return { variant: "error", key: "forbidden" };
    case 404:
      return { variant: "warning", key: "notFound" };
    case 409:
      return { variant: "warning", key: "conflict" };
    case 429:
      return { variant: "warning", key: "rateLimited" };
    case 413:
      return { variant: "warning", key: "payloadTooLarge" };
    default:
      return status >= 500
        ? { variant: "error", key: "server" }
        : { variant: "error", key: "unknown" };
  }
}

/**
 * Classifies a (typically failed) APIResponse into a localizable toast
 * payload. Callers translate `messageKey`/`titleKey` themselves — see
 * showApiError() below for the common "translate + toast" path.
 */
export function classifyApiError(res: APIResponse<unknown>): ClassifiedError {
  if (res.success) {
    return { variant: "success", messageKey: "common:success" };
  }

  if (res.error) {
    for (const [pattern, key] of AUTH_ERROR_PATTERNS) {
      if (pattern.test(res.error)) {
        return { variant: AUTH_KEY_VARIANT[key] ?? "error", messageKey: `auth:${key}` };
      }
    }
  }

  if (res.code) {
    const byCode = classifyByCode(res.code);
    if (byCode) {
      // INTERNAL errors carry a server-generated correlation_id (5xx only) —
      // surface it as a short reference so a user can quote it in a support
      // report instead of the raw (deliberately generic) server message.
      if (res.code === "INTERNAL" && res.correlation_id) {
        return {
          variant: byCode.variant,
          titleKey: `errors:${byCode.key}Title`,
          messageKey: "errors:serverCorrelation",
          values: { correlationId: res.correlation_id },
        };
      }
      return {
        variant: byCode.variant,
        titleKey: `errors:${byCode.key}Title`,
        messageKey: `errors:${byCode.key}`,
      };
    }
  }

  if (typeof res.status === "number") {
    const byStatus = classifyByStatus(res.status);
    return {
      variant: byStatus.variant,
      titleKey: `errors:${byStatus.key}Title`,
      messageKey: `errors:${byStatus.key}`,
    };
  }

  if (res.isNetworkError) {
    return { variant: "warning", titleKey: "errors:networkTitle", messageKey: "errors:network" };
  }

  return { variant: "error", titleKey: "errors:unknownTitle", messageKey: "errors:unknown" };
}

export type ShowApiErrorOptions = {
  /**
   * Site-specific override for the toast message key (namespaced, e.g.
   * "settings:platformLogsLoadError") — wins over the classifier's generic
   * bucket message. Use this where the call site already has a more
   * contextual, existing i18n key so it isn't lost in the migration to
   * showApiError.
   */
  fallbackKey?: string;
  /** Overrides the classifier's title (or supplies one when it has none). */
  title?: string;
  /** Forwarded to addToast — 0/null makes the toast persistent. */
  duration?: number | null;
  action?: ToastAction;
  /** Interpolation values for fallbackKey or the classified messageKey. */
  values?: Record<string, unknown>;
};

/**
 * Classifies `res` and fires the resulting toast in one call — the common
 * path for the ~40 call sites that used to do
 * `addToast("error", res.error ?? t("someFallback"))`.
 */
export function showApiError(res: APIResponse<unknown>, options: ShowApiErrorOptions = {}): void {
  const classified = classifyApiError(res);
  const messageKey = options.fallbackKey ?? classified.messageKey;
  const message = t(messageKey, { ...classified.values, ...options.values });
  const title = options.title ?? (classified.titleKey ? t(classified.titleKey) : undefined);

  useToastStore.getState().addToast(classified.variant, message, options.duration, {
    title,
    action: options.action,
  });
}
