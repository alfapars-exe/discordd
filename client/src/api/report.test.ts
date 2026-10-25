import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./client", () => ({ apiClient: vi.fn().mockResolvedValue({ success: true }) }));

import { apiClient } from "./client";
import { reportUser } from "./report";

const messageRequest = {
  reason: "harassment" as const,
  description: "A sufficiently detailed report",
  source_kind: "channel" as const,
  source_server_id: "s1",
  source_channel_id: "c1",
  source_message_id: "m1",
  evidence_content: "explicit evidence",
  evidence_consent: true,
};

describe("message report API", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends structured message context in JSON", async () => {
    await reportUser("target", messageRequest);
    expect(apiClient).toHaveBeenCalledWith("/users/target/report", {
      method: "POST",
      body: messageRequest,
    });
  });

  it("preserves context and explicit consent in multipart reports", async () => {
    await reportUser("target", messageRequest, [new File(["png"], "evidence.png", { type: "image/png" })]);
    const request = vi.mocked(apiClient).mock.calls[0][1];
    expect(request?.body).toBeInstanceOf(FormData);
    const form = request?.body as FormData;
    expect(form.get("source_kind")).toBe("channel");
    expect(form.get("source_message_id")).toBe("m1");
    expect(form.get("evidence_content")).toBe("explicit evidence");
    expect(form.get("evidence_consent")).toBe("true");
    expect((form.get("files") as File).name).toBe("evidence.png");
  });
});
