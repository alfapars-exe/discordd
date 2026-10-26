import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import InviteFriendsModal from "./InviteFriendsModal";

const {
  getOrCreateShareInvite,
  createOrGetChannel,
  sendMessage,
  copyToClipboard,
  addToast,
  friends,
  categories,
  overridesByChannel,
  fetchOverridesForChannels,
  authState,
} = vi.hoisted(() => ({
  getOrCreateShareInvite: vi.fn(),
  createOrGetChannel: vi.fn(),
  sendMessage: vi.fn(),
  copyToClipboard: vi.fn(),
  addToast: vi.fn(),
  friends: [
    { user_id: "u1", username: "alice", display_name: "Alice", avatar_url: null },
    { user_id: "u2", username: "bob", display_name: "Bob", avatar_url: null },
  ],
  categories: [{ category: { id: "cat", name: "Text", position: 0 }, channels: [
    { id: "public", name: "general", type: "text", category_id: "cat", topic: null, position: 0, user_limit: 0, bitrate: 0, created_at: "2026-01-01T00:00:00Z" },
    { id: "private", name: "staff", type: "text", category_id: "cat", topic: null, position: 1, user_limit: 0, bitrate: 0, created_at: "2026-01-01T00:00:00Z" },
  ] }],
  overridesByChannel: { private: [{ channel_id: "private", role_id: "everyone", allow: 0, deny: 4096 }] },
  fetchOverridesForChannels: vi.fn(),
  authState: { user: { id: "sender" } },
}));

vi.mock("../../stores/friendStore", () => ({ useFriendStore: (pick: (state: unknown) => unknown) => pick({ friends }) }));
vi.mock("../../stores/inviteStore", () => ({ useInviteStore: (pick: (state: unknown) => unknown) => pick({ getOrCreateShareInvite }) }));
vi.mock("../../stores/dmStore", () => ({ useDMStore: (pick: (state: unknown) => unknown) => pick({ createOrGetChannel, sendMessage }) }));
vi.mock("../../stores/toastStore", () => ({ useToastStore: (pick: (state: unknown) => unknown) => pick({ addToast }) }));
vi.mock("../../stores/authStore", () => {
  const useAuthStore = (pick: (state: unknown) => unknown) => pick(authState);
  Object.assign(useAuthStore, { getState: () => authState });
  return { useAuthStore };
});
vi.mock("../../stores/channelStore", () => ({ useChannelStore: (pick: (state: unknown) => unknown) => pick({ categoriesByServer: { s1: categories } }) }));
vi.mock("../../stores/channelPermissionStore", () => ({ useChannelPermissionStore: (pick: (state: unknown) => unknown) => pick({ overridesByChannel, fetchOverridesForChannels }) }));
vi.mock("../../utils/constants", () => ({
  getInviteUrl: (code: string) => `https://hichat.test/invite/${code}`,
  copyToClipboard,
  resolveAssetUrl: (value: string) => value,
}));
vi.mock("../shared/Avatar", () => ({ default: ({ name }: { name: string }) => <span aria-hidden="true">{name.slice(0, 1)}</span> }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }), initReactI18next: { type: "3rdParty", init: () => {} } }));

describe("InviteFriendsModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getOrCreateShareInvite.mockResolvedValue({ code: "seven-day" });
    createOrGetChannel.mockImplementation(async (userID: string) => `dm-${userID}`);
    sendMessage.mockResolvedValue(true);
  });

  it("names the dialog, contains keyboard focus and restores its opener on close", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const onClose = vi.fn();
    const view = render(<InviteFriendsModal serverId="s1" serverName="Team" onClose={onClose} />);
    const dialog = screen.getByRole("dialog", { name: "inviteFriends" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("textbox", { name: "searchFriends" })).toHaveFocus();
    const close = screen.getByRole("button", { name: "close" });
    close.focus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    const last = document.activeElement;
    expect(last).not.toBe(close);
    expect(dialog.contains(last)).toBe(true);
    expect(last).not.toBeDisabled();
    fireEvent.keyDown(last!, { key: "Tab" });
    expect(close).toHaveFocus();
    opener.focus();
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    view.unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it("loads and displays the same seven-day share link that it copies", async () => {
    render(<InviteFriendsModal serverId="s1" serverName="Team" onClose={() => undefined} />);
    const link = await screen.findByRole("textbox", { name: "inviteLink" });
    await waitFor(() => expect(link).toHaveValue("https://hichat.test/invite/seven-day"));
    fireEvent.click(screen.getByRole("button", { name: "copyInviteLink" }));
    await waitFor(() => expect(copyToClipboard).toHaveBeenCalledWith("https://hichat.test/invite/seven-day"));
  });

  it("filters recipients and exposes real failed/sent retry state per row", async () => {
    sendMessage.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<InviteFriendsModal serverId="s1" serverName="Team" onClose={() => undefined} />);
    await screen.findByDisplayValue("https://hichat.test/invite/seven-day");

    fireEvent.change(screen.getByRole("textbox", { name: "searchFriends" }), { target: { value: "ali" } });
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.queryByText("Bob")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "invite" }));
    await screen.findAllByRole("button", { name: "retryInvite" });
    fireEvent.click(screen.getByRole("button", { name: "retryInvite" }));
    await screen.findByRole("button", { name: "inviteSent" });
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("creates a channel-targeted link and warns that a private target grants no access", async () => {
    getOrCreateShareInvite.mockImplementation(async (_serverID: string, channelID?: string) => ({ code: channelID || "server" }));
    render(<InviteFriendsModal serverId="s1" serverName="Team" onClose={() => undefined} />);
    fireEvent.change(screen.getByLabelText("inviteTargetChannel"), { target: { value: "private" } });
    expect(await screen.findByRole("note")).toHaveTextContent("invitePrivateChannelWarning");
    await waitFor(() => expect(getOrCreateShareInvite).toHaveBeenCalledWith("s1", "private"));
    expect(screen.getByRole("textbox", { name: "inviteLink" })).toHaveValue("https://hichat.test/invite/private");
  });

  it("continues a bulk send after a thrown DM error and leaves that recipient retryable", async () => {
    createOrGetChannel.mockRejectedValueOnce(new Error("offline"));
    render(<InviteFriendsModal serverId="s1" serverName="Team" onClose={() => undefined} />);
    await screen.findByDisplayValue("https://hichat.test/invite/seven-day");

    fireEvent.click(screen.getByRole("button", { name: /selectAll/ }));
    fireEvent.click(screen.getByRole("button", { name: /sendInvites/ }));

    await screen.findAllByRole("button", { name: "retryInvite" });
    await screen.findByRole("button", { name: "inviteSent" });
    expect(createOrGetChannel).toHaveBeenCalledTimes(2);
    expect(addToast).toHaveBeenCalledWith("success", "invitesSent");
    expect(screen.getByRole("button", { name: /sendInvites/ })).toBeEnabled();
  });

  it("does not show a success toast when every bulk DM send fails", async () => {
    sendMessage.mockResolvedValue(false);
    render(<InviteFriendsModal serverId="s1" serverName="Team" onClose={() => undefined} />);
    await screen.findByDisplayValue("https://hichat.test/invite/seven-day");

    fireEvent.click(screen.getByRole("button", { name: /selectAll/ }));
    fireEvent.click(screen.getByRole("button", { name: /sendInvites/ }));

    await screen.findAllByRole("button", { name: "retryInvite" });
    expect(addToast).not.toHaveBeenCalledWith("success", "invitesSent");
    expect(screen.getByRole("button", { name: /sendInvites/ })).toBeEnabled();
  });

  it("handles a rejected invite lookup without leaving bulk mode locked", async () => {
    getOrCreateShareInvite.mockRejectedValue(new Error("network unavailable"));
    render(<InviteFriendsModal serverId="s1" serverName="Team" onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "inviteLink" })).toHaveValue(""));

    fireEvent.click(screen.getByRole("button", { name: /selectAll/ }));
    fireEvent.click(screen.getByRole("button", { name: /sendInvites/ }));

    await waitFor(() => expect(screen.getByRole("button", { name: /sendInvites/ })).toBeEnabled());
    expect(addToast).toHaveBeenCalledWith("error", "inviteCreateFailed");
    expect(createOrGetChannel).not.toHaveBeenCalled();
  });
});
