import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createCS2JoinController, type CS2JoinRequest } from "./cs2-join-controller";

const recipe = { adapter: "cs2-steam", lobbyId: ((1n << 56n) | (8n << 52n) | (1n << 50n) | 123n).toString(), inviterId: ((1n << 56n) | (1n << 52n) | (1n << 32n) | 123n).toString() };
const epoch = Date.parse("2026-10-25T12:00:00Z");
function setup(overrides: Partial<Parameters<typeof createCS2JoinController>[0]> = {}) {
  const endpoint = {}, foreign = {};
  const calls: Array<{ url: string; init: RequestInit }> = [], launches: string[] = [];
  let current = true;
  const payload = { origin: "https://chat.example.test", ownerId: "abc123", generation: 1, nonce: randomUUID() };
  let request: CS2JoinRequest;
  const data = () => ({ ticket_id: request.ticketId, viewer_user_id: payload.ownerId, target_user_id: request.targetUserId, offer_revision: request.offerRevision, expires_at: new Date(epoch + 30_000).toISOString(), recipe });
  const response = (value: unknown = data(), init: ResponseInit = {}) => new Response(JSON.stringify({ success: true, data: value }), { headers: { "Content-Type": "application/json" }, ...init });
  const controller = createCS2JoinController({ now: () => epoch, fetch: async (url, init) => { calls.push({ url, init }); return response(); }, openExternal: async uri => { launches.push(uri); }, isCurrent: candidate => candidate === endpoint && current, ...overrides });
  const ack = controller.sync(endpoint, payload);
  assert.equal(ack.accepted, true);
  request = { scopeNonce: ack.scopeNonce!, ticketId: randomUUID(), ticket: "A".repeat(43), targetUserId: "target_123", offerRevision: 8, accessToken: "synthetic.token.value", requestId: randomUUID() };
  return { controller, endpoint, foreign, calls, launches, payload, request, response, data, setCurrent: (value: boolean) => { current = value; } };
}

test("only fixed server consume path and typed CS2 recipe reach external handler", async () => {
  const f = setup(); assert.equal(await f.controller.launch(f.endpoint, f.request), "forwarded");
  assert.deepEqual(f.launches, [`steam://joinlobby/730/${recipe.lobbyId}/${recipe.inviterId}`]);
  assert.equal(f.calls[0].url, "https://chat.example.test/api/game-join/tickets/consume");
  assert.deepEqual(JSON.parse(f.calls[0].init.body as string), { ticket: f.request.ticket, expected_user_id: f.payload.ownerId });
  assert.equal(f.calls[0].init.redirect, "error"); assert.equal(f.calls[0].init.credentials, "omit"); assert.equal(f.calls[0].init.cache, "no-store");
  assert.deepEqual(f.calls[0].init.headers, { "Content-Type": "application/json", Authorization: `Bearer ${f.request.accessToken}` });
  assert.equal(await f.controller.launch(f.endpoint, f.request), "denied"); assert.equal(f.launches.length, 1);
});
test("context ACK is idempotent for exact projection and fresh for auth generation", () => {
  const f = setup(); assert.equal(f.controller.sync(f.endpoint, f.payload).scopeNonce, f.request.scopeNonce);
  assert.notEqual(f.controller.sync(f.endpoint, { ...f.payload, generation: 2 }).scopeNonce, f.request.scopeNonce);
  assert.deepEqual(f.controller.sync(f.foreign, f.payload), { accepted: false, scopeNonce: null });
  assert.deepEqual(f.controller.sync(f.endpoint, null), { accepted: true, scopeNonce: null });
});
test("origin requires exact sanitized bare origin; packaged HTTP and decorated authorities rejected", async () => {
  for (const origin of ["http://localhost:9090", "file:///tmp", "https://u:p@host.test", "https://host.test/path", "https://host.test/", "https://host.test?x=1", "https://host.test#fragment", "https://host.test\\x"]) {
    const f = setup(); assert.equal(f.controller.sync(f.endpoint, { ...f.payload, origin }).accepted, false, origin); assert.equal(await f.controller.launch(f.endpoint, f.request), "denied");
  }
  const f = setup({ allowLoopback: true }); assert.equal(f.controller.sync(f.endpoint, { ...f.payload, origin: "http://127.0.0.1:18181" }).accepted, true);
});
test("foreign and no-longer-live main endpoints cannot launch", async () => {
  const f = setup(); assert.equal(await f.controller.launch(f.foreign, f.request), "denied"); f.setCurrent(false); assert.equal(await f.controller.launch(f.endpoint, f.request), "denied"); assert.equal(f.calls.length, 0);
});
test("request is bounded data, no extra URL/recipe/headers or malformed bearer", async () => {
  const mutations = [ { url: "steam://run/730" }, { recipe }, { accessToken: "x\nInjected: 1" }, { accessToken: "x".repeat(8193) }, { targetUserId: "../target" }, { offerRevision: 0 }, { offerRevision: 1.1 }, { ticketId: "opaque" }, { ticket: "A".repeat(42) }, { requestId: "id" }, { scopeNonce: randomUUID() } ];
  for (const patch of mutations) { const f = setup(); assert.equal(await f.controller.launch(f.endpoint, { ...f.request, ...patch }), "denied"); assert.equal(f.calls.length, 0); }
});
test("pending fetch is fenced on logout, endpoint retirement or scope replacement", async () => {
  for (const kind of ["logout", "retire", "replace", "dead"]) {
    let resolve!: (value: Response) => void;
    const f = setup({ fetch: () => new Promise(done => { resolve = done; }) });
    const pending = f.controller.launch(f.endpoint, f.request);
    if (kind === "logout") f.controller.sync(f.endpoint, null);
    if (kind === "retire") f.controller.retire(f.endpoint);
    if (kind === "replace") f.controller.sync(f.endpoint, { ...f.payload, nonce: randomUUID() });
    if (kind === "dead") f.setCurrent(false);
    resolve(f.response()); assert.equal(await pending, "denied"); assert.equal(f.launches.length, 0);
  }
});
test("pending busy and no replay after failed consume; unrelated endpoint cannot retire", async () => {
  let resolve!: (value: Response) => void;
  const f = setup({ fetch: () => new Promise(done => { resolve = done; }) });
  const pending = f.controller.launch(f.endpoint, f.request); f.controller.retire(f.foreign);
  assert.equal(await f.controller.launch(f.endpoint, { ...f.request, ticketId: randomUUID(), requestId: randomUUID() }), "busy");
  resolve(new Response("", { status: 403 })); assert.equal(await pending, "denied"); assert.equal(await f.controller.launch(f.endpoint, f.request), "denied");
});
test("server identity, revision, expiry, recipe and envelope mismatches cannot launch", async () => {
  for (const patch of [{ viewer_user_id: "other" }, { target_user_id: "other" }, { ticket_id: randomUUID() }, { offer_revision: 9 }, { expires_at: "invalid" }, { expires_at: new Date(epoch - 1).toISOString() }, { expires_at: new Date(epoch + 90_000).toISOString() }, { recipe: { ...recipe, url: "https://foreign" } }, { recipe: { ...recipe, adapter: "other" } }, { extra: true }]) {
    let f!: ReturnType<typeof setup>; f = setup({ fetch: async () => f.response({ ...f.data(), ...patch }) });
    const status = await f.controller.launch(f.endpoint, f.request); assert.notEqual(status, "forwarded"); assert.equal(f.launches.length, 0);
  }
});
test("HTTP rejection, redirects, invalid content type, oversized and malformed JSON cannot launch", async () => {
  const responses = [new Response("", { status: 401 }), new Response("", { status: 410 }), new Response("", { status: 302 }), new Response("{}", { headers: { "Content-Type": "text/html" } }), new Response("{}", { headers: { "Content-Type": "application/json", "Content-Length": "65537" } }), new Response("x".repeat(65537), { headers: { "Content-Type": "application/json" } }), new Response("{", { headers: { "Content-Type": "application/json" } }), new Response('{"success":false,"data":{}}', { headers: { "Content-Type": "application/json" } })];
  for (const response of responses) { const f = setup({ fetch: async () => response }); assert.notEqual(await f.controller.launch(f.endpoint, f.request), "forwarded"); assert.equal(f.launches.length, 0); }
});
test("timeout covers unresolved fetch and unresolved response body without late shell dispatch", async () => {
  let resolve!: (value: Response) => void;
  const f = setup({ timeoutMs: 15, fetch: () => new Promise(done => { resolve = done; }) });
  assert.equal(await f.controller.launch(f.endpoint, f.request), "error"); resolve(f.response()); await new Promise(done => setTimeout(done, 5)); assert.equal(f.launches.length, 0);
  const body = new ReadableStream<Uint8Array>({ start() { /* deliberately no response chunks */ } });
  const g = setup({ timeoutMs: 15, fetch: async () => new Response(body, { headers: { "Content-Type": "application/json" } }) });
  assert.equal(await g.controller.launch(g.endpoint, g.request), "error"); assert.equal(g.launches.length, 0);
});
test("shell failure reports error; burst limiter survives context replacement", async () => {
  const f = setup({ openExternal: async () => { throw new Error("not installed"); } }); assert.equal(await f.controller.launch(f.endpoint, f.request), "error");
  let g!: ReturnType<typeof setup>; let count = 0; g = setup({ fetch: async () => { count++; return new Response("", { status: 403 }); } });
  for (let i = 0; i < 11; i++) { const ack = g.controller.sync(g.endpoint, { ...g.payload, nonce: randomUUID() }); await g.controller.launch(g.endpoint, { ...g.request, scopeNonce: ack.scopeNonce!, ticketId: randomUUID(), requestId: randomUUID() }); }
  assert.equal(count, 10); assert.equal(g.launches.length, 0);
});
test("early response rejections and late fetch responses cancel unread bodies", async () => {
  for (const mode of ["auth", "expired", "content-type", "content-length", "late-auth"]) {
    let cancelled = 0;
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled++; } });
    const response = new Response(stream, { status: mode === "auth" ? 403 : mode === "expired" ? 410 : 200,
      headers: { "Content-Type": mode === "content-type" ? "text/html" : "application/json", ...(mode === "content-length" ? { "Content-Length": "65537" } : {}) } });
    let resolve!: (response: Response) => void;
    const f = setup({ fetch: () => new Promise(done => { resolve = done; }) });
    const pending = f.controller.launch(f.endpoint, f.request);
    if (mode === "late-auth") f.controller.sync(f.endpoint, null);
    resolve(response); assert.notEqual(await pending, "forwarded");
    assert.equal(cancelled, 1, mode); assert.equal(f.launches.length, 0);
  }
});
test("throwing, rejected or never-settling body cancellation cannot hang or reject IPC", async () => {
  for (const mode of ["throw", "reject", "pending"]) {
    const response = new Response(new ReadableStream(), { status: 403 });
    Object.defineProperty(response.body, "cancel", { value: () => {
      if (mode === "throw") throw new Error("cancel failed");
      return mode === "reject" ? Promise.reject(new Error("cancel rejected")) : new Promise(() => {});
    } });
    const f = setup({ fetch: async () => response, timeoutMs: 15 });
    assert.equal(await f.controller.launch(f.endpoint, f.request), "denied");
  }
});
test("retired auth during external-handler dispatch never produces a stale forwarded result", async () => {
  let finish!: () => void, called!: () => void;
  const dispatched = new Promise<void>(done => { called = done; });
  const f = setup({ openExternal: async () => { called(); await new Promise<void>(done => { finish = done; }); } });
  const pending = f.controller.launch(f.endpoint, f.request);
  await dispatched; f.controller.sync(f.endpoint, null); finish();
  assert.equal(await pending, "denied");
});
