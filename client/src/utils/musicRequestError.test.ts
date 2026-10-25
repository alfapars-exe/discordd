import { beforeEach, describe, expect, it, vi } from "vitest";
import type { APIResponse } from "../types";
import { MUSIC_BOT_ERROR_REASONS } from "../types/music";

const addToast = vi.fn();
vi.mock("../stores/toastStore", () => ({ useToastStore: { getState: () => ({ addToast }) } }));
vi.mock("../i18n", () => ({ default: { t: (key: string) => key } }));
import { showMusicRequestError } from "./musicRequestError";

beforeEach(() => vi.clearAllMocks());

describe("music request error feedback", () => {
  it.each(MUSIC_BOT_ERROR_REASONS)("localizes allowlisted provider reason %s", (reason) => {
    showMusicRequestError({ success: false, status: 502, code: `MUSIC_${reason.toUpperCase()}`, error: "private provider detail" }, "play");
    expect(addToast).toHaveBeenCalledWith("error", `music:reason_${reason}`);
  });

  it.each([
    [{ code: "FORBIDDEN", status: 403 }, "errors:forbidden"],
    [{ code: "RATE_LIMITED", status: 429 }, "errors:rateLimited"],
    [{ status: 401 }, "errors:unauthorized"],
    [{ isNetworkError: true }, "errors:network"],
    [{ status: 502, code: "MUSIC_UNRECOGNIZED" }, "errors:server"],
  ] as const)("preserves generic actionable classification: %j", (fields, key) => {
    showMusicRequestError({ success: false, ...fields }, "control");
    expect(addToast.mock.calls[0]?.[1]).toBe(key);
  });

  it.each(["play", "control"] as const)("uses contextual %s fallback without rendering raw error", (action) => {
    showMusicRequestError({ success: false, code: "MUSIC_unsafe/key", error: "private provider detail" }, action);
    expect(addToast.mock.calls[0]?.[1]).toBe(`music:${action}Error`);
  });

  it.each(["play", "control"] as const)("does not claim a timed-out %s POST was rejected", (action) => {
    showMusicRequestError({ success: false, isTimeout: true }, action);
    expect(addToast).toHaveBeenCalledWith("info", `music:${action}Timeout`);
  });

  it("does not show an error for a successful response", () => {
    showMusicRequestError({ success: true } satisfies APIResponse, "control");
    expect(addToast).not.toHaveBeenCalled();
  });
});
