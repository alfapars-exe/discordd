import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import SessionSettings from "./SessionSettings";

const mocks = vi.hoisted(() => ({ list: vi.fn(), revoke: vi.fn(), confirm: vi.fn(), logout: vi.fn(), generation: 1, owner: "a" }));
const t = (key: string) => key;
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t, i18n: { language: "en" } }), initReactI18next: { type: "3rdParty", init: () => {} } }));
vi.mock("../../api/sessions", () => ({ getSessions: mocks.list, revokeSession: mocks.revoke }));
vi.mock("../../api/client", () => ({ getAuthGeneration: () => mocks.generation }));
vi.mock("../../stores/authStore", () => ({ useAuthStore: { getState: () => ({ user: { id: mocks.owner }, logout: mocks.logout }) } }));
vi.mock("../../stores/confirmStore", () => ({ useConfirmStore: { getState: () => ({ open: mocks.confirm }) } }));

const row = (id: string, current = false) => ({ id, current, client_type: "web", user_agent: `Agent-${id}`, created_at: 1700000000, last_active_at: 1700000020, expires_at: 1800000000 });
const data = () => ({ success: true, data: { sessions: [row("current", true), row("other")], current_session_id: "current" } });
function fill(password = "current-password") { fireEvent.change(screen.getByLabelText("currentPassword"), { target: { value: password } }); }

describe("SessionSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.owner = "a"; mocks.generation = 1;
    mocks.list.mockResolvedValue(data()); mocks.confirm.mockResolvedValue(true);
    mocks.revoke.mockResolvedValue({ success: true, data: { revoked_count: 1, current_revoked: false } });
  });
  it("shows real current/other rows and requires approval before ending one", async () => {
    render(<SessionSettings userID="a" />); await screen.findByText("Agent-other");
    expect(screen.getByText(/sessions.current/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "sessions.revoke" })).toBeDisabled();
    fill(); mocks.confirm.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "sessions.revoke" }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled()); expect(mocks.revoke).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "sessions.revoke" })).toBeEnabled());
    mocks.list.mockResolvedValue({ success: true, data: { sessions: [row("current", true)], current_session_id: "current" } });
    fireEvent.click(screen.getByRole("button", { name: "sessions.revoke" }));
    await waitFor(() => expect(mocks.revoke).toHaveBeenCalledWith("a", "other", "current-password", "", expect.any(Function)));
    await waitFor(() => expect(screen.queryByText("Agent-other")).not.toBeInTheDocument());
    expect(mocks.logout).not.toHaveBeenCalled();
  });
  it("uses local-only sign-out after ending the current session", async () => {
    mocks.revoke.mockResolvedValue({ success: true, data: { revoked_count: 1, current_revoked: true } });
    render(<SessionSettings userID="a" />); await screen.findByText("Agent-current"); fill();
    fireEvent.click(screen.getByRole("button", { name: "sessions.revokeCurrent" }));
    await waitFor(() => expect(mocks.logout).toHaveBeenCalledWith({ localOnly: true, expectedUserId: "a" }));
  });
  it("preserves credentials on an MFA failure without success feedback", async () => {
    mocks.revoke.mockResolvedValue({ success: false, code: "MFA_REQUIRED" });
    render(<SessionSettings userID="a" />); await screen.findByText("Agent-other"); fill();
    fireEvent.click(screen.getByRole("button", { name: "sessions.revokeOthers" }));
    await screen.findByText("sessions.factorRequired");
    expect(screen.getByLabelText("currentPassword")).toHaveValue("current-password");
    expect(screen.queryByText("sessions.revoked")).not.toBeInTheDocument();
  });
  it("does not apply a late destructive result after a replacement login", async () => {
    let finish!: (value: unknown) => void;
    mocks.revoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(<SessionSettings userID="a" />); await screen.findByText("Agent-current"); fill();
    fireEvent.click(screen.getByRole("button", { name: "sessions.revokeCurrent" }));
    await waitFor(() => expect(mocks.revoke).toHaveBeenCalled()); mocks.generation = 2;
    await act(async () => finish({ success: true, data: { revoked_count: 1, current_revoked: true } }));
    expect(mocks.logout).not.toHaveBeenCalled();
  });
  it("does not let the initial list overwrite a newer refresh", async () => {
    let finish!: (value: unknown) => void;
    mocks.list.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    mocks.list.mockResolvedValueOnce({ success: true, data: { sessions: [row("fresh", true)], current_session_id: "fresh" } });
    render(<SessionSettings userID="a" />);
    fireEvent.click(screen.getByRole("button", { name: "sessions.refresh" }));
    await screen.findByText("Agent-fresh");
    await act(async () => finish(data()));
    expect(screen.getByText("Agent-fresh")).toBeInTheDocument();
    expect(screen.queryByText("Agent-other")).not.toBeInTheDocument();
  });
});
