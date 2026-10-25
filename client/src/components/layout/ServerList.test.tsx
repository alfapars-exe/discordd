import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ContextMenuItem } from "../../hooks/useContextMenu";
import { Permissions } from "../../utils/permissions";
import ServerList from "./ServerList";

const state = vi.hoisted(() => ({
  sidebar: { toggleSection: vi.fn(), expandSection: vi.fn(), expandedSections: {} },
  server: { servers: [{ id: "s1", name: "Server One", icon_url: null }], activeServerId: "s1", activeServer: { id: "s1", owner_id: "owner" }, mutedServerIds: new Set(),
    setActiveServer: vi.fn(), reorderServers: vi.fn(), unmuteServer: vi.fn(), leaveServer: vi.fn(), toggleE2EE: vi.fn() },
  read: { markAllAsRead: vi.fn(), getServerUnreadTotal: vi.fn() },
  auth: { user: { id: "me" } },
  settings: { openSettings: vi.fn() },
  toast: { addToast: vi.fn() },
  members: [{ id: "me", effective_permissions: 0 }],
  openMenu: vi.fn(),
  uiShellV2: true,
}));
vi.mock("../../stores/sidebarStore", () => ({ useSidebarStore: (select: (value: typeof state.sidebar) => unknown) => select(state.sidebar) }));
vi.mock("../../stores/serverStore", () => ({ useServerStore: (select: (value: typeof state.server) => unknown) => select(state.server) }));
vi.mock("../../stores/readStateStore", () => ({ useReadStateStore: (select: (value: typeof state.read) => unknown) => select(state.read) }));
vi.mock("../../stores/authStore", () => ({ useAuthStore: (select: (value: typeof state.auth) => unknown) => select(state.auth) }));
vi.mock("../../stores/settingsStore", () => ({ useSettingsStore: (select: (value: typeof state.settings) => unknown) => select(state.settings) }));
vi.mock("../../stores/toastStore", () => ({ useToastStore: (select: (value: typeof state.toast) => unknown) => select(state.toast) }));
vi.mock("../../stores/memberStore", () => ({ useActiveMembers: () => state.members }));
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => vi.fn() }));
vi.mock("../../hooks/useContextMenu", () => ({ useContextMenu: () => ({ menuState: null, openMenu: state.openMenu, closeMenu: vi.fn() }) }));
vi.mock("../shared/ContextMenu", () => ({ default: () => null }));
vi.mock("../../utils/constants", () => ({ resolveAssetUrl: (value: string) => value }));
vi.mock("../../utils/uiShell", () => ({ get UI_SHELL_V2() { return state.uiShellV2; } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }), initReactI18next: { type: "3rdParty", init: () => {} } }));

describe("V2 server management entry", () => {
  beforeEach(() => { vi.clearAllMocks(); state.members[0].effective_permissions = 0; state.uiShellV2 = true; });
  const props = { onAddServer: vi.fn(), onCreateChannel: vi.fn(), onInviteServer: vi.fn(), onOpenEvents: vi.fn(), onMuteServer: vi.fn(), renderServerBody: () => null };

  function settingsItem() {
    render(<ServerList {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /Server One/ }));
    return (state.openMenu.mock.calls[0][1] as ContextMenuItem[]).find((item) => item.label === "serverSettings");
  }

  it("keeps management hidden from ordinary members", () => {
    expect(settingsItem()).toBeUndefined();
  });
  it("allows a non-admin channel moderator to reach permitted settings", () => {
    state.members[0].effective_permissions = Permissions.ManageChannels;
    settingsItem()?.onClick();
    expect(state.settings.openSettings).toHaveBeenCalledWith("server-general");
  });
  it("opens entrance sounds directly for an entrance-only moderator", () => {
    state.members[0].effective_permissions = Permissions.MuteMembers;
    settingsItem()?.onClick();
    expect(state.settings.openSettings).toHaveBeenCalledWith("entrance-sounds");
  });
  it("adds the events entry to the active server header menu", () => {
    render(<ServerList {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /Server One/ }));
    const eventsItem = (state.openMenu.mock.calls[0][1] as ContextMenuItem[]).find((item) => item.label === "serverEvents");
    expect(eventsItem).toBeDefined();
    eventsItem?.onClick();
    expect(props.onOpenEvents).toHaveBeenCalledWith("s1", "Server One");
  });

  it("previews server rail movement and persists only when dropped", async () => {
    state.uiShellV2 = false;
    state.server.servers = [
      { id: "s1", name: "Server One", icon_url: null },
      { id: "s2", name: "Server Two", icon_url: null },
    ];
    state.server.reorderServers.mockResolvedValue(true);
    render(<ServerList {...props} />);
    const first = screen.getByRole("button", { name: /Server One/ });
    fireEvent.keyDown(first, { key: "d", code: "KeyD", ctrlKey: true });
    fireEvent.keyDown(first, { key: "ArrowDown", code: "ArrowDown" });

    const railRows = screen.getAllByRole("button", { name: /Server (One|Two)/ });
    expect(railRows.slice(0, 2).map((button) => button.textContent?.includes("Server Two") ? "s2" : "s1")).toEqual(["s2", "s1"]);
    expect(state.server.reorderServers).not.toHaveBeenCalled();

    fireEvent.keyDown(first, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(state.server.reorderServers).toHaveBeenCalledWith([
      { id: "s2", position: 0 },
      { id: "s1", position: 1 },
    ]));
  });
});
