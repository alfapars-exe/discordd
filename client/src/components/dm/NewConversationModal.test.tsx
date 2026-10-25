import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import NewConversationModal from "./NewConversationModal";
import { useFriendStore } from "../../stores/friendStore";
import { useDMStore } from "../../stores/dmStore";
import { useUIStore } from "../../stores/uiStore";
import { useGroupDMStore } from "../../stores/groupDMStore";
vi.mock("react-i18next", async (importOriginal) => ({
  ...await importOriginal<typeof import("react-i18next")>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("../shared/Avatar", () => ({ default: () => null }));

describe("new conversation", () => {
  beforeEach(() => {
    useFriendStore.setState({ isLoading: false, friends: [{ id: "friendship", status: "accepted", created_at: "2026-10-22", user_id: "alice", username: "alice_handle", display_name: "Alice", avatar_url: null, user_status: "offline", user_custom_status: null }] });
    useDMStore.setState({ createOrGetChannel: vi.fn().mockResolvedValue("dm"), selectDM: vi.fn(), clearDMUnread: vi.fn(), fetchMessages: vi.fn().mockResolvedValue(undefined) });
    useUIStore.setState({ openTab: vi.fn() });
  });
  it("finds an offline friend by username and opens their conversation", async () => {
    const close = vi.fn();
    render(<NewConversationModal onClose={close} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "alice_handle" } });
    fireEvent.click(screen.getByRole("button", { name: /Alice/ }));
    await waitFor(() => expect(useUIStore.getState().openTab).toHaveBeenCalledWith("dm", "dm", "Alice"));
    expect(close).toHaveBeenCalled();
  });
  it("shows a retryable error when the server refuses to open the DM", async () => {
    useDMStore.setState({ createOrGetChannel: vi.fn().mockResolvedValue(null) });
    render(<NewConversationModal onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Alice/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("dmOpenFailed");
    expect(screen.getByRole("button", { name: /Alice/ })).toBeEnabled();
    expect(useUIStore.getState().openTab).not.toHaveBeenCalled();
  });
  it("does not navigate after the picker is dismissed during an outstanding request", async () => {
    let resolve!: (value: string) => void;
    useDMStore.setState({ createOrGetChannel: vi.fn(() => new Promise<string>((done) => { resolve = done; })) });
    const { unmount } = render(<NewConversationModal onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Alice/ }));
    expect(screen.getByRole("button", { name: /Alice/ })).toBeDisabled();
    unmount();
    await act(async () => { resolve("dm"); });
    expect(useUIStore.getState().openTab).not.toHaveBeenCalled();
  });

  it("can open directly in group mode and uses the existing create flow", async () => {
    const group = { id: "g1", name: "Study group" } as import("../../types/groupDM").GroupDM;
    const create = vi.fn().mockResolvedValue(group);
    const fetchMessages = vi.fn().mockResolvedValue(undefined);
    useGroupDMStore.setState({ create, fetchMessages });
    const close = vi.fn();
    render(<NewConversationModal initialGroupMode onClose={close} />);

    expect(screen.getByRole("textbox", { name: "groupName" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "groupName" }), { target: { value: "Study group" } });
    fireEvent.click(screen.getByRole("button", { name: /Alice/ }));
    fireEvent.click(screen.getByRole("button", { name: "createGroup" }));

    await waitFor(() => expect(create).toHaveBeenCalledWith("Study group", ["alice"]));
    await waitFor(() => expect(useUIStore.getState().openTab).toHaveBeenCalledWith("g1", "group-dm", "Study group"));
    expect(fetchMessages).toHaveBeenCalledWith("g1");
    expect(close).toHaveBeenCalledOnce();
  });
});
