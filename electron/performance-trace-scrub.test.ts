import assert from "node:assert/strict";
import test from "node:test";
import { scrubPerformanceTrace } from "./performance-trace-scrub.js";

test("scrubs query credentials, authorization values and websocket paths", () => {
  const input = JSON.stringify({
    api: "https://api.example.test/room?token=secret&safe=1",
    authorization: "Bearer private-token",
    socket: "wss://api.example.test/api/ws?ticket=one-time",
  });
  const scrubbed = scrubPerformanceTrace(input);
  assert.doesNotMatch(scrubbed, /secret|private-token|one-time/);
  assert.match(scrubbed, /token=\[REDACTED\]/);
  assert.match(scrubbed, /authorization/);
  assert.match(scrubbed, /wss:\/\/api\.example\.test\/\[REDACTED\]/);
});
