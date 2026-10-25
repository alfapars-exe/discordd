import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import MobileHeader from "./MobileHeader";
import MemberList from "./MemberList";

const state = vi.hoisted(() => ({
  isMobile: true,
  ui: { panels: {}, activePanelId: null, destination: { type: "text", label: "General", serverInfo: { serverId: "server" } }, membersOpen: true, toggleMembers: vi.fn() },
  mobile: { leftDrawerOpen: false, rightDrawerOpen: false, openLeftDrawer: vi.fn(), closeLeftDrawer: vi.fn(), openRightDrawer: vi.fn(), closeRightDrawer: vi.fn() },
  member: { isLoading: false, onlineUserIds: new Set() },
  server: { activeServer: null },
}));
vi.mock("../../stores/uiStore", () => ({ useUIStore: (select: (value: typeof state.ui) => unknown) => select(state.ui) }));
vi.mock("../../stores/mobileStore", () => ({ useMobileStore: (select: (value: typeof state.mobile) => unknown) => select(state.mobile) }));
vi.mock("../../stores/memberStore", () => ({ useMemberStore: (select: (value: typeof state.member) => unknown) => select(state.member), useActiveMembers: () => [] }));
vi.mock("../../stores/serverStore", () => ({ useServerStore: (select: (value: typeof state.server) => unknown) => select(state.server) }));
vi.mock("../../hooks/useMediaQuery", () => ({ useIsMobile: () => state.isMobile }));
vi.mock("../../hooks/useResizeHandle", () => ({ useResizeHandle: () => ({ width: 240, handleMouseDown: vi.fn(), isDragging: false }) }));
vi.mock("../../hooks/useNowTick", () => ({ useNowTick: () => 0 }));
vi.mock("../inbox/HeaderInboxButtons", () => ({ default: () => null }));
vi.mock("../members/MemberItem", () => ({ default: () => null }));
vi.mock("../../utils/constants", () => ({ resolveAssetUrl: (value: string) => value }));
vi.mock("../../utils/uiShell", () => ({ UI_SHELL_V2: true }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }), initReactI18next: { type: "3rdParty", init: () => {} } }));

describe("mobile panel controls", () => {
  beforeEach(() => { vi.clearAllMocks(); state.isMobile = true; state.ui.membersOpen = true; state.mobile.leftDrawerOpen = false; state.mobile.rightDrawerOpen = false; });

  it("names drawer controls and reports which dialog each controls", () => {
    const view = render(<MobileHeader />);
    const sidebar = screen.getByRole("button", { name: "openSidebar" });
    expect(sidebar).toHaveAttribute("aria-controls", "mobile-drawer-left");
    expect(sidebar).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(sidebar);
    expect(state.mobile.openLeftDrawer).toHaveBeenCalledOnce();
    state.mobile.leftDrawerOpen = true;
    view.rerender(<MobileHeader />);
    expect(screen.getByRole("button", { name: "closeSidebar" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "openMembers" })).toHaveAttribute("aria-controls", "mobile-drawer-right");
  });

  it("provides an accessible members close action with the correct mobile handler", () => {
    render(<MemberList />);
    fireEvent.click(screen.getByRole("button", { name: "closeMembers" }));
    expect(state.mobile.closeRightDrawer).toHaveBeenCalledOnce();
    expect(state.ui.toggleMembers).not.toHaveBeenCalled();
  });

  it("makes collapsed desktop members content inert without disabling its reopen button", () => {
    state.isMobile = false;
    state.ui.membersOpen = false;
    const { container } = render(<MemberList />);
    expect(container.querySelector(".members-inner")).toHaveAttribute("inert");
    expect(screen.getByRole("button", { name: "members" })).not.toBeDisabled();
  });
});
