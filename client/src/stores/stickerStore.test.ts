import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ServerSticker } from "../types/expression";

vi.mock("../api/stickers", () => ({
  listMyStickers: vi.fn(),
  listServerStickers: vi.fn(),
  createSticker: vi.fn(),
  updateSticker: vi.fn(),
  deleteSticker: vi.fn(),
}));

import * as stickersApi from "../api/stickers";
import { useStickerStore } from "./stickerStore";

const api = vi.mocked(stickersApi);

function sticker(id: string, serverId: string, name: string): ServerSticker {
  return {
    id,
    server_id: serverId,
    name,
    display_name: name,
    description: "",
    tags: [],
    animated: false,
    url: `/api/uploads/stickers/${id}.png`,
    animated_url: null,
    copyable: false,
    cloned_from: null,
    created_by: "u1",
    created_at: "2026-10-22T10:00:00Z",
  };
}

const A = sticker("aaaaaaaaaaaaaaaa", "s1", "zebra");
const B = sticker("bbbbbbbbbbbbbbbb", "s1", "alpha");
const C = sticker("cccccccccccccccc", "s2", "kedi");

beforeEach(() => {
  vi.clearAllMocks();
  useStickerStore.getState().reset();
});

describe("stickerStore", () => {
  it("ensureLoaded groups by server, sorts by name, fills byId", async () => {
    api.listMyStickers.mockResolvedValue({ success: true, data: [A, B, C] });
    await useStickerStore.getState().ensureLoaded(["s2", "s1"]);
    const s = useStickerStore.getState();
    expect(s.status).toBe("ready");
    expect(s.byServer.s1.map((x) => x.name)).toEqual(["alpha", "zebra"]);
    expect(s.byServer.s2).toEqual([C]);
    expect(s.byId[C.id]).toEqual(C);
  });

  it("does not refetch for the same server set (signature), refetches when it changes", async () => {
    api.listMyStickers.mockResolvedValue({ success: true, data: [A] });
    await useStickerStore.getState().ensureLoaded(["s1", "s2"]);
    await useStickerStore.getState().ensureLoaded(["s2", "s1"]);
    expect(api.listMyStickers).toHaveBeenCalledTimes(1);
    await useStickerStore.getState().ensureLoaded(["s1"]);
    expect(api.listMyStickers).toHaveBeenCalledTimes(2);
  });

  it("marks error and allows a retry", async () => {
    api.listMyStickers.mockResolvedValueOnce({ success: false, error: "boom" });
    await useStickerStore.getState().ensureLoaded(["s1"]);
    expect(useStickerStore.getState().status).toBe("error");
    api.listMyStickers.mockResolvedValueOnce({ success: true, data: [A] });
    await useStickerStore.getState().ensureLoaded(["s1"]);
    expect(useStickerStore.getState().status).toBe("ready");
  });

  it("drops a response that lands after reset (logout race)", async () => {
    let resolve: (v: { success: boolean; data: ServerSticker[] }) => void = () => {};
    api.listMyStickers.mockReturnValue(new Promise((r) => (resolve = r)));
    const pending = useStickerStore.getState().ensureLoaded(["s1"]);
    useStickerStore.getState().reset();
    resolve({ success: true, data: [A] });
    await pending;
    const s = useStickerStore.getState();
    expect(s.byId).toEqual({});
    expect(s.status).toBe("idle");
  });

  it("fetchServer drops a response after reset", async () => {
    let resolve: (v: { success: boolean; data: ServerSticker[] }) => void = () => {};
    api.listServerStickers.mockReturnValue(new Promise((r) => (resolve = r)));
    const pending = useStickerStore.getState().fetchServer("s1");
    useStickerStore.getState().reset();
    resolve({ success: true, data: [A] });
    await pending;
    expect(useStickerStore.getState().byServer).toEqual({});
  });

  it("handleCreate / handleUpdate upsert, handleDelete removes", () => {
    const st = useStickerStore.getState();
    st.handleCreate(A);
    st.handleCreate(B);
    expect(useStickerStore.getState().byServer.s1.map((x) => x.name)).toEqual(["alpha", "zebra"]);
    st.handleUpdate({ ...A, name: "aardvark" });
    expect(useStickerStore.getState().byServer.s1.map((x) => x.name)).toEqual(["aardvark", "alpha"]);
    expect(useStickerStore.getState().byId[A.id].name).toBe("aardvark");
    st.handleCreate(B); // idempotent (WS echo after local upsert)
    expect(useStickerStore.getState().byServer.s1).toHaveLength(2);
    st.handleDelete({ id: A.id, server_id: "s1" });
    expect(useStickerStore.getState().byId[A.id]).toBeUndefined();
    expect(useStickerStore.getState().byServer.s1.map((x) => x.id)).toEqual([B.id]);
  });

  it("mutations upsert on success only", async () => {
    api.createSticker.mockResolvedValueOnce({ success: false, error: "x" });
    const file = new File([new Uint8Array([1])], "a.png");
    await useStickerStore.getState().createSticker("s2", { file, display_name: "Kedi" });
    expect(useStickerStore.getState().byId[C.id]).toBeUndefined();
    api.createSticker.mockResolvedValueOnce({ success: true, data: C });
    await useStickerStore.getState().createSticker("s2", { file, display_name: "Kedi" });
    expect(useStickerStore.getState().byId[C.id]).toEqual(C);
    api.deleteSticker.mockResolvedValueOnce({ success: true });
    await useStickerStore.getState().deleteSticker("s2", C.id);
    expect(useStickerStore.getState().byId[C.id]).toBeUndefined();
  });
});
