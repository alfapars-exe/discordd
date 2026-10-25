import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import LinkedGameSettings from "./LinkedGameSettings";

const f = vi.hoisted(() => ({ list: vi.fn(), update: vi.fn(), revoke: vi.fn(), confirm: vi.fn(), owner: "u1", generation: 1 }));
const t = (key: string) => key;
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t }) }));
vi.mock("../../api/gameApplications", () => ({ listGameApplicationGrants: f.list, updateGameApplicationGrant: f.update, revokeGameApplicationGrant: f.revoke }));
vi.mock("../../api/client", () => ({ getAuthGeneration: () => f.generation }));
vi.mock("../../stores/authStore", () => {
  const state = () => ({ user: { id: f.owner } });
  return { useAuthStore: Object.assign((selector: (value: ReturnType<typeof state>) => unknown) => selector(state()), { getState: state }) };
});
vi.mock("../../stores/confirmStore", () => ({ useConfirmStore: { getState: () => ({ open: f.confirm }) } }));
vi.mock("./settingsWorkspaceContext", () => ({ useSettingsDraft: vi.fn() }));

const grant = { application_id: "app1", application_name: "Test Game", application_username: "testgame", messaging_enabled: true, revision: 3, authorized_at: "2026-10-25", updated_at: "2026-10-25" };
beforeEach(() => {
  vi.resetAllMocks(); f.owner = "u1"; f.generation = 1;
  f.list.mockResolvedValue({ success: true, data: { grants: [grant] } }); f.confirm.mockResolvedValue(true);
});

it("shows the real empty state and does not claim a failed load is empty", async () => {
  f.list.mockResolvedValueOnce({ success: false });
  render(<LinkedGameSettings />);
  expect(await screen.findByRole("alert")).toHaveTextContent("linkedGames.loadError");
  expect(screen.queryByText("linkedGames.empty")).toBeNull();
  f.list.mockResolvedValueOnce({ success: true, data: { grants: [] } });
  fireEvent.click(screen.getByRole("button", { name: "applications.refresh" }));
  expect(await screen.findByText("linkedGames.empty")).toBeVisible();
});

it("does not toggle until the server acknowledges the exact revisioned grant", async () => {
  let finish!: (value: unknown) => void;
  f.update.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  render(<LinkedGameSettings />); const toggle = await screen.findByRole("switch");
  fireEvent.click(toggle);
  expect(toggle).toBeChecked(); expect(toggle).toBeDisabled();
  expect(f.update).toHaveBeenCalledWith("app1", 3, false, expect.any(Function));
  await act(async () => finish({ success: true, data: { ...grant, revision: 4, messaging_enabled: false } }));
  expect(toggle).not.toBeChecked(); expect(toggle).toBeEnabled();
});

it("refreshes a conflict and preserves the server's current choice", async () => {
  f.update.mockResolvedValueOnce({ success: false, code: "CONFLICT" });
  render(<LinkedGameSettings />); fireEvent.click(await screen.findByRole("switch"));
  expect(await screen.findByRole("alert")).toHaveTextContent("linkedGames.conflict");
  await waitFor(() => expect(f.list).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("switch")).toBeChecked();
});

it("requires explicit authorization and starts a new grant at revision zero", async () => {
  f.list.mockResolvedValue({ success: true, data: { grants: [] } });
  f.update.mockResolvedValueOnce({ success: true, data: { ...grant, revision: 1 } });
  render(<LinkedGameSettings />); await screen.findByText("linkedGames.empty");
  fireEvent.change(screen.getByLabelText("linkedGames.applicationID"), { target: { value: "app1" } });
  fireEvent.click(screen.getByRole("button", { name: "linkedGames.authorize" }));
  expect(await screen.findByText("Test Game")).toBeVisible();
  expect(f.confirm).toHaveBeenCalledOnce();
  expect(f.update).toHaveBeenCalledWith("app1", 0, true, expect.any(Function));
});

it("revokes only after confirmation and shows the returned revoked record", async () => {
  f.revoke.mockResolvedValueOnce({ success: true, data: { ...grant, messaging_enabled: false, revision: 4, revoked_at: "2026-10-25" } });
  render(<LinkedGameSettings />); await screen.findByText("Test Game");
  fireEvent.click(screen.getByRole("button", { name: "linkedGames.revoke" }));
  expect(await screen.findByText("linkedGames.revoked")).toBeVisible();
  expect(f.revoke).toHaveBeenCalledWith("app1", 3, expect.any(Function));
  expect(screen.queryByRole("switch")).toBeNull();
});

it("ignores a delayed mutation after account/session changes", async () => {
  let finish!: (value: unknown) => void;
  f.update.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  render(<LinkedGameSettings />); fireEvent.click(await screen.findByRole("switch"));
  f.owner = "u2"; f.generation++;
  await act(async () => finish({ success: true, data: { ...grant, messaging_enabled: false, revision: 4 } }));
  expect(screen.getByRole("switch")).toBeChecked();
  expect(screen.queryByRole("alert")).toBeNull();
});
