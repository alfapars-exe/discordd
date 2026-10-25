import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import SettingsNav from "./SettingsNav";
import { SettingsWorkspaceContext, type SettingsWorkspace } from "./settingsWorkspaceContext";

const state = vi.hoisted(() => ({
  mobile: false,
  auth: { user: { id: "me", is_platform_admin: false }, logout: vi.fn() },
  settings: { activeTab: "profile", setActiveTab: vi.fn() },
}));
vi.mock("../../stores/authStore", () => ({ useAuthStore: (select: (value: typeof state.auth) => unknown) => select(state.auth) }));
vi.mock("../../stores/settingsStore", () => ({ useSettingsStore: (select: (value: typeof state.settings) => unknown) => select(state.settings) }));
vi.mock("../../stores/memberStore", () => ({ useActiveMembers: () => [] }));
vi.mock("../../hooks/useMediaQuery", () => ({ useIsMobile: () => state.mobile }));
vi.mock("../../utils/constants", () => ({ isElectron: () => false }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }), initReactI18next: { type: "3rdParty", init: () => {} } }));

describe("searchable settings navigation", () => {
  beforeEach(() => {
    state.mobile = false;
    state.auth.user.is_platform_admin = false;
    state.settings.setActiveTab.mockClear();
  });

  it("filters destinations without exposing privileged settings", () => {
    render(<SettingsNav />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "voice" } });
    fireEvent.click(screen.getByRole("button", { name: "voiceSettings" }));
    expect(state.settings.setActiveTab).toHaveBeenCalledWith("voice");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "platform" } });
    expect(screen.getByRole("status")).toHaveTextContent("noResults");
    expect(screen.queryByRole("button", { name: "platformUsersTab" })).not.toBeInTheDocument();
  });

  it("makes every permitted section selectable on mobile", () => {
    state.mobile = true;
    render(<SettingsNav />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "encryption" } });
    expect(state.settings.setActiveTab).toHaveBeenCalledWith("encryption");
    expect(screen.queryByRole("option", { name: "platformUsersTab" })).not.toBeInTheDocument();
  });

  it("shows platform destinations for admins but keeps desktop-only items hidden on web", () => {
    state.auth.user.is_platform_admin = true;
    render(<SettingsNav />);
    expect(screen.getByRole("button", { name: "platformUsersTab" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "platformConnections" })).not.toBeInTheDocument();
  });

  it.each([false, true])("finds and opens sections in an unopened panel (mobile=%s)", (mobile) => {
    state.mobile = mobile;
    const workspace: SettingsWorkspace = {
      sections: [], activeSection: null, navigate: vi.fn(), navigateSection: vi.fn(), back: vi.fn(),
      close: vi.fn(), registerDraft: vi.fn(), canGoBack: false,
    };
    render(<SettingsWorkspaceContext.Provider value={workspace}><SettingsNav /></SettingsWorkspaceContext.Provider>);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "acc.colorContrast" } });
    if (mobile) fireEvent.change(screen.getByRole("combobox"), { target: { value: "accessibility#contrast" } });
    else fireEvent.click(screen.getByRole("button", { name: "acc.colorContrast" }));
    expect(workspace.navigate).toHaveBeenCalledWith("accessibility", "contrast");
    expect(document.querySelector("optgroup optgroup")).toBeNull();
  });
});
