import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import * as authApi from "../../api/auth";
import ForgotPasswordPage from "./ForgotPasswordPage";

vi.mock("../../api/auth", () => ({ forgotPassword: vi.fn() }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

it("keeps the submitted identity visible until the request settles and allows retry after an error", async () => {
  let rejectRequest!: () => void;
  vi.mocked(authApi.forgotPassword)
    .mockImplementationOnce(() => new Promise(resolve => {
      rejectRequest = () => resolve({ success: false, error: "unavailable" });
    }))
    .mockResolvedValueOnce({ success: true, data: { message: "accepted" } });
  render(<MemoryRouter><ForgotPasswordPage /></MemoryRouter>);
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "first-user" } });
  fireEvent.click(screen.getByRole("button"));
  expect(input).toHaveAttribute("readonly");
  expect(screen.getByRole("button")).toBeDisabled();
  expect(authApi.forgotPassword).toHaveBeenCalledWith("first-user");
  rejectRequest();
  await screen.findByText("unavailable");
  expect(input).not.toHaveAttribute("readonly");
  fireEvent.change(input, { target: { value: "second-user" } });
  expect(screen.queryByText("unavailable")).toBeNull();
  fireEvent.click(screen.getByRole("button"));
  expect(await screen.findByRole("heading", { name: "resetLinkSent" })).toBeVisible();
  expect(authApi.forgotPassword).toHaveBeenLastCalledWith("second-user");
});
