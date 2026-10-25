import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ generation: 1, client: vi.fn() }));
vi.mock("./client", () => ({ apiClient: state.client, getAuthGeneration: () => state.generation }));

import * as api from "./serverEvents";

const eventBody: api.CreateServerEventRequest = {
  name: "Launch",
  description: "Community meetup",
  starts_at: "2099-01-01T12:00:00Z",
  ends_at: "2099-01-01T13:00:00Z",
  channel_id: "voice",
};

it("returns the handler response shapes and bounds list queries", () => {
  api.listServerEvents("server/id", { limit: 1000, beforeId: "event /1" }, { expectedUserId: "owner /1" });
  const [listURL, listOptions] = state.client.mock.lastCall!;
  const query = new URLSearchParams(listURL.slice(listURL.indexOf("?") + 1));
  expect(listURL).toContain("/servers/server%2Fid/events?");
  expect(query.get("limit")).toBe("100");
  expect(query.get("before_id")).toBe("event /1");
  expect(query.get("expected_user_id")).toBe("owner /1");
  expect(listOptions.timeoutMs).toBe(15000);

  api.getServerEvent("server", "event/id");
  expect(state.client.mock.lastCall![0]).toContain("/servers/server/events/event%2Fid");
});

it("sends create, versioned update/cancel and interested RSVP using server contracts", () => {
  api.createServerEvent("server/id", eventBody, { expectedUserId: "owner" });
  let [url, options] = state.client.mock.lastCall!;
  expect(url).toContain("expected_user_id=owner");
  expect(options).toMatchObject({ method: "POST", timeoutMs: 15000, body: eventBody });

  const updateBody: api.UpdateServerEventRequest = { ...eventBody, name: "Launch updated", expected_version: 3 };
  api.updateServerEvent("server/id", "event/id", updateBody);
  [url, options] = state.client.mock.lastCall!;
  expect(url).toContain("/servers/server%2Fid/events/event%2Fid");
  expect(options).toMatchObject({ method: "PATCH", body: updateBody });

  api.cancelServerEvent("server", "event", 4);
  options = state.client.mock.lastCall![1];
  expect(options).toMatchObject({ method: "POST", body: { expected_version: 4 } });

  api.setServerEventInterested("server", "event", true);
  [url, options] = state.client.mock.lastCall!;
  expect(url).toContain("/events/event/rsvp");
  expect(options).toMatchObject({ method: "PUT", body: { interested: true } });
});

it("invalidates in-flight requests after caller scope or auth identity changes", () => {
  let current = true;
  state.generation = 7;
  const context = { expectedUserId: "owner", isCurrent: () => current };
  for (const invoke of [
    () => api.listServerEvents("server", {}, context),
    () => api.getServerEvent("server", "event", context),
    () => api.createServerEvent("server", eventBody, context),
    () => api.updateServerEvent("server", "event", { ...eventBody, expected_version: 1 }, context),
    () => api.cancelServerEvent("server", "event", 1, context),
    () => api.setServerEventInterested("server", "event", true, context),
  ]) {
    current = true;
    state.generation = 7;
    invoke();
    const [url, options] = state.client.mock.lastCall!;
    expect(url).toContain("expected_user_id=owner");
    expect(options.timeoutMs).toBe(15000);
    expect(options.isCurrent()).toBe(true);
    current = false;
    expect(options.isCurrent()).toBe(false);
    current = true;
    state.generation++;
    expect(options.isCurrent()).toBe(false);
  }
});
