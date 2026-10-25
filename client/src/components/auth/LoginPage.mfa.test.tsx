import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { create } from "zustand";

const mocks = vi.hoisted(() => ({ login: vi.fn(), clear: vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }), initReactI18next: { type: "3rdParty", init: () => {} } }));
vi.mock("../../utils/constants", () => ({ isElectron: () => false, isNativeApp: () => false, SERVER_URL: "https://test.invalid" }));
vi.mock("../../hooks/useServerWakeUp", () => ({ useServerWakeUp: () => ({ state: { phase: "idle" }, reset: vi.fn() }) }));
vi.mock("../../stores/authStore", () => ({ useAuthStore: create(() => ({ login: mocks.login, applyLoginResponse: vi.fn(), isLoading: false, error: null, mfaRequired: false, accountDisabled: false, clearError: mocks.clear })) }));
import { useAuthStore } from "../../stores/authStore";
import LoginPage from "./LoginPage";

describe("LoginPage MFA challenge", () => {
  beforeEach(() => {
    vi.clearAllMocks(); useAuthStore.setState({ mfaRequired: false, error: null, accountDisabled: false });
    mocks.clear.mockImplementation(() => useAuthStore.setState({ error: null, mfaRequired: false, accountDisabled: false }));
    mocks.login.mockImplementation(async () => { useAuthStore.setState({ mfaRequired: true }); return false; });
  });
  it("does not restore by default and binds explicit restore consent to the entered identity", async () => {
    mocks.login.mockImplementation(async () => { useAuthStore.setState({ accountDisabled: true }); return false; });
    render(<MemoryRouter><LoginPage /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText("username"), { target: { value: "disabled-fixture" } });
    fireEvent.change(screen.getByLabelText("password"), { target: { value: "private-password" } });
    fireEvent.submit(screen.getByRole("button", { name: "login" }).closest("form")!);
    const consent = await screen.findByLabelText("restoreAccountConsent");
    expect(consent).not.toBeChecked(); expect(mocks.login).toHaveBeenLastCalledWith("disabled-fixture", "private-password", undefined);
    fireEvent.click(consent);
    fireEvent.submit(screen.getByRole("button", { name: "login" }).closest("form")!);
    expect(mocks.login).toHaveBeenLastCalledWith("disabled-fixture", "private-password", undefined, true);
    fireEvent.change(screen.getByLabelText("username"), { target: { value: "other" } });
    expect(screen.queryByLabelText("restoreAccountConsent")).not.toBeInTheDocument();
  });
  it("focuses the second-factor field and submits it with the original credentials", async () => {
    render(<MemoryRouter><LoginPage /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText("username"), { target: { value: "fixture" } });
    fireEvent.change(screen.getByLabelText("password"), { target: { value: "private-password" } });
    fireEvent.submit(screen.getByRole("button", { name: "login" }).closest("form")!);
    const code = await screen.findByLabelText("mfaCode");
    await waitFor(() => expect(code).toHaveFocus());
    fireEvent.change(code, { target: { value: "recovery-code" } });
    fireEvent.submit(screen.getByRole("button", { name: "login" }).closest("form")!);
    expect(mocks.login).toHaveBeenLastCalledWith("fixture", "private-password", "recovery-code");
    fireEvent.change(screen.getByLabelText("username"), { target: { value: "other-account" } });
    expect(screen.queryByLabelText("mfaCode")).not.toBeInTheDocument();
    expect(useAuthStore.getState().mfaRequired).toBe(false);
  });
});
