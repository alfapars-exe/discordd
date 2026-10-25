import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPreferences, updatePreferences } from "./preferences";
import { apiClient } from "./client";

vi.mock("./client", () => ({ apiClient: vi.fn().mockResolvedValue({ success: true }) }));

describe("preferences account affinity", () => {
  beforeEach(() => vi.clearAllMocks());

  it("binds reads to the initiating account and retains cancellation", async () => {
    const signal = new AbortController().signal;
    const isCurrent = () => true;
    await getPreferences({ expectedUserId: "account/a&b", signal, isCurrent });
    expect(apiClient).toHaveBeenCalledWith("/users/me/preferences?expected_user_id=account%2Fa%26b", {
      method: "GET", signal, isCurrent, timeoutMs: 15_000,
    });
  });

  it("includes the original account in writes before a shared cookie can change", async () => {
    const data = { appearance: { avatarAnimation: "always" } };
    const signal = new AbortController().signal;
    const isCurrent = () => true;
    await updatePreferences(data, { expectedUserId: "account-a", signal, isCurrent });
    expect(apiClient).toHaveBeenCalledWith("/users/me/preferences", {
      method: "PATCH", body: { data, expected_user_id: "account-a" }, signal, isCurrent, timeoutMs: 15_000,
    });
  });

  it("retains the old envelope when no account assertion is supplied", async () => {
    await updatePreferences({ theme: "ocean" });
    expect(apiClient).toHaveBeenCalledWith("/users/me/preferences", expect.objectContaining({ body: { data: { theme: "ocean" } } }));
    await getPreferences();
    expect(apiClient).toHaveBeenLastCalledWith("/users/me/preferences", expect.objectContaining({ method: "GET" }));
  });
});
