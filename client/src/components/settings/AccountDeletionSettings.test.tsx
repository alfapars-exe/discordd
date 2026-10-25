import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import AccountDeletionSettings from "./AccountDeletionSettings";
const mocks = vi.hoisted(() => ({ get: vi.fn(), remove: vi.fn(), confirm: vi.fn(), logout: vi.fn(), setTab: vi.fn(), generation: 1, owner: "a" }));
const t = (key: string) => key;
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t }), initReactI18next: { type: "3rdParty", init: () => {} } }));
vi.mock("../../api/accountDeletion", () => ({ getDeletionStatus: mocks.get, deleteAccount: mocks.remove }));
vi.mock("./ServerOwnershipTransfer", () => ({ default: ({ userID, serverID }: { userID: string; serverID: string }) => <button>{`handoff:${userID}:${serverID}`}</button> }));
vi.mock("../../api/client", () => ({ getAuthGeneration: () => mocks.generation }));
vi.mock("../../stores/authStore", () => ({ useAuthStore: { getState: () => ({ user: { id: mocks.owner }, logout: mocks.logout }) } }));
vi.mock("../../stores/confirmStore", () => ({ useConfirmStore: { getState: () => ({ open: mocks.confirm }) } }));
vi.mock("../../stores/settingsStore", () => ({ useSettingsStore: { getState: () => ({ setActiveTab: mocks.setTab }) } }));
const status = { platform_admin: false, owned_count: 0, resources: [], next_offset: null, checked_at: 1 };
async function fill() {
  await waitFor(() => expect(screen.getByRole("button", { name: "deletion.refresh" })).toBeEnabled());
  fireEvent.change(screen.getByLabelText("currentPassword"), { target: { value: "current-password" } });
  fireEvent.change(screen.getByLabelText("deletion.type"), { target: { value: "DELETE" } });
  fireEvent.click(screen.getByRole("checkbox"));
}
describe("AccountDeletionSettings", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.generation = 1; mocks.owner = "a"; mocks.get.mockResolvedValue({ success: true, data: status }); mocks.confirm.mockResolvedValue(true); mocks.remove.mockResolvedValue({ success: true, data: { deleted: true, shared_history: "retained", personal_asset_cleanup: "queued" } }); });
  it("requires all explicit consent and preserves input after final cancellation", async () => {
    mocks.confirm.mockResolvedValue(false); render(<AccountDeletionSettings userID="a" />);
    expect(screen.getByRole("button", { name: "deletion.remove" })).toBeDisabled(); await fill();
    fireEvent.click(screen.getByRole("button", { name: "deletion.remove" }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    expect(mocks.remove).not.toHaveBeenCalled(); expect(screen.getByLabelText("currentPassword")).toHaveValue("current-password"); expect(screen.getByLabelText("deletion.type")).toHaveValue("DELETE");
  });
  it("never treats failed preflight as an empty safe account", async () => {
    mocks.get.mockResolvedValue({ success: false }); render(<AccountDeletionSettings userID="a" />); await screen.findByRole("alert"); await fill();
    expect(screen.getByRole("button", { name: "deletion.remove" })).toBeDisabled(); expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("keeps full ownership count blocking even beyond the last page", async () => {
    mocks.get.mockResolvedValue({ success: true, data: { ...status, owned_count: 51 } }); render(<AccountDeletionSettings userID="a" />); await fill();
    expect(screen.getByRole("button", { name: "deletion.remove" })).toBeDisabled(); expect(screen.getByText("deletion.handoff")).toBeVisible();
  });
  it("offers the real server handoff entry point without deleting the resource", async () => {
    mocks.get.mockResolvedValue({ success: true, data: { ...status, owned_count: 1, resources: [{ kind: "server", id: "s", name: "Owned" }] } });
    render(<AccountDeletionSettings userID="a" />);
    expect(await screen.findByRole("button", { name: "handoff:a:s" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "deletion.remove" })).toBeDisabled();
  });
  it("routes owned applications to their real management panel", async () => {
    mocks.get.mockResolvedValue({ success: true, data: { ...status, owned_count: 1, resources: [{ kind: "application", id: "app", name: "Helper" }] } });
    render(<AccountDeletionSettings userID="a" />);
    const button = await screen.findByRole("button", { name: "applications.title" });
    fireEvent.click(button);
    expect(mocks.setTab).toHaveBeenCalledWith("applications");
    expect(screen.getByRole("button", { name: "deletion.remove" })).toBeDisabled();
  });
  it("logs out only the intended local account after actual deletion acknowledgement", async () => {
    render(<AccountDeletionSettings userID="a" />); await fill(); fireEvent.click(screen.getByRole("button", { name: "deletion.remove" }));
    await waitFor(() => expect(mocks.logout).toHaveBeenCalledWith({ localOnly: true, expectedUserId: "a" }));
    expect(mocks.remove).toHaveBeenCalledWith("a", "current-password", "", "DELETE", expect.any(Function));
  });
  it("preserves credentials and requires a fresh check after failed or partial acknowledgement", async () => {
    mocks.remove.mockResolvedValue({ success: true, data: { deleted: true } }); render(<AccountDeletionSettings userID="a" />); await fill(); fireEvent.click(screen.getByRole("button", { name: "deletion.remove" }));
    await screen.findByRole("alert"); expect(mocks.logout).not.toHaveBeenCalled(); expect(screen.getByLabelText("currentPassword")).toHaveValue("current-password"); expect(screen.getByRole("button", { name: "deletion.remove" })).toBeDisabled();
  });
  it("ignores a successful old response after the login changes", async () => {
    let finish!: (value: unknown) => void; mocks.remove.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(<AccountDeletionSettings userID="a" />); await fill(); fireEvent.click(screen.getByRole("button", { name: "deletion.remove" }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalled()); mocks.generation = 2;
    await act(async () => finish({ success: true, data: { deleted: true, shared_history: "retained", personal_asset_cleanup: "queued" } })); expect(mocks.logout).not.toHaveBeenCalled();
  });
});
