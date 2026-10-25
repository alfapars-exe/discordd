import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ generation: 1 }));
vi.mock("./client", () => ({ apiClient: vi.fn(async () => ({ success: true, data: { version: 2 } })), getAuthGeneration: () => auth.generation }));
import { apiClient } from "./client";
import { deleteBanner, getProfileShowcase, getUserProfileShowcase, saveProfileShowcase, updateProfile, uploadAvatar, uploadBanner, type ProfileShowcase } from "./profile";

describe("profile showcase API", () => {
  beforeEach(() => { vi.clearAllMocks(); auth.generation = 1; });
  it("encodes server scope for owner and public reads", async () => {
    await getProfileShowcase("server / one", { expectedUserId: "owner / one" });
    await getUserProfileShowcase("user/one", "server / one");
    expect(vi.mocked(apiClient).mock.calls[0][0]).toBe("/users/me/profile-showcase?server_id=server%20%2F%20one&expected_user_id=owner%20%2F%20one");
    expect(vi.mocked(apiClient).mock.calls[0][1]).toMatchObject({ timeoutMs: 15000 });
    expect(vi.mocked(apiClient).mock.calls[1][0]).toBe("/users/user%2Fone/profile-showcase?server_id=server%20%2F%20one");
  });
  it("sends the optimistic version with the document", async () => {
    const showcase: ProfileShowcase = { theme: { primary: "#111111", secondary: "#222222" }, widgets: [], links: [], version: 7 };
    await saveProfileShowcase(showcase, 7);
    expect(vi.mocked(apiClient)).toHaveBeenCalledWith("/users/me/profile-showcase", expect.objectContaining({ method: "PUT", body: { expected_version: 7, showcase }, timeoutMs: 15000 }));
  });
  it("binds profile writes to the owner, current context and captured auth generation", () => {
    let current = true;
    const context = { expectedUserId: "owner/one", isCurrent: () => current };
    const calls = [
      () => updateProfile({ display_name: "Name" }, context),
      () => uploadAvatar(new File(["avatar"], "avatar.png"), context),
      () => uploadBanner(new File(["banner"], "banner.png"), context),
      () => deleteBanner(context),
      () => getProfileShowcase(null, context),
      () => saveProfileShowcase({ theme: { primary: "", secondary: "" }, widgets: [], links: [], version: 0 }, 0, null, context),
    ];
    for (const invoke of calls) {
      current = true;
      auth.generation = 1;
      invoke();
      const [url, options] = vi.mocked(apiClient).mock.lastCall!;
      if (!options?.isCurrent) throw new Error("Missing request lifetime guard");
      expect(url).toContain("expected_user_id=owner%2Fone");
      expect(options.timeoutMs).toBe(15000);
      expect(options.isCurrent()).toBe(true);
      current = false;
      expect(options.isCurrent()).toBe(false);
      current = true;
      auth.generation++;
      expect(options.isCurrent()).toBe(false);
    }
    expect(vi.mocked(apiClient).mock.calls[0][0]).toBe("/users/me/profile?expected_user_id=owner%2Fone");
    expect(vi.mocked(apiClient).mock.calls[1][0]).toBe("/users/me/avatar?expected_user_id=owner%2Fone");
    expect(vi.mocked(apiClient).mock.calls[2][0]).toBe("/users/me/banner?expected_user_id=owner%2Fone");
    expect(vi.mocked(apiClient).mock.calls[3][1]).toMatchObject({ method: "DELETE" });
  });
  it("preserves legacy profile calls and leaves wallpaper/public endpoints unchanged", async () => {
    await getProfileShowcase("server");
    await getUserProfileShowcase("user/one", "server");
    await updateProfile({ display_name: "Legacy" });
    const calls = vi.mocked(apiClient).mock.calls;
    expect(calls[0][0]).toBe("/users/me/profile-showcase?server_id=server");
    expect(calls[1][0]).toBe("/users/user%2Fone/profile-showcase?server_id=server");
    expect(calls[2][0]).toBe("/users/me/profile");
    expect(calls[2][1]?.timeoutMs).toBe(15000);
  });
});
