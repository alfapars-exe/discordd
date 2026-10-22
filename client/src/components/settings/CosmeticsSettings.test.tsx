import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

import CosmeticsSettings from "./CosmeticsSettings";
import { useCosmeticsStore } from "../../stores/cosmeticsStore";
import { useServerStore } from "../../stores/serverStore";
import { useAuthStore } from "../../stores/authStore";
import type { CosmeticItem, MyCosmetics } from "../../types/cosmetics";
import type { User } from "../../types";

const item = (over: Partial<CosmeticItem> & Pick<CosmeticItem, "id" | "type" | "asset">): CosmeticItem => ({
  server_id: null,
  format: over.type === "avatar_frame" ? "svg" : "css",
  name: over.id,
  description: null,
  animated: false,
  availability: "free",
  created_at: "2026-10-01T00:00:00Z",
  ...over,
});

const ITEMS: CosmeticItem[] = [
  item({ id: "b_frame_aurora", type: "avatar_frame", asset: { v: 1, frame: "aurora" }, animated: true }),
  item({ id: "b_frame_frost", type: "avatar_frame", asset: { v: 1, frame: "frost" } }),
  // Corrupt asset: the tile must still render without crashing.
  item({ id: "b_frame_broken", type: "avatar_frame", asset: { v: 9, frame: "evil" } }),
  item({
    id: "b_name_gold",
    type: "name_style",
    asset: { v: 1, font: "bold", stops: ["#ffd166", "#ffb703"], angle: 90 },
  }),
];

function mine(over: Partial<MyCosmetics> = {}): MyCosmetics {
  return {
    items: ITEMS,
    grants: [],
    equipped: {
      global: {
        avatar_frame: { item_id: "b_frame_aurora", format: "svg", animated: true, asset: { v: 1, frame: "aurora" } },
        name_style: {
          item_id: "b_name_gold",
          format: "css",
          animated: false,
          asset: { v: 1, font: "bold", stops: ["#ffd166", "#ffb703"], angle: 90 },
        },
      },
      servers: {},
    },
    plain_server_ids: [],
    ...over,
  };
}

const equip = vi.fn();
const setPlainServer = vi.fn();
const loadMine = vi.fn(() => Promise.resolve());

beforeEach(() => {
  equip.mockReset();
  setPlainServer.mockReset();
  loadMine.mockClear();
  equip.mockResolvedValue({ success: true, data: mine() });
  setPlainServer.mockResolvedValue({ success: true, status: 204 });
  useCosmeticsStore.setState({ mine: mine(), mineStatus: "ready", equip, setPlainServer, loadMine });
  useServerStore.setState({ servers: [{ id: "s1", name: "Server One", icon_url: null }] });
  useAuthStore.setState({
    user: { id: "me", username: "alice", display_name: null, avatar_url: null, custom_status: null } as unknown as User,
  });
});

describe("CosmeticsSettings", () => {
  it("loads mine on open and lists the equipped slots", () => {
    render(<CosmeticsSettings />);
    expect(loadMine).toHaveBeenCalled();
    expect(screen.getAllByText("builtin.b_frame_aurora").length).toBeGreaterThan(0);
  });

  it("Save sends ONE equip call with only the changed slots", async () => {
    render(<CosmeticsSettings />);
    const save = screen.getByRole("button", { name: "save" });
    expect(save).toBeDisabled();

    fireEvent.click(screen.getByTestId("cos-tile-b_frame_frost"));
    expect(screen.getByTestId("cos-tile-b_frame_frost")).toHaveAttribute("aria-checked", "true");
    fireEvent.click(save);

    await waitFor(() => expect(equip).toHaveBeenCalledTimes(1));
    expect(equip).toHaveBeenCalledWith({ scope: "global", slots: { avatar_frame: "b_frame_frost" } });
  });

  it("picking an item and going back to the equipped one is not a change", () => {
    render(<CosmeticsSettings />);
    fireEvent.click(screen.getByTestId("cos-tile-b_frame_frost"));
    fireEvent.click(screen.getByTestId("cos-tile-b_frame_aurora"));
    expect(screen.getByRole("button", { name: "save" })).toBeDisabled();
  });

  it('"None" unequips with null', async () => {
    render(<CosmeticsSettings />);
    fireEvent.click(screen.getByTestId("cos-tile-none"));
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() => expect(equip).toHaveBeenCalledTimes(1));
    expect(equip).toHaveBeenCalledWith({ scope: "global", slots: { avatar_frame: null } });
  });

  it("collects changes across several slot tabs into the same request", async () => {
    render(<CosmeticsSettings />);
    fireEvent.click(screen.getByTestId("cos-tile-b_frame_frost"));
    fireEvent.click(screen.getByRole("tab", { name: /types\.name_style/ }));
    fireEvent.click(screen.getByTestId("cos-tile-none"));
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() => expect(equip).toHaveBeenCalledTimes(1));
    expect(equip).toHaveBeenCalledWith({
      scope: "global",
      slots: { avatar_frame: "b_frame_frost", name_style: null },
    });
  });

  it("in a server scope the plain switch calls setPlainServer", async () => {
    render(<CosmeticsSettings />);
    fireEvent.change(screen.getByLabelText("scope"), { target: { value: "s1" } });
    const toggle = screen.getByRole("switch", { name: "plainHere" });
    fireEvent.click(toggle);
    await waitFor(() => expect(setPlainServer).toHaveBeenCalledWith("s1", true));
  });

  it("server-scope Save targets that server", async () => {
    render(<CosmeticsSettings />);
    fireEvent.change(screen.getByLabelText("scope"), { target: { value: "s1" } });
    fireEvent.click(screen.getByTestId("cos-tile-b_frame_frost"));
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() => expect(equip).toHaveBeenCalledWith({ scope: "s1", slots: { avatar_frame: "b_frame_frost" } }));
  });

  it("renders a tile whose asset is invalid without crashing", () => {
    render(<CosmeticsSettings />);
    const tile = screen.getByTestId("cos-tile-b_frame_broken");
    expect(tile).toBeInTheDocument();
    expect(tile.querySelector("[data-testid='cos-frame']")).toBeNull();
  });

  it("hides the grants section while empty", () => {
    render(<CosmeticsSettings />);
    expect(screen.queryByText("grantsTitle")).toBeNull();
  });

  it("shows a rate-limit error toast on 429", async () => {
    equip.mockResolvedValue({ success: false, status: 429 });
    const { useToastStore } = await import("../../stores/toastStore");
    const addToast = vi.fn();
    useToastStore.setState({ addToast });
    render(<CosmeticsSettings />);
    fireEvent.click(screen.getByTestId("cos-tile-b_frame_frost"));
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() => expect(addToast).toHaveBeenCalledWith("error", "errors.rateLimited"));
  });
});
