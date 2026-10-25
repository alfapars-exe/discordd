import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import MFASettings from "./MFASettings";

const mocks = vi.hoisted(() => ({ status: vi.fn(), begin: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), regenerate: vi.fn(), disable: vi.fn(), account: "a" }));
const translate = (key: string) => key;
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: translate }), initReactI18next: { type: "3rdParty", init: () => {} } }));
vi.mock("../../api/mfa", () => ({ getMFAStatus: mocks.status, beginMFA: mocks.begin, confirmMFA: mocks.confirm, cancelMFA: mocks.cancel, regenerateMFA: mocks.regenerate, disableMFA: mocks.disable }));
vi.mock("../../stores/authStore", () => ({ useAuthStore: { getState: () => ({ user: { id: mocks.account } }) } }));

const button = (name: string) => screen.getByRole("button", { name });
const fill = (id: string, value: string) => fireEvent.change(document.getElementById(id)!, { target: { value } });

describe("MFASettings", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.account = "a";
    mocks.status.mockResolvedValue({ success: true, data: { enabled: false, recovery_remaining: 0 } });
    mocks.begin.mockResolvedValue({ success: true, data: { setup_id: "setup", secret: "PRIVATE-KEY", uri: "otpauth://fixture", expires_at: 123 } });
    mocks.confirm.mockResolvedValue({ success: true, data: { recovery_codes: ["private-recovery-1", "private-recovery-2"] } });
    mocks.cancel.mockResolvedValue({ success: true });
    mocks.disable.mockResolvedValue({ success: true });
  });
  it("enrolls, presents one-time codes and removes them after acknowledgement", async () => {
    render(<MFASettings userID="a" />); await screen.findByText("mfa.disabled");
    fill("mfa-password", "current"); fireEvent.click(button("mfa.begin"));
    await screen.findByText("PRIVATE-KEY"); expect(mocks.begin).toHaveBeenCalledWith("a", "current");
    expect(document.getElementById("mfa-password")).not.toBeInTheDocument();
    fill("mfa-manage-code", "123456"); fireEvent.click(button("mfa.confirm"));
    await screen.findByText("private-recovery-1"); expect(mocks.confirm).toHaveBeenCalledWith("a", "setup", "123456");
    fireEvent.click(button("mfa.codesSaved"));
    expect(screen.queryByText("private-recovery-1")).not.toBeInTheDocument();
    expect(screen.queryByText("PRIVATE-KEY")).not.toBeInTheDocument();
    expect(document.getElementById("mfa-password")).toHaveValue("");
  });
  it("cancels the pending setup on the server, not just in the UI", async () => {
    render(<MFASettings userID="a" />); await screen.findByText("mfa.disabled");
    fill("mfa-password", "current"); fireEvent.click(button("mfa.begin")); await screen.findByText("PRIVATE-KEY");
    fireEvent.click(button("mfa.cancelSetup")); await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith("a", "setup"));
    expect(screen.queryByText("PRIVATE-KEY")).not.toBeInTheDocument();
  });
  it("preserves the code on failure and requires explicit confirmation to disable", async () => {
    mocks.status.mockResolvedValue({ success: true, data: { enabled: true, recovery_remaining: 10 } });
    mocks.disable.mockResolvedValueOnce({ success: false, code: "MFA_INVALID" });
    render(<MFASettings userID="a" />); await screen.findByText("mfa.enabled");
    fill("mfa-password", "current"); fill("mfa-manage-code", "used-code");
    fireEvent.click(button("mfa.disable")); expect(mocks.disable).not.toHaveBeenCalled();
    fireEvent.click(button("mfa.confirmDisable")); await screen.findByText("mfa.invalid");
    expect(document.getElementById("mfa-manage-code")).toHaveValue("used-code");
    expect(mocks.disable).toHaveBeenCalledWith("a", "current", "used-code");
  });
  it("does not reveal a late setup secret to a replacement account", async () => {
    let finish!: (value: unknown) => void;
    mocks.begin.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = render(<MFASettings userID="a" />); await screen.findByText("mfa.disabled");
    fill("mfa-password", "current"); fireEvent.click(button("mfa.begin"));
    view.unmount(); mocks.account = "b"; render(<MFASettings userID="b" />);
    await act(async () => finish({ success: true, data: { setup_id: "old", secret: "DO-NOT-REVEAL" } }));
    expect(screen.queryByText("DO-NOT-REVEAL")).not.toBeInTheDocument();
  });
});
