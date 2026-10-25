import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ThreadModal from "./ThreadModal";
import { createThread, listThreads, setThreadArchived } from "../../api/threads";
import type { Channel } from "../../types";

const remember = vi.fn();
const openTab = vi.fn();
const addToast = vi.fn();
const auth = vi.hoisted(() => ({ owner: "u1" as string | undefined, generation: 1 }));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }), initReactI18next: { type: "3rdParty", init: () => {} } }));
vi.mock("../../api/client", () => ({ getAuthGeneration: () => auth.generation }));
vi.mock("../../api/threads", () => ({ listThreads: vi.fn(), createThread: vi.fn(), setThreadArchived: vi.fn() }));
vi.mock("../../stores/authStore", () => ({ useAuthStore: Object.assign((selector: (state: { user: { id: string } | null }) => unknown) => selector({ user: auth.owner ? { id: auth.owner } : null }), { getState: () => ({ user: auth.owner ? { id: auth.owner } : null }) }) }));
vi.mock("../../stores/threadStore", () => ({ useThreadStore: (selector: (state: { remember: typeof remember }) => unknown) => selector({ remember }) }));
vi.mock("../../stores/serverStore", () => ({ useServerStore: { getState: () => ({ servers: [{ id: "s1", name: "Server", icon_url: null }] }) } }));
vi.mock("../../stores/uiStore", () => ({ useUIStore: { getState: () => ({ openTab }) } }));
vi.mock("../../stores/toastStore", () => ({ useToastStore: { getState: () => ({ addToast }) } }));

const thread = (overrides: Partial<Channel> = {}): Channel => ({
  id: "t1", name: "Topic", type: "thread", category_id: null, topic: null,
  position: 0, user_limit: 0, bitrate: 0, created_at: "2026-10-23T00:00:00Z",
  parent_channel_id: "c1", starter_message_id: "m1", archived_at: null, ...overrides,
});

describe("ThreadModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.owner = "u1";
    auth.generation = 1;
    vi.mocked(listThreads).mockResolvedValue({ success: true, data: { threads: [] } });
    vi.mocked(createThread).mockResolvedValue({ success: true, data: thread() });
    vi.mocked(setThreadArchived).mockResolvedValue({ success: true, data: thread({ archived_at: "2026-10-23T01:00:00Z" }) });
  });

  it("creates a persistent thread and opens it in the main chat area", async () => {
    const onClose = vi.fn();
    render(<ThreadModal serverId="s1" channelId="c1" messageId="m1" defaultName="Topic" onClose={onClose} />);
    await waitFor(() => expect(listThreads).toHaveBeenCalledWith("s1", "c1", true, expect.objectContaining({ expectedUserId: "u1", isCurrent: expect.any(Function) })));
    fireEvent.click(screen.getByRole("button", { name: "threadCreate" }));
    await waitFor(() => expect(createThread).toHaveBeenCalledWith("s1", "c1", "m1", "Topic", expect.objectContaining({ expectedUserId: "u1", isCurrent: expect.any(Function) })));
    expect(remember).toHaveBeenCalledWith(expect.objectContaining({ id: "t1" }), "s1");
    expect(openTab).toHaveBeenCalledWith("t1", "text", "Topic", expect.objectContaining({ serverId: "s1" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("archives and reloads an existing thread", async () => {
    vi.mocked(listThreads).mockResolvedValue({ success: true, data: { threads: [thread()] } });
    render(<ThreadModal serverId="s1" channelId="c1" messageId="m1" defaultName="Topic" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "threadArchive" }));
    await waitFor(() => expect(setThreadArchived).toHaveBeenCalledWith("s1", "t1", true, expect.objectContaining({ expectedUserId: "u1", isCurrent: expect.any(Function) })));
    expect(screen.getByRole("button", { name: "threadReopen" })).toBeInTheDocument();
    expect(remember).toHaveBeenCalledWith(expect.objectContaining({ archived_at: "2026-10-23T01:00:00Z" }), "s1");
  });

  it("does not offer creation when the thread list fails and allows retry", async () => {
    vi.mocked(listThreads)
      .mockResolvedValueOnce({ success: false, error: "offline" })
      .mockResolvedValueOnce({ success: true, data: { threads: [] } });
    render(<ThreadModal serverId="s1" channelId="c1" messageId="m1" defaultName="Topic" onClose={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("threadLoadFailed");
    expect(screen.queryByRole("textbox", { name: "threadName" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "spamRetry" }));
    expect(await screen.findByRole("textbox", { name: "threadName" })).toBeInTheDocument();
    expect(listThreads).toHaveBeenCalledTimes(2);
  });

  it("ignores a create result after the account changes", async () => {
    let resolveCreate!: (value: Awaited<ReturnType<typeof createThread>>) => void;
    vi.mocked(createThread).mockReturnValueOnce(new Promise((resolve) => { resolveCreate = resolve; }));
    const onClose = vi.fn();
    const view = render(<ThreadModal serverId="s1" channelId="c1" messageId="m1" defaultName="Topic" onClose={onClose} />);
    fireEvent.click(await screen.findByRole("button", { name: "threadCreate" }));
    await waitFor(() => expect(createThread).toHaveBeenCalledOnce());
    const context = vi.mocked(createThread).mock.calls[0][4]!;
    expect(context.isCurrent?.()).toBe(true);
    auth.owner = "u2";
    view.rerender(<ThreadModal serverId="s1" channelId="c1" messageId="m1" defaultName="Topic" onClose={onClose} />);
    expect(context.isCurrent?.()).toBe(false);
    resolveCreate({ success: true, data: thread() });
    await waitFor(() => expect(view.container.querySelector(".thread-modal")).toBeInTheDocument());
    expect(openTab).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(addToast).not.toHaveBeenCalled();
  });

  it("ignores a late thread list after switching channels", async () => {
    let resolveFirst!: (value: Awaited<ReturnType<typeof listThreads>>) => void;
    vi.mocked(listThreads)
      .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ success: true, data: { threads: [thread({ id: "t2", name: "Other channel thread", parent_channel_id: "c2", starter_message_id: "m2" })] } });
    const view = render(<ThreadModal serverId="s1" channelId="c1" messageId="m1" defaultName="First" onClose={vi.fn()} />);
    await waitFor(() => expect(listThreads).toHaveBeenCalledTimes(1));
    view.rerender(<ThreadModal serverId="s1" channelId="c2" messageId="m2" defaultName="Second" onClose={vi.fn()} />);
    expect(await screen.findByText("Other channel thread")).toBeInTheDocument();
    resolveFirst({ success: true, data: { threads: [thread({ id: "stale", name: "Stale thread" })] } });
    await waitFor(() => expect(screen.queryByText("Stale thread")).not.toBeInTheDocument());
    expect(screen.getByText("Other channel thread")).toBeInTheDocument();
  });
});
