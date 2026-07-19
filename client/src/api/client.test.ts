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
