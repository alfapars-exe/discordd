/**
 * Profile API — profile update, avatar / banner upload, public profile read.
 *
 * Upload and update endpoints return the updated MemberWithRoles for
 * immediate state sync.
 */

import { apiClient } from "./client";
import type { MemberWithRoles, UserProfile } from "../types";

type UpdateProfileRequest = {
  username?: string;
  display_name?: string | null;
  custom_status?: string | null;
  language?: string;
  dm_privacy?: string;
  /** Omitted = no change; "" clears the field. */
  bio?: string;
  pronouns?: string;
  /** `#rrggbb`; "" clears. */
  accent_color?: string;
};

export async function updateProfile(data: UpdateProfileRequest) {
  return apiClient<MemberWithRoles>("/users/me/profile", {
    method: "PATCH",
    body: data,
  });
}

/** Uploads avatar via multipart/form-data. Browser sets Content-Type with boundary automatically.
 *  For a multi-frame GIF the response carries both `avatar_url` (static
 *  poster) and `avatar_animated_url`; for anything else the latter is null. */
export async function uploadAvatar(file: File) {
  const formData = new FormData();
  formData.append("file", file);

  return apiClient<MemberWithRoles>("/users/me/avatar", {
    method: "POST",
    body: formData,
  });
}

/** Uploads the profile banner (server centre-crops to 5:2, static only). */
export async function uploadBanner(file: File) {
  const formData = new FormData();
  formData.append("file", file);

  return apiClient<MemberWithRoles>("/users/me/banner", {
    method: "POST",
    body: formData,
  });
}

export async function deleteBanner() {
  return apiClient<MemberWithRoles>("/users/me/banner", { method: "DELETE" });
}

/** Public profile of any user — used where only a PublicUser is at hand. */
export async function getUserProfile(userId: string) {
  return apiClient<UserProfile>(`/users/${userId}/profile`);
}

export async function uploadWallpaper(file: File) {
  const formData = new FormData();
  formData.append("file", file);

  return apiClient<{ wallpaper_url: string }>("/users/me/wallpaper", {
    method: "POST",
    body: formData,
  });
}

export async function deleteWallpaper() {
  return apiClient<void>("/users/me/wallpaper", { method: "DELETE" });
}
