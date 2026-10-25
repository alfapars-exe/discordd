import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ServerRail from "./ServerRail";

const state = vi.hoisted(() => ({
  servers: [
    { id: "server-1", name: "Alpha", icon_url: null },
    { id: "server-2", name: "Beta", icon_url: null },
  ],
  reorderServers: vi.fn(),
  toast: vi.fn(),
  ui: { destination: { serverInfo: { serverId: "server-1" } }, navigate: vi.fn(), openServer: vi.fn() },
}));

vi.mock("../../stores/serverStore", () => ({ useServerStore: (select: (value: unknown) => unknown) => select({ servers: state.servers, mutedServerIds: new Set(), reorderServers: state.reorderServers }) }));
vi.mock("../../stores/authStore", () => ({ useAuthStore: (select: (value: unknown) => unknown) => select({ user: { id: "user-1" } }) }));
vi.mock("../../stores/uiStore", () => ({ useUIStore: Object.assign((select: (value: unknown) => unknown) => select(state.ui), { getState: () => state.ui }) }));
vi.mock("../../stores/readStateStore", () => ({ useReadStateStore: (select: (value: unknown) => unknown) => select({ unreadCounts: {}, channelServerMap: {} }) }));
vi.mock("../../stores/dmStore", () => ({ useDMStore: (select: (value: unknown) => unknown) => select({ dmUnreadCounts: {} }) }));
vi.mock("../../stores/toastStore", () => ({ useToastStore: Object.assign((select: (value: unknown) => unknown) => select({ addToast: state.toast }), { getState: () => ({ addToast: state.toast }) }) }));
vi.mock("../../utils/constants", () => ({ publicAsset: (value: string) => value, resolveAssetUrl: (value: string) => value, ALLOW_SERVER_CREATION: false }));
vi.mock("../../api/client", () => ({ getAuthGeneration: () => 1 }));
vi.mock("../servers/AddServerModal", () => ({ default: () => <div data-testid="add-server-modal" /> }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }), initReactI18next: { type: "3rdParty", init: () => {} } }));

describe("ServerRail keyboard reordering", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("previews, then commits the current server order on Enter", async () => {
    state.reorderServers.mockResolvedValue(true);
    render(<ServerRail />);
    const alpha = screen.getByRole("button", { name: "Alpha" });
    fireEvent.keyDown(alpha, { key: "d", code: "KeyD", ctrlKey: true });
    fireEvent.keyDown(alpha, { key: "ArrowDown", code: "ArrowDown" });
    expect(screen.getAllByRole("button").filter((button) => ["Alpha", "Beta"].includes(button.getAttribute("title") ?? "")).map((button) => button.getAttribute("title"))).toEqual(["Beta", "Alpha"]);
    expect(state.reorderServers).not.toHaveBeenCalled();

    fireEvent.keyDown(alpha, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(state.reorderServers).toHaveBeenCalledWith([
      { id: "server-2", position: 0 },
      { id: "server-1", position: 1 },
    ]));
  });

  it("does not expose the manual add-server button in single-server mode", () => {
    render(<ServerRail />);
    expect(screen.queryByRole("button", { name: "addServer" })).not.toBeInTheDocument();
  });
});
