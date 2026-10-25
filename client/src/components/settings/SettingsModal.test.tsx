import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SettingsModal from "./SettingsModal";
import type { ReactNode } from "react";

const state = vi.hoisted(() => ({
  settings: { isOpen: true, activeTab: "profile", context: "account", contextServerId: null as string | null, closeSettings: vi.fn(), setActiveTab: vi.fn() },
  auth: { user: { id: "me", is_platform_admin: true } },
  server: { activeServerId: "s1", activeServer: { id: "s1", name: "Server" } },
  members: [{ id: "me", effective_permissions: 512 }],
}));
vi.mock("../../stores/settingsStore", () => ({ useSettingsStore: (select: (value: typeof state.settings) => unknown) => select(state.settings) }));
vi.mock("../../stores/authStore", () => ({ useAuthStore: (select: (value: typeof state.auth) => unknown) => select(state.auth) }));
vi.mock("../../stores/serverStore", () => ({ useServerStore: (select: (value: typeof state.server) => unknown) => select(state.server) }));
vi.mock("../../stores/memberStore", () => ({ useActiveMembers: () => state.members }));
vi.mock("../../utils/constants", () => ({ isElectron: () => false, SERVER_URL: "https://test.example" }));
vi.mock("../../utils/uiShell", () => ({ UI_SHELL_V2: true }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }), initReactI18next: { type: "3rdParty", init: () => {} } }));
vi.mock("./SettingsNav", () => ({ default: () => <button>First nav</button> }));
vi.mock("./PreferencesSyncStatus", () => ({ default: () => null }));
vi.mock("../shared/SectionErrorBoundary", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("./ProfileSettings", () => ({ default: () => <button>Last field</button> }));
vi.mock("./PlatformSettings", () => ({ default: () => <div>Privileged platform editor</div> }));
vi.mock("./ServerGeneralSettings", () => ({ default: () => <div>Privileged server editor</div> }));

describe("SettingsModal safety", () => {
  beforeEach(() => {
    state.settings.isOpen = true;
    state.settings.activeTab = "profile";
    state.settings.context = "account";
    state.settings.contextServerId = null;
    state.settings.closeSettings.mockClear();
    state.auth.user.is_platform_admin = true;
    state.server.activeServerId = "s1";
    state.members = [{ id: "me", effective_permissions: 512 }];
  });

  it("contains Tab focus and restores the opener when closed", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const view = render(<SettingsModal />);
    await screen.findByRole("button", { name: "Last field" });
    const last = screen.getAllByRole("button").at(-1)!;
    await waitFor(() => expect(screen.getByText("First nav")).toHaveFocus());
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(screen.getByText("First nav")).toHaveFocus();
    fireEvent.keyDown(screen.getByText("First nav"), { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
    state.settings.isOpen = false;
    view.rerender(<SettingsModal />);
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it("does not close settings when Escape belongs to a nested modal", async () => {
    render(<SettingsModal />);
    await screen.findByText("Last field");
    const nested = document.createElement("div");
    nested.className = "modal-backdrop";
    document.body.append(nested);
    fireEvent.keyDown(nested, { key: "Escape" });
    expect(state.settings.closeSettings).not.toHaveBeenCalled();
    nested.remove();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(state.settings.closeSettings).toHaveBeenCalledOnce();
  });

  it("still handles Escape when opened above an underlying mobile drawer", async () => {
    const drawer = document.createElement("div");
    drawer.className = "mobile-drawer open";
    drawer.setAttribute("role", "dialog");
    document.body.append(drawer);
    render(<SettingsModal />);
    await screen.findByText("Last field");
    fireEvent.keyDown(screen.getByText("Last field"), { key: "Escape" });
    expect(state.settings.closeSettings).toHaveBeenCalledOnce();
    drawer.remove();
  });

  it("unmounts a platform editor immediately after admin access is revoked", async () => {
    state.settings.activeTab = "platform";
    state.settings.context = "platform";
    const view = render(<SettingsModal />);
    await screen.findByText("Privileged platform editor");
    state.auth.user.is_platform_admin = false;
    view.rerender(<SettingsModal />);
    expect(screen.queryByText("Privileged platform editor")).not.toBeInTheDocument();
    expect(state.settings.closeSettings).toHaveBeenCalledOnce();
  });

  it("unmounts a server editor if the active server changes underneath it", async () => {
    state.settings.activeTab = "server-general";
    state.settings.context = "server";
    state.settings.contextServerId = "s1";
    const view = render(<SettingsModal />);
    await screen.findByText("Privileged server editor");
    state.server.activeServerId = "s2";
    view.rerender(<SettingsModal />);
    expect(screen.queryByText("Privileged server editor")).not.toBeInTheDocument();
    expect(state.settings.closeSettings).toHaveBeenCalledOnce();
  });
});
