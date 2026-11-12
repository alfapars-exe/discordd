/**
 * Tests for the main-process "Remember Me" login (pentest 2026-07-26, H-09).
 *
 * The property under test is negative and easy to lose in a refactor: the
 * stored password must reach the upstream request body and nothing else. So
 * these assert on what the fetch was called with, not merely that a login
 * happened.
 *
 * The credential reader is injected rather than module-mocked: the Electron
 * tsconfig emits CommonJS, so node:test's mock.module needs a top-level await
 * that will not compile here. Injection also matches how fetchImpl is already
 * passed in. A real safeStorage round trip is out of scope anyway — it needs a
 * running Electron app, and the encryption is not what this file is about.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loginWithSavedCredentials, NO_SAVED_CREDENTIALS } from "./credential-login";

type Creds = { username: string; password: string; origin?: string } | null;

let stored: Creds = null;
/** Injected in place of the real safeStorage-backed reader. */
const loadCreds = () => stored;

type Captured = { input: string; init: RequestInit };

function fakeFetch(response: Response): {
  calls: Captured[];
  impl: (input: string, init: RequestInit) => Promise<Response>;
} {
  const calls: Captured[] = [];
  return {
    calls,
    impl: (input, init) => {
      calls.push({ input, init });
      return Promise.resolve(response);
    },
  };
}

const okLogin = () =>
  new Response(JSON.stringify({ success: true, data: { access_token: "a" } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

test("sends the stored credentials to the upstream login endpoint", async () => {
  stored = { username: "ada", password: "hunter2", origin: "https://example.test" };
  const { calls, impl } = fakeFetch(okLogin());

  const result = await loginWithSavedCredentials("https://example.test", impl, { loadCreds });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, "https://example.test/api/auth/login");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body as string), {
    username: "ada",
    password: "hunter2",
  });
  // The refresh cookie has to land in the shared session jar, or the renderer
  // silently loses its session on the next refresh.
  assert.equal(calls[0].init.credentials, "include");
  assert.deepEqual(result, {
    status: 200,
    body: { success: true, data: { access_token: "a" } },
  });
});

test("returns only status and body — never the password", async () => {
  stored = { username: "ada", password: "hunter2", origin: "https://example.test" };
  const { impl } = fakeFetch(okLogin());

  const result = await loginWithSavedCredentials("https://example.test", impl, { loadCreds });

  // The whole point of the change: nothing the renderer receives may contain
  // the password, however deeply nested.
  assert.equal(JSON.stringify(result).includes("hunter2"), false);
  assert.deepEqual(Object.keys(result).sort(), ["body", "status"]);
});

test("legacy credentials require a manual login to establish their origin", async () => {
  stored = { username: "ada", password: "hunter2" };
  const { calls, impl } = fakeFetch(okLogin());
  await assert.rejects(
    loginWithSavedCredentials("https://example.test", impl, { loadCreds }),
    (err: Error) => err.message === NO_SAVED_CREDENTIALS,
  );
  assert.equal(calls.length, 0);
});

test("refuses invalid upstream origins without sending credentials", async () => {
  stored = { username: "ada", password: "hunter2", origin: "https://example.test" };

  for (const hostile of [
    "http://evil.test", // plain http is not loopback
    "https://user:pw@evil.test", // credentials in the URL
    "not-a-url",
    "",
  ]) {
    const { calls, impl } = fakeFetch(okLogin());
    await assert.rejects(() => loginWithSavedCredentials(hostile, impl, { loadCreds }));
    assert.equal(calls.length, 0);
  }
});

test("accepts a legitimate https upstream", async () => {
  stored = { username: "ada", password: "hunter2", origin: "https://self-hosted.example" };
  const { calls, impl } = fakeFetch(okLogin());

  await loginWithSavedCredentials("https://self-hosted.example", impl, { loadCreds });

  // Without this the sanitizer could reject everything and the previous test
  // would still pass.
  assert.equal(calls[0].input, "https://self-hosted.example/api/auth/login");
});

test("throws, and never dials, when nothing is stored", async () => {
  stored = null;
  const { calls, impl } = fakeFetch(okLogin());

  await assert.rejects(
    () => loginWithSavedCredentials("https://example.test", impl, { loadCreds }),
    (err: Error) => err.message === NO_SAVED_CREDENTIALS,
  );
  assert.equal(calls.length, 0);
});

test("reports a non-JSON upstream response as a null body rather than throwing", async () => {
  stored = { username: "ada", password: "hunter2", origin: "https://example.test" };
  const { impl } = fakeFetch(new Response("<html>502</html>", { status: 502 }));

  const result = await loginWithSavedCredentials("https://example.test", impl, { loadCreds });

  // A gateway error page must surface as an ordinary failed login, not as an
  // unhandled rejection in the renderer's mount effect.
  assert.deepEqual(result, { status: 502, body: null });
});

test("a 307 cannot relay a saved password to another origin", async t => {
  const { createServer } = await import("node:http");
  const listen = async (server: ReturnType<typeof createServer>) => {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    return "http://127.0.0.1:" + address.port;
  };
  let received = false;
  const destination = await listen(createServer((_req, res) => {
    received = true;
    res.end("{}");
  }));
  const upstream = await listen(createServer((_req, res) => {
    res.writeHead(307, { location: destination }).end();
  }));
  const result = await loginWithSavedCredentials(upstream, fetch, {
    allowLoopback: true, loadCreds: () => ({ username: "fixture", password: "fixture-only", origin: upstream }),
  });
  assert.equal(received, false);
  assert.equal(result.status, 307);
});

test("another HTTPS origin cannot receive the remembered password", async () => {
  const { calls, impl } = fakeFetch(okLogin());
  await assert.rejects(() => loginWithSavedCredentials("https://other.example", impl, {
    loadCreds: () => ({ username: "reader", password: "fixture", origin: "https://original.example" }),
  }));
  assert.equal(calls.length, 0);
});
