/**
 * RegisterPage — two regressions pinned in one file (they share the same
 * render scaffolding, so keeping them together avoids standing up the
 * mocks twice):
 *
 * 1. The native server-picker removal (mirrors LoginPage.test.tsx — see
 *    that file's header comment for the full "why").
 * 2. New registrations require email. Exercise form validation and the real
 *    auth-store registration path with deterministic API boundaries.
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

// Registration starts preference hydration in the background. Keep that API
// deterministic and await its completion so it cannot outlive this test file.
vi.mock("../../api/preferences", () => ({
  getPreferences: vi.fn(async () => ({ success: true, data: { user_id: "1", data: {} } })),
  updatePreferences: vi.fn(async () => ({ success: true, data: { user_id: "1", data: {} } })),
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
import { usePreferencesStore } from "../../stores/preferencesStore";

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

describe("RegisterPage — email is required", () => {
	it("does not submit when the email field is blank", async () => {
    registerMock.mockResolvedValue(registerSuccess());

    render(
      <MemoryRouter initialEntries={["/register"]}>
        <RegisterPage />
      </MemoryRouter>,
    );

		await fillAndSubmit({ withEmail: false });
		expect(screen.getByLabelText(/email/i)).toBeInvalid();
		expect(registerMock).not.toHaveBeenCalled();
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
    await usePreferencesStore.getState().fetchAndApply();
    expect(usePreferencesStore.getState().isLoaded).toBe(true);
  });

	it("marks the email input as required", () => {
    render(
      <MemoryRouter initialEntries={["/register"]}>
        <RegisterPage />
      </MemoryRouter>,
    );

    const emailInput = screen.getByLabelText(/email/i) as HTMLInputElement;
		expect(emailInput.required).toBe(true);
  });
});
