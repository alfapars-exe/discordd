import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "../../stores/authStore";
import type { User } from "../../types";

const mocks = vi.hoisted(() => ({
  uploadAvatar: vi.fn(),
  uploadBanner: vi.fn(),
  deleteBanner: vi.fn(),
  updateProfile: vi.fn(),
  showApiError: vi.fn(),
  addToast: vi.fn(),
  changeLanguage: vi.fn(),
  generation: 1,
  createObjectURL: vi.fn(() => "blob:staged-avatar"),
  revokeObjectURL: vi.fn(),
}));

vi.mock("../../api/profile", () => ({
  uploadAvatar: mocks.uploadAvatar,
  uploadBanner: mocks.uploadBanner,
  deleteBanner: mocks.deleteBanner,
  updateProfile: mocks.updateProfile,
}));
vi.mock("../../api/client", () => ({ getAuthGeneration: () => mocks.generation }));
vi.mock("../../utils/apiError", () => ({ showApiError: mocks.showApiError }));
vi.mock("../../stores/toastStore", () => ({
  useToastStore: (select: (state: { addToast: typeof mocks.addToast }) => unknown) => select({ addToast: mocks.addToast }),
}));
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key, i18n: { changeLanguage: mocks.changeLanguage, language: "tr", resolvedLanguage: "tr" } }),
}));
vi.mock("./AvatarUpload", () => ({
  default: ({ onUpload }: { onUpload: (file: File) => Promise<void> }) => (
    <button type="button" onClick={() => void onUpload(new File(["avatar"], "avatar.png", { type: "image/png" }))}>mock-avatar-select</button>
  ),
}));
vi.mock("./BannerUpload", () => ({
  default: ({ onSelect }: { onSelect: (file: File) => void }) => (
    <button type="button" onClick={() => onSelect(new File(["banner"], "banner.png", { type: "image/png" }))}>mock-banner-select</button>
  ),
}));
vi.mock("./ColorPicker", () => ({ default: () => null }));
vi.mock("./LanguageSelector", () => ({ default: ({ currentLanguage, onChange }: { currentLanguage: string; onChange: (value: string) => void }) => (
  <select aria-label="language-choice" value={currentLanguage} onChange={(event) => onChange(event.target.value)}>
    <option value="en">English</option><option value="tr">Turkish</option>
  </select>
) }));
vi.mock("./ProfileShowcaseEditor", () => ({ default: () => null }));
vi.mock("./ProfilePreviewCard", () => ({
  default: (props: { username: string; displayName: string; bio: string; pronouns: string; customStatus: string }) => (
    <output data-testid="profile-preview">{JSON.stringify(props)}</output>
  ),
}));

import ProfileSettings from "./ProfileSettings";

function makeUser(id: string, username: string) {
  return {
    id,
    username,
    display_name: username,
    custom_status: "",
    language: "en",
    dm_privacy: "message_request",
    avatar_url: `/${id}.png`,
    avatar_animated_url: null,
    banner_url: null,
    banner_animated_url: null,
    bio: null,
    pronouns: null,
    accent_color: null,
  } as User;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function renderProfile() {
  const view = render(<ProfileSettings />);
  await act(async () => { await Promise.resolve(); });
  return view;
}

describe("ProfileSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generation = 1;
    mocks.uploadAvatar.mockResolvedValue({ success: true, data: { avatar_url: "/uploaded.png", avatar_animated_url: null } });
    mocks.uploadBanner.mockResolvedValue({ success: true, data: { banner_url: "/banner.png", banner_animated_url: null } });
    mocks.deleteBanner.mockResolvedValue({ success: true, data: { banner_url: null, banner_animated_url: null } });
    mocks.updateProfile.mockResolvedValue({ success: true, data: { username: "alice", display_name: "New name", custom_status: "", language: "en", bio: "draft bio", pronouns: null, accent_color: null } });
    vi.stubGlobal("URL", Object.assign(Object.create(URL), {
      createObjectURL: mocks.createObjectURL,
      revokeObjectURL: mocks.revokeObjectURL,
    }));
    useAuthStore.setState({ user: makeUser("account-a", "alice") });
  });

  afterEach(() => vi.unstubAllGlobals());

  it.each(["", "unsupported"])('saves only bio for legacy enum value "%s" without changing language/privacy', async (legacyValue) => {
    useAuthStore.setState({ user: { ...makeUser("account-a", "alice"), language: legacyValue, dm_privacy: legacyValue } as unknown as User });
    await renderProfile();
    expect(screen.getByLabelText("language-choice")).toHaveValue("tr");
    expect(screen.getByLabelText("dmPrivacy")).toHaveValue("message_request");
    expect(screen.getByRole("button", { name: "saveChanges" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("profileBio"), { target: { value: "draft bio" } });
    fireEvent.click(screen.getByRole("button", { name: "saveChanges" }));
    await waitFor(() => expect(mocks.updateProfile).toHaveBeenCalledOnce());
    expect(mocks.updateProfile.mock.calls[0][0]).toEqual({ bio: "draft bio" });
    await waitFor(() => expect(mocks.addToast).toHaveBeenCalledWith("success", "profileSaved"));
    expect(mocks.changeLanguage).not.toHaveBeenCalled();
    expect(useAuthStore.getState().user).toMatchObject({ language: legacyValue, dm_privacy: legacyValue, bio: "draft bio" });
  });

  it("keeps valid enum values untouched on bio save and submits explicit enum edits", async () => {
    useAuthStore.setState({ user: { ...makeUser("account-a", "alice"), language: "tr", dm_privacy: "friends_only" } });
    await renderProfile();
    expect(screen.getByLabelText("language-choice")).toHaveValue("tr");
    expect(screen.getByLabelText("dmPrivacy")).toHaveValue("friends_only");
    fireEvent.change(screen.getByLabelText("profileBio"), { target: { value: "draft bio" } });
    fireEvent.click(screen.getByRole("button", { name: "saveChanges" }));
    await waitFor(() => expect(mocks.addToast).toHaveBeenCalledWith("success", "profileSaved"));
    expect(mocks.updateProfile.mock.calls[0][0]).toEqual({ bio: "draft bio" });
    expect(mocks.changeLanguage).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("language-choice"), { target: { value: "en" } });
    fireEvent.change(screen.getByLabelText("dmPrivacy"), { target: { value: "everyone" } });
    fireEvent.click(screen.getByRole("button", { name: "saveChanges" }));
    await waitFor(() => expect(mocks.updateProfile).toHaveBeenCalledTimes(2));
    expect(mocks.updateProfile.mock.calls[1][0]).toEqual({ language: "en", dm_privacy: "everyone" });
    await waitFor(() => expect(mocks.changeLanguage).toHaveBeenCalledWith("en"));
    expect(useAuthStore.getState().user).toMatchObject({ language: "en", dm_privacy: "everyone" });
  });

  it("keeps the live preview in sync with unsaved fields and saves the draft", async () => {
    await renderProfile();
    fireEvent.change(screen.getByLabelText("displayName"), { target: { value: "New name" } });
    fireEvent.change(screen.getByLabelText("profileBio"), { target: { value: "draft bio" } });

    await waitFor(() => {
      const preview = JSON.parse(screen.getByTestId("profile-preview").textContent ?? "{}");
      expect(preview).toMatchObject({ displayName: "New name", bio: "draft bio" });
    });
    expect(mocks.updateProfile).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "saveChanges" }));
    await waitFor(() => expect(mocks.updateProfile).toHaveBeenCalledWith(
      expect.objectContaining({ display_name: "New name", bio: "draft bio" }),
      expect.objectContaining({ expectedUserId: "account-a", isCurrent: expect.any(Function) }),
    ));
    await waitFor(() => expect(mocks.addToast).toHaveBeenCalledWith("success", "profileSaved"));
  });

  it("does not apply a late upload response to a replacement account", async () => {
    const upload = deferred<{ success: boolean; data: { avatar_url: string; avatar_animated_url: null } }>();
    mocks.uploadAvatar.mockReturnValueOnce(upload.promise);
    await renderProfile();
    fireEvent.click(screen.getByRole("button", { name: "mock-avatar-select" }));
    fireEvent.change(screen.getByLabelText("username"), { target: { value: "alice_draft" } });
    fireEvent.click(screen.getByRole("button", { name: "saveChanges" }));
    await waitFor(() => expect(mocks.uploadAvatar).toHaveBeenCalledOnce());
    const requestContext = mocks.uploadAvatar.mock.calls[0][1];
    expect(requestContext).toMatchObject({ expectedUserId: "account-a", isCurrent: expect.any(Function) });

    act(() => useAuthStore.setState({ user: makeUser("account-b", "bravo") }));
    await waitFor(() => expect(screen.getByLabelText("username")).toHaveValue("bravo"));
    expect(requestContext.isCurrent()).toBe(false);
    await act(async () => upload.resolve({ success: true, data: { avatar_url: "/account-a-upload.png", avatar_animated_url: null } }));

    expect(useAuthStore.getState().user).toMatchObject({ id: "account-b", username: "bravo", avatar_url: "/account-b.png" });
    expect(mocks.updateProfile).not.toHaveBeenCalled();
    expect(mocks.addToast).not.toHaveBeenCalled();
  });

  it("ignores a late response after same-account reauthentication", async () => {
    const upload = deferred<{ success: boolean; data: { avatar_url: string; avatar_animated_url: null } }>();
    mocks.uploadAvatar.mockReturnValueOnce(upload.promise);
    await renderProfile();
    fireEvent.click(screen.getByRole("button", { name: "mock-avatar-select" }));
    fireEvent.click(screen.getByRole("button", { name: "saveChanges" }));
    await waitFor(() => expect(mocks.uploadAvatar).toHaveBeenCalledOnce());

    mocks.generation += 1;
    expect(mocks.uploadAvatar.mock.calls[0][1].isCurrent()).toBe(false);
    await act(async () => upload.resolve({ success: true, data: { avatar_url: "/stale.png", avatar_animated_url: null } }));

    expect(useAuthStore.getState().user).toMatchObject({ id: "account-a", avatar_url: "/account-a.png" });
    expect(mocks.addToast).not.toHaveBeenCalled();
  });

  it("does not apply a late response or set state after unmount", async () => {
    const upload = deferred<{ success: boolean; data: { avatar_url: string; avatar_animated_url: null } }>();
    mocks.uploadAvatar.mockReturnValueOnce(upload.promise);
    const view = await renderProfile();
    fireEvent.click(screen.getByRole("button", { name: "mock-avatar-select" }));
    fireEvent.click(screen.getByRole("button", { name: "saveChanges" }));
    await waitFor(() => expect(mocks.uploadAvatar).toHaveBeenCalledOnce());

    view.unmount();
    expect(mocks.uploadAvatar.mock.calls[0][1].isCurrent()).toBe(false);
    await act(async () => upload.resolve({ success: true, data: { avatar_url: "/late.png", avatar_animated_url: null } }));

    expect(useAuthStore.getState().user).toMatchObject({ id: "account-a", avatar_url: "/account-a.png" });
    expect(mocks.addToast).not.toHaveBeenCalled();
  });

  it("locks duplicate saves synchronously before the saving render", async () => {
    const upload = deferred<{ success: boolean; data: { avatar_url: string; avatar_animated_url: null } }>();
    mocks.uploadAvatar.mockReturnValueOnce(upload.promise);
    await renderProfile();
    fireEvent.click(screen.getByRole("button", { name: "mock-avatar-select" }));
    const saveButton = screen.getByRole("button", { name: "saveChanges" });

    act(() => {
      saveButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      saveButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(mocks.uploadAvatar).toHaveBeenCalledOnce();
    await act(async () => upload.resolve({ success: true, data: { avatar_url: "/uploaded.png", avatar_animated_url: null } }));
  });

  it("lets a replacement account save while an old request is pending without its finally unlocking the new save", async () => {
    const oldUpload = deferred<{ success: boolean; data: { avatar_url: string; avatar_animated_url: null } }>();
    const newProfileSave = deferred<{ success: boolean; data: { username: string; display_name: string; custom_status: string; language: string; bio: string; pronouns: null; accent_color: null } }>();
    mocks.uploadAvatar.mockReturnValueOnce(oldUpload.promise);
    mocks.updateProfile.mockReturnValueOnce(newProfileSave.promise);
    await renderProfile();
    fireEvent.click(screen.getByRole("button", { name: "mock-avatar-select" }));
    fireEvent.click(screen.getByRole("button", { name: "saveChanges" }));
    await waitFor(() => expect(mocks.uploadAvatar).toHaveBeenCalledOnce());

    act(() => useAuthStore.setState({ user: makeUser("account-b", "bravo") }));
    await waitFor(() => expect(screen.getByLabelText("username")).toHaveValue("bravo"));
    fireEvent.change(screen.getByLabelText("displayName"), { target: { value: "Bravo draft" } });
    fireEvent.click(screen.getByRole("button", { name: /saveChanges/ }));
    await waitFor(() => expect(mocks.updateProfile).toHaveBeenCalledOnce());
    const saveButton = screen.getByRole("button", { name: /saveChanges/ });
    expect(saveButton).toBeDisabled();

    await act(async () => oldUpload.resolve({ success: true, data: { avatar_url: "/old.png", avatar_animated_url: null } }));
    expect(saveButton).toBeDisabled();
    expect(useAuthStore.getState().user).toMatchObject({ id: "account-b", avatar_url: "/account-b.png" });

    await act(async () => newProfileSave.resolve({ success: true, data: { username: "bravo", display_name: "Bravo draft", custom_status: "", language: "en", bio: null as never, pronouns: null, accent_color: null } }));
    await waitFor(() => expect(mocks.addToast).toHaveBeenCalledWith("success", "profileSaved"));
  });

  it("preserves remaining text drafts after an avatar succeeds and banner upload fails", async () => {
    mocks.uploadBanner.mockResolvedValueOnce({ success: false, error: "failed" });
    await renderProfile();
    fireEvent.change(screen.getByLabelText("displayName"), { target: { value: "Unsaved name" } });
    fireEvent.change(screen.getByLabelText("profileBio"), { target: { value: "Unsaved bio" } });
    fireEvent.click(screen.getByRole("button", { name: "mock-avatar-select" }));
    fireEvent.click(screen.getByRole("button", { name: "mock-banner-select" }));
    fireEvent.click(screen.getByRole("button", { name: "saveChanges" }));

    await waitFor(() => expect(mocks.showApiError).toHaveBeenCalledOnce());
    expect(mocks.uploadAvatar).toHaveBeenCalledOnce();
    expect(mocks.updateProfile).not.toHaveBeenCalled();
    expect(screen.getByLabelText("displayName")).toHaveValue("Unsaved name");
    expect(screen.getByLabelText("profileBio")).toHaveValue("Unsaved bio");
    expect(JSON.parse(screen.getByTestId("profile-preview").textContent ?? "{}")).toMatchObject({
      displayName: "Unsaved name",
      bio: "Unsaved bio",
      avatarUrl: expect.stringContaining("/uploaded.png?t="),
    });
  });
});
