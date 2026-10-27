import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProfileRequestContext, ProfileShowcase } from "../../api/profile";
import ProfileShowcaseEditor from "./ProfileShowcaseEditor";

const mocks = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), toast: vi.fn(), generation: 1, owner: "a", serverId: "s1" }));
const t = (key: string) => key;
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t }), initReactI18next: { type: "3rdParty", init: () => {} } }));
vi.mock("../../api/profile", () => ({ getProfileShowcase: mocks.get, saveProfileShowcase: mocks.save }));
vi.mock("../../api/client", () => ({ getAuthGeneration: () => mocks.generation }));
vi.mock("../../stores/authStore", () => {
  const state = () => ({ user: { id: mocks.owner } });
  const hook = (selector: (value: ReturnType<typeof state>) => unknown) => selector(state());
  Object.assign(hook, { getState: state });
  return { useAuthStore: hook };
});
vi.mock("../../stores/serverStore", () => ({ useServerStore: (selector: (value: unknown) => unknown) => selector({ activeServerId: mocks.serverId, activeServer: { name: "Server" } }) }));
vi.mock("../../stores/toastStore", () => ({ useToastStore: (selector: (value: unknown) => unknown) => selector({ addToast: mocks.toast }) }));
vi.mock("./settingsWorkspaceContext", () => ({ useSettingsDraft: vi.fn() }));

const showcase = (widgets: ProfileShowcase["widgets"] = [], links: ProfileShowcase["links"] = []): ProfileShowcase => ({ theme: { primary: "", secondary: "" }, watching: "", widgets, links, version: 1 });

describe("ProfileShowcaseEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.owner = "a"; mocks.generation = 1; mocks.serverId = "s1";
    mocks.get.mockResolvedValue({ success: true, data: showcase() });
    mocks.save.mockImplementation(async (data: ProfileShowcase) => ({ success: true, data: { ...data, version: 2 } }));
  });

  it("allows typing several games and saves only nonempty trimmed items", async () => {
    const user = userEvent.setup();
    mocks.get.mockResolvedValue({ success: true, data: showcase([{ id: "games", type: "liked_games", items: [] }]) });
    render(<ProfileShowcaseEditor />);
    const items = await screen.findByLabelText("profileWidgetItems");
    await user.type(items, "Counter Strike,  Deep Rock Galactic, ");
    expect(items).toHaveValue("Counter Strike,  Deep Rock Galactic, ");
    await user.click(screen.getByRole("button", { name: "saveChanges" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalled());
    expect(mocks.save.mock.calls[0][0].widgets[0].items).toEqual(["Counter Strike", "Deep Rock Galactic"]);
    await waitFor(() => expect(screen.getByRole("button", { name: "saveChanges" })).toBeDisabled());
  });

  it("does not let a filtered wishlist index reorder the wrong widget", async () => {
    const data = showcase([{ id: "other", type: "favorite_game" }, { id: "wish-a", type: "wishlist" }, { id: "middle", type: "liked_games" }, { id: "wish-b", type: "wishlist" }]);
    mocks.get.mockResolvedValue({ success: true, data });
    render(<ProfileShowcaseEditor />);
    await screen.findByRole("tab", { name: "profileTab_wishlist" });
    fireEvent.click(screen.getByRole("tab", { name: "profileTab_wishlist" }));
    const cards = document.querySelectorAll(".profile-widget-card");
    fireEvent.click(cards[1].querySelectorAll("button")[0]);
    fireEvent.click(screen.getByRole("button", { name: "saveChanges" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalled());
    const sent = mocks.save.mock.calls[0][0] as ProfileShowcase;
    expect(sent.widgets.map((widget) => widget.id)).toEqual(["other", "wish-a", "wish-b", "middle"]);
  });

  it("keeps a dirty server draft when the active server changes and restores it on return", async () => {
    mocks.get.mockImplementation(async (serverId: string | null) => ({ success: true, data: { ...showcase(), watching: serverId ? `server ${serverId}` : "global" } }));
    const view = render(<ProfileShowcaseEditor />);
    await screen.findByDisplayValue("global");
    fireEvent.click(screen.getByRole("button", { name: /profileScopeServer/ }));
    await waitFor(() => expect(screen.getByLabelText("profileWatching")).toHaveValue("server s1"));
    fireEvent.change(screen.getByLabelText("profileWatching"), { target: { value: "unsaved from s1" } });

    mocks.serverId = "s2";
    view.rerender(<ProfileShowcaseEditor />);
    await waitFor(() => expect(screen.getByLabelText("profileWatching")).toHaveValue("server s2"));
    expect(mocks.get).toHaveBeenLastCalledWith("s2", expect.objectContaining({ expectedUserId: "a" }));

    mocks.serverId = "s1";
    view.rerender(<ProfileShowcaseEditor />);
    await waitFor(() => expect(screen.getByLabelText("profileWatching")).toHaveValue("unsaved from s1"));
    fireEvent.click(screen.getByRole("button", { name: "saveChanges" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ watching: "unsaved from s1" }), 1, "s1", expect.any(Object)));
  });

  it("clears retained drafts when the signed-in account changes", async () => {
    mocks.get.mockImplementation(async (serverId: string | null) => ({ success: true, data: { ...showcase(), watching: serverId ? `server ${serverId}` : "global" } }));
    const view = render(<ProfileShowcaseEditor />);
    await screen.findByDisplayValue("global");
    fireEvent.click(screen.getByRole("button", { name: /profileScopeServer/ }));
    await waitFor(() => expect(screen.getByLabelText("profileWatching")).toHaveValue("server s1"));
    fireEvent.change(screen.getByLabelText("profileWatching"), { target: { value: "private draft from A" } });
    mocks.serverId = "s2";
    view.rerender(<ProfileShowcaseEditor />);
    await waitFor(() => expect(screen.getByLabelText("profileWatching")).toHaveValue("server s2"));

    mocks.owner = "b";
    view.rerender(<ProfileShowcaseEditor />);
    await waitFor(() => expect(screen.getByLabelText("profileWatching")).toHaveValue("server s2"));
    mocks.owner = "a";
    view.rerender(<ProfileShowcaseEditor />);
    await waitFor(() => expect(screen.getByLabelText("profileWatching")).toHaveValue("server s2"));
    expect(screen.queryByDisplayValue("private draft from A")).toBeNull();
  });

  it("fetches the latest base on version conflict and requires an explicit overwrite", async () => {
    mocks.get.mockReset()
      .mockResolvedValueOnce({ success: true, data: { ...showcase(), watching: "original", version: 1 } })
      .mockResolvedValueOnce({ success: true, data: { ...showcase(), watching: "changed elsewhere", version: 2 } });
    mocks.save.mockResolvedValueOnce({ success: false, code: "VERSION_CONFLICT" })
      .mockResolvedValueOnce({ success: true, data: { ...showcase(), watching: "my draft", version: 3 } });
    render(<ProfileShowcaseEditor />);
    await screen.findByDisplayValue("original");
    fireEvent.change(screen.getByLabelText("profileWatching"), { target: { value: "my draft" } });
    fireEvent.click(screen.getByRole("button", { name: "saveChanges" }));

    const overwrite = await screen.findByRole("button", { name: "profileShowcaseOverwrite" });
    expect(screen.getByLabelText("profileWatching")).toHaveValue("my draft");
    expect(mocks.get).toHaveBeenCalledTimes(2);
    fireEvent.click(overwrite);
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(2));
    expect(mocks.save.mock.calls[1][1]).toBe(2);
    expect(mocks.save.mock.calls[1][0].watching).toBe("my draft");
    await waitFor(() => expect(screen.getByLabelText("profileWatching")).toHaveValue("my draft"));
  });

  it("prevents changing profile scope while edits are unsaved", async () => {
    render(<ProfileShowcaseEditor />);
    await screen.findByRole("tab", { name: "profileTab_board" });
    fireEvent.change(screen.getByLabelText("profileWatching"), { target: { value: "Now playing" } });
    expect(screen.getByRole("button", { name: "profileScopeGlobal" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /profileScopeServer/ })).toBeDisabled();
  });

  it("ignores an old scope response after a newer scope loads", async () => {
    let resolveGlobal!: (value: unknown) => void;
    mocks.get.mockImplementationOnce(() => new Promise((resolve) => { resolveGlobal = resolve; }));
    const view = render(<ProfileShowcaseEditor />);
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(1));
    const globalContext = mocks.get.mock.calls[0][1] as ProfileRequestContext;
    expect(globalContext.expectedUserId).toBe("a");
    expect(globalContext.isCurrent?.()).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /profileScopeServer/ }));
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
    expect(globalContext.isCurrent?.()).toBe(false);
    await act(async () => resolveGlobal({ success: true, data: { ...showcase(), watching: "stale global" } }));
    await waitFor(() => expect(screen.getByLabelText("profileWatching")).toHaveValue(""));
    expect(screen.queryByDisplayValue("stale global")).toBeNull();
    view.unmount();
  });

  it("passes an API context that becomes false when the account changes during save", async () => {
    let finishSave!: (value: unknown) => void;
    mocks.save.mockImplementationOnce(() => new Promise((resolve) => { finishSave = resolve; }));
    render(<ProfileShowcaseEditor />);
    await screen.findByRole("tab", { name: "profileTab_board" });
    fireEvent.change(screen.getByLabelText("profileWatching"), { target: { value: "Editing" } });
    fireEvent.click(screen.getByRole("button", { name: "saveChanges" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    const context = mocks.save.mock.calls[0][3] as ProfileRequestContext;
    expect(context.expectedUserId).toBe("a");
    expect(context.isCurrent?.()).toBe(true);
    mocks.owner = "b";
    expect(context.isCurrent?.()).toBe(false);
    await act(async () => finishSave({ success: true, data: { ...showcase(), watching: "Editing", version: 2 } }));
    expect(mocks.toast).not.toHaveBeenCalledWith("success", "profileShowcaseSaved");
  });

  it("keeps a save invalid after leaving and returning to the same server", async () => {
    let finishSave!: (value: unknown) => void;
    mocks.save.mockImplementationOnce(() => new Promise((resolve) => { finishSave = resolve; }));
    const view = render(<ProfileShowcaseEditor />);
    await screen.findByLabelText("profileWatching");
    fireEvent.click(screen.getByRole("button", { name: /profileScopeServer/ }));
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
    await screen.findByLabelText("profileWatching");
    fireEvent.change(screen.getByLabelText("profileWatching"), { target: { value: "pending save" } });
    fireEvent.click(screen.getByRole("button", { name: "saveChanges" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    const context = mocks.save.mock.calls[0][3] as ProfileRequestContext;

    mocks.serverId = "s2";
    view.rerender(<ProfileShowcaseEditor />);
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(3));
    mocks.serverId = "s1";
    view.rerender(<ProfileShowcaseEditor />);
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(4));
    await screen.findByDisplayValue("pending save");
    expect(context.isCurrent?.()).toBe(false);
    await act(async () => finishSave({ success: true, data: { ...showcase(), watching: "stale response", version: 2 } }));
    expect(screen.getByLabelText("profileWatching")).toHaveValue("pending save");
    expect(mocks.toast).not.toHaveBeenCalledWith("success", "profileShowcaseSaved");
  });

  it("does not write links with non-web protocols", async () => {
    render(<ProfileShowcaseEditor />);
    await screen.findByRole("tab", { name: "profileTab_board" });
    fireEvent.click(screen.getByRole("button", { name: /profileManualLink/ }));
    const inputs = screen.getAllByPlaceholderText("https://");
    fireEvent.change(screen.getByPlaceholderText("profileLinkLabel"), { target: { value: "Portfolio" } });
    fireEvent.change(inputs[0], { target: { value: "javascript:alert(1)" } });
    fireEvent.click(screen.getByRole("button", { name: "saveChanges" }));
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
