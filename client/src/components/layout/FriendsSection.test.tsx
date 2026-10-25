import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import FriendsSection from "./FriendsSection";
import { useFriendStore } from "../../stores/friendStore";
import { useDMStore } from "../../stores/dmStore";
import { useUIStore } from "../../stores/uiStore";
import { useMobileStore } from "../../stores/mobileStore";
import { useToastStore } from "../../stores/toastStore";
import { useSidebarStore } from "../../stores/sidebarStore";

vi.mock("react-i18next", async (importOriginal) => ({
  ...await importOriginal<typeof import("react-i18next")>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("../shared/Avatar", () => ({ default: () => null }));

describe("sidebar friend navigation", () => {
  beforeEach(() => {
    useSidebarStore.setState({ expandedSections: { friends: true } });
    useFriendStore.setState({ incoming: [], friends: [{
      id: "friendship", status: "accepted", created_at: "2026-10-22",
      user_id: "alice", username: "alice", display_name: "Alice",
      avatar_url: null, user_status: "online", user_custom_status: null,
    }] });
    useDMStore.setState({ createOrGetChannel: vi.fn().mockResolvedValue("conversation"), selectDM: vi.fn(), clearDMUnread: vi.fn(), fetchMessages: vi.fn().mockResolvedValue(undefined) });
    useUIStore.setState({ openTab: vi.fn() });
    useMobileStore.setState({ closeAllDrawers: vi.fn() });
    useToastStore.setState({ addToast: vi.fn() });
  });

  it("opens the selected friend's conversation and closes the mobile drawer", async () => {
    render(<FriendsSection onShowUserCard={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Alice" }));
    await waitFor(() => expect(useUIStore.getState().openTab).toHaveBeenCalledWith("conversation", "dm", "Alice"));
    expect(useDMStore.getState().createOrGetChannel).toHaveBeenCalledWith("alice");
    expect(useDMStore.getState().clearDMUnread).toHaveBeenCalledWith("conversation");
    expect(useMobileStore.getState().closeAllDrawers).toHaveBeenCalled();
  });

  it("keeps navigation in place and explains a failed conversation request", async () => {
    useDMStore.setState({ createOrGetChannel: vi.fn().mockResolvedValue(null) });
    render(<FriendsSection onShowUserCard={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Alice" }));
    await waitFor(() => expect(useToastStore.getState().addToast).toHaveBeenCalledWith("error", "dmOpenFailed"));
    expect(useUIStore.getState().openTab).not.toHaveBeenCalled();
    expect(useMobileStore.getState().closeAllDrawers).not.toHaveBeenCalled();
  });
});
