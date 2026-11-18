import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { useAuthStore } from "../../stores/authStore";
import { useToastStore } from "../../stores/toastStore";
import LoginPage from "./LoginPage";

vi.mock("../../utils/constants", async (original) => ({
  ...await original<typeof import("../../utils/constants")>(),
  isElectron: () => true,
  SERVER_URL: "https://chat.example",
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each([
  { remember: true, message: "rememberSaveFailed" },
  { remember: false, message: "rememberClearFailed" },
])("opens channels and warns after a credential failure (remember=$remember)", async ({ remember, message }) => {
  const storage = {
    loadCredentials: vi.fn().mockResolvedValue(null),
    saveCredentials: vi.fn().mockRejectedValue(new Error("storage unavailable")),
    clearCredentials: vi.fn().mockRejectedValue(new Error("access denied")),
  };
  vi.stubGlobal("electronAPI", storage);
  vi.spyOn(useAuthStore.getState(), "login").mockResolvedValue(true);
  const warn = vi.spyOn(useToastStore.getState(), "addToast").mockImplementation(() => {});
  render(<MemoryRouter initialEntries={["/login"]}><Routes>
    <Route path="/login" element={<LoginPage />} />
    <Route path="/channels" element={<h1>Channels</h1>} />
  </Routes></MemoryRouter>);

  fireEvent.change(screen.getByLabelText("username"), { target: { value: "ada" } });
  fireEvent.change(screen.getByLabelText("password"), { target: { value: "fixture-password" } });
  if (remember) fireEvent.click(screen.getByLabelText("rememberMe"));
  fireEvent.click(screen.getByRole("button", { name: "login" }));

  expect(await screen.findByRole("heading", { name: "Channels" })).toBeInTheDocument();
  expect(warn).toHaveBeenCalledWith("warning", message);
  if (remember) {
    expect(storage.saveCredentials).toHaveBeenCalledWith("ada", "fixture-password", "https://chat.example");
    expect(storage.clearCredentials).not.toHaveBeenCalled();
  } else {
    expect(storage.clearCredentials).toHaveBeenCalledOnce();
    expect(storage.saveCredentials).not.toHaveBeenCalled();
  }
});
