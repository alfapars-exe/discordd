/**
 * SecuritySettings — password-change regression pins.
 *
 * The change-password feature was silently broken end-to-end: the server
 * (POST /api/users/me/password) 400s without `current_password`, but the
 * client never asked for it or sent it. These tests pin (1) the request
 * body includes current_password, and (2) a server "incorrect" rejection
 * renders as the wrongCurrentPassword toast, not the generic one.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

const mockChangePassword = vi.fn();

vi.mock("../../api/auth", () => ({
  changePassword: (...args: unknown[]) => mockChangePassword(...args),
  changeEmail: vi.fn(),
}));

vi.mock("../../stores/authStore", async () => {
  const { create } = await import("zustand");
  return {
    useAuthStore: create(() => ({
      user: { id: "u-1", email: "user@example.com" },
      updateUser: vi.fn(),
    })),
  };
});

// addToast is created INSIDE the factory (not a closed-over outer const) —
// referencing an outer `const mockAddToast` here would throw
// "Cannot access before initialization": vi.mock factories run as part of
// module resolution, which happens before this file's own top-level
// statements (ES import ordering), so an outer const wouldn't be
// initialized yet. Assertions read the spy back via
// useToastStore.getState().addToast instead.
vi.mock("../../stores/toastStore", async () => {
  const { create } = await import("zustand");
  return {
    useToastStore: create(() => ({ addToast: vi.fn() })),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import SecuritySettings from "./SecuritySettings";
import { useToastStore } from "../../stores/toastStore";

beforeEach(() => {
  mockChangePassword.mockReset();
  useToastStore.setState({ addToast: vi.fn() });
});

/** Fills the three password-section fields and clicks submit. */
async function fillAndSubmitPasswordForm(current: string, next: string, confirm: string) {
  const currentInput = screen.getByPlaceholderText("currentPasswordPlaceholder");
  const newInput = screen.getByPlaceholderText("newPasswordPlaceholder");
  const confirmInput = screen.getByPlaceholderText("confirmNewPasswordPlaceholder");

  await act(async () => {
    fireEvent.change(currentInput, { target: { value: current } });
    fireEvent.change(newInput, { target: { value: next } });
    fireEvent.change(confirmInput, { target: { value: confirm } });
  });

  const submitButtons = screen.getAllByText("changePassword");
  const submitButton = submitButtons[submitButtons.length - 1]!;
  await act(async () => {
    fireEvent.click(submitButton);
  });
}

describe("SecuritySettings — password change", () => {
  it("renders a current-password input with autocomplete=current-password", () => {
    render(<SecuritySettings />);
    const currentInput = screen.getByPlaceholderText(
      "currentPasswordPlaceholder"
    ) as HTMLInputElement;
    expect(currentInput.type).toBe("password");
    expect(currentInput.autocomplete).toBe("current-password");
  });

  it("sends current_password alongside new_password on submit", async () => {
    mockChangePassword.mockResolvedValue({ success: true, data: { message: "ok" } });
    render(<SecuritySettings />);

    await fillAndSubmitPasswordForm("oldSecret1", "newSecret1", "newSecret1");

    expect(mockChangePassword).toHaveBeenCalledTimes(1);
    expect(mockChangePassword).toHaveBeenCalledWith("oldSecret1", "newSecret1");
    expect(useToastStore.getState().addToast).toHaveBeenCalledWith(
      "success",
      "passwordChanged"
    );
  });

  it("submit is disabled until current password is filled in", async () => {
    render(<SecuritySettings />);
    const newInput = screen.getByPlaceholderText("newPasswordPlaceholder");
    const confirmInput = screen.getByPlaceholderText("confirmNewPasswordPlaceholder");

    await act(async () => {
      fireEvent.change(newInput, { target: { value: "newSecret1" } });
      fireEvent.change(confirmInput, { target: { value: "newSecret1" } });
    });

    const submitButtons = screen.getAllByText("changePassword");
    const submitButton = submitButtons[submitButtons.length - 1]!;
    expect(submitButton).toBeDisabled();
    expect(mockChangePassword).not.toHaveBeenCalled();
  });

  it("renders wrongCurrentPassword when the server rejects the current password", async () => {
    mockChangePassword.mockResolvedValue({
      success: false,
      error: "unauthorized: current password is incorrect",
    });
    render(<SecuritySettings />);

    await fillAndSubmitPasswordForm("wrongOld", "newSecret1", "newSecret1");

    expect(useToastStore.getState().addToast).toHaveBeenCalledWith(
      "error",
      "wrongCurrentPassword"
    );
  });

  it("falls back to the generic error toast for other failures", async () => {
    mockChangePassword.mockResolvedValue({
      success: false,
      error: "internal server error",
    });
    render(<SecuritySettings />);

    await fillAndSubmitPasswordForm("oldSecret1", "newSecret1", "newSecret1");

    expect(useToastStore.getState().addToast).toHaveBeenCalledWith(
      "error",
      "passwordChangeError"
    );
  });
});
