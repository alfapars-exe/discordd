import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { UserProfile } from "../types";

vi.mock("../api/profile", () => ({
  getUserProfile: vi.fn(),
}));

import { getUserProfile } from "../api/profile";
import { useUserProfile } from "./useUserProfile";

const mockGet = vi.mocked(getUserProfile);

function profile(id: string, bio: string): UserProfile {
  return {
    id,
    username: id,
    display_name: null,
    avatar_url: null,
    avatar_animated_url: null,
    banner_url: null,
    bio,
    pronouns: null,
    accent_color: null,
    custom_status: null,
    is_bot: false,
    created_at: "2026-01-01T00:00:00Z",
  };
}

/** A promise we resolve by hand, to control response ordering. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

type Res = Awaited<ReturnType<typeof getUserProfile>>;

describe("useUserProfile", () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  it("does not fetch while disabled", () => {
    const { result } = renderHook(() => useUserProfile("u1", false));
    expect(mockGet).not.toHaveBeenCalled();
    expect(result.current).toEqual({ profile: null, loading: false });
  });

  it("fetches when enabled and exposes the profile", async () => {
    mockGet.mockResolvedValue({ success: true, data: profile("u1", "hi") } as Res);
    const { result } = renderHook(() => useUserProfile("u1", true));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.profile?.bio).toBe("hi"));
    expect(result.current.loading).toBe(false);
    expect(mockGet).toHaveBeenCalledWith("u1");
  });

  it("yields null on an API failure", async () => {
    mockGet.mockResolvedValue({ success: false, error: "not found" } as Res);
    const { result } = renderHook(() => useUserProfile("u1", true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.profile).toBeNull();
  });

  it("drops a stale response after userId changes", async () => {
    const first = deferred<Res>();
    const second = deferred<Res>();
    mockGet.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const { result, rerender } = renderHook(({ id }) => useUserProfile(id, true), {
      initialProps: { id: "u1" },
    });
    rerender({ id: "u2" });

    second.resolve({ success: true, data: profile("u2", "second") } as Res);
    await waitFor(() => expect(result.current.profile?.bio).toBe("second"));

    // The older request lands late — it must not overwrite u2's profile.
    first.resolve({ success: true, data: profile("u1", "first") } as Res);
    await Promise.resolve();
    await Promise.resolve();
    expect(result.current.profile?.id).toBe("u2");
  });
});
