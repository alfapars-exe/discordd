import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { Destination } from "../../stores/uiStore";

const viewport = vi.hoisted(() => ({ mobile: false, tablet: false }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }), initReactI18next: { type: "3rdParty", init: () => {} } }));
vi.mock("../../hooks/useMediaQuery", () => ({ useIsMobile: () => viewport.mobile, useIsTablet: () => viewport.tablet }));
vi.mock("../../stores/uiStore", async () => {
  const { create } = await import("zustand");
  return { useUIStore: create<{ destination: Destination; membersOpen: boolean; toggleMembers: () => void }>((set) => ({
    destination: { type: "friends", channelId: "friends", label: "Friends" }, membersOpen: true,
    toggleMembers: () => set((state) => ({ membersOpen: !state.membersOpen })),
  })) };
});
vi.mock("./Sidebar", () => ({ default: () => <aside>Sidebar controls</aside> }));
vi.mock("./MemberList", () => ({ default: () => <aside>Members</aside> }));
vi.mock("./MobileAppLayout", () => ({ default: () => <div>Mobile layout</div> }));
vi.mock("./DestinationView", () => ({ default: () => <div>Single destination</div> }));

import ShellV2 from "./ShellV2";
import { useUIStore } from "../../stores/uiStore";
const props = {
  sidebarProps: { onJoinVoice: vi.fn(), onToggleMute: vi.fn(), onToggleDeafen: vi.fn(), onToggleScreenShare: vi.fn(), onDisconnect: vi.fn() },
  sendTyping: vi.fn(), sendDMTyping: vi.fn(),
};
const serverInfo = { serverId: "s1", serverName: "Server", serverIconUrl: null };

beforeEach(() => {
  viewport.mobile = false;
  viewport.tablet = false;
  useUIStore.setState({ destination: { type: "friends", channelId: "friends", label: "Friends" }, membersOpen: true });
});

describe("ShellV2 layout boundaries", () => {
  it("shows members only in server context, never in friends, DMs or a personal call", () => {
    render(<ShellV2 {...props} />);
    expect(screen.queryByText("Members")).not.toBeInTheDocument();
    act(() => useUIStore.setState({ destination: { type: "text", channelId: "c1", label: "general", serverInfo } }));
    expect(screen.getByText("Members")).toBeInTheDocument();
    for (const type of ["dm", "p2p", "saved", "notifications", "inbox", "friends"] as const) {
      act(() => useUIStore.setState({ destination: { type, channelId: "home", label: type } }));
      expect(screen.queryByText("Members")).not.toBeInTheDocument();
    }
    expect(screen.getAllByText("Single destination")).toHaveLength(1);
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("collapses the tablet member panel initially and provides a dismissible backdrop", () => {
    viewport.tablet = true;
    useUIStore.setState({ destination: { type: "text", channelId: "c1", label: "general", serverInfo } });
    render(<ShellV2 {...props} />);
    expect(useUIStore.getState().membersOpen).toBe(false);
    act(() => useUIStore.getState().toggleMembers());
    fireEvent.click(screen.getByRole("button", { name: "close" }));
    expect(useUIStore.getState().membersOpen).toBe(false);
  });

  it("uses one mobile layout at the mobile breakpoint", () => {
    viewport.mobile = true;
    viewport.tablet = true;
    render(<ShellV2 {...props} />);
    expect(screen.getByText("Mobile layout")).toBeInTheDocument();
    expect(screen.queryByText("Single destination")).not.toBeInTheDocument();
    expect(screen.queryByText("Sidebar controls")).not.toBeInTheDocument();
  });
});
