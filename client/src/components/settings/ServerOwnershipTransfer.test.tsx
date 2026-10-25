import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ServerOwnershipTransfer from "./ServerOwnershipTransfer";

const mocks = vi.hoisted(() => ({ detail: vi.fn(), members: vi.fn(), transfer: vi.fn(), confirm: vi.fn(), update: vi.fn(), refresh: vi.fn(), generation: 1, owner: "a" }));
const t = (key: string) => key;
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t }), initReactI18next: { type: "3rdParty", init: () => {} } }));
vi.mock("../../api/serverOwnership", () => ({ getOwnershipServer: mocks.detail, getOwnershipMembers: mocks.members, transferServerOwnership: mocks.transfer }));
vi.mock("../../api/client", () => ({ getAuthGeneration: () => mocks.generation }));
vi.mock("../../stores/authStore", () => ({ useAuthStore: { getState: () => ({ user: { id: mocks.owner } }) } }));
vi.mock("../../stores/confirmStore", () => ({ useConfirmStore: { getState: () => ({ open: mocks.confirm }) } }));
vi.mock("../../stores/serverStore", () => ({ useServerStore: { getState: () => ({ handleServerUpdate: mocks.update }) } }));
vi.mock("../../stores/memberStore", () => ({ useMemberStore: { getState: () => ({ fetchMembers: mocks.refresh }) } }));
const server = { id: "s", name: "Owned", owner_id: "a" };
async function fill() {
  fireEvent.click(screen.getByRole("button", { name: "ownership.open" }));
  await waitFor(() => expect(screen.getByLabelText("ownership.target")).toBeEnabled());
  fireEvent.change(screen.getByLabelText("ownership.target"), { target: { value: "b" } });
  fireEvent.change(screen.getByLabelText("currentPassword"), { target: { value: "current-password" } });
  fireEvent.change(screen.getByLabelText("ownership.type"), { target: { value: "TRANSFER" } });
  fireEvent.click(screen.getByRole("checkbox"));
}
describe("ServerOwnershipTransfer", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.owner = "a"; mocks.generation = 1;
    mocks.detail.mockResolvedValue({ success: true, data: server });
    mocks.members.mockResolvedValue({ success: true, data: [{ id: "a", username: "self" }, { id: "b", username: "recipient", display_name: "Recipient" }] });
    mocks.confirm.mockResolvedValue(true);
    mocks.transfer.mockResolvedValue({ success: true, data: { ...server, owner_id: "b" } });
  });
  it("requires full explicit consent and retains the form on final cancellation", async () => {
    mocks.confirm.mockResolvedValue(false);
    render(<ServerOwnershipTransfer userID="a" serverID="s" />); await fill();
    expect(screen.queryByRole("option", { name: /self/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "ownership.transfer" }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    expect(mocks.transfer).not.toHaveBeenCalled();
    expect(screen.getByLabelText("currentPassword")).toHaveValue("current-password");
  });
  it("updates only the acknowledged server and refreshes its protected role", async () => {
    const done = vi.fn(); render(<ServerOwnershipTransfer userID="a" serverID="s" onTransferred={done} />); await fill();
    fireEvent.click(screen.getByRole("button", { name: "ownership.transfer" }));
    await screen.findByText("ownership.success");
    expect(mocks.transfer).toHaveBeenCalledExactlyOnceWith("a", "s", "b", "current-password", "", "TRANSFER", expect.any(Function));
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith({ ...server, owner_id: "b" });
    expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith("s", true); expect(done).toHaveBeenCalledTimes(1);
  });
  it("requires a fresh check after an uncertain response and preserves credentials", async () => {
    mocks.transfer.mockResolvedValue({ success: true, data: { ...server, owner_id: "other" } });
    render(<ServerOwnershipTransfer userID="a" serverID="s" />); await fill();
    fireEvent.click(screen.getByRole("button", { name: "ownership.transfer" })); await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "ownership.transfer" })).toBeDisabled();
    expect(screen.getByLabelText("currentPassword")).toHaveValue("current-password"); expect(mocks.update).not.toHaveBeenCalled();
  });
  it("fails closed if refreshed ownership belongs to someone else", async () => {
    mocks.detail.mockResolvedValue({ success: true, data: { ...server, owner_id: "other" } });
    render(<ServerOwnershipTransfer userID="a" serverID="s" />);
    fireEvent.click(screen.getByRole("button", { name: "ownership.open" })); await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "ownership.transfer" })).toBeDisabled(); expect(mocks.transfer).not.toHaveBeenCalled();
  });
  it("ignores a late acknowledgement after switching accounts", async () => {
    let finish!: (value: unknown) => void;
    mocks.transfer.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const done = vi.fn(); render(<ServerOwnershipTransfer userID="a" serverID="s" onTransferred={done} />); await fill();
    fireEvent.click(screen.getByRole("button", { name: "ownership.transfer" })); await waitFor(() => expect(mocks.transfer).toHaveBeenCalled());
    mocks.generation++;
    await act(async () => finish({ success: true, data: { ...server, owner_id: "b" } }));
    expect(done).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled();
  });
  it("blocks duplicate submit while the confirmation dialog is pending", async () => {
    let finish!: (value: boolean) => void; mocks.confirm.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(<ServerOwnershipTransfer userID="a" serverID="s" />); await fill();
    fireEvent.click(screen.getByRole("button", { name: "ownership.transfer" })); fireEvent.click(screen.getByRole("button", { name: "ownership.transfer" }));
    expect(mocks.confirm).toHaveBeenCalledTimes(1); await act(async () => finish(true));
    await screen.findByText("ownership.success"); expect(mocks.transfer).toHaveBeenCalledTimes(1);
  });
});
