import { redirectFixture } from "./redirect-test-fixture";
/**
 * Uses node:test — zero new dependencies, same harness as resolve-path.test.ts.
 * api-proxy.ts deliberately imports nothing from `electron` so these run
 * under plain node; the fetch implementation is injected as a fake.
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { WebContents } from "electron";
import { API_REQUEST_HEADER, createApiRequestCancellation } from "./api-request-cancellation";
import {
  DEFAULT_UPSTREAM,
  UPSTREAM_HEADER,
  buildUpstreamUrl,
  isProxyableUrl,
  proxyApiRequest,
  sanitizeUpstreamOrigin,
} from "./api-proxy.js";

// ─── isProxyableUrl ───

test("proxies only the /api subtree of app://hichat", () => {
  assert.equal(isProxyableUrl("app://hichat/api/auth/login"), true);
  assert.equal(isProxyableUrl("app://hichat/api"), true);
  assert.equal(isProxyableUrl("app://hichat/api/uploads/x.png?r=1"), true);
  // Static assets keep going to disk.
  assert.equal(isProxyableUrl("app://hichat/index.html"), false);
  assert.equal(isProxyableUrl("app://hichat/assets/main.js"), false);
  assert.equal(isProxyableUrl("app://hichat/"), false);
  // /apifoo must not match — prefix check is on the path segment.
  assert.equal(isProxyableUrl("app://hichat/apifoo"), false);
});

test("rejects wrong scheme/host and malformed URLs", () => {
  assert.equal(isProxyableUrl("app://evil/api/x"), false);
  assert.equal(isProxyableUrl("https://hichat/api/x"), false);
  assert.equal(isProxyableUrl("not a url"), false);
});

// ─── sanitizeUpstreamOrigin ───

test("accepts https origins and reduces them to bare origin", () => {
  assert.equal(
    sanitizeUpstreamOrigin("https://infinayazilim-discord.hf.space"),
    "https://infinayazilim-discord.hf.space"
  );
  // Path/query/fragment and trailing slash are discarded.
  assert.equal(
    sanitizeUpstreamOrigin("https://example.com/some/path?q=1#frag"),
    "https://example.com"
  );
  assert.equal(sanitizeUpstreamOrigin("https://example.com:8443/"), "https://example.com:8443");
});

test("allows plain-http loopback ONLY when explicitly enabled (dev builds)", () => {
  const dev = { allowLoopback: true };
  assert.equal(sanitizeUpstreamOrigin("http://localhost:9090", dev), "http://localhost:9090");
  assert.equal(sanitizeUpstreamOrigin("http://127.0.0.1:9090", dev), "http://127.0.0.1:9090");
  // Non-loopback http is refused even in dev.
  assert.equal(sanitizeUpstreamOrigin("http://192.168.1.10", dev), null);
  assert.equal(sanitizeUpstreamOrigin("http://example.com", dev), null);
});

test("packaged builds refuse loopback — main is not bound by the renderer CSP", () => {
  // The one capability this relay could genuinely add over a compromised
  // renderer is reaching services on the user's own machine. Default off.
  assert.equal(sanitizeUpstreamOrigin("http://localhost:9090"), null);
  assert.equal(sanitizeUpstreamOrigin("http://127.0.0.1:9090"), null);
  assert.equal(sanitizeUpstreamOrigin("http://[::1]:9090"), null);
  // https still works, loopback or not — that's the production path.
  assert.equal(sanitizeUpstreamOrigin("https://example.com"), "https://example.com");
});

test("a packaged build falls back to the default upstream when handed a loopback URL", async () => {
  const { calls, impl } = fakeFetch(new Response("{}", { status: 200 }));
  await proxyApiRequest(
    new Request("app://hichat/api/health", { headers: { [UPSTREAM_HEADER]: "http://localhost:9090" } }),
    impl
  );
  assert.equal(calls[0].input, `${DEFAULT_UPSTREAM}/api/health`);
});

test("dev builds honour a loopback upstream", async () => {
  const { calls, impl } = fakeFetch(new Response("{}", { status: 200 }));
  await proxyApiRequest(
    new Request("app://hichat/api/health", { headers: { [UPSTREAM_HEADER]: "http://localhost:9090" } }),
    impl,
    { allowLoopback: true }
  );
  assert.equal(calls[0].input, "http://localhost:9090/api/health");
});

test("rejects credential smuggling, exotic schemes, and garbage", () => {
  assert.equal(sanitizeUpstreamOrigin("https://user:pass@example.com"), null);
  assert.equal(sanitizeUpstreamOrigin("ftp://example.com"), null);
  assert.equal(sanitizeUpstreamOrigin("javascript:alert(1)"), null);
  assert.equal(sanitizeUpstreamOrigin("file:///etc/passwd"), null);
  assert.equal(sanitizeUpstreamOrigin(""), null);
  assert.equal(sanitizeUpstreamOrigin(null), null);
  assert.equal(sanitizeUpstreamOrigin("%%%"), null);
});

// ─── buildUpstreamUrl ───

test("maps app path + query onto the upstream origin", () => {
  assert.equal(
    buildUpstreamUrl("app://hichat/api/messages?channel=3&limit=50", "https://api.example"),
    "https://api.example/api/messages?channel=3&limit=50"
  );
});

// ─── proxyApiRequest ───

type Captured = { input: string; init: RequestInit & { duplex?: string } };

function fakeFetch(response: Response): { calls: Captured[]; impl: (input: string, init: RequestInit) => Promise<Response> } {
  const calls: Captured[] = [];
  return {
    calls,
    impl: (input, init) => {
      calls.push({ input, init });
      return Promise.resolve(response);
    },
  };
}

test("forwards method, API headers and body; strips routing + cookie headers", async () => {
  const { calls, impl } = fakeFetch(new Response("{}", { status: 200 }));
  const request = new Request("app://hichat/api/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-HiChat-Client": "electron",
      [UPSTREAM_HEADER]: "https://api.example",
      Cookie: "refresh_token=stale-app-scheme-copy",
    },
    body: JSON.stringify({ username: "u", password: "p" }),
  });

  const res = await proxyApiRequest(request, impl);

  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, "https://api.example/api/auth/login");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.credentials, "include");

  const sent = new Headers(calls[0].init.headers);
  assert.equal(sent.get("x-hichat-client"), "electron");
  assert.equal(sent.get("content-type"), "application/json");
  // Routing header must not leak upstream; Cookie is owned by the network
  // layer (session jar), never forwarded from the renderer copy.
  assert.equal(sent.get(UPSTREAM_HEADER), null);
  assert.equal(sent.get("cookie"), null);

  // Streaming body requires explicit half-duplex.
  assert.ok(calls[0].init.body);
  assert.equal(calls[0].init.duplex, "half");
});

test("falls back to the default upstream when the header is missing or invalid", async () => {
  const { calls, impl } = fakeFetch(new Response("{}", { status: 200 }));
  await proxyApiRequest(new Request("app://hichat/api/health"), impl);
  await proxyApiRequest(
    new Request("app://hichat/api/health", { headers: { [UPSTREAM_HEADER]: "ftp://x" } }),
    impl
  );
  assert.equal(calls[0].input, `${DEFAULT_UPSTREAM}/api/health`);
  assert.equal(calls[1].input, `${DEFAULT_UPSTREAM}/api/health`);
});

test("GET requests carry no body and no duplex flag", async () => {
  const { calls, impl } = fakeFetch(new Response("{}", { status: 200 }));
  await proxyApiRequest(new Request("app://hichat/api/users/me"), impl);
  assert.equal(calls[0].init.body, undefined);
  assert.equal(calls[0].init.duplex, undefined);
});

test("strips Set-Cookie from the upstream response", async () => {
  // The network layer already stored the cookie against the real backend
  // host; passing it through would double-store it under app://hichat and
  // desync on rotation.
  const upstream = new Response("{}", {
    status: 200,
    headers: { "Set-Cookie": "refresh_token=abc; Path=/", "X-Request-Id": "rid-1" },
  });
  const { impl } = fakeFetch(upstream);
  const res = await proxyApiRequest(new Request("app://hichat/api/auth/refresh", { method: "POST", body: "{}" }), impl);
  assert.equal(res.headers.get("set-cookie"), null);
  // Non-cookie headers survive.
  assert.equal(res.headers.get("x-request-id"), "rid-1");
});

test("relays 204 responses without a body payload", async () => {
  const { impl } = fakeFetch(new Response(null, { status: 204 }));
  const res = await proxyApiRequest(new Request("app://hichat/api/thing", { method: "DELETE" }), impl);
  assert.equal(res.status, 204);
  assert.equal(res.body, null);
});

test("rethrows upstream network failures so the renderer sees a fetch error", async () => {
  const impl = () => Promise.reject(new TypeError("net::ERR_CONNECTION_REFUSED"));
  await assert.rejects(
    () => proxyApiRequest(new Request("app://hichat/api/health"), impl),
    /ERR_CONNECTION_REFUSED/
  );
});

test("aborting a desktop request aborts the pending upstream fetch", async () => {
  const controller = new AbortController();
  const request = new Request("app://hichat/api/servers/s/voice/token", { signal: controller.signal });
  let upstreamSignal: AbortSignal | null | undefined;
  const pending = proxyApiRequest(request, (_url, init) => new Promise<Response>((_resolve, reject) => {
    upstreamSignal = init.signal;
    init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  }));
  const rejected = assert.rejects(pending, { name: "AbortError" });
  controller.abort();
  await rejected;
  assert.equal(upstreamSignal?.aborted, true);
});

test("keeps an already cancelled desktop request cancelled upstream", async () => {
  const controller = new AbortController();
  controller.abort();
  const request = new Request("app://hichat/api/servers/s/voice/token", { signal: controller.signal });
  await assert.rejects(proxyApiRequest(request, async (_url, init) => {
    assert.equal(init.signal?.aborted, true);
    init.signal?.throwIfAborted();
    return new Response("{}");
  }), { name: "AbortError" });
});

function registeredRequest() {
  const frame = {}, sender = { isDestroyed: () => false, mainFrame: frame } as unknown as WebContents;
  const owner = { sender, frame: sender.mainFrame }, cancellation = createApiRequestCancellation();
  const binding = { url: "app://hichat/api/servers/a/voice/token", method: "POST", upstream: "https://api.example" };
  const id = cancellation.reserve(owner, binding);
  const request = new Request(binding.url, { method: binding.method, headers: { [UPSTREAM_HEADER]: binding.upstream, [API_REQUEST_HEADER]: id }, body: "{}" });
  return { owner, cancellation, id, request };
}

test("registered desktop cancellation aborts upstream even while the protocol signal stays live", async () => {
  const h = registeredRequest();
  let upstreamSignal: AbortSignal | null | undefined;
  const pending = proxyApiRequest(h.request, (_url, init) => new Promise<Response>((_resolve, reject) => {
    assert.equal(new Headers(init.headers).get(API_REQUEST_HEADER), null);
    upstreamSignal = init.signal;
    init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  }), h);
  const rejected = assert.rejects(pending, { name: "AbortError" });
  h.cancellation.cancel(h.owner, h.id);
  await rejected;
  assert.equal(h.request.signal.aborted, false);
  assert.equal(upstreamSignal?.aborted, true);
  assert.equal(h.cancellation.size, 0);
});

test("a registered lease survives headers and is released only after body EOF", async () => {
  const h = registeredRequest();
  let finish!: () => void;
  const res = await proxyApiRequest(h.request, async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode("hello")); finish = () => controller.close(); },
  })), h);
  assert.equal(h.cancellation.size, 1);
  const body = res.text();
  finish();
  assert.equal(await body, "hello");
  assert.equal(h.cancellation.size, 0);
});

test("registered cancellation interrupts an active upstream response body", async () => {
  const h = registeredRequest();
  const res = await proxyApiRequest(h.request, async (_url, init) => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([1])); init.signal?.addEventListener("abort", () => controller.error(init.signal?.reason)); },
  })), h);
  const body = res.text(), rejected = assert.rejects(body, { name: "AbortError" });
  h.cancellation.cancel(h.owner, h.id);
  await rejected;
  assert.equal(h.cancellation.size, 0);
});

test("body cancellation, fetch failure and null responses release registered leases", async () => {
  for (const mode of ["body", "failure", "empty"] as const) {
    const h = registeredRequest();
    let sourceCancelled = false;
    if (mode === "failure") {
      await assert.rejects(proxyApiRequest(h.request, async () => { throw Error("unavailable"); }, h), /unavailable/);
    } else {
      const res = await proxyApiRequest(h.request, async () => mode === "empty" ? new Response(null, { status: 204 }) : new Response(new ReadableStream({ cancel() { sourceCancelled = true; } })), h);
      if (mode === "body") { await res.body!.cancel(); assert.equal(sourceCancelled, true); }
    }
    assert.equal(h.cancellation.size, 0);
  }
});

test("unknown or retired private IDs are rejected before any upstream fetch", async () => {
  const h = registeredRequest(), calls: string[] = [];
  h.cancellation.cancel(h.owner, h.id);
  await assert.rejects(proxyApiRequest(h.request, async url => { calls.push(url); return new Response("{}"); }, h), /unavailable/);
  await assert.rejects(proxyApiRequest(h.request, async url => { calls.push(url); return new Response("{}"); }), /unavailable/);
  assert.deepEqual(calls, []);
});

test("a proxied API read cannot follow an upstream redirect into a second server", async t => {
  const { origin, targetRequests } = await redirectFixture(t);
  const request = new Request("app://hichat/api/health", {headers: {[UPSTREAM_HEADER]: origin}});
  await assert.rejects(() => proxyApiRequest(request, fetch, {allowLoopback: true}));
  assert.equal(targetRequests(), 0);
});
