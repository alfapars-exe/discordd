import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ServerEmoji } from "../types/expression";

vi.mock("../api/emojis", () => ({
  listMyEmojis: vi.fn(),
  listServerEmojis: vi.fn(),
  createEmoji: vi.fn(),
  updateEmoji: vi.fn(),
  deleteEmoji: vi.fn(),
}));

import * as emojisApi from "../api/emojis";
import { serverIdSignature, useEmojiStore } from "./emojiStore";

const api = vi.mocked(emojisApi);

function emoji(id: string, serverId: string, name: string): ServerEmoji {
  return {
    id,
    server_id: serverId,
    name,
    display_name: name,
    animated: false,
    url: `/api/uploads/emojis/${id}.png`,
    animated_url: null,
    copyable: false,
    cloned_from: null,
    created_by: "u1",
    created_at: "2026-10-22T10:00:00Z",
  };
}

const A = emoji("aaaaaaaaaaaaaaaa", "s1", "zebra");
const B = emoji("bbbbbbbbbbbbbbbb", "s1", "alpha");
const C = emoji("cccccccccccccccc", "s2", "kedi");

beforeEach(() => {
  vi.clearAllMocks();
  useEmojiStore.getState().reset();
});

describe("emojiStore", () => {
  it("serverIdSignature is order-independent", () => {
    expect(serverIdSignature(["b", "a"])).toBe(serverIdSignature(["a", "b"]));
  });

  it("ensureLoaded groups by server, sorts by name, fills byId", async () => {
    api.listMyEmojis.mockResolvedValue({ success: true, data: [A, B, C] });
    await useEmojiStore.getState().ensureLoaded(["s2", "s1"]);
    const s = useEmojiStore.getState();
    expect(s.status).toBe("ready");
    expect(s.byServer.s1.map((e) => e.name)).toEqual(["alpha", "zebra"]);
    expect(s.byServer.s2).toEqual([C]);
    expect(s.byId[C.id]).toEqual(C);
  });

  it("does not refetch for the same server set, refetches when it changes", async () => {
    api.listMyEmojis.mockResolvedValue({ success: true, data: [A] });
    await useEmojiStore.getState().ensureLoaded(["s1", "s2"]);
    await useEmojiStore.getState().ensureLoaded(["s2", "s1"]);
    expect(api.listMyEmojis).toHaveBeenCalledTimes(1);
    await useEmojiStore.getState().ensureLoaded(["s1"]);
    expect(api.listMyEmojis).toHaveBeenCalledTimes(2);
  });

  it("marks error and allows a retry", async () => {
    api.listMyEmojis.mockResolvedValueOnce({ success: false, error: "boom" });
    await useEmojiStore.getState().ensureLoaded(["s1"]);
    expect(useEmojiStore.getState().status).toBe("error");
    api.listMyEmojis.mockResolvedValueOnce({ success: true, data: [A] });
    await useEmojiStore.getState().ensureLoaded(["s1"]);
    expect(useEmojiStore.getState().status).toBe("ready");
  });

  it("drops a response that lands after reset (logout race)", async () => {
    let resolve: (v: { success: boolean; data: ServerEmoji[] }) => void = () => {};
    api.listMyEmojis.mockReturnValue(new Promise((r) => (resolve = r)));
    const pending = useEmojiStore.getState().ensureLoaded(["s1"]);
    useEmojiStore.getState().reset();
    resolve({ success: true, data: [A] });
    await pending;
    expect(useEmojiStore.getState().byId).toEqual({});
    expect(useEmojiStore.getState().status).toBe("idle");
  });

  it("handleCreate / handleUpdate / handleDelete keep both indexes in sync", () => {
    const st = useEmojiStore.getState();
    st.handleCreate(A);
    st.handleCreate(B);
    expect(useEmojiStore.getState().byServer.s1.map((e) => e.name)).toEqual(["alpha", "zebra"]);

    st.handleUpdate({ ...A, name: "aardvark" });
    expect(useEmojiStore.getState().byServer.s1.map((e) => e.name)).toEqual(["aardvark", "alpha"]);
    expect(useEmojiStore.getState().byId[A.id].name).toBe("aardvark");

    st.handleDelete({ id: A.id, server_id: "s1" });
    expect(useEmojiStore.getState().byServer.s1).toEqual([B]);
    expect(useEmojiStore.getState().byId[A.id]).toBeUndefined();
  });

  it("handleCreate is idempotent (REST result + WS echo)", () => {
    useEmojiStore.getState().handleCreate(A);
    useEmojiStore.getState().handleCreate(A);
    expect(useEmojiStore.getState().byServer.s1).toHaveLength(1);
  });

  it("fetchServer replaces one server's list and its byId entries", async () => {
    useEmojiStore.getState().handleCreate(A);
    useEmojiStore.getState().handleCreate(C);
    api.listServerEmojis.mockResolvedValue({ success: true, data: [B] });
    await useEmojiStore.getState().fetchServer("s1");
    const s = useEmojiStore.getState();
    expect(s.byServer.s1).toEqual([B]);
    expect(s.byId[A.id]).toBeUndefined();
    expect(s.byId[C.id]).toEqual(C);
  });

  it("createEmoji applies the created emoji locally", async () => {
    api.createEmoji.mockResolvedValue({ success: true, data: C });
    const file = new File(["x"], "k.png", { type: "image/png" });
    const res = await useEmojiStore.getState().createEmoji("s2", { file, display_name: "Kedi" });
    expect(res.success).toBe(true);
    expect(useEmojiStore.getState().byId[C.id]).toEqual(C);
  });

  it("reset clears everything", () => {
    useEmojiStore.getState().handleCreate(A);
    useEmojiStore.getState().reset();
    const s = useEmojiStore.getState();
    expect(s.byServer).toEqual({});
    expect(s.byId).toEqual({});
    expect(s.loadedFor).toBe("");
  });
});
