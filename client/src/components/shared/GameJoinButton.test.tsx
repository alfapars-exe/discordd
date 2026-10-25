import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAuthStore } from "../../stores/authStore";
import { useVoiceStore } from "../../stores/voiceStore";
import { clearTokens } from "../../api/client";
import { getGameJoinTargets, mintGameJoinTicket, consumeGameJoinTicket } from "../../api/gameJoin";
import { dispatchConsumedGameJoin } from "../../utils/gameJoin";
import GameJoinButton from "./GameJoinButton";
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }), initReactI18next: { type: "3rdParty", init: () => {} } }));
vi.mock("../../api/gameJoin", () => ({ getGameJoinTargets: vi.fn(), mintGameJoinTicket: vi.fn(), consumeGameJoinTicket: vi.fn() }));
vi.mock("../../utils/gameJoin", async original => ({ ...await original<typeof import("../../utils/gameJoin")>(), dispatchConsumedGameJoin: vi.fn(() => true) }));
const ticket = () => ({ ticket_id: "12345678-1234-4234-8234-123456789abc", ticket: "a".repeat(43), viewer_user_id: "viewer", target_user_id: "target", offer_revision: 7, expires_at: new Date(Date.now() + 20_000).toISOString(), adapter: "cs2-steam" as const });
beforeEach(() => {
  vi.clearAllMocks(); clearTokens(); delete window.electronAPI;
  useAuthStore.setState({ user: { id: "viewer" } as never });
  useVoiceStore.setState({ currentVoiceChannelId: null, currentVoiceServerId: null, voiceStates: {} });
  vi.mocked(getGameJoinTargets).mockResolvedValue({ success: true, data: { targets: [{ target_user_id: "target", context: "friend", joinable: true, offer_revision: 7 }] } });
  vi.mocked(mintGameJoinTicket).mockImplementation(async () => ({ success: true, data: ticket() }));
  vi.mocked(consumeGameJoinTicket).mockResolvedValue({ success: true, data: { ...ticket(), recipe: { adapter: "cs2-steam", lobbyId: "invalid", inviterId: "invalid" } } });
});
afterEach(() => cleanup());
it("makes no N+1 presence requests and requires a separate explicit launch click", async () => {
  render(<GameJoinButton userId="target" />);
  await act(async () => {});
  expect(getGameJoinTargets).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "gameJoinCheck" }));
  await screen.findByRole("button", { name: "gameJoinOpenSteam" });
  expect(consumeGameJoinTicket).not.toHaveBeenCalled(); expect(dispatchConsumedGameJoin).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "gameJoinOpenSteam" }));
  await waitFor(() => expect(dispatchConsumedGameJoin).toHaveBeenCalledTimes(1));
  expect(screen.getByRole("status")).toHaveTextContent("gameJoinForwarded");
});
it("does not mint or launch when fresh server eligibility denies", async () => {
  vi.mocked(getGameJoinTargets).mockResolvedValue({ success: true, data: { targets: [{ target_user_id: "target", context: "friend", joinable: false }] } });
  render(<GameJoinButton userId="target" />); await act(async () => {});
  fireEvent.click(screen.getByRole("button")); await screen.findByText("gameJoinUnavailable");
  expect(mintGameJoinTicket).not.toHaveBeenCalled(); expect(dispatchConsumedGameJoin).not.toHaveBeenCalled();
});
it("discards a delayed minted ticket after account replacement", async () => {
  let resolve!: (value: Awaited<ReturnType<typeof mintGameJoinTicket>>) => void;
  vi.mocked(mintGameJoinTicket).mockImplementation(() => new Promise(done => { resolve = done; }));
  render(<GameJoinButton userId="target" />); await act(async () => {});
  fireEvent.click(screen.getByRole("button")); await waitFor(() => expect(mintGameJoinTicket).toHaveBeenCalled());
  act(() => useAuthStore.setState({ user: { id: "other" } as never }));
  await act(async () => { resolve({ success: true, data: ticket() }); });
  expect(screen.queryByRole("button", { name: "gameJoinOpenSteam" })).not.toBeInTheDocument();
  expect(dispatchConsumedGameJoin).not.toHaveBeenCalled();
});
it("never dispatches a consumed invitation after its target UI unmounts", async () => {
  let done!: (value: Awaited<ReturnType<typeof consumeGameJoinTicket>>) => void;
  vi.mocked(consumeGameJoinTicket).mockImplementation(() => new Promise(resolve => { done = resolve; }));
  const view = render(<GameJoinButton userId="target" />); await act(async () => {});
  fireEvent.click(screen.getByRole("button")); await screen.findByRole("button", { name: "gameJoinOpenSteam" });
  fireEvent.click(screen.getByRole("button", { name: "gameJoinOpenSteam" }));
  await waitFor(() => expect(consumeGameJoinTicket).toHaveBeenCalled()); view.unmount();
  await act(async () => { done({ success: true, data: { ...ticket(), recipe: { adapter: "cs2-steam", lobbyId: "invalid", inviterId: "invalid" } } }); });
  expect(dispatchConsumedGameJoin).not.toHaveBeenCalled();
});
