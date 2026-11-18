import { expect, test } from "@playwright/test";
import { readTestAccount } from "./helpers";

test("concurrent refresh keeps the winning session usable", async ({ playwright, baseURL }) => {
  const api = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "X-HiChat-Client": "web" } });
  try {
    const login = await api.post("/api/auth/login", { data: readTestAccount() });
    expect(login.status()).toBe(200);
    const refreshCookie = (await api.storageState()).cookies.find(cookie => cookie.name === "hichat_refresh");
    if (!refreshCookie) throw new Error("missing login refresh cookie");
    const request = { headers: { Cookie: refreshCookie.name + "=" + refreshCookie.value }, data: {} };
    const replies = await Promise.all([api.post("/api/auth/refresh", request), api.post("/api/auth/refresh", request)]);
    expect(replies.map(reply => reply.status()).sort()).toEqual([200, 409]);
    const conflict = replies.find(reply => reply.status() === 409)!;
    expect((await conflict.json()).code).toBe("REFRESH_SUPERSEDED");
    expect(conflict.headers()["set-cookie"]).toBeUndefined();
    const retry = await api.post("/api/auth/refresh", { data: {} });
    expect(retry.status()).toBe(200);
    const token = (await retry.json()).data.access_token;
    const me = await api.get("/api/users/me", { headers: { Authorization: "Bearer " + token } });
    expect(me.status()).toBe(200);
    expect((await me.json()).data.username).toBe(readTestAccount().username);
  } finally {
    await api.dispose();
  }
});
