/**
 * App route-guard tests — boot-time routing decisions on /channels:
 *
 *   a. getMe pending  → auth spinner, no /login bounce.
 *   b. getMe success  → AppLayout renders, never the login page.
 *   c. getMe hard 401 → definitive rejection routes to /login.
 *   d. getMe service_unavailable → initPhase "waking" keeps the spinner
 *      up with the serverWaking caption (QA 2026-05-28 bug #1: a HF cold
 *      start must not bounce a logged-in user to /login).
 *
 * Mock set matches authStore.test.ts; lazy route chunks are stubbed so
 * the tests exercise App's own guard logic, not the page internals.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// t() returns the key — assertions query by i18n key, independent of
// locale text. initReactI18next is needed because the real src/i18n
// module (pulled in by authStore) registers it as an i18next plugin.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

vi.mock("./api/auth", () => ({
  getMe: vi.fn(),
  login: vi.fn(),
  register: vi.fn(),
  logout: vi.fn(),
}));
vi.mock("./api/client", () => ({
  setTokens: vi.fn(),
  clearTokens: vi.fn(),
}));
vi.mock("./api/clientLog", () => ({
  logToServer: vi.fn(),
}));
vi.mock("./utils/serverProbe", () => ({
  pingServer: vi.fn(async () => true),
}));
vi.mock("./stores/preferencesStore", () => ({
  usePreferencesStore: {
    getState: () => ({ fetchAndApply: vi.fn(), reset: vi.fn() }),
  },
}));
vi.mock("./stores/voiceStore", () => ({
  useVoiceStore: {
    getState: () => ({ currentVoiceChannelId: null, leaveVoiceChannel: vi.fn() }),
  },
}));
vi.mock("./stores/e2eeStore", () => ({
  useE2EEStore: { getState: () => ({ reset: vi.fn(async () => {}) }) },
}));
// App consumes settingsStore as a hook — a minimal REAL zustand store keeps
// selector subscriptions working (pattern from SearchPanel.test.tsx).
vi.mock("./stores/settingsStore", async () => {
  const { create } = await vi.importActual<typeof import("zustand")>("zustand");
  return {
    useSettingsStore: create(() => ({
      blurEnabled: false,
      transparentBackground: false,
      closeSettings: vi.fn(),
    })),
  };
});

// Chrome around the routes — irrelevant to guard behavior.
vi.mock("./components/layout/CustomTitleBar", () => ({ default: () => null }));
vi.mock("./components/shared/UpdateBanner", () => ({ default: () => null }));

// The only lazy route chunks these tests can reach. Stubs resolve
// instantly, so Suspense settles within findByText's waitFor.
vi.mock("./components/auth/LoginPage", () => ({
  default: () => <div>login-page</div>,
}));
vi.mock("./components/layout/AppLayout", () => ({
  default: () => <div>app-layout</div>,
}));

import App from "./App";
import { useAuthStore } from "./stores/authStore";
import * as authApi from "./api/auth";
import type { User } from "./types";

const getMe = vi.mocked(authApi.getMe);
const fakeUser = { id: "u1", username: "alice", language: "en" } as User;

function renderApp() {
  return render(
    <MemoryRouter initialEntries={["/channels"]}>
      <App />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({
    user: null,
    isLoading: false,
    error: null,
    isInitialized: false,
    initPhase: "idle",
  });
});

describe("App — route guards", () => {
  it("shows the boot spinner while getMe is pending, without a /login bounce", () => {
    getMe.mockReturnValue(new Promise<never>(() => {})); // never resolves
    renderApp();

    expect(screen.getByText("loading")).toBeInTheDocument();
    expect(screen.queryByText("login-page")).not.toBeInTheDocument();
  });

  it("renders the app layout on /channels when getMe succeeds", async () => {
    getMe.mockResolvedValue({ success: true, data: fakeUser });
    renderApp();

    expect(await screen.findByText("app-layout")).toBeInTheDocument();
    expect(screen.queryByText("login-page")).not.toBeInTheDocument();
  });

  it("routes to /login on a definitive auth rejection", async () => {
    getMe.mockResolvedValue({ success: false, error: "unauthorized" });
    renderApp();

    expect(await screen.findByText("login-page")).toBeInTheDocument();
    expect(screen.queryByText("app-layout")).not.toBeInTheDocument();
  });

  // Kept last: initialize()'s wake-up backoff holds a real 2s timer past
  // this test's assertions; no later test in this file can be affected
  // by its eventual retry.
  it("keeps the spinner with the serverWaking caption during a cold start", async () => {
    getMe.mockResolvedValue({ success: false, error: "service_unavailable: HTTP 503" });
    renderApp();

    expect(await screen.findByText("serverWaking")).toBeInTheDocument();
    expect(screen.queryByText("login-page")).not.toBeInTheDocument();
    expect(useAuthStore.getState().initPhase).toBe("waking");
  });
});
