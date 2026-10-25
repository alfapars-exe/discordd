/**
 * Profile API — profile update, avatar / banner upload, public profile read.
 *
 * Upload and update endpoints return the updated MemberWithRoles for
 * immediate state sync.
 */

import { apiClient, getAuthGeneration } from "./client";
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

export type ProfileRequestContext = { expectedUserId?: string; isCurrent?: () => boolean };

function requestScope(context: ProfileRequestContext = {}) {
  const generation = getAuthGeneration();
  const expectedUserQuery = context.expectedUserId ? `expected_user_id=${encodeURIComponent(context.expectedUserId)}` : "";
  return {
    expectedUserQuery,
    options: {
      timeoutMs: 15000,
      isCurrent: () => generation === getAuthGeneration() && (!context.isCurrent || context.isCurrent()),
    },
  };
}

const appendQuery = (path: string, query: string) => query ? `${path}?${query}` : path;

export async function updateProfile(data: UpdateProfileRequest, context: ProfileRequestContext = {}) {
  const scope = requestScope(context);
  return apiClient<MemberWithRoles>(appendQuery("/users/me/profile", scope.expectedUserQuery), {
    ...scope.options,
    method: "PATCH",
    body: data,
  });
}

/** Uploads avatar via multipart/form-data. Browser sets Content-Type with boundary automatically.
 *  For a multi-frame GIF the response carries both `avatar_url` (static
 *  poster) and `avatar_animated_url`; for anything else the latter is null. */
export async function uploadAvatar(file: File, context: ProfileRequestContext = {}) {
  const scope = requestScope(context);
  const formData = new FormData();
  formData.append("file", file);

  return apiClient<MemberWithRoles>(appendQuery("/users/me/avatar", scope.expectedUserQuery), {
    ...scope.options,
    method: "POST",
    body: formData,
  });
}

/** Uploads the profile banner (server centre-crops to 5:2, static only). */
export async function uploadBanner(file: File, context: ProfileRequestContext = {}) {
  const scope = requestScope(context);
  const formData = new FormData();
  formData.append("file", file);

  return apiClient<MemberWithRoles>(appendQuery("/users/me/banner", scope.expectedUserQuery), {
    ...scope.options,
    method: "POST",
    body: formData,
  });
}

export async function deleteBanner(context: ProfileRequestContext = {}) {
  const scope = requestScope(context);
  return apiClient<MemberWithRoles>(appendQuery("/users/me/banner", scope.expectedUserQuery), { ...scope.options, method: "DELETE" });
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

export type ProfileWidgetType = "favorite_game" | "liked_games" | "rotation_games" | "wishlist" | "game_link";
export type ProfileWidget = { id: string; type: ProfileWidgetType; title?: string; game?: string; url?: string; items?: string[] };
export type ProfileLink = { id: string; label: string; url: string; visible: boolean };
export type ProfileShowcase = {
  scope_server_id?: string;
  theme: { primary: string; secondary: string };
  watching?: string;
  widgets: ProfileWidget[];
  links: ProfileLink[];
  version: number;
  updated_at?: string;
};

const showcaseQuery = (serverId?: string | null, expectedUserQuery = "") => {
  const query = [serverId ? `server_id=${encodeURIComponent(serverId)}` : "", expectedUserQuery].filter(Boolean).join("&");
  return query ? `?${query}` : "";
};

export async function getProfileShowcase(serverId?: string | null, context: ProfileRequestContext = {}) {
  const scope = requestScope(context);
  return apiClient<ProfileShowcase>(`/users/me/profile-showcase${showcaseQuery(serverId, scope.expectedUserQuery)}`, scope.options);
}

export async function getUserProfileShowcase(userId: string, serverId?: string | null) {
  return apiClient<ProfileShowcase>(`/users/${encodeURIComponent(userId)}/profile-showcase${showcaseQuery(serverId)}`);
}

export async function saveProfileShowcase(showcase: ProfileShowcase, expectedVersion: number, serverId?: string | null, context: ProfileRequestContext = {}) {
  const scope = requestScope(context);
  return apiClient<ProfileShowcase>(`/users/me/profile-showcase${showcaseQuery(serverId, scope.expectedUserQuery)}`, {
    ...scope.options,
    method: "PUT",
    body: { expected_version: expectedVersion, showcase },
  });
}
