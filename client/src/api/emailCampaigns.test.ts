import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ generation: 4, client: vi.fn() }));
vi.mock("./client", () => ({ apiClient: state.client, getAuthGeneration: () => state.generation }));

import { createEmailCampaignDraft, getEmailCampaignPreview, publishEmailCampaign } from "./emailCampaigns";

it("uses the admin draft/preview/publish routes with bounded account-current requests", () => {
  let current = true;
  const controller = new AbortController();
  const context = { isCurrent: () => current, signal: controller.signal };
  createEmailCampaignDraft({ category: "tips", subject: "Subject", body: "Plain body", expires_at: "2099-01-01T00:00:00Z" }, context);
  let [url, options] = state.client.mock.lastCall!;
  expect(url).toBe("/admin/email-campaigns");
  expect(options).toMatchObject({ method: "POST", timeoutMs: 15_000 });
  expect(options.signal).toBe(controller.signal);
  expect(options.body).toMatchObject({ category: "tips", subject: "Subject", body: "Plain body" });
  expect(options.isCurrent()).toBe(true);
  current = false;
  expect(options.isCurrent()).toBe(false);
  current = true;
  state.generation++;
  expect(options.isCurrent()).toBe(false);

  state.generation = 4;
  getEmailCampaignPreview("ec_id/with/path", context);
  [url, options] = state.client.mock.lastCall!;
  expect(url).toBe("/admin/email-campaigns/ec_id%2Fwith%2Fpath");
  expect(options.timeoutMs).toBe(15_000);

  publishEmailCampaign("ec_123", context);
  [url, options] = state.client.mock.lastCall!;
  expect(url).toBe("/admin/email-campaigns/ec_123/publish");
  expect(options).toMatchObject({ method: "POST", timeoutMs: 15_000 });
});
