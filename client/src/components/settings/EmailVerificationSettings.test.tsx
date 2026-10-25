import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import EmailVerificationSettings from "./EmailVerificationSettings";
const mocks = vi.hoisted(() => ({ status: vi.fn(), request: vi.fn(), generation: 1 }));
const t = (key: string) => key;
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t }), initReactI18next: { type: "3rdParty", init: () => {} } }));
vi.mock("../../api/emailVerification", () => ({ getEmailVerification: mocks.status, requestEmailVerification: mocks.request }));
vi.mock("../../api/client", () => ({ getAuthGeneration: () => mocks.generation }));
vi.mock("../../stores/authStore", () => ({ useAuthStore: { getState: () => ({ user: { id: "a" } }) } }));
const status = (patch = {}) => ({ success: true, data: { email: "fixture@example.invalid", generation: 2, verified: false, verified_at: null, delivery_available: true, retry_after: 0, ...patch } });
describe("EmailVerificationSettings", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.generation = 1; mocks.status.mockResolvedValue(status()); });
  it("does not offer fake delivery when the server is unconfigured", async () => {
    mocks.status.mockResolvedValue(status({ delivery_available: false }));
    render(<EmailVerificationSettings userID="a" />); await screen.findByText("verification.unavailable");
    expect(screen.getByRole("button", { name: "verification.send" })).toBeDisabled();
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("uses the actual email generation and shows acceptance only for an acknowledged request", async () => {
    mocks.request.mockResolvedValue({ success: true, data: { accepted: true } });
    render(<EmailVerificationSettings userID="a" />); await screen.findByText("fixture@example.invalid");
    mocks.status.mockResolvedValueOnce(status({ retry_after: 60 }));
    fireEvent.click(screen.getByRole("button", { name: "verification.send" }));
    await screen.findByText("verification.accepted");
    expect(mocks.request).toHaveBeenCalledWith("a", 2, expect.any(Function));
    await waitFor(() => expect(screen.getByRole("button", { name: "verification.send" })).toBeDisabled());
  });
  it("never reports acceptance on an uncertain provider failure", async () => {
    mocks.request.mockResolvedValue({ success: false, code: "EMAIL_DELIVERY_FAILED" });
    render(<EmailVerificationSettings userID="a" />); await screen.findByText("fixture@example.invalid");
    fireEvent.click(screen.getByRole("button", { name: "verification.send" }));
    await screen.findByText("verification.sendError"); expect(screen.queryByText("verification.accepted")).not.toBeInTheDocument();
  });
  it("ignores status returned after a replacement login", async () => {
    let finish!: (value: unknown) => void; mocks.status.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(<EmailVerificationSettings userID="a" />); mocks.generation = 2;
    await act(async () => finish(status({ verified: true })));
    expect(screen.queryByText("verification.verified")).not.toBeInTheDocument();
  });
});
