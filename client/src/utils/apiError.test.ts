/**
 * apiError — classifyApiError / showApiError unit tests.
 *
 * i18n is mocked to the identity function (returns the key) so assertions
 * can check exactly which namespaced key was resolved, mirroring the
 * pattern used by sendWithRetry.test.ts for the same "../i18n" module.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { APIResponse } from "../types";

const addToast = vi.fn();
vi.mock("../stores/toastStore", () => ({
  useToastStore: { getState: () => ({ addToast }) },
}));

vi.mock("../i18n", () => ({
  default: {
    t: (key: string, options?: Record<string, unknown>) =>
      options && Object.keys(options).length > 0 ? `${key}:${JSON.stringify(options)}` : key,
  },
}));

import { classifyApiError, showApiError } from "./apiError";

function fail(overrides: Partial<APIResponse<unknown>> = {}): APIResponse<unknown> {
  return { success: false, ...overrides };
}

describe("classifyApiError", () => {
  it("classifies a 2xx response as success", () => {
    const res = classifyApiError({ success: true, data: {} });
    expect(res.variant).toBe("success");
  });

  it("prefers res.code over res.status when both are present", () => {
    const res = classifyApiError(fail({ code: "RATE_LIMITED", status: 500 }));
    expect(res.variant).toBe("warning");
    expect(res.messageKey).toBe("errors:rateLimited");
  });

  it("falls back to res.status when res.code is absent", () => {
    const res = classifyApiError(fail({ status: 404 }));
    expect(res.variant).toBe("warning");
    expect(res.messageKey).toBe("errors:notFound");
    expect(res.titleKey).toBe("errors:notFoundTitle");
  });

  it("falls back to res.status when res.code is unrecognized", () => {
    const res = classifyApiError(fail({ code: "SOME_FUTURE_CODE", status: 409 }));
    expect(res.messageKey).toBe("errors:conflict");
  });

  it("classifies 429 as warning", () => {
    const res = classifyApiError(fail({ status: 429 }));
    expect(res.variant).toBe("warning");
    expect(res.messageKey).toBe("errors:rateLimited");
  });

  it("classifies any 5xx as error", () => {
    expect(classifyApiError(fail({ status: 500 })).variant).toBe("error");
    expect(classifyApiError(fail({ status: 503 })).variant).toBe("error");
    expect(classifyApiError(fail({ status: 500 })).messageKey).toBe("errors:server");
  });

  it("classifies isNetworkError as warning when no status is present", () => {
    const res = classifyApiError(fail({ isNetworkError: true }));
    expect(res.variant).toBe("warning");
    expect(res.messageKey).toBe("errors:network");
  });

  it("falls back to a generic unknown error when nothing else matches", () => {
    const res = classifyApiError(fail());
    expect(res.variant).toBe("error");
    expect(res.messageKey).toBe("errors:unknown");
  });

  it("prioritizes auth-specific message patterns over status/code", () => {
    const res = classifyApiError(
      fail({ error: "unauthorized: invalid username or password", status: 401 }),
    );
    expect(res.messageKey).toBe("auth:invalidCredentials");
    expect(res.variant).toBe("warning");
  });

  it("maps the sessionExpired auth pattern to the error variant", () => {
    const res = classifyApiError(fail({ error: "unauthorized: invalid refresh token" }));
    expect(res.messageKey).toBe("auth:sessionExpired");
    expect(res.variant).toBe("error");
  });

  it("maps usernameTaken (register flow) to warning", () => {
    const res = classifyApiError(fail({ error: "username already taken", status: 409 }));
    expect(res.messageKey).toBe("auth:usernameTaken");
    expect(res.variant).toBe("warning");
  });
});

describe("showApiError", () => {
  beforeEach(() => {
    addToast.mockReset();
  });

  it("fires a toast with the classifier's variant, message, and title", () => {
    showApiError(fail({ status: 429 }));
    expect(addToast).toHaveBeenCalledTimes(1);
    const [variant, message, duration, options] = addToast.mock.calls[0]!;
    expect(variant).toBe("warning");
    expect(message).toBe("errors:rateLimited");
    expect(duration).toBeUndefined();
    expect(options.title).toBe("errors:rateLimitedTitle");
  });

  it("uses a site-specific fallbackKey instead of the classifier's generic message", () => {
    showApiError(fail({ status: 500 }), { fallbackKey: "settings:platformLogsLoadError" });
    const [, message] = addToast.mock.calls[0]!;
    expect(message).toBe("settings:platformLogsLoadError");
  });

  it("still uses the classifier's title even when fallbackKey overrides the message", () => {
    showApiError(fail({ status: 500 }), { fallbackKey: "settings:platformLogsLoadError" });
    const [, , , options] = addToast.mock.calls[0]!;
    expect(options.title).toBe("errors:serverTitle");
  });

  it("forwards duration and action through to addToast", () => {
    const action = { label: "Retry", onClick: () => {} };
    showApiError(fail({ status: 500 }), { duration: 0, action });
    const [, , duration, options] = addToast.mock.calls[0]!;
    expect(duration).toBe(0);
    expect(options.action).toBe(action);
  });
});
