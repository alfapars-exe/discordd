import { afterEach, expect, it, vi } from "vitest";
import { createDesktopRequestOwner } from "./desktopRequestCancellation";

afterEach(() => { delete window.electronAPI; vi.unstubAllGlobals(); });
const request = { method: "POST", headers: { "X-HiChat-Upstream": "https://api.example" }, body: "{}" };
const url = "app://hichat/api/servers/a/voice/token";
function bridge() {
  const api = { reserveApiRequest: vi.fn().mockResolvedValue("lease"), cancelApiRequest: vi.fn().mockResolvedValue(true) };
  window.electronAPI = api as unknown as NonNullable<Window["electronAPI"]>;
  return api;
}

it("registers before dispatch and forwards an abort to the native lease", async () => {
  const api = bridge(), controller = new AbortController(), fetch = vi.fn().mockResolvedValue(new Response("{}"));
  vi.stubGlobal("fetch", fetch);
  const owner = createDesktopRequestOwner(true, controller.signal);
  await owner.fetch(url, request);
  expect(api.reserveApiRequest).toHaveBeenCalledWith({ url, method: "POST", upstream: "https://api.example" });
  expect(new Headers(fetch.mock.calls[0][1].headers).get("X-HiChat-Request-Id")).toBe("lease");
  controller.abort();
  expect(api.cancelApiRequest).toHaveBeenCalledWith("lease");
  owner.dispose();
  expect(api.cancelApiRequest).toHaveBeenCalledOnce();
});

it.each(["abort", "dispose"] as const)("retires a registration acknowledged after %s without dispatching fetch", async action => {
  const api = bridge(), controller = new AbortController(), fetch = vi.fn();
  let acknowledge!: (id: string) => void;
  api.reserveApiRequest.mockReturnValueOnce(new Promise(resolve => { acknowledge = resolve; }));
  vi.stubGlobal("fetch", fetch);
  const owner = createDesktopRequestOwner(true, controller.signal), pending = owner.fetch(url, request);
  if (action === "abort") controller.abort(); else owner.dispose();
  acknowledge("late-lease");
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(api.cancelApiRequest).toHaveBeenCalledWith("late-lease");
  expect(fetch).not.toHaveBeenCalled();
  owner.dispose();
});

it("releases an unread preceding response and reserves a fresh ID for a retry", async () => {
  const api = bridge(), controller = new AbortController();
  api.reserveApiRequest.mockResolvedValueOnce("first").mockResolvedValueOnce("retry");
  const fetch = vi.fn().mockResolvedValue(new Response("{}")); vi.stubGlobal("fetch", fetch);
  const owner = createDesktopRequestOwner(true, controller.signal);
  await owner.fetch(url, request); await owner.fetch(url, request);
  expect(api.cancelApiRequest).toHaveBeenCalledWith("first");
  expect(fetch.mock.calls.map(call => new Headers(call[1].headers).get("X-HiChat-Request-Id"))).toEqual(["first", "retry"]);
  owner.dispose(); expect(api.cancelApiRequest).toHaveBeenLastCalledWith("retry");
});

it.each([false, true])("leaves requests without a caller signal unchanged (desktop=%s)", async enabled => {
  const api = bridge(), fetch = vi.fn().mockResolvedValue(new Response("{}")); vi.stubGlobal("fetch", fetch);
  const owner = createDesktopRequestOwner(enabled);
  await owner.fetch(url, request); owner.dispose();
  expect(fetch).toHaveBeenCalledWith(url, request);
  expect(api.reserveApiRequest).not.toHaveBeenCalled();
});
