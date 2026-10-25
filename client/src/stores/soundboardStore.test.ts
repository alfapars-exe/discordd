import { beforeEach, describe, expect, it, vi } from "vitest";
import type { APIResponse, SoundboardSound } from "../types";
import { useSoundboardStore } from "./soundboardStore";
import * as soundboardApi from "../api/soundboard";

const server = vi.hoisted(() => ({ activeServerId: "server-a" }));
vi.mock("./serverStore", () => ({ useServerStore: { getState: () => server } }));
vi.mock("../api/soundboard", () => ({ getSounds: vi.fn(), playSound: vi.fn() }));
vi.mock("../utils/constants", () => ({ SERVER_URL: "" }));

describe("soundboard server context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    server.activeServerId = "server-a";
    useSoundboardStore.setState({ sounds: [], isPanelOpen: false, isLoading: false });
  });

  it("discards a list response from the server browsed before returning to the call", async () => {
    let resolveA!: (value: APIResponse<SoundboardSound[]>) => void;
    vi.mocked(soundboardApi.getSounds).mockImplementationOnce(() => new Promise((resolve) => { resolveA = resolve; }));
    const requestA = useSoundboardStore.getState().fetchSounds();
    server.activeServerId = "server-b";
    useSoundboardStore.getState().clearForServerSwitch();
    const soundsB = [{ id: "sound-b", server_id: "server-b", name: "B" }] as SoundboardSound[];
    vi.mocked(soundboardApi.getSounds).mockResolvedValueOnce({ success: true, data: soundsB });
    await useSoundboardStore.getState().fetchSounds();
    resolveA({ success: true, data: [{ id: "sound-a", server_id: "server-a", name: "A" }] as SoundboardSound[] });
    await requestA;
    expect(useSoundboardStore.getState().sounds).toEqual(soundsB);
    expect(useSoundboardStore.getState().isLoading).toBe(false);
  });
});
