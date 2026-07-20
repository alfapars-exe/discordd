/**
 * RegisterPage — post-registration auto-join.
 *
 * When a user registers via an invite link (`returnUrl=/invite/{code}`),
 * RegisterPage should join that server automatically instead of bouncing
 * the user back to the invite page to click "Join" a second time. These
 * tests pin the three outcomes that matter security- and UX-wise:
 *   - success: joins, lands on /channels
 *   - partial failure: account exists but join failed — redirect back to
 *     the invite page WITHOUT re-submitting registration (rate limits,
 *     duplicate accounts)
 *   - malicious returnUrl: never trusted, falls back to /channels and
 *     never attempts a join
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import type { Server } from "../../types";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../../api/servers", () => ({
  joinServer: vi.fn(),
}));

vi.mock("../../stores/authStore", async () => {
  const { create } = await import("zustand");
  return {
    useAuthStore: create(() => ({
      register: vi.fn(async () => true),
      isLoading: false,
      error: null as string | null,
      clearError: vi.fn(),
    })),
  };
});

vi.mock("../../stores/serverStore", async () => {
  const { create } = await import("zustand");
  return {
    useServerStore: create(() => ({
      servers: [] as { id: string; name: string; icon_url: string | null }[],
      activeServerId: null as string | null,
      activeServer: null as Server | null,
    })),
  };
});

vi.mock("../../stores/toastStore", async () => {
  const { create } = await import("zustand");
  return {
    useToastStore: create(() => ({ addToast: vi.fn() })),
  };
});

import RegisterPage from "./RegisterPage";
import { useAuthStore } from "../../stores/authStore";
import { useServerStore } from "../../stores/serverStore";
import { useToastStore } from "../../stores/toastStore";
import * as serversApi from "../../api/servers";

const joinServerMock = vi.mocked(serversApi.joinServer);

const INVITE_CODE = "0123456789abcdef";

const fakeServer: Server = {
  id: "srv1",
  name: "Test Server",
  icon_url: null,
  owner_id: "u-owner",
  invite_required: true,
  e2ee_enabled: false,
  livekit_instance_id: null,
  afk_timeout_minutes: 0,
  member_count: 5,
  created_at: "2026-01-01T00:00:00Z",
};

function renderRegisterPage(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/channels" element={<div data-testid="channels-page" />} />
        <Route path="/invite/:code" element={<div data-testid="invite-page" />} />
      </Routes>
    </MemoryRouter>
  );
}

function fillAndSubmit() {
  fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "alice123" } });
  fireEvent.change(document.getElementById("password") as HTMLInputElement, {
    target: { value: "password123" },
  });
  fireEvent.change(document.getElementById("confirmPassword") as HTMLInputElement, {
    target: { value: "password123" },
  });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "register" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ register: vi.fn(async () => true), isLoading: false, error: null });
  useServerStore.setState({ servers: [], activeServerId: null, activeServer: null });
});

describe("RegisterPage — invite auto-join", () => {
  it("joins the invite server and lands on /channels on success", async () => {
    joinServerMock.mockResolvedValue({ success: true, data: fakeServer });
    renderRegisterPage(`/register?returnUrl=/invite/${INVITE_CODE}`);

    await fillAndSubmit();

    await waitFor(() => {
      expect(screen.getByTestId("channels-page")).toBeInTheDocument();
    });
    expect(joinServerMock).toHaveBeenCalledWith(INVITE_CODE);
    expect(useAuthStore.getState().register).toHaveBeenCalledTimes(1);
    expect(useServerStore.getState().activeServerId).toBe("srv1");
    expect(useServerStore.getState().servers).toContainEqual({
      id: "srv1",
      name: "Test Server",
      icon_url: null,
    });
    expect(useToastStore.getState().addToast).toHaveBeenCalledWith("success", "serverJoined");
  });

  it("redirects to the invite page and never re-submits registration when join fails", async () => {
    joinServerMock.mockResolvedValue({ success: false, error: "invite not found" });
    renderRegisterPage(`/register?returnUrl=/invite/${INVITE_CODE}`);

    await fillAndSubmit();

    await waitFor(() => {
      expect(screen.getByTestId("invite-page")).toBeInTheDocument();
    });
    expect(joinServerMock).toHaveBeenCalledWith(INVITE_CODE);
    // Account was already created — register must NOT be POSTed a second time.
    expect(useAuthStore.getState().register).toHaveBeenCalledTimes(1);
    expect(useToastStore.getState().addToast).toHaveBeenCalledWith("error", "joinAfterRegisterFailed");
  });

  it("routes to /channels (not re-registering) when already a member", async () => {
    joinServerMock.mockResolvedValue({ success: false, error: "already a member" });
    renderRegisterPage(`/register?returnUrl=/invite/${INVITE_CODE}`);

    await fillAndSubmit();

    await waitFor(() => {
      expect(screen.getByTestId("channels-page")).toBeInTheDocument();
    });
    expect(useAuthStore.getState().register).toHaveBeenCalledTimes(1);
    expect(useToastStore.getState().addToast).toHaveBeenCalledWith("info", "alreadyMember");
  });

  it("never joins on a malicious returnUrl and falls back to /channels", async () => {
    renderRegisterPage("/register?returnUrl=https://evil.example");

    await fillAndSubmit();

    await waitFor(() => {
      expect(screen.getByTestId("channels-page")).toBeInTheDocument();
    });
    expect(joinServerMock).not.toHaveBeenCalled();
  });

  it("never joins on a protocol-relative returnUrl and falls back to /channels", async () => {
    renderRegisterPage("/register?returnUrl=//evil.example");

    await fillAndSubmit();

    await waitFor(() => {
      expect(screen.getByTestId("channels-page")).toBeInTheDocument();
    });
    expect(joinServerMock).not.toHaveBeenCalled();
  });
});
