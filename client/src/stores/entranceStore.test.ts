import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EntranceSelection, EntranceSound } from "../types/entrance";

vi.mock("../api/entrance", () => ({
  listMine: vi.fn(),
  uploadSound: vi.fn(),
  renameSound: vi.fn(),
  deleteSound: vi.fn(),
  putSelection: vi.fn(),
}));

import * as entranceApi from "../api/entrance";
import { useEntranceStore } from "./entranceStore";

const api = vi.mocked(entranceApi);

function sound(id: string, created: string, name = id): EntranceSound {
  return {
    id,
    name,
    url: `/api/uploads/entrance/${id}.wav`,
    duration_ms: 1000,
    size: 48044,
    created_at: created,
  };
}

const A = sound("aaaaaaaaaaaaaaaa", "2026-10-22T10:00:00Z");
const B = sound("bbbbbbbbbbbbbbbb", "2026-10-21T10:00:00Z");
const SEL: EntranceSelection = {
  scope: "global",
  kind: "clip",
  sound_id: A.id,
  preset: null,
  updated_at: "2026-10-22T10:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  useEntranceStore.getState().reset();
});

describe("entranceStore", () => {
  it("load fills sounds (oldest first) and selections", async () => {
    api.listMine.mockResolvedValue({ success: true, data: { sounds: [A, B], selections: [SEL] } });
    await useEntranceStore.getState().load();
    const s = useEntranceStore.getState();
    expect(s.status).toBe("ready");
    expect(s.sounds.map((x) => x.id)).toEqual([B.id, A.id]);
    expect(s.selections).toEqual([SEL]);
  });

  it("load failure → error status", async () => {
    api.listMine.mockResolvedValue({ success: false, error: "x" });
    await useEntranceStore.getState().load();
    expect(useEntranceStore.getState().status).toBe("error");
  });

  it("drops a load response that lands after reset (generation)", async () => {
    let resolve: (v: Awaited<ReturnType<typeof entranceApi.listMine>>) => void = () => {};
    api.listMine.mockReturnValue(new Promise((r) => (resolve = r)));
    const p = useEntranceStore.getState().load();
    useEntranceStore.getState().reset();
    resolve({ success: true, data: { sounds: [A], selections: [SEL] } });
    await p;
    const s = useEntranceStore.getState();
    expect(s.sounds).toEqual([]);
    expect(s.selections).toEqual([]);
    expect(s.status).toBe("idle");
  });

  it("drops an upload response that lands after reset", async () => {
    let resolve: (v: Awaited<ReturnType<typeof entranceApi.uploadSound>>) => void = () => {};
    api.uploadSound.mockReturnValue(new Promise((r) => (resolve = r)));
    const p = useEntranceStore.getState().upload(new Blob(["x"]), "a");
    useEntranceStore.getState().reset();
    resolve({ success: true, data: A });
    await p;
    expect(useEntranceStore.getState().sounds).toEqual([]);
  });

  it("upload / rename / remove fold the server answer in", async () => {
    api.uploadSound.mockResolvedValue({ success: true, data: A });
    await useEntranceStore.getState().upload(new Blob(["x"]), "a");
    expect(useEntranceStore.getState().sounds).toEqual([A]);

    const renamed = { ...A, name: "Davul" };
    api.renameSound.mockResolvedValue({ success: true, data: renamed });
    await useEntranceStore.getState().rename(A.id, "Davul");
    expect(useEntranceStore.getState().sounds[0].name).toBe("Davul");

    useEntranceStore.setState({ selections: [SEL] });
    api.deleteSound.mockResolvedValue({ success: true });
    await useEntranceStore.getState().remove(A.id);
    expect(useEntranceStore.getState().sounds).toEqual([]);
    expect(useEntranceStore.getState().selections).toEqual([]);
  });

  it("failed upload leaves state untouched and returns the error", async () => {
    api.uploadSound.mockResolvedValue({ success: false, code: "ENTRANCE_LIMIT_REACHED" });
    const res = await useEntranceStore.getState().upload(new Blob(["x"]), "a");
    expect(res.code).toBe("ENTRANCE_LIMIT_REACHED");
    expect(useEntranceStore.getState().sounds).toEqual([]);
  });

  it("setSelection replaces selections with the server list", async () => {
    api.putSelection.mockResolvedValue({ success: true, data: [SEL] });
    await useEntranceStore.getState().setSelection({ scope: "global", kind: "clip", sound_id: A.id });
    expect(api.putSelection).toHaveBeenCalledWith({ scope: "global", kind: "clip", sound_id: A.id });
    expect(useEntranceStore.getState().selections).toEqual([SEL]);
  });

  it("reset clears everything", () => {
    useEntranceStore.setState({ sounds: [A], selections: [SEL], status: "ready" });
    useEntranceStore.getState().reset();
    const s = useEntranceStore.getState();
    expect(s.sounds).toEqual([]);
    expect(s.selections).toEqual([]);
    expect(s.status).toBe("idle");
  });
});
