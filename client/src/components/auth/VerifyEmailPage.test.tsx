import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import VerifyEmailPage from "./VerifyEmailPage";
const verify = vi.hoisted(() => vi.fn());
vi.mock("../../api/emailVerification", () => ({ verifyEmail: verify }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }), initReactI18next: { type: "3rdParty", init: () => {} } }));
function LocationProbe() { return <output data-testid="hash">{useLocation().hash}</output>; }
function show(token = "a".repeat(64)) { render(<MemoryRouter initialEntries={[`/verify-email#token=${token}`]}><VerifyEmailPage /><LocationProbe /></MemoryRouter>); }
describe("VerifyEmailPage", () => {
  beforeEach(() => verify.mockReset());
  it("removes the secret fragment and requires explicit confirmation rather than a GET visit", async () => {
    show(); await waitFor(() => expect(screen.getByTestId("hash")).toBeEmptyDOMElement());
    expect(verify).not.toHaveBeenCalled(); verify.mockResolvedValue({ success: true, data: { verified: true } });
    fireEvent.click(screen.getByRole("button", { name: "verificationConfirm" }));
    await screen.findByText("verificationSuccess"); expect(verify).toHaveBeenCalledWith("a".repeat(64));
    expect(screen.queryByRole("button", { name: "verificationConfirm" })).not.toBeInTheDocument();
  });
  it("does not treat a failed response as verification and allows retry", async () => {
    show(); verify.mockResolvedValueOnce({ success: false, code: "EMAIL_VERIFICATION_INVALID" });
    fireEvent.click(screen.getByRole("button", { name: "verificationConfirm" }));
    await screen.findByText("verificationInvalid"); expect(screen.queryByText("verificationSuccess")).not.toBeInTheDocument();
    verify.mockResolvedValueOnce({ success: true, data: { verified: true } });
    fireEvent.click(screen.getByRole("button", { name: "verificationConfirm" })); await screen.findByText("verificationSuccess");
  });
  it("does not submit a missing or malformed proof", () => {
    show("bad"); expect(screen.getByText("verificationInvalid")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument(); expect(verify).not.toHaveBeenCalled();
  });
});
