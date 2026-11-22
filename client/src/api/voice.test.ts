import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../utils/constants", () => ({
  API_BASE_URL: "https://api.test.local/api", SERVER_URL: "https://api.test.local",
  isElectron: () => false, isCapacitor: () => false, isAppProtocolPage: () => false,
}));

const json = (body: unknown) => new Response(JSON.stringify(body), {
  headers: { "Content-Type": "application/json" },
});
const validToken = `header.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))}.signature`;
beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.unstubAllGlobals(); });

it("cancels the actual voice HTTP fetch when its owner aborts", async () => {
  const { setTokens } = await import("./client");
  const { getVoiceToken } = await import("./voice");
  setTokens(validToken, "");
  let networkSignal: AbortSignal | undefined;
  const fetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    networkSignal = init.signal!;
    networkSignal.addEventListener("abort", () => reject(networkSignal?.reason), { once: true });
  }));
  vi.stubGlobal("fetch", fetch);
  const controller = new AbortController();
  const pending = getVoiceToken("server", "voice", { signal: controller.signal, timeoutMs: 15_000 });
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  controller.abort();
  await expect(pending).resolves.toMatchObject({ success: false, error: "request_cancelled" });
  expect(networkSignal?.aborted).toBe(true);
});

it("keeps shared authentication refresh alive when a superseded voice request is aborted", async () => {
  const { setTokens } = await import("./client");
  const { getVoiceToken } = await import("./voice");
  setTokens("expired-token", "");
  let resolveRefresh!: (response: Response) => void;
  const refresh = new Promise<Response>(resolve => { resolveRefresh = resolve; });
  const fetch = vi.fn((url: string) => url.endsWith("/auth/refresh") ? refresh : Promise.resolve(json({
    success: true, data: { channel_id: "latest", token: "room-token", url: "wss://voice.test" },
  })));
  vi.stubGlobal("fetch", fetch);
  const controller = new AbortController();
  const first = getVoiceToken("server", "old", { signal: controller.signal, timeoutMs: 15_000 });
  const latest = getVoiceToken("server", "latest", { timeoutMs: 15_000 });
  controller.abort();
  await expect(first).resolves.toMatchObject({ success: false, error: "request_cancelled" });
  const refreshInit = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
  expect(refreshInit.signal?.aborted).toBe(false);
  resolveRefresh(json({ success: true, data: { access_token: validToken } }));
  await expect(latest).resolves.toMatchObject({ success: true, data: { channel_id: "latest" } });
  expect(fetch).toHaveBeenCalledTimes(2);
  const tokenInit = (fetch.mock.calls[1] as unknown as [string, RequestInit])[1];
  expect(JSON.parse(tokenInit.body as string)).toEqual({ channel_id: "latest" });
});
