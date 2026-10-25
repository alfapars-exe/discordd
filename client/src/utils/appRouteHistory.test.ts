import { beforeEach, expect, it } from "vitest";
import { observeAppRoute, resetAppRouteHistory, stepAppRouteHistory } from "./appRouteHistory";

beforeEach(() => resetAppRouteHistory());

it("keeps back and forward inside observed app routes", () => {
  observeAppRoute("/channels/@me/friends");
  observeAppRoute("/channels/server/s1/text/c1");
  expect(stepAppRouteHistory(-1)).toBe("/channels/@me/friends");
  expect(stepAppRouteHistory(-1)).toBeUndefined();
  expect(stepAppRouteHistory(1)).toBe("/channels/server/s1/text/c1");
  expect(stepAppRouteHistory(1)).toBeUndefined();
});

it("recognizes observed browser back/forward and truncates after a new route", () => {
  observeAppRoute("/a"); observeAppRoute("/b"); observeAppRoute("/c");
  observeAppRoute("/b");
  expect(stepAppRouteHistory(1)).toBe("/c");
  observeAppRoute("/d");
  expect(stepAppRouteHistory(1)).toBeUndefined();
});
