/**
 * apiClient — X-HiChat-Client header tests.
 *
 * Why this header matters (the ".exe session doesn't persist" bug): the
 * packaged Electron renderer runs at origin app://hichat while the API is on
 * a different host, so every request is cross-site and the server must issue
 * the refresh cookie as SameSite=None or Chromium drops it at set time. The
 * server decides that from this header, and it also gates the whole
 * cookie-reading path on the header's presence (CSRF defense). So:
 *
 *   - Native shells MUST send it or their session never persists.
 *   - The WEB client MUST send it too, or the CSRF gate locks it out of the
 *     cookie path and web sessions stop refreshing.
 *   - doRefresh MUST send it — that call is the entire point of the cookie.
 *
 * constants.ts is mocked so isElectron/isCapacitor can be steered per-test
 * without a real Electron/Capacitor global.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const API_BASE_URL = "https://api.test.local/api";

const SERVER_URL = "https://api.test.local";

// Hoisted so the vi.mock factory (which is lifted above imports) can see them.
const platform = vi.hoisted(() => ({
  electron: false,
  capacitor: false,
  appProtocolPage: false,
}));

vi.mock("../utils/constants", () => ({
  API_BASE_URL: "https://api.test.local/api",
  SERVER_URL: "https://api.test.local",
  isElectron: () => platform.electron,
  isCapacitor: () => platform.capacitor,
  isAppProtocolPage: () => platform.appProtocolPage,
}));

const HEADER = "X-HiChat-Client";

/** Reads the header off a recorded fetch call, whatever shape the init took. */
function headerOf(call: unknown[] | undefined): string | undefined {
  const init = call?.[1] as RequestInit | undefined;
  const headers = (init?.headers ?? {}) as Record<string, string>;
  return headers[HEADER];
}

/** Reads the RequestInit off a recorded fetch call. */
function initOf(call: unknown[] | undefined): RequestInit | undefined {
  return call?.[1] as RequestInit | undefined;
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

/**
 * Import the module fresh for each test. client.ts holds the access token in
 * module scope, so a stale module would leak auth state between cases.
 */
async function loadClient() {
  vi.resetModules();
  return await import("./client");
}

beforeEach(() => {
  platform.electron = false;
  platform.capacitor = false;
  platform.appProtocolPage = false;
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("apiClient client-hint header", () => {
  it.each([
    { name: "web", electron: false, capacitor: false, expected: "web" },
    { name: "electron", electron: true, capacitor: false, expected: "electron" },
    { name: "capacitor", electron: false, capacitor: true, expected: "capacitor" },
  ])("sends $expected on a normal request ($name)", async ({ electron, capacitor, expected }) => {
    platform.electron = electron;
    platform.capacitor = capacitor;

    const { apiClient } = await loadClient();
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: { ok: 1 } }));

    await apiClient("/users/me");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(headerOf(fetchMock.mock.calls[0])).toBe(expected);
  });

  it("prefers electron when both detectors somehow report true", async () => {
    // Defensive: an Electron build that also loads the Capacitor shim must
    // not report the wrong shell to the server.
    platform.electron = true;
    platform.capacitor = true;

    const { apiClient } = await loadClient();
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: null }));

    await apiClient("/users/me");

    expect(headerOf(fetchMock.mock.calls[0])).toBe("electron");
  });

  it("does not let a caller's custom headers drop the client hint", async () => {
    platform.electron = true;

    const { apiClient } = await loadClient();
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: null }));

    await apiClient("/users/me", { headers: { "X-Custom": "1" } });

    const headers = initOf(fetchMock.mock.calls[0])?.headers as Record<string, string>;
    expect(headers[HEADER]).toBe("electron");
    expect(headers["X-Custom"]).toBe("1");
  });

  it("sends credentials so the refresh cookie rides along", async () => {
    const { apiClient } = await loadClient();
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: null }));

    await apiClient("/users/me");

    expect(initOf(fetchMock.mock.calls[0])?.credentials).toBe("include");
  });
});

describe("doRefresh client-hint header", () => {
  /**
   * The refresh call is the one that MUST carry the header: the server only
   * reads the refresh cookie when the header is present. Without it the
   * desktop app can never restore a session.
   */
  it.each([
    { name: "web", electron: false, capacitor: false, expected: "web" },
    { name: "electron", electron: true, capacitor: false, expected: "electron" },
    { name: "capacitor", electron: false, capacitor: true, expected: "capacitor" },
  ])("sends $expected on /auth/refresh ($name)", async ({ electron, capacitor, expected }) => {
    platform.electron = electron;
    platform.capacitor = capacitor;

    const { apiClient } = await loadClient();

    // First call 401s, triggering the refresh path, then the retry succeeds.
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ success: false }, 401))
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { access_token: "new-access", refresh_token: "" } }),
      )
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { ok: 1 } }));

    await apiClient("/users/me");

    const refreshCall = fetchMock.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("/auth/refresh"),
    );
    expect(refreshCall, "expected a /auth/refresh call").toBeDefined();
    expect(headerOf(refreshCall)).toBe(expected);
    expect(initOf(refreshCall)?.credentials).toBe("include");
  });

  it("refresh call targets the configured API base", async () => {
    const { apiClient } = await loadClient();

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ success: false }, 401))
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { access_token: "new-access", refresh_token: "" } }),
      )
      .mockResolvedValueOnce(jsonResponse({ success: true, data: null }));

    await apiClient("/users/me");

    expect(fetchMock.mock.calls[1][0]).toBe(`${API_BASE_URL}/auth/refresh`);
  });
});

describe("same-origin proxy (packaged Electron shell)", () => {
  /**
   * The HF edge answers CORS preflights itself WITHOUT
   * Access-Control-Allow-Credentials, so any credentialed preflighted fetch
   * from app://hichat dies in Chromium before reaching the server. When the
   * page runs at app://, every API call must therefore target our own
   * origin (app://hichat/api/...) — same-origin generates no preflight —
   * and carry X-HiChat-Upstream so the main-process relay knows the real
   * server. See electron/api-proxy.ts.
   */
  function enablePackagedElectron() {
    platform.electron = true;
    platform.appProtocolPage = true;
  }

  it("routes requests through app://hichat and sends the upstream header", async () => {
    enablePackagedElectron();
    const { apiClient } = await loadClient();
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: null }));

    await apiClient("/users/me");

    expect(fetchMock.mock.calls[0][0]).toBe("app://hichat/api/users/me");
    const headers = initOf(fetchMock.mock.calls[0])?.headers as Record<string, string>;
    expect(headers["X-HiChat-Upstream"]).toBe(SERVER_URL);
    // The client hint must survive alongside the routing header — the
    // server's cookie SameSite + CSRF gate still depend on it.
    expect(headers[HEADER]).toBe("electron");
    expect(initOf(fetchMock.mock.calls[0])?.credentials).toBe("include");
  });

  it("routes the refresh call through the proxy too", async () => {
    enablePackagedElectron();
    const { apiClient } = await loadClient();

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ success: false }, 401))
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { access_token: "new-access", refresh_token: "" } }),
      )
      .mockResolvedValueOnce(jsonResponse({ success: true, data: null }));

    await apiClient("/users/me");

    expect(fetchMock.mock.calls[1][0]).toBe("app://hichat/api/auth/refresh");
    const headers = initOf(fetchMock.mock.calls[1])?.headers as Record<string, string>;
    expect(headers["X-HiChat-Upstream"]).toBe(SERVER_URL);
  });

  it("does NOT proxy in the Vite-dev Electron shell (page origin is http)", async () => {
    // electron:dev loads from http://localhost:3030 where app://hichat
    // fetches would be cross-origin to an unhandled scheme — dev must keep
    // talking to the server directly.
    platform.electron = true;
    platform.appProtocolPage = false;
    const { apiClient } = await loadClient();
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: null }));

    await apiClient("/users/me");

    expect(fetchMock.mock.calls[0][0]).toBe(`${API_BASE_URL}/users/me`);
    const headers = initOf(fetchMock.mock.calls[0])?.headers as Record<string, string>;
    expect(headers["X-HiChat-Upstream"]).toBeUndefined();
  });

  it("does NOT proxy on web even if the page protocol check somehow passes", async () => {
    // Defense in depth: web builds have no main process to answer app://.
    platform.electron = false;
    platform.appProtocolPage = true;
    const { apiClient } = await loadClient();
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: null }));

    await apiClient("/users/me");

    expect(fetchMock.mock.calls[0][0]).toBe(`${API_BASE_URL}/users/me`);
  });
});

describe("apiClient timeoutMs (send-path hang guard)", () => {
  /**
   * A stalled POST used to hang forever (no AbortSignal anywhere) and froze
   * the composer, which keeps the textarea read-only while a send is in
   * flight. timeoutMs is opt-in per call site; the resulting envelope is
   * isTimeout — deliberately NOT isNetworkError, so retry helpers won't
   * auto-resend a request that may already have been persisted server-side.
   */
  it("aborts a stalled request and resolves with isTimeout", async () => {
    vi.useFakeTimers();
    try {
      const { apiClient } = await loadClient();
      fetchMock.mockImplementation(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("The operation was aborted.", "AbortError"))
            );
          })
      );

      const promise = apiClient("/servers/s/channels/c/messages", {
        method: "POST",
        body: { content: "x" },
        timeoutMs: 15_000,
      });
      await vi.advanceTimersByTimeAsync(15_001);
      const res = await promise;

      expect(res.success).toBe(false);
      expect(res.isTimeout).toBe(true);
      expect(res.isNetworkError).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("attaches no AbortSignal when timeoutMs is absent (uploads must not be cut off)", async () => {
    const { apiClient } = await loadClient();
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: null }));

    await apiClient("/users/me");

    expect(initOf(fetchMock.mock.calls[0])?.signal).toBeUndefined();
  });
});

describe("apiClient gateway error envelopes", () => {
  it.each([502, 503, 504])("preserves structured API codes on HTTP %i", async (status) => {
    const { apiClient } = await loadClient();
    fetchMock.mockResolvedValue(jsonResponse({ success: false, error: "failed to resolve YouTube track", code: "MUSIC_BOT_CHECK" }, status));
    expect(await apiClient("/servers/s/channels/c/music/play", { method: "POST" })).toEqual({
      success: false, error: "failed to resolve YouTube track", code: "MUSIC_BOT_CHECK", status,
    });
  });

  it.each([502, 503, 504])("keeps the infrastructure sentinel for an HTML HTTP %i", async (status) => {
    const { apiClient } = await loadClient();
    const response = jsonResponse({}, status);
    response.headers.set("content-type", "text/html");
    fetchMock.mockResolvedValue(response);
    expect(await apiClient("/users/me")).toEqual({ success: false, error: `service_unavailable: HTTP ${status}`, status });
  });

  it("keeps the infrastructure sentinel when a gateway advertises invalid JSON", async () => {
    const { apiClient } = await loadClient();
    const response = jsonResponse({}, 502);
    response.json = async () => { throw new SyntaxError("edge HTML mislabeled as JSON"); };
    fetchMock.mockResolvedValue(response);
    expect(await apiClient("/users/me")).toEqual({ success: false, error: "service_unavailable: HTTP 502", status: 502 });
  });
});

describe("account-scoped request cancellation", () => {
  it("does not dispatch an obsolete preference write", async () => {
    const { apiClient } = await loadClient();
    const result = await apiClient("/users/me/preferences", { method: "PATCH", isCurrent: () => false });
    expect(result).toEqual({ success: false, error: "request_cancelled" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not retry under a new account after proactive refresh", async () => {
    const { apiClient, setTokens, getAccessToken } = await loadClient();
    setTokens("expired-token", "");
    let resolve!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => { resolve = r; }));
    let current = true;
    const request = apiClient("/users/me/preferences", { method: "PATCH", body: { data: { theme: "midnight" } }, isCurrent: () => current });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    current = false;
    setTokens("new-account-token", "");
    resolve(jsonResponse({ success: true, data: { access_token: "old-account-refresh" } }));
    expect(await request).toEqual({ success: false, error: "request_cancelled" });
    expect(getAccessToken()).toBe("new-account-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 401 under a replacement account", async () => {
    const { apiClient, setTokens, getAccessToken } = await loadClient();
    let resolve!: (response: Response) => void;
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: false }, 401));
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => { resolve = r; }));
    let current = true;
    const request = apiClient("/users/me/preferences", { method: "PATCH", isCurrent: () => current });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    current = false;
    setTokens("new-account-token", "");
    resolve(jsonResponse({ success: false }, 401));
    expect(await request).toEqual({ success: false, error: "request_cancelled" });
    expect(getAccessToken()).toBe("new-account-token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not restore credentials when a refresh finishes after logout", async () => {
    const { apiClient, setTokens, clearTokens, getAccessToken } = await loadClient();
    setTokens("expired-token", "");
    let resolve!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => { resolve = r; }));
    const controller = new AbortController();
    const request = apiClient("/users/me/preferences", { signal: controller.signal });
    controller.abort();
    clearTokens();
    resolve(jsonResponse({ success: true, data: { access_token: "old-refreshed-token" } }));
    expect((await request).error).toBe("request_cancelled");
    expect(getAccessToken()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("combines caller abort with timeout without labelling it a timeout", async () => {
    const { apiClient } = await loadClient();
    fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const controller = new AbortController();
    const request = apiClient("/users/me/preferences", { signal: controller.signal, timeoutMs: 15000 });
    controller.abort();
    expect(await request).toEqual({ success: false, error: "request_cancelled" });
  });
});

describe("bounded request and shared-refresh lifetimes", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it.each(["proactive", "401"] as const)("settles caller abort while a %s refresh remains hung", async (mode) => {
    const { apiClient, setTokens } = await loadClient();
    if (mode === "proactive") setTokens("expired-token", "");
    else fetchMock.mockResolvedValueOnce(jsonResponse({ success: false }, 401));
    // Intentionally ignores AbortSignal: the caller must settle independently.
    fetchMock.mockImplementationOnce(() => new Promise<Response>(() => {}));
    const controller = new AbortController();
    const request = apiClient("/users/me/preferences", { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    const refresh = fetchMock.mock.calls.find((call) => String(call[0]).endsWith("/auth/refresh"));
    expect(refresh).toBeDefined();

    controller.abort();
    expect(await request).toEqual({ success: false, error: "request_cancelled" });
    expect(initOf(refresh)?.signal?.aborted).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(mode === "proactive" ? 1 : 2);
  });

  it.each(["proactive", "401"] as const)("bounds the caller's wait for a hung %s refresh", async (mode) => {
    const { apiClient, setTokens } = await loadClient();
    if (mode === "proactive") setTokens("expired-token", "");
    else fetchMock.mockResolvedValueOnce(jsonResponse({ success: false }, 401));
    fetchMock.mockImplementationOnce(() => new Promise<Response>(() => {}));
    const request = apiClient("/users/me/preferences", { timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect(await request).toEqual({ success: false, error: "timeout", isTimeout: true });
    const refresh = fetchMock.mock.calls.find((call) => String(call[0]).endsWith("/auth/refresh"));
    // Its own finite timeout still applies, but this caller cannot kill it.
    expect(initOf(refresh)?.signal?.aborted).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(mode === "proactive" ? 1 : 2);
  });

  it.each(["abort", "timeout"] as const)("keeps a shared refresh alive for another consumer after one caller's %s", async (stop) => {
    const { apiClient, setTokens, getAccessToken } = await loadClient();
    setTokens("expired-token", "");
    const refresh = deferred<Response>();
    fetchMock.mockImplementation((url: string) => url.endsWith("/auth/refresh")
      ? refresh.promise
      : Promise.resolve(jsonResponse({ success: true, data: "second-consumer" })));
    const controller = new AbortController();
    const first = apiClient("/first", { signal: controller.signal, timeoutMs: 100 });
    const second = apiClient("/second", { timeoutMs: 1000 });
    if (stop === "abort") controller.abort();
    else await vi.advanceTimersByTimeAsync(100);
    expect(await first).toEqual(stop === "abort"
      ? { success: false, error: "request_cancelled" }
      : { success: false, error: "timeout", isTimeout: true });
    expect(initOf(fetchMock.mock.calls[0])?.signal?.aborted).toBe(false);

    refresh.resolve(jsonResponse({ success: true, data: { access_token: "fresh-shared-token" } }));
    expect(await second).toEqual({ success: true, data: "second-consumer", status: 200 });
    expect(getAccessToken()).toBe("fresh-shared-token");
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      `${API_BASE_URL}/auth/refresh`, `${API_BASE_URL}/second`,
    ]);
    expect((initOf(fetchMock.mock.calls[1])?.headers as Record<string, string>).Authorization).toBe("Bearer fresh-shared-token");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([200, 503])("bounds a stalled HTTP %i JSON body using the original request deadline", async (status) => {
    const { apiClient } = await loadClient();
    const response = jsonResponse({}, status);
    response.json = vi.fn(() => new Promise(() => {}));
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => {
      setTimeout(() => resolve(response), 40);
    }));
    let settled = false;
    const request = apiClient("/users/me/preferences", { timeoutMs: 100 });
    void request.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(99);
    expect(response.json).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await request).toEqual({ success: false, error: "timeout", isTimeout: true });
    expect(initOf(fetchMock.mock.calls[0])?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles caller abort after headers while JSON decoding is stalled", async () => {
    const { apiClient } = await loadClient();
    const response = jsonResponse({});
    response.json = vi.fn(() => new Promise(() => {}));
    fetchMock.mockResolvedValue(response);
    const controller = new AbortController();
    const request = apiClient("/users/me/preferences", { signal: controller.signal, timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(response.json).toHaveBeenCalledTimes(1);
    controller.abort();
    expect(await request).toEqual({ success: false, error: "request_cancelled" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses one deadline across initial fetch, refresh and retry instead of restarting the budget", async () => {
    const { apiClient } = await loadClient();
    const responses = [
      jsonResponse({ success: false }, 401),
      jsonResponse({ success: true, data: { access_token: "fresh" } }),
      jsonResponse({ success: true, data: "too late" }),
    ];
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => {
      const next = responses.shift()!;
      setTimeout(() => resolve(next), 40);
    }));
    let settled = false;
    const request = apiClient("/users/me/preferences", { timeoutMs: 100 });
    void request.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(99);
    expect(settled).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(await request).toEqual({ success: false, error: "timeout", isTimeout: true });
    expect(initOf(fetchMock.mock.calls[2])?.signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(40);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["headers", "body"] as const)("times out shared refresh %s, releases the lock, and ignores late credentials", async (phase) => {
    const { ensureFreshToken, setTokens, getAccessToken } = await loadClient();
    setTokens("expired-token", "");
    const delayedHeaders = deferred<Response>();
    const delayedBody = deferred<unknown>();
    if (phase === "headers") fetchMock.mockReturnValueOnce(delayedHeaders.promise);
    else {
      const response = jsonResponse({});
      response.json = () => delayedBody.promise;
      fetchMock.mockResolvedValueOnce(response);
    }
    const first = ensureFreshToken();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await first).toBeNull();
    expect(getAccessToken()).toBe("expired-token");
    expect(initOf(fetchMock.mock.calls[0])?.signal?.aborted).toBe(true);

    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: { access_token: "fresh-current-token" } }));
    expect(await ensureFreshToken()).toBe("fresh-current-token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const staleBody = { success: true, data: { access_token: "late-obsolete-token" } };
    if (phase === "headers") delayedHeaders.resolve(jsonResponse(staleBody));
    else delayedBody.resolve(staleBody);
    await vi.advanceTimersByTimeAsync(0);
    expect(getAccessToken()).toBe("fresh-current-token");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not replay credential or one-time-factor rejections through refresh", async () => {
    const { apiClient, setTokens } = await loadClient();
    setTokens("expired-token", "", "a");
    fetchMock.mockResolvedValue(jsonResponse({ success: false, code: "MFA_REQUIRED" }, 401));
    const result = await apiClient("/auth/login", { method: "POST", body: { username: "a", password: "test" }, skipAuthRefresh: true });
    expect(result.code).toBe("MFA_REQUIRED"); expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockClear(); setTokens(`x.${btoa(JSON.stringify({ exp: Date.now()/1000+3600 }))}.x`, "", "a");
    await apiClient("/users/me/mfa/confirm", { method: "POST", body: { code: "123456" }, retryUnauthorized: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("binds refresh to the displayed account and rejects a different returned owner", async () => {
    const { ensureFreshToken, setTokens, getAccessToken } = await loadClient();
    setTokens("expired-token", "", "a");
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: { access_token: "b-token", user: { id: "b" } } }));
    expect(await ensureFreshToken()).toBeNull();
    expect(JSON.parse(initOf(fetchMock.mock.calls[0])!.body as string)).toEqual({ expected_user_id: "a" });
    expect(getAccessToken()).toBe("expired-token");
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: { access_token: "a-token", user: { id: "a" } } }));
    expect(await ensureFreshToken()).toBe("a-token");
  });

  it("learns cookie owner on cold restore and constrains later refreshes", async () => {
    const { ensureFreshToken, getAccessToken, setTokens } = await loadClient();
    setTokens("expired-token", "");
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: { access_token: "expired-token", user: { id: "restored" } } }));
    expect(await ensureFreshToken()).toBe("expired-token");
    expect(JSON.parse(initOf(fetchMock.mock.calls[0])!.body as string)).toEqual({});
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: false, code: "ACCOUNT_MISMATCH" }, 409));
    expect(await ensureFreshToken()).toBeNull();
    expect(JSON.parse(initOf(fetchMock.mock.calls[1])!.body as string)).toEqual({ expected_user_id: "restored" });
    expect(getAccessToken()).toBe("expired-token");
  });

  it.each(["logout", "replacement"] as const)("does not apply stale credentials if %s happens during refresh JSON decoding", async (change) => {
    const { ensureFreshToken, setTokens, clearTokens, getAccessToken } = await loadClient();
    setTokens("expired-token", "");
    const delayed = deferred<unknown>();
    const response = jsonResponse({});
    response.json = vi.fn(() => delayed.promise);
    fetchMock.mockResolvedValueOnce(response);
    const request = ensureFreshToken();
    await vi.advanceTimersByTimeAsync(0);
    expect(response.json).toHaveBeenCalledTimes(1);
    if (change === "logout") clearTokens();
    else setTokens("replacement-account-token", "");
    delayed.resolve({ success: true, data: { access_token: "old-account-token" } });
    expect(await request).toBeNull();
    expect(getAccessToken()).toBe(change === "logout" ? null : "replacement-account-token");
  });
});
