import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import AccountStatusSettings from "./AccountStatusSettings";

const mocks = vi.hoisted(() => ({ get: vi.fn(), generation: 1, owner: "a" }));
const t = (key: string) => key;
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t, i18n: { language: "en" } }), initReactI18next: { type: "3rdParty", init: () => {} } }));
vi.mock("../../api/accountStatus", () => ({ getAccountStatus: mocks.get }));
vi.mock("../../api/client", () => ({ getAuthGeneration: () => mocks.generation }));
vi.mock("../../stores/authStore", () => ({ useAuthStore: { getState: () => ({ user: { id: mocks.owner } }) } }));
const item = (id: string, kind = "ban") => ({ kind, server_id: id, server_name: `Server-${id}`, reason: `<script>not HTML</script> ${id}`, created_at: 1700000000, expires_at: null });
const response = (items = [item("one")], next: number | null = null) => ({ success: true, data: { platform_banned: false, checked_at: 1700000000, restrictions: items, next_offset: next } });
describe("AccountStatusSettings", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.owner = "a"; mocks.generation = 1; });
  it("does not show healthy or empty status after a failed check", async () => {
    mocks.get.mockResolvedValueOnce({ success: false });
    render(<AccountStatusSettings userID="a" />);
    await screen.findByRole("alert");
    expect(screen.queryByText("accountStatus.platformAllowed")).not.toBeInTheDocument();
    expect(screen.queryByText("accountStatus.none")).not.toBeInTheDocument();
    mocks.get.mockResolvedValueOnce(response([]));
    fireEvent.click(screen.getByRole("button", { name: "accountStatus.refresh" }));
    await screen.findByText("accountStatus.none");
  });
  it("renders actual records as text and loads more without losing prior rows", async () => {
    mocks.get.mockResolvedValueOnce(response([item("one")], 50)).mockResolvedValueOnce(response([item("two", "timeout")]));
    render(<AccountStatusSettings userID="a" />);
    await screen.findByText(/Server-one/);
    expect(screen.getByText("<script>not HTML</script> one")).toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "accountStatus.more" }));
    await screen.findByText(/Server-two/);
    expect(screen.getByText(/Server-one/)).toBeInTheDocument();
    expect(mocks.get).toHaveBeenLastCalledWith("a", 50, expect.any(Function));
  });
  it("ignores the response from a replaced login", async () => {
    let finish!: (value: unknown) => void;
    mocks.get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(<AccountStatusSettings userID="a" />); mocks.generation = 2;
    await act(async () => finish(response()));
    expect(screen.queryByText(/Server-one/)).not.toBeInTheDocument();
  });
});
