import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ApplicationSettings from "./ApplicationSettings";

const mocks = vi.hoisted(() => ({ registerGame: vi.fn(), list: vi.fn(), manifests: vi.fn(), saveManifest: vi.fn(), testAction: vi.fn(), incoming: vi.fn(), create: vi.fn(), revoke: vi.fn(), remove: vi.fn(), requestTransfer: vi.fn(), resolveTransfer: vi.fn(), confirm: vi.fn(), generation: 1, owner: "owner" }));
const t = (key: string) => key;
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t }), initReactI18next: { type: "3rdParty", init: () => {} } }));
vi.mock("../../api/applications", () => ({ listApplications: mocks.list, listApplicationManifests: mocks.manifests, saveApplicationManifest: mocks.saveManifest, invokeApplicationTest: mocks.testAction, listIncomingApplicationTransfers: mocks.incoming, createApplication: mocks.create, revokeApplicationCredentials: mocks.revoke, removeApplication: mocks.remove, requestApplicationTransfer: mocks.requestTransfer, resolveApplicationTransfer: mocks.resolveTransfer }));
vi.mock("../../api/client", () => ({ getAuthGeneration: () => mocks.generation }));
vi.mock("../../api/gameApplications", () => ({ registerGameApplication: mocks.registerGame }));
vi.mock("../../stores/authStore", () => {
  const state = () => ({ user: { id: mocks.owner } });
  const hook = (selector: (value: ReturnType<typeof state>) => unknown) => selector(state());
  Object.assign(hook, { getState: state });
  return { useAuthStore: hook };
});
vi.mock("../../stores/confirmStore", () => ({ useConfirmStore: { getState: () => ({ open: mocks.confirm }) } }));
vi.mock("./settingsWorkspaceContext", () => ({ useSettingsDraft: vi.fn() }));

const app = { id: "app-1", username: "helperbot", display_name: "Helper", created_at: "2026-10-23", is_bot: true as const };

describe("ApplicationSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.owner = "owner"; mocks.generation = 1;
    mocks.list.mockResolvedValue({ success: true, data: { bots: [app] } });
    mocks.manifests.mockResolvedValue({ success: true, data: { applications: [] } });
    mocks.incoming.mockResolvedValue({ success: true, data: { requests: [] } });
    mocks.confirm.mockResolvedValue(true);
    mocks.revoke.mockResolvedValue({ success: true });
    mocks.remove.mockResolvedValue({ success: true, data: { removed: true, shared_history: "retained", personal_asset_cleanup: "queued" } });
  });

  it("requires explicit confirmation before permanent game identity registration", async () => {
    mocks.registerGame.mockResolvedValueOnce({ success: true, data: { application_id: "app-1", is_game_application: true } });
    render(<ApplicationSettings />); await screen.findByText("Helper");
    fireEvent.click(screen.getByRole("button", { name: "linkedGames.register" }));
    expect(await screen.findByText("linkedGames.registered")).toBeVisible();
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ message: "linkedGames.registerConfirm" }));
    expect(mocks.registerGame).toHaveBeenCalledWith("app-1", expect.any(Function));
  });

  it("shows a newly minted token once without persisting it in the list response", async () => {
    mocks.create.mockResolvedValue({ success: true, data: { bot: { ...app, id: "app-2", username: "newbot" }, token: "hb_one_time" } });
    render(<ApplicationSettings />);
    await screen.findByText("Helper");
    fireEvent.change(screen.getByLabelText("applications.username"), { target: { value: "newbot" } });
    fireEvent.change(screen.getByLabelText("applications.displayName"), { target: { value: "New Bot" } });
    fireEvent.click(screen.getByRole("button", { name: "applications.create" }));
    expect(await screen.findByDisplayValue("hb_one_time")).toBeVisible();
    expect(mocks.create).toHaveBeenCalledWith("newbot", "New Bot", expect.any(Function));
    fireEvent.click(screen.getByRole("button", { name: "applications.tokenSaved" }));
    expect(screen.queryByDisplayValue("hb_one_time")).toBeNull();
  });

  it("requires typed consent and preserves shared-history acknowledgement", async () => {
    render(<ApplicationSettings />);
    await screen.findByText("Helper");
    fireEvent.click(screen.getByRole("button", { name: "applications.remove" }));
    const confirmRemoval = screen.getByRole("button", { name: "applications.confirmRemove" });
    expect(confirmRemoval).toBeDisabled();
    fireEvent.change(screen.getByLabelText("currentPassword"), { target: { value: "current-password" } });
    fireEvent.change(screen.getByLabelText("applications.typeRemove"), { target: { value: "REMOVE" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(confirmRemoval);
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith("owner", "app-1", "current-password", "", "REMOVE", expect.any(Function)));
    expect(await screen.findByText("applications.removed")).toBeVisible();
    expect(screen.queryByText("Helper")).toBeNull();
  });

  it("ignores a late successful removal after the account changes", async () => {
    let finish!: (value: unknown) => void;
    mocks.remove.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(<ApplicationSettings />); await screen.findByText("Helper");
    fireEvent.click(screen.getByRole("button", { name: "applications.remove" }));
    fireEvent.change(screen.getByLabelText("currentPassword"), { target: { value: "current-password" } });
    fireEvent.change(screen.getByLabelText("applications.typeRemove"), { target: { value: "REMOVE" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "applications.confirmRemove" }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalled());
    mocks.generation = 2;
    await act(async () => finish({ success: true, data: { removed: true, shared_history: "retained", personal_asset_cleanup: "queued" } }));
    expect(screen.getByText("Helper")).toBeVisible();
    expect(screen.queryByText("applications.removed")).toBeNull();
  });

  it("requires recipient acceptance and exposes only the rotated token", async () => {
    mocks.incoming.mockResolvedValueOnce({ success: true, data: { requests: [{ id: "tr-1", application_id: "incoming-app", application_username: "incomingbot", application_name: "Incoming", from_user_id: "sender", from_name: "Sender", to_user_id: "owner", created_at: "2026-10-23", expires_at: "2026-10-30" }] } });
    mocks.resolveTransfer.mockResolvedValue({ success: true, data: { accepted: true, token: "hb_rotated" } });
    render(<ApplicationSettings />);
    await screen.findByText("Incoming");
    fireEvent.click(screen.getByRole("button", { name: "applications.acceptTransfer" }));
    await waitFor(() => expect(mocks.resolveTransfer).toHaveBeenCalledWith("tr-1", true, expect.any(Function)));
    expect(await screen.findByDisplayValue("hb_rotated")).toBeVisible();
    expect(await screen.findByText("applications.transferAccepted")).toBeVisible();
  });
});
