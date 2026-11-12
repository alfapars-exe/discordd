import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import type { TestContext } from "node:test";

export async function redirectFixture(t: TestContext) {
  async function listen(handler: RequestListener) {
    const server = createServer(handler);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    return "http://127.0.0.1:" + address.port;
  }

  let requests = 0;
  const target = await listen((_req, res) => {
    requests++;
    res.end("{}");
  });
  const origin = await listen((_req, res) => {
    res.writeHead(307, { location: target }).end();
  });
  return { origin, targetRequests: () => requests };
}
