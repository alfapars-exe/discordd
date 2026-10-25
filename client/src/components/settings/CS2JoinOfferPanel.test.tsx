import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { useAuthStore } from "../../stores/authStore";
import { useGameActivityStore } from "../../stores/gameActivityStore";
import { useGameJoinStore } from "../../stores/gameJoinStore";
import CS2JoinOfferPanel from "./CS2JoinOfferPanel";
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }), initReactI18next: { type: "3rdParty", init: () => {} } }));
const send = vi.fn();
const id = (kind: bigint, instance: bigint) => ((1n << 56n) | (kind << 52n) | (instance << 32n) | 123n).toString();
const invite = `steam://joinlobby/730/${id(8n, 1n << 18n)}/${id(1n, 1n)}`;
beforeEach(() => {
  vi.useFakeTimers(); send.mockClear();
  useAuthStore.setState({ user: { id: "owner" } as never });
  useGameActivityStore.getState().start("epoch"); useGameJoinStore.getState().register(send);
});
afterEach(() => { cleanup(); useGameJoinStore.getState().register(null); vi.useRealTimers(); });
it("requires an exact Steam CS2 link and shows active state only after correlated server acceptance", () => {
  render(<CS2JoinOfferPanel gameId="local-game" eligible />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "https://example.invalid" } });
  fireEvent.click(screen.getByRole("button", { name: "cs2OfferShare" }));
  expect(send).not.toHaveBeenCalled(); expect(screen.getByRole("alert")).toHaveTextContent("cs2OfferError");
  fireEvent.change(screen.getByRole("textbox"), { target: { value: invite } });
  fireEvent.click(screen.getByRole("button", { name: "cs2OfferShare" }));
  expect(screen.getByRole("status")).toHaveTextContent("cs2OfferPending");
  const request = send.mock.calls[0][1];
  act(() => useGameJoinStore.getState().acknowledge({ request_id: request.request_id, accepted: true, offer_revision: 8, expires_at: new Date(Date.now() + 90_000).toISOString() }));
  expect(screen.getByRole("status")).toHaveTextContent("cs2OfferActive");
  act(() => vi.advanceTimersByTime(91_000));
  expect(screen.queryByText("cs2OfferActive")).not.toBeInTheDocument();
  expect(send).toHaveBeenCalledTimes(1); // no automatic heartbeat/renewal
});
it("does not offer sharing for a stopped/unshared/unassociated source", () => {
  render(<CS2JoinOfferPanel gameId="local-game" eligible={false} />);
  expect(screen.getByRole("button", { name: "cs2OfferShare" })).toBeDisabled();
});
