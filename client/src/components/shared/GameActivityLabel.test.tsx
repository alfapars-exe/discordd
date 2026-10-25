import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearTokens } from "../../api/client";
import { useAuthStore } from "../../stores/authStore";
import { useBlockStore } from "../../stores/blockStore";
import { usePresenceStore } from "../../stores/presenceStore";
import { useGameActivityStore } from "../../stores/gameActivityStore";
import GameActivityLabel from "./GameActivityLabel";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, values?: { name?: string }) => values?.name ?? key }), initReactI18next: { type: "3rdParty", init: () => {} } }));
const game = { id: "game", name: "Example", started_at: "2026-10-24T12:00:00Z" };
beforeEach(() => {
  clearTokens();
  useAuthStore.setState({ user: { id: "viewer" } as never });
  useBlockStore.setState({ blockedUserIds: [] });
  usePresenceStore.setState({ statusByUserId: {} });
  useGameActivityStore.getState().start("epoch-a");
});
afterEach(() => cleanup());

it("does not reuse a scoped server grant in another server or globally", () => {
  useGameActivityStore.getState().apply({ epoch: "epoch-a", user_id: "target", server_id: "allowed", game, revision: 1 });
  const view = render(<GameActivityLabel userId="target" serverId="other" />);
  expect(screen.queryByText("Example")).not.toBeInTheDocument();
  view.rerender(<GameActivityLabel userId="target" />);
  expect(screen.queryByText("Example")).not.toBeInTheDocument();
  view.rerender(<GameActivityLabel userId="target" serverId="allowed" />);
  expect(screen.getByText("Example")).toHaveAttribute("title", "gameActivitySelfReported");
});

it("hides immediately for blocking, offline presence and a server revoke", () => {
  useGameActivityStore.getState().apply({ epoch: "epoch-a", user_id: "target", game, revision: 1 });
  render(<GameActivityLabel userId="target" />);
  expect(screen.getByText("Example")).toBeInTheDocument();
  act(() => useBlockStore.setState({ blockedUserIds: ["target"] }));
  expect(screen.queryByText("Example")).not.toBeInTheDocument();
  act(() => { useBlockStore.setState({ blockedUserIds: [] }); usePresenceStore.setState({ statusByUserId: { target: "offline" } }); });
  expect(screen.queryByText("Example")).not.toBeInTheDocument();
  act(() => { usePresenceStore.setState({ statusByUserId: { target: "online" } }); useGameActivityStore.getState().apply({ epoch: "epoch-a", user_id: "target", game: null, revision: 2 }); });
  expect(screen.queryByText("Example")).not.toBeInTheDocument();
});

it("does not display another signed-in account's cached grants", () => {
  useGameActivityStore.getState().apply({ epoch: "epoch-a", user_id: "target", game, revision: 1 });
  render(<GameActivityLabel userId="target" />);
  act(() => useAuthStore.setState({ user: { id: "other" } as never }));
  expect(screen.queryByText("Example")).not.toBeInTheDocument();
});
