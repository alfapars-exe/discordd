import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ServerEventsModal from "./ServerEventsModal";

const mocks = vi.hoisted(() => ({
  auth: { user: { id: "u1" } as { id: string } | null },
  server: { activeServerId: "s1" as string | null },
  members: { membersByServer: { s1: [{ id: "u1", effective_permissions: 1 << 23 }] as Array<{ id: string; effective_permissions: number }> } },
  generation: 1,
  list: vi.fn(), detail: vi.fn(), create: vi.fn(), update: vi.fn(), cancel: vi.fn(), rsvp: vi.fn(),
}));

vi.mock("../../api/client", () => ({ getAuthGeneration: () => mocks.generation }));
vi.mock("../../api/serverEvents", () => ({
  listServerEvents: mocks.list,
  getServerEvent: mocks.detail,
  createServerEvent: mocks.create,
  updateServerEvent: mocks.update,
  cancelServerEvent: mocks.cancel,
  setServerEventInterested: mocks.rsvp,
}));
vi.mock("../../stores/authStore", () => {
  const hook = (pick: (state: unknown) => unknown) => pick(mocks.auth);
  Object.assign(hook, { getState: () => mocks.auth });
  return { useAuthStore: hook };
});
vi.mock("../../stores/serverStore", () => {
  const hook = (pick: (state: unknown) => unknown) => pick(mocks.server);
  Object.assign(hook, { getState: () => mocks.server });
  return { useServerStore: hook };
});
vi.mock("../../stores/memberStore", () => ({ useMemberStore: (pick: (state: unknown) => unknown) => pick(mocks.members) }));
vi.mock("../../stores/channelStore", () => ({ useChannelStore: (pick: (state: unknown) => unknown) => pick({ categoriesByServer: { s1: [] } }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }), initReactI18next: { type: "3rdParty", init: () => {} } }));

const event = (overrides: Record<string, unknown> = {}) => ({
  id: "e1", server_id: "s1", creator_id: "u1", name: "Launch", description: "Meet up",
  starts_at: "2099-01-01T12:00:00Z", ends_at: null, channel_id: null, status: "scheduled" as const,
  version: 2, interested: false, created_at: "2098-01-01T00:00:00Z", updated_at: "2098-01-01T00:00:00Z", ...overrides,
});
const ok = <T,>(data: T) => ({ success: true, data });

describe("ServerEventsModal", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.auth.user = { id: "u1" };
    mocks.server.activeServerId = "s1";
    mocks.members.membersByServer = { s1: [{ id: "u1", effective_permissions: 1 << 23 }] };
    mocks.generation = 1;
    mocks.list.mockResolvedValue(ok({ events: [event()] }));
    mocks.detail.mockResolvedValue(ok(event()));
    mocks.create.mockResolvedValue(ok(event({ id: "e2" })));
    mocks.update.mockResolvedValue(ok(event({ name: "Launch edited", version: 3 })));
    mocks.cancel.mockResolvedValue(ok(event({ status: "cancelled", version: 3 })));
    mocks.rsvp.mockResolvedValue(ok({ interested: true }));
  });

  it("loads and paginates server events with owner-scoped API context", async () => {
    const onClose = vi.fn();
    const many = Array.from({ length: 50 }, (_, index) => event({ id: `e${index}`, name: `Event ${index}` }));
    mocks.list.mockResolvedValueOnce(ok({ events: many })).mockResolvedValueOnce(ok({ events: [event({ id: "e51", name: "Event 50" })] }));
    render(<ServerEventsModal serverId="s1" serverName="Team" onClose={onClose} />);
    expect(await screen.findByText("Event 0")).toBeInTheDocument();
    expect(mocks.list.mock.calls[0][2].expectedUserId).toBe("u1");
    fireEvent.click(screen.getByRole("button", { name: "eventLoadMore" }));
    await screen.findByText("Event 50");
    expect(mocks.list.mock.calls[1][1]).toEqual({ limit: 50, beforeId: "e49" });
    expect(mocks.list.mock.calls[1][2].isCurrent()).toBe(true);
  });

  it("creates and edits events with expected version, retaining draft on conflict", async () => {
    mocks.list.mockResolvedValueOnce(ok({ events: [event()] })).mockResolvedValueOnce(ok({ events: [event({ id: "e-sooner", name: "Sooner" }), event()] }));
    render(<ServerEventsModal serverId="s1" serverName="Team" onClose={() => undefined} />);
    await screen.findByText("Launch");
    fireEvent.click(screen.getByRole("button", { name: "eventCreate" }));
    fireEvent.change(screen.getByLabelText("eventName"), { target: { value: "Planning" } });
    fireEvent.change(screen.getByLabelText("eventStartsAt"), { target: { value: "2099-01-02T12:30" } });
    fireEvent.click(screen.getByRole("button", { name: "eventSave" }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalled());
    expect(mocks.create.mock.calls[0][1]).toMatchObject({ name: "Planning", starts_at: new Date("2099-01-02T12:30").toISOString() });
    await screen.findByText("Sooner");
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual(["Sooner", "Launch"]);

    fireEvent.click(screen.getAllByRole("button", { name: "eventEdit" })[1]);
    const nameInput = screen.getByLabelText("eventName");
    fireEvent.change(nameInput, { target: { value: "My unsaved draft" } });
    mocks.update.mockResolvedValueOnce({ success: false, status: 409, code: "SERVER_EVENT_VERSION_CONFLICT" });
    fireEvent.click(screen.getByRole("button", { name: "eventSave" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("eventVersionConflict");
    expect(nameInput).toHaveValue("My unsaved draft");
    expect(mocks.update.mock.calls.at(-1)?.[2].expected_version).toBe(2);
    mocks.list.mockResolvedValueOnce(ok({ events: [event({ name: "Other editor version", version: 3 })] }));
    mocks.detail.mockResolvedValueOnce(ok(event({ name: "Other editor version", version: 3 })));
    fireEvent.click(screen.getByRole("button", { name: "eventReloadList" }));
    await screen.findByText("Other editor version");
    expect(nameInput).toHaveValue("My unsaved draft");
    fireEvent.click(await screen.findByRole("button", { name: "eventUseLatestVersion" }));
    fireEvent.click(screen.getByRole("button", { name: "eventSave" }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(2));
    expect(mocks.update.mock.calls.at(-1)?.[2].expected_version).toBe(3);
  });

  it("persists RSVP state and keeps list failures retryable", async () => {
    mocks.list.mockResolvedValueOnce({ success: false, status: 503, error: "offline" }).mockResolvedValueOnce(ok({ events: [event()] }));
    render(<ServerEventsModal serverId="s1" serverName="Team" onClose={() => undefined} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("eventRequestFailed");
    expect(screen.queryByText("eventEmpty")).toBeNull();
    expect(screen.queryByText("eventLoading")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "eventRetry" }));
    fireEvent.click(await screen.findByRole("button", { name: "eventInterestedAction" }));
    await screen.findByRole("button", { name: "eventInterested" });
    expect(mocks.rsvp).toHaveBeenCalledWith("s1", "e1", true, expect.objectContaining({ expectedUserId: "u1" }));
  });

  it("cancels with the event version and updates the persisted status", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true));
    render(<ServerEventsModal serverId="s1" serverName="Team" onClose={() => undefined} />);
    await screen.findByText("Launch");
    fireEvent.click(screen.getByRole("button", { name: "eventCancel" }));
    await screen.findByText("eventCancelled");
    expect(mocks.cancel).toHaveBeenCalledWith("s1", "e1", 2, expect.objectContaining({ expectedUserId: "u1" }));
    vi.unstubAllGlobals();
  });

  it("only allows a new RSVP before the event starts, while allowing withdrawal afterward", async () => {
    const past = event({ starts_at: "2000-01-01T00:00:00Z" });
    mocks.list.mockResolvedValueOnce(ok({ events: [past] }));
    const view = render(<ServerEventsModal serverId="s1" serverName="Team" onClose={() => undefined} />);
    await screen.findByText("Launch");
    expect(screen.queryByRole("button", { name: "eventInterestedAction" })).toBeNull();
    view.unmount();

    mocks.list.mockResolvedValueOnce(ok({ events: [{ ...past, interested: true }] }));
    render(<ServerEventsModal serverId="s1" serverName="Team" onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "eventInterested" }));
    await waitFor(() => expect(mocks.rsvp).toHaveBeenCalledWith("s1", "e1", false, expect.objectContaining({ expectedUserId: "u1" })));
  });

  it("expires RSVP actions for successive events while the modal stays open", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2099-01-01T12:00:00Z"));
    mocks.list.mockResolvedValueOnce(ok({ events: [
      event({ id: "first", starts_at: "2099-01-01T12:01:00Z" }),
      event({ id: "second", starts_at: "2099-01-01T12:02:00Z" }),
    ] }));
    const view = render(<ServerEventsModal serverId="s1" serverName="Team" onClose={() => undefined} />);
    try {
      await act(async () => { await Promise.resolve(); });
      expect(screen.getAllByRole("button", { name: "eventInterestedAction" })).toHaveLength(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(60_001); });
      expect(screen.getAllByRole("button", { name: "eventInterestedAction" })).toHaveLength(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(screen.queryByRole("button", { name: "eventInterestedAction" })).toBeNull();
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it("validates name and description by Unicode code point limits", async () => {
    render(<ServerEventsModal serverId="s1" serverName="Team" onClose={() => undefined} />);
    await screen.findByText("Launch");
    fireEvent.click(screen.getByRole("button", { name: "eventCreate" }));
    const name = screen.getByLabelText("eventName");
    const description = screen.getByLabelText("eventDescription");
    fireEvent.change(name, { target: { value: "😀".repeat(101) } });
    fireEvent.change(screen.getByLabelText("eventStartsAt"), { target: { value: "2099-01-02T12:30" } });
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "eventSave" })).toBeDisabled();
    fireEvent.change(name, { target: { value: "Valid" } });
    fireEvent.change(description, { target: { value: "😀".repeat(2001) } });
    expect(description).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "eventSave" })).toBeDisabled();
    expect(mocks.create).not.toHaveBeenCalled();
    fireEvent.change(name, { target: { value: "😀".repeat(100) } });
    fireEvent.change(description, { target: { value: "😀".repeat(2000) } });
    expect(name).toHaveAttribute("aria-invalid", "false");
    expect(description).toHaveAttribute("aria-invalid", "false");
    fireEvent.click(screen.getByRole("button", { name: "eventSave" }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalled());
    expect(Array.from(mocks.create.mock.calls[0][1].name)).toHaveLength(100);
    expect(Array.from(mocks.create.mock.calls[0][1].description)).toHaveLength(2000);
  });

  it("fetches an initial deep-linked event separately without moving the page cursor", async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => event({ id: `e${index}`, name: `Page event ${index}` }));
    mocks.list.mockResolvedValueOnce(ok({ events: firstPage })).mockResolvedValueOnce(ok({ events: [event({ id: "e-next", name: "Next page" })] }));
    mocks.detail.mockResolvedValueOnce(ok(event({ id: "deep", name: "Deep event" })));
    render(<ServerEventsModal serverId="s1" serverName="Team" initialEventId="deep" onClose={() => undefined} />);
    const deepTarget = await screen.findByRole("heading", { name: "Deep event" });
    expect(deepTarget.closest("article")).toHaveClass("server-event-target");
    await waitFor(() => expect(document.activeElement).toBe(deepTarget.closest("article")));
    expect(mocks.detail.mock.calls[0][2]).toMatchObject({ expectedUserId: "u1" });
    fireEvent.click(within(deepTarget.closest("article")!).getByRole("button", { name: "eventInterestedAction" }));
    await waitFor(() => expect(mocks.rsvp).toHaveBeenCalledWith("s1", "deep", true, expect.objectContaining({ expectedUserId: "u1" })));
    fireEvent.click(screen.getByRole("button", { name: "eventLoadMore" }));
    await screen.findByText("Next page");
    expect(mocks.list.mock.calls[1][1]).toEqual({ limit: 50, beforeId: "e49" });
  });

  it("shows and retries a failed deep-linked detail instead of treating it as absent", async () => {
    mocks.list.mockResolvedValueOnce(ok({ events: [] }));
    mocks.detail.mockResolvedValueOnce({ success: false, status: 503, error: "offline" }).mockResolvedValueOnce(ok(event({ id: "deep", name: "Deep event" })));
    render(<ServerEventsModal serverId="s1" serverName="Team" initialEventId="deep" onClose={() => undefined} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("eventRequestFailed");
    expect(screen.queryByText("eventEmpty")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "eventRetry" }));
    expect(await screen.findByText("Deep event")).toBeInTheDocument();
  });

  it("hides manager controls from members and suppresses stale account responses", async () => {
    mocks.members.membersByServer = { s1: [{ id: "u1", effective_permissions: 0 }] };
    let resolveList!: (value: unknown) => void;
    mocks.list.mockImplementationOnce(() => new Promise((resolve) => { resolveList = resolve; }));
    render(<ServerEventsModal serverId="s1" serverName="Team" onClose={() => undefined} />);
    await waitFor(() => expect(mocks.list).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "eventCreate" })).toBeNull();
    expect(screen.queryByRole("button", { name: "eventEdit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "eventCancel" })).toBeNull();
    mocks.auth.user = { id: "u2" };
    resolveList(ok({ events: [event({ name: "Private old-account result" })] }));
    await waitFor(() => expect(mocks.list.mock.calls[0][2].isCurrent()).toBe(false));
    expect(screen.queryByText("Private old-account result")).toBeNull();
  });
});
