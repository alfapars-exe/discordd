import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import AccountLifecycleSettings from "./AccountLifecycleSettings";

const mocks = vi.hoisted(() => ({ disable: vi.fn(), confirm: vi.fn(), logout: vi.fn(), generation: 1, owner: "a" }));
const t = (key: string) => key;
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t }), initReactI18next: { type: "3rdParty", init: () => {} } }));
vi.mock("../../api/accountLifecycle", () => ({ disableAccount: mocks.disable }));
vi.mock("../../api/client", () => ({ getAuthGeneration: () => mocks.generation }));
vi.mock("../../stores/authStore", () => ({ useAuthStore: { getState: () => ({ user: { id: mocks.owner }, logout: mocks.logout }) } }));
vi.mock("../../stores/confirmStore", () => ({ useConfirmStore: { getState: () => ({ open: mocks.confirm }) } }));
function fill() { fireEvent.change(screen.getByLabelText("currentPassword"), { target: { value: "current-password" } }); }
describe("AccountLifecycleSettings", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.generation = 1; mocks.owner = "a"; mocks.confirm.mockResolvedValue(true); mocks.disable.mockResolvedValue({ success: true, data: { disabled: true } }); });
  it("requires separate confirmation and retains drafts when cancelled", async () => {
    mocks.confirm.mockResolvedValue(false); render(<AccountLifecycleSettings userID="a" />); fill();
    fireEvent.click(screen.getByRole("button", { name: "lifecycle.disable" }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    expect(mocks.disable).not.toHaveBeenCalled(); expect(screen.getByLabelText("currentPassword")).toHaveValue("current-password");
  });
  it("requires actual disabled acknowledgement before clearing only the local session", async () => {
    render(<AccountLifecycleSettings userID="a" />); fill();
    fireEvent.click(screen.getByRole("button", { name: "lifecycle.disable" }));
    await waitFor(() => expect(mocks.logout).toHaveBeenCalledWith({ localOnly: true, expectedUserId: "a" }));
    expect(mocks.disable).toHaveBeenCalledWith("a", "current-password", "", expect.any(Function));
  });
  it("preserves credentials on failed MFA without logging out", async () => {
    mocks.disable.mockResolvedValue({ success: false, code: "MFA_REQUIRED" });
    render(<AccountLifecycleSettings userID="a" />); fill(); fireEvent.click(screen.getByRole("button", { name: "lifecycle.disable" }));
    await screen.findByRole("alert"); expect(mocks.logout).not.toHaveBeenCalled();
    expect(screen.getByLabelText("currentPassword")).toHaveValue("current-password");
  });
  it("ignores success from a replaced login", async () => {
    let finish!: (value: unknown) => void;
    mocks.disable.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(<AccountLifecycleSettings userID="a" />); fill(); fireEvent.click(screen.getByRole("button", { name: "lifecycle.disable" }));
    await waitFor(() => expect(mocks.disable).toHaveBeenCalled()); mocks.generation = 2;
    await act(async () => finish({ success: true, data: { disabled: true } })); expect(mocks.logout).not.toHaveBeenCalled();
  });
});
