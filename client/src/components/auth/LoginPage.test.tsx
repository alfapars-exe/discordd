/**
 * LoginPage — regression pin for the removed native server-picker UI.
 *
 * Until this change, native (Electron) builds rendered a raw
 * "Sunucu: https://…" control at the bottom of the login card
 * (ServerUrlPicker.tsx, now deleted along with its only other consumer,
 * RegisterPage.tsx, and its sole helper module utils/serverUrl.ts). This
 * test forces native mode — the one mode where the picker used to render —
 * so the assertion is meaningful rather than vacuously true from running in
 * web mode, where it was already hidden.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

vi.mock("../../utils/constants", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../utils/constants");
  return {
    ...actual,
    isNativeApp: () => true,
    isElectron: () => false,
  };
});

vi.mock("../../api/auth", () => ({
  login: vi.fn(),
  register: vi.fn(),
  getMe: vi.fn(),
}));

import LoginPage from "./LoginPage";

describe("LoginPage — native server-picker removal", () => {
  it("never renders a server picker, even in native mode", () => {
    render(
      <MemoryRouter initialEntries={["/login"]}>
        <LoginPage />
      </MemoryRouter>,
    );

    // The picker used to render its raw "Sunucu:"/"Server:" toggle text and
    // an expandable URL input; neither should exist anywhere in the tree.
    expect(screen.queryByText(/serverUrlPicker/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /sunucu|server/i })).not.toBeInTheDocument();
  });

  it("still renders the actual login form untouched by the removal", () => {
    render(
      <MemoryRouter initialEntries={["/login"]}>
        <LoginPage />
      </MemoryRouter>,
    );

    expect(screen.getByLabelText(/username/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^password/i)).toBeInTheDocument();
  });
});
