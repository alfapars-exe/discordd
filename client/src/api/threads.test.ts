import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ generation: 1, client: vi.fn() }));
vi.mock("./client", () => ({ apiClient: state.client, getAuthGeneration: () => state.generation }));
import { createThread, getThread, listThreads, setThreadArchived } from "./threads";

it("binds thread reads and writes to the expected account and auth generation", () => {
  let current = true;
  const context = { expectedUserId: "owner /1", isCurrent: () => current };
  const calls = [
    () => listThreads("server/1", "channel?2", false, context),
    () => getThread("server/1", "thread/4", context),
    () => createThread("server/1", "channel?2", "message/3", "Topic", context),
    () => setThreadArchived("server/1", "thread/4", true, context),
  ];
  for (const invoke of calls) {
    current = true;
    state.generation = 1;
    invoke();
    const [url, options] = state.client.mock.lastCall!;
    expect(url).toContain("/servers/server%2F1/");
    expect(url).toContain("expected_user_id=owner%20%2F1");
    expect(options.timeoutMs).toBe(15000);
    expect(options.isCurrent()).toBe(true);
    current = false;
    expect(options.isCurrent()).toBe(false);
    current = true;
    state.generation++;
    expect(options.isCurrent()).toBe(false);
  }
  expect(state.client.mock.calls[0][0]).toContain("/channels/channel%3F2/threads?archived=false&expected_user_id=");
  expect(state.client.mock.calls[1][0]).toContain("/servers/server%2F1/threads/thread%2F4?expected_user_id=");
  expect(state.client.mock.calls[2][0]).toContain("/channels/channel%3F2/threads?expected_user_id=");
  expect(state.client.mock.calls[2][1].body).toEqual({ message_id: "message/3", name: "Topic" });
  expect(state.client.mock.calls[3][0]).toContain("/threads/thread%2F4?expected_user_id=");
  expect(state.client.mock.calls[3][1]).toMatchObject({ method: "PATCH", body: { archived: true } });
});

it("keeps legacy call forms usable without an account query", () => {
  state.generation = 20;
  listThreads("server", "channel", true);
  getThread("server", "thread");
  createThread("server", "channel", "message", "Topic");
  setThreadArchived("server", "thread", false);
  for (const [url, options] of state.client.mock.calls.slice(-4)) {
    expect(url).not.toContain("expected_user_id");
    expect(options.timeoutMs).toBe(15000);
    expect(options.isCurrent()).toBe(true);
  }
  expect(state.client.mock.calls.at(-4)?.[0]).toContain("?archived=true");
});
