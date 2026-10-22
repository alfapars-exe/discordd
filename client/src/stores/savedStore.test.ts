/**
 * savedStore — id index, save/unsave bookkeeping, the "unknown row id"
 * unsave path (POST-then-DELETE), the 500-cap error, and list paging.
 *
 * Crypto is mocked as pass-through; the E2EE store reports "uninitialized"
 * so decryptSavedRows is a no-op (rows keep their server content).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../api/saved", () => ({
  SAVED_LIMIT_REACHED: "saved_limit_reached",
  listSaved: vi.fn(),
  getSavedIds: vi.fn(),
  saveMessage: vi.fn(),
  updateSavedNote: vi.fn(),
  deleteSaved: vi.fn(),
}));
vi.mock("../crypto/channelEncryption", () => ({
  decryptChannelMessages: vi.fn(async (msgs: unknown[]) => msgs),
}));
vi.mock("../crypto/dmEncryption", () => ({
  decryptDMMessages: vi.fn(async (msgs: unknown[]) => msgs),
}));
vi.mock("./e2eeStore", () => ({
  useE2EEStore: { getState: () => ({ initStatus: "uninitialized" }) },
}));
const addToast = vi.fn();
vi.mock("./toastStore", () => ({
  useToastStore: { getState: () => ({ addToast }) },
}));
vi.mock("../i18n", () => ({
  default: { t: (key: string) => key },
}));

import { useSavedStore } from "./savedStore";
import * as api from "../api/saved";
import type { SavedMessage } from "../types";

function makeRow(id: string, overrides: Partial<SavedMessage> = {}): SavedMessage {
  return {
    id,
    user_id: "me",
    note: null,
    created_at: "2026-10-22T10:00:00Z",
    message_id: `m-${id}`,
    dm_message_id: null,
    message: {
      id: `m-${id}`,
      channel_id: "ch-1",
      server_id: "srv-1",
      channel_name: "genel",
      server_name: "Tayfa",
      user_id: "u-2",
      content: `content ${id}`,
      encryption_version: 0,
      created_at: "2026-10-21T10:00:00Z",
      attachment_count: 0,
      author: null,
    },
    dm_message: null,
    unavailable: false,
    ...overrides,
  };
}

/** Server stub for a deleted / no-longer-readable bookmark. */
function makeStub(id: string): SavedMessage {
  return makeRow(id, { message: null, dm_message: null, unavailable: true });
}

function resetStore() {
  useSavedStore.setState({
    items: [],
    hasMore: false,
    nextBefore: null,
    isLoading: false,
    loadError: false,
    idsLoaded: false,
    savedMessageIds: {},
    savedDMMessageIds: {},
    savedIdByTarget: {},
  });
}

beforeEach(() => {
  resetStore();
  vi.clearAllMocks();
});

describe("savedStore — id index", () => {
  it("loads both id lists once and answers isSaved", async () => {
    vi.mocked(api.getSavedIds).mockResolvedValue({
      success: true,
      data: { message_ids: ["m-1"], dm_message_ids: ["d-1"] },
    });
    const s = useSavedStore.getState();
    await Promise.all([s.ensureIds(), s.ensureIds()]);
    expect(api.getSavedIds).toHaveBeenCalledTimes(1);

    const after = useSavedStore.getState();
    expect(after.isSaved({ kind: "message", id: "m-1" })).toBe(true);
    expect(after.isSaved({ kind: "dm", id: "d-1" })).toBe(true);
    expect(after.isSaved({ kind: "message", id: "m-x" })).toBe(false);

    await after.ensureIds();
    expect(api.getSavedIds).toHaveBeenCalledTimes(1);
  });
});

describe("savedStore — save / unsave", () => {
  it("save marks the id, remembers the row id, prepends the row, toasts", async () => {
    vi.mocked(api.saveMessage).mockResolvedValue({ success: true, data: makeRow("s-1") });
    const ok = await useSavedStore.getState().save({ kind: "message", id: "m-s-1" });
    expect(ok).toBe(true);
    expect(api.saveMessage).toHaveBeenCalledWith({ message_id: "m-s-1" });
    const s = useSavedStore.getState();
    expect(s.isSaved({ kind: "message", id: "m-s-1" })).toBe(true);
    expect(s.items.map((r) => r.id)).toEqual(["s-1"]);
    expect(addToast).toHaveBeenCalledWith("success", "saved:saved");
  });

  it("save surfaces the 500-cap error as limitReached", async () => {
    vi.mocked(api.saveMessage).mockResolvedValue({
      success: false, status: 400, error: "saved_limit_reached",
    });
    const ok = await useSavedStore.getState().save({ kind: "dm", id: "d-9" });
    expect(ok).toBe(false);
    expect(addToast).toHaveBeenCalledWith("error", "saved:limitReached");
    expect(useSavedStore.getState().isSaved({ kind: "dm", id: "d-9" })).toBe(false);
  });

  it("unsave with a known row id deletes it and clears the index", async () => {
    useSavedStore.setState({
      items: [makeRow("s-1")],
      savedMessageIds: { "m-s-1": true },
      savedIdByTarget: { "message:m-s-1": "s-1" },
    });
    vi.mocked(api.deleteSaved).mockResolvedValue({ success: true });
    const ok = await useSavedStore.getState().unsave({ kind: "message", id: "m-s-1" });
    expect(ok).toBe(true);
    expect(api.saveMessage).not.toHaveBeenCalled();
    expect(api.deleteSaved).toHaveBeenCalledWith("s-1");
    const s = useSavedStore.getState();
    expect(s.items).toEqual([]);
    expect(s.isSaved({ kind: "message", id: "m-s-1" })).toBe(false);
    expect(addToast).toHaveBeenCalledWith("success", "saved:unsaved");
  });

  it("unsave of a bookmark from an earlier session learns the row id via idempotent POST", async () => {
    useSavedStore.setState({ savedDMMessageIds: { "d-7": true }, idsLoaded: true });
    vi.mocked(api.saveMessage).mockResolvedValue({
      success: true,
      data: makeRow("s-7", { message_id: null, dm_message_id: "d-7", message: null }),
    });
    vi.mocked(api.deleteSaved).mockResolvedValue({ success: true });

    const ok = await useSavedStore.getState().toggle({ kind: "dm", id: "d-7" });
    expect(ok).toBe(true);
    expect(api.saveMessage).toHaveBeenCalledWith({ dm_message_id: "d-7" });
    expect(api.deleteSaved).toHaveBeenCalledWith("s-7");
    expect(useSavedStore.getState().isSaved({ kind: "dm", id: "d-7" })).toBe(false);
  });
});

describe("savedStore — list paging", () => {
  it("fetchMore pages by the server's next_before cursor, not the last visible row", async () => {
    vi.mocked(api.listSaved)
      .mockResolvedValueOnce({
        success: true,
        // Cursor deliberately differs from the last visible row id.
        data: { saved: [makeRow("s-2"), makeRow("s-1")], has_more: true, next_before: "cursor-9" },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { saved: [makeRow("s-1"), makeRow("s-0")], has_more: false, next_before: null },
      });

    await useSavedStore.getState().fetchInitial();
    expect(useSavedStore.getState().items.map((r) => r.id)).toEqual(["s-2", "s-1"]);
    expect(useSavedStore.getState().hasMore).toBe(true);

    await useSavedStore.getState().fetchMore();
    expect(api.listSaved).toHaveBeenLastCalledWith({ before: "cursor-9", limit: 25 });
    const s = useSavedStore.getState();
    expect(s.items.map((r) => r.id)).toEqual(["s-2", "s-1", "s-0"]);
    expect(s.hasMore).toBe(false);
    expect(s.savedIdByTarget["message:m-s-0"]).toBe("s-0");
    expect(s.nextBefore).toBeNull();

    // End of list — no further request.
    await useSavedStore.getState().fetchMore();
    expect(api.listSaved).toHaveBeenCalledTimes(2);
  });

  it("an empty first page with has_more still allows loading more", async () => {
    vi.mocked(api.listSaved)
      .mockResolvedValueOnce({ success: true, data: { saved: [], has_more: true, next_before: "c-1" } })
      .mockResolvedValueOnce({ success: true, data: { saved: [makeRow("s-5")], has_more: false, next_before: null } });

    await useSavedStore.getState().fetchInitial();
    expect(useSavedStore.getState().items).toEqual([]);
    expect(useSavedStore.getState().hasMore).toBe(true);

    await useSavedStore.getState().fetchMore();
    expect(api.listSaved).toHaveBeenLastCalledWith({ before: "c-1", limit: 25 });
    expect(useSavedStore.getState().items.map((r) => r.id)).toEqual(["s-5"]);
  });

  it("keeps unavailable stubs and removes them by saved id without a re-POST", async () => {
    vi.mocked(api.listSaved).mockResolvedValueOnce({
      success: true,
      data: { saved: [makeStub("s-dead"), makeRow("s-ok")], has_more: false, next_before: null },
    });
    vi.mocked(api.deleteSaved).mockResolvedValue({ success: true });

    await useSavedStore.getState().fetchInitial();
    const stub = useSavedStore.getState().items.find((r) => r.id === "s-dead");
    expect(stub?.unavailable).toBe(true);
    expect(stub?.message).toBeNull();

    expect(await useSavedStore.getState().remove("s-dead")).toBe(true);
    expect(api.saveMessage).not.toHaveBeenCalled();
    expect(api.deleteSaved).toHaveBeenCalledWith("s-dead");
    expect(useSavedStore.getState().items.map((r) => r.id)).toEqual(["s-ok"]);
  });

  it("flags loadError when the list request fails", async () => {
    vi.mocked(api.listSaved).mockResolvedValue({ success: false, status: 500 });
    await useSavedStore.getState().fetchInitial();
    expect(useSavedStore.getState().loadError).toBe(true);
    expect(useSavedStore.getState().isLoading).toBe(false);
  });

  it("setNote patches the row in place", async () => {
    useSavedStore.setState({ items: [makeRow("s-1")] });
    vi.mocked(api.updateSavedNote).mockResolvedValue({
      success: true, data: makeRow("s-1", { note: "remember this" }),
    });
    const ok = await useSavedStore.getState().setNote("s-1", "remember this");
    expect(ok).toBe(true);
    expect(useSavedStore.getState().items[0].note).toBe("remember this");
  });
});

describe("savedStore — reset (logout)", () => {
  it("clears rows, ids and cursor, and drops a list response that lands after it", async () => {
    useSavedStore.setState({
      items: [makeRow("s-1")],
      hasMore: true,
      nextBefore: "c-1",
      idsLoaded: true,
      savedMessageIds: { "m-s-1": true },
      savedIdByTarget: { "message:m-s-1": "s-1" },
    });
    let resolveList!: (v: Awaited<ReturnType<typeof api.listSaved>>) => void;
    vi.mocked(api.listSaved).mockReturnValueOnce(new Promise((r) => { resolveList = r; }));
    const loading = useSavedStore.getState().fetchInitial();

    useSavedStore.getState().reset();
    resolveList({ success: true, data: { saved: [makeRow("s-leak")], has_more: false, next_before: null } });
    await loading;

    const s = useSavedStore.getState();
    expect(s.items).toEqual([]);
    expect(s.idsLoaded).toBe(false);
    expect(s.savedMessageIds).toEqual({});
    expect(s.savedIdByTarget).toEqual({});
    expect(s.nextBefore).toBeNull();
    expect(s.hasMore).toBe(false);
  });
});
