/**
 * RegisterPage — two regressions pinned in one file (they share the same
 * render scaffolding, so keeping them together avoids standing up the
 * mocks twice):
 *
 * 1. The native server-picker removal (mirrors LoginPage.test.tsx — see
 *    that file's header comment for the full "why").
 * 2. Email stays optional at registration. Nothing was broken here — every
 *    layer (this form, authStore.register, and the Go server's
 *    CreateUserRequest.Validate()) already treats a blank email as valid.
 *    This test exists so a future change that adds a `required` attribute
 *    or a presence check gets caught immediately instead of silently
 *    reintroducing a mandatory-email requirement nobody asked for.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

vi.mock("../../utils/constants", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../utils/constants");
  return {
    ...actual,
    isNativeApp: () => true,
  };
});

const registerMock = vi.fn();
vi.mock("../../api/auth", () => ({
  register: (...args: unknown[]) => registerMock(...args),
  login: vi.fn(),
  getMe: vi.fn(),
}));

// authApi.register() is the higher-level function being mocked here — its
// real implementation already parses the response into this envelope
// (apiClient<T>() does the res.json() internally), so the mock resolves
// straight to that shape rather than a raw fetch Response.
function registerSuccess() {
  return {
    success: true,
    data: {
      access_token: "t",
      refresh_token: "",
      user: { id: "1", username: "newuser1", is_platform_admin: false },
    },
  };
}

import RegisterPage from "./RegisterPage";

beforeEach(() => {
  registerMock.mockReset();
});

async function fillAndSubmit(opts: { withEmail: boolean }) {
  fireEvent.change(screen.getByLabelText(/^username/i), { target: { value: "newuser1" } });
  fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: "longenough123" } });
  fireEvent.change(screen.getByLabelText(/confirmPassword/i), { target: { value: "longenough123" } });
  if (opts.withEmail) {
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "user@example.com" } });
  }
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: /^register$/i }));
}

describe("RegisterPage — native server-picker removal", () => {
  it("never renders a server picker, even in native mode", () => {
    render(
      <MemoryRouter initialEntries={["/register"]}>
        <RegisterPage />
      </MemoryRouter>,
    );

    expect(screen.queryByText(/serverUrlPicker/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /sunucu|server/i })).not.toBeInTheDocument();
  });
});

describe("RegisterPage — email stays optional", () => {
  it("submits successfully with the email field left blank, and omits it from the request", async () => {
    registerMock.mockResolvedValue(registerSuccess());

    render(
      <MemoryRouter initialEntries={["/register"]}>
        <RegisterPage />
      </MemoryRouter>,
    );

    // No "email is required" validation error blocks this — the only two
    // client-side checks in RegisterPage.handleSubmit are password
    // match and password length, neither of which fires here.
    await fillAndSubmit({ withEmail: false });

    await waitFor(() => expect(registerMock).toHaveBeenCalledTimes(1));

    const [payload] = registerMock.mock.calls[0] as [{ email?: string }];
    // authStore.register does `email: email || undefined`, and the
    // component passes an empty string when the field was never touched —
    // either shape (absent key or `undefined` value) proves email did not
    // block or get force-required on the wire.
    expect(payload.email).toBeUndefined();
    expect(screen.queryByText(/passwordsDoNotMatch|passwordTooShort/i)).not.toBeInTheDocument();
  });

  it("still submits successfully when an email IS provided", async () => {
    registerMock.mockResolvedValue(registerSuccess());

    render(
      <MemoryRouter initialEntries={["/register"]}>
        <RegisterPage />
      </MemoryRouter>,
    );

    await fillAndSubmit({ withEmail: true });

    await waitFor(() => expect(registerMock).toHaveBeenCalledTimes(1));
    const [payload] = registerMock.mock.calls[0] as [{ email?: string }];
    expect(payload.email).toBe("user@example.com");
  });

  it("marks the email input as optional, not required", () => {
    render(
      <MemoryRouter initialEntries={["/register"]}>
        <RegisterPage />
      </MemoryRouter>,
    );

    const emailInput = screen.getByLabelText(/email/i) as HTMLInputElement;
    expect(emailInput.required).toBe(false);
  });
});
