import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { create } from "zustand";
import SecuritySettings from "./SecuritySettings";

const mocks = vi.hoisted(() => ({ email: vi.fn(), password: vi.fn(), toast: vi.fn(), update: vi.fn(), logout: vi.fn() }));
vi.mock("../../api/auth", () => ({ changeEmail: mocks.email, changePassword: mocks.password }));
vi.mock("./ServerOwnershipTransfer", () => ({ default: () => null }));
vi.mock("../../stores/toastStore", () => ({ useToastStore: (select: (s: unknown) => unknown) => select({ addToast: mocks.toast }) }));
vi.mock("../../stores/settingsStore", () => ({ useSettingsStore: { getState: () => ({ setActiveTab: vi.fn() }) } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }), initReactI18next: { type: "3rdParty", init: () => {} } }));
vi.mock("../../stores/authStore", () => ({ useAuthStore: create(() => ({ user: { id: "a", email: "old@example.invalid" }, updateUser: mocks.update, logout: mocks.logout })) }));
import { useAuthStore } from "../../stores/authStore";

function fill(id: string, value: string) { fireEvent.change(document.getElementById(id)!, { target: { value } }); }
function fillPassword(value = "new-password") {
  fill("currentPasswordForChange", "current-password"); fill("newPassword", value); fill("confirmNewPassword", value);
}

describe("SecuritySettings credential writes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ user: { id: "a", email: "old@example.invalid" } as never });
    mocks.email.mockResolvedValue({ success: true, data: { email: null } });
    mocks.password.mockResolvedValue({ success: true });
  });
	it("does not render an email removal action", () => {
    render(<SecuritySettings />);
		expect(screen.queryByRole("button", { name: "removeEmail" })).not.toBeInTheDocument();
  });
  it("clears private drafts on an account switch and ignores the old response", async () => {
    let finish!: (value: unknown) => void;
    mocks.email.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    render(<SecuritySettings />);
    fill("newEmail", "new@example.invalid"); fill("emailPassword", "private-draft");
    fireEvent.click(screen.getByRole("button", { name: "changeEmail" }));
    act(() => useAuthStore.setState({ user: { id: "b", email: "b@example.invalid" } as never }));
    expect(document.getElementById("emailPassword")).toHaveValue("");
    expect(document.getElementById("newEmail")).toHaveValue("");
    await act(async () => finish({ success: true, data: { email: "new@example.invalid" } }));
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });
  it("applies the shared password policy before sending", async () => {
    render(<SecuritySettings />);
    fillPassword("ş".repeat(7));
    fireEvent.click(screen.getByRole("button", { name: "changePassword" }));
    expect(mocks.toast).toHaveBeenLastCalledWith("error", "passwordTooShort");
    fillPassword("😀".repeat(19));
    fireEvent.click(screen.getByRole("button", { name: "changePassword" }));
    expect(mocks.toast).toHaveBeenLastCalledWith("error", "passwordTooLong");
    expect(mocks.password).not.toHaveBeenCalled();
    fillPassword();
    fireEvent.click(screen.getByRole("button", { name: "changePassword" }));
    await waitFor(() => expect(mocks.password).toHaveBeenCalledWith("current-password", "new-password", "a"));
    expect(mocks.logout).toHaveBeenCalledWith({ localOnly: true, expectedUserId: "a" });
  });
  it("shows account mismatch without success and preserves fields for retry", async () => {
    mocks.email.mockResolvedValue({ success: false, code: "ACCOUNT_MISMATCH" });
    render(<SecuritySettings />); fill("newEmail", "new@example.invalid"); fill("emailPassword", "secret");
    fireEvent.click(screen.getByRole("button", { name: "changeEmail" }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("error", "securityAccountChanged"));
    expect(document.getElementById("newEmail")).toHaveValue("new@example.invalid");
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("reports transport failure and allows retry without an unhandled rejection", async () => {
    mocks.password.mockRejectedValueOnce(new Error("offline"));
    render(<SecuritySettings />); fillPassword();
    fireEvent.click(screen.getByRole("button", { name: "changePassword" }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("error", "passwordChangeError"));
    expect(screen.getByRole("button", { name: "changePassword" })).toBeEnabled();
    expect(document.getElementById("newPassword")).toHaveValue("new-password");
  });
});
