import type { SettingsContext, SettingsTab } from "../../stores/settingsStore";
import { hasPermission, Permissions } from "../../utils/permissions";

export type SettingsNavItem = { id: SettingsTab; labelKey: string };
export type SettingsNavGroup = { label: string; items: SettingsNavItem[] };

/** Searchable anchors exist even before their lazy panel has been opened. */
export const SETTINGS_SECTIONS: Partial<Record<SettingsTab, { id: string; labelKey: string }[]>> = {
  appearance: [
    { id: "theme", labelKey: "themeTitle" }, { id: "scale", labelKey: "uiScaleTitle" },
    { id: "avatars", labelKey: "avatarAnimationMode" }, { id: "wallpaper", labelKey: "wallpaperTitle" },
    { id: "effects", labelKey: "overlayEffects" },
  ],
  accessibility: [
    { id: "text", labelKey: "acc.textReadability" }, { id: "density", labelKey: "acc.visualDensity" },
    { id: "contrast", labelKey: "acc.colorContrast" }, { id: "motion", labelKey: "acc.reducedMotion" },
    { id: "audio", labelKey: "acc.audioScreenReader" },
  ],
  notifications: [
    { id: "desktop", labelKey: "notifications.desktop" },
    { id: "sounds", labelKey: "notifications.sounds" },
    { id: "email", labelKey: "notifications.email" },
  ],
  "registered-games": [
    { id: "registered-games-current", labelKey: "registeredGamesCurrent" },
    { id: "registered-games-recent", labelKey: "registeredGamesRecent" },
  ],
  "activity-privacy": [
    { id: "activity-sharing", labelKey: "activityPrivacyMaster" },
    { id: "activity-new-server", labelKey: "activityPrivacyNewServer" },
    { id: "activity-servers", labelKey: "activityPrivacyServers" },
  ],
  security: [{ id: "email", labelKey: "emailSection" }, { id: "password", labelKey: "changePassword" }, { id: "email-verification", labelKey: "verification.title" }, { id: "mfa", labelKey: "mfa.title" }, { id: "sessions", labelKey: "sessions.title" }, { id: "account-status", labelKey: "accountStatus.title" }, { id: "lifecycle", labelKey: "lifecycle.title" }, { id: "data-processing", labelKey: "privacyControls.title" }, { id: "deletion", labelKey: "deletion.title" }],
  applications: [{ id: "create", labelKey: "applications.create" }, { id: "owned", labelKey: "applications.owned" }],
  voice: [
    { id: "input", labelKey: "voiceInputMode" }, { id: "noise", labelKey: "noiseReduction" },
    { id: "camera", labelKey: "cameraDevice" }, { id: "sounds", labelKey: "joinLeaveSounds" },
    { id: "sharing", labelKey: "screenShareShowCursor" },
  ],
  diagnostics: [{ id: "capabilities", labelKey: "capabilities.title" }],
  developer: [{ id: "developer-mode", labelKey: "developer.mode" }],
};

/** Shared by the navigation and renderer so a revoked destination cannot stay mounted. */
export function getSettingsGroups(perms: number, platformAdmin: boolean, desktop: boolean, context?: SettingsContext): SettingsNavGroup[] {
  const canManageServer = [Permissions.Admin, Permissions.ManageChannels, Permissions.ManageRoles,
    Permissions.KickMembers, Permissions.BanMembers, Permissions.ManageExpressions].some((permission) => hasPermission(perms, permission));
  const canManageEntrance = hasPermission(perms, Permissions.ManageSoundboard) || hasPermission(perms, Permissions.MuteMembers);
  const canManageApplications = hasPermission(perms, Permissions.ManageApplications);
  const account: SettingsNavGroup[] = [
    { label: "accountGroup", items: [
      { id: "profile", labelKey: "profile" }, { id: "security", labelKey: "security" }, { id: "applications", labelKey: "applications.title" },
      { id: "encryption", labelKey: "encryption" }, { id: "blocked-users", labelKey: "blockedUsers" },
    ] },
    { label: "experienceGroup", items: [
      { id: "cosmetics", labelKey: "cosmetics" }, { id: "appearance", labelKey: "appearance" },
      { id: "accessibility", labelKey: "accessibility" }, { id: "notifications", labelKey: "notifications.title" }, { id: "voice", labelKey: "voiceSettings" },
      { id: "entrance", labelKey: "entranceSounds" },
    ] },
    { label: "gamesGroup", items: [
      { id: "activity-privacy", labelKey: "activityPrivacyTitle" },
      { id: "registered-games", labelKey: "registeredGamesTitle" },
    ] },
    { label: "supportGroup", items: [
      { id: "feedback", labelKey: "feedback" }, { id: "diagnostics", labelKey: "diagnostics" },
      { id: "developer", labelKey: "developer.title" },
      ...(desktop ? [{ id: "general" as const, labelKey: "general" }] : []),
    ] },
  ];
  const server: SettingsNavGroup = { label: "serverSettings", items: [
    ...(canManageServer ? [
      { id: "server-general" as const, labelKey: "general" }, { id: "channels" as const, labelKey: "channels" },
      { id: "roles" as const, labelKey: "roles" }, { id: "members" as const, labelKey: "members" },
      { id: "invites" as const, labelKey: "invites" }, { id: "emojis" as const, labelKey: "emojis" },
      { id: "stickers" as const, labelKey: "stickers" },
    ] : []),
    ...(canManageEntrance ? [{ id: "entrance-sounds" as const, labelKey: "serverEntranceSounds" }] : []),
    ...(canManageApplications ? [{ id: "server-applications" as const, labelKey: "serverApplications.title" }] : []),
  ] };
  const platform: SettingsNavGroup = { label: "platformSettings", items: platformAdmin ? [
    { id: "platform", labelKey: "platformLiveKitInstances" }, { id: "platform-quota", labelKey: "platformLiveKitQuota" },
    { id: "platform-servers", labelKey: "platformServersTab" }, { id: "platform-users", labelKey: "platformUsersTab" },
    { id: "platform-reports", labelKey: "platformReportsTab" }, { id: "platform-logs", labelKey: "platformLogsTab" },
    { id: "platform-campaigns", labelKey: "platformEmailCampaigns" },
    { id: "platform-feedback", labelKey: "feedback" },
    ...(desktop ? [{ id: "platform-connections" as const, labelKey: "platformConnections" }] : []),
  ] : [] };
  if (context === "account") return account;
  if (context === "server") return [server];
  if (context === "platform") return [platform];
  return [...account, server, { ...platform, items: platform.items.filter((item) => item.id !== "platform-feedback") }];
}
