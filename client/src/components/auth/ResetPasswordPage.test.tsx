import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import ResetPasswordPage from "./ResetPasswordPage";

const reset = vi.hoisted(() => vi.fn());
vi.mock("../../api/auth", () => ({ resetPassword: reset }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }), initReactI18next: { type: "3rdParty", init: () => {} } }));

function submit(password = "valid-password") {
  fireEvent.change(screen.getByLabelText("newPassword"), { target: { value: password } });
  fireEvent.change(screen.getByLabelText("confirmNewPassword"), { target: { value: password } });
  fireEvent.submit(screen.getByRole("button", { name: "resetPassword" }).closest("form")!);
}
describe("password recovery result", () => {
  beforeEach(() => reset.mockReset());
  it("does not treat a failure envelope without text as success", async () => {
    reset.mockResolvedValue({ success: false });
    render(<MemoryRouter initialEntries={["/reset-password?token=test-token"]}><ResetPasswordPage /></MemoryRouter>);
    submit();
    await screen.findByText("resetPasswordError");
    expect(screen.queryByText("resetSuccess")).not.toBeInTheDocument();
  });
  it("handles thrown transport errors and permits retry", async () => {
    reset.mockRejectedValueOnce(new Error("offline"));
    render(<MemoryRouter initialEntries={["/reset-password?token=test-token"]}><ResetPasswordPage /></MemoryRouter>);
    submit();
    await screen.findByText("networkError");
    expect(screen.getByRole("button", { name: "resetPassword" })).toBeEnabled();
    reset.mockResolvedValue({ success: true });
    submit();
    await screen.findByText("resetSuccess");
  });
  it("rejects oversized Unicode passwords without consuming a recovery token", async () => {
    render(<MemoryRouter initialEntries={["/reset-password?token=test-token"]}><ResetPasswordPage /></MemoryRouter>);
    submit("😀".repeat(19));
    await waitFor(() => expect(screen.getByText("passwordTooLong")).toBeInTheDocument());
    expect(reset).not.toHaveBeenCalled();
  });
});
