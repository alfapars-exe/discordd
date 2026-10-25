/** ProfileSettings — User profile settings tab. */

import { useState, useEffect, useRef } from "react";
import { useSettingsDraft } from "./settingsWorkspaceContext";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "../../stores/authStore";
import { getAuthGeneration } from "../../api/client";
import { useToastStore } from "../../stores/toastStore";
import { showApiError } from "../../utils/apiError";
import * as profileApi from "../../api/profile";
import AvatarUpload from "./AvatarUpload";
import BannerUpload from "./BannerUpload";
import ColorPicker from "./ColorPicker";
import ProfilePreviewCard from "./ProfilePreviewCard";
import LanguageSelector from "./LanguageSelector";
import ProfileShowcaseEditor from "./ProfileShowcaseEditor";

const BIO_MAX_RUNES = 190;
const PRONOUNS_MAX = 40;
const ACCENT_RE = /^#[0-9a-f]{6}$/;

/** Mirrors the server's bio normalisation ("\r" stripped, TrimSpace) so
 *  "changed?" and the rune counter agree with what will be stored. */
function normalizeBio(s: string): string {
  return s.replace(/\r/g, "").trim();
}

function runeCount(s: string): number {
  return [...s].length;
}

/** `?t=<now>` suffix (see the cache-bust note in handleSave). Module-level
 *  so the react-hooks purity rule doesn't see Date.now inside the component. */
function withCacheBust(url: string): string {
  return `${url}?t=${Date.now()}`;
}

function ProfileSettings() {
  const { t } = useTranslation("settings");
  const { i18n } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const updateUser = useAuthStore((s) => s.updateUser);
  const addToast = useToastStore((s) => s.addToast);

  const [username, setUsername] = useState(user?.username ?? "");
  const [displayName, setDisplayName] = useState(user?.display_name ?? "");
  const [customStatus, setCustomStatus] = useState(user?.custom_status ?? "");
  const [pendingLanguage, setPendingLanguage] = useState(user?.language ?? "en");
  const [pendingDMPrivacy, setPendingDMPrivacy] = useState(user?.dm_privacy ?? "message_request");
  const [pendingAvatarFile, setPendingAvatarFile] = useState<File | null>(null);
  const [avatarPreviewUrl, setAvatarPreviewUrl] = useState<string | null>(null);
  const [bio, setBio] = useState(user?.bio ?? "");
  const [pronouns, setPronouns] = useState(user?.pronouns ?? "");
  /** Lower-case `#rrggbb`, "" = none. May be a partial hex while typing. */
  const [accentColor, setAccentColor] = useState(user?.accent_color ?? "");
  const [pendingBannerFile, setPendingBannerFile] = useState<File | null>(null);
  const [bannerPreviewUrl, setBannerPreviewUrl] = useState<string | null>(null);
  const [bannerRemoved, setBannerRemoved] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const prevPreviewUrlRef = useRef<string | null>(null);
  const prevBannerUrlRef = useRef<string | null>(null);
  const previousUserIdRef = useRef(user?.id);
  const saveInProgressRef = useRef(false);
  const saveSequenceRef = useRef(0);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      saveSequenceRef.current += 1;
      saveInProgressRef.current = false;
    };
  }, []);

  useEffect(() => {
    const accountChanged = previousUserIdRef.current !== user?.id;
    previousUserIdRef.current = user?.id;
    if (accountChanged) {
      // A new account gets an independent form/save lifecycle, even while an
      // earlier account's request is still unresolved.
      saveSequenceRef.current += 1;
      saveInProgressRef.current = false;
      setIsSaving(false);
    }
    // Upload responses patch the current account while this form is saving.
    // Keep its other staged fields intact; a real account switch still resets
    // every draft immediately, even if the old save is in flight.
    if (saveInProgressRef.current && !accountChanged) return;
    // Mirror current `user` snapshot into the local form buffers when
    // the upstream user object changes (login flip, profile API
    // patch). setState deferred via microtask so the lint rule
    // react-hooks/set-state-in-effect treats the writes as
    // Promise-callback state rather than cascading render-time writes.
    queueMicrotask(() => {
      setUsername(user?.username ?? "");
      setDisplayName(user?.display_name ?? "");
      setCustomStatus(user?.custom_status ?? "");
      setPendingLanguage(user?.language ?? "en");
      setPendingDMPrivacy(user?.dm_privacy ?? "message_request");
      setPendingAvatarFile(null);
      setBio(user?.bio ?? "");
      setPronouns(user?.pronouns ?? "");
      setAccentColor(user?.accent_color ?? "");
      setPendingBannerFile(null);
      setBannerRemoved(false);
    });
    if (prevPreviewUrlRef.current) {
      URL.revokeObjectURL(prevPreviewUrlRef.current);
      prevPreviewUrlRef.current = null;
    }
    if (prevBannerUrlRef.current) {
      URL.revokeObjectURL(prevBannerUrlRef.current);
      prevBannerUrlRef.current = null;
    }
    queueMicrotask(() => {
      setAvatarPreviewUrl(null);
      setBannerPreviewUrl(null);
    });
  }, [
    user?.username, user?.display_name, user?.custom_status, user?.language, user?.avatar_url, user?.dm_privacy,
    user?.bio, user?.pronouns, user?.accent_color, user?.banner_url, user?.id,
  ]);

  useEffect(() => {
    return () => {
      if (prevPreviewUrlRef.current) {
        URL.revokeObjectURL(prevPreviewUrlRef.current);
      }
      if (prevBannerUrlRef.current) {
        URL.revokeObjectURL(prevBannerUrlRef.current);
      }
    };
  }, []);

  const normalizedBio = normalizeBio(bio);
  const normalizedPronouns = pronouns.trim();
  const accentValid = accentColor === "" || ACCENT_RE.test(accentColor);
  const bioChanged = normalizedBio !== (user?.bio ?? "");
  const pronounsChanged = normalizedPronouns !== (user?.pronouns ?? "");
  const accentChanged = accentColor !== (user?.accent_color ?? "");
  const bannerChanged = pendingBannerFile !== null || bannerRemoved;

  const hasChanges =
    username !== (user?.username ?? "") ||
    displayName !== (user?.display_name ?? "") ||
    customStatus !== (user?.custom_status ?? "") ||
    pendingAvatarFile !== null ||
    pendingLanguage !== (user?.language ?? "en") ||
    pendingDMPrivacy !== (user?.dm_privacy ?? "message_request") ||
    bioChanged ||
    pronounsChanged ||
    accentChanged ||
    bannerChanged;
  const canSave = hasChanges && accentValid && runeCount(normalizedBio) <= BIO_MAX_RUNES;
  useSettingsDraft(hasChanges || isSaving);

  async function handleAvatarSelect(file: File) {
    if (prevPreviewUrlRef.current) {
      URL.revokeObjectURL(prevPreviewUrlRef.current);
    }
    const previewUrl = URL.createObjectURL(file);
    prevPreviewUrlRef.current = previewUrl;
    setPendingAvatarFile(file);
    setAvatarPreviewUrl(previewUrl);
  }

  function handleBannerSelect(file: File) {
    if (prevBannerUrlRef.current) {
      URL.revokeObjectURL(prevBannerUrlRef.current);
    }
    const previewUrl = URL.createObjectURL(file);
    prevBannerUrlRef.current = previewUrl;
    setPendingBannerFile(file);
    setBannerPreviewUrl(previewUrl);
    setBannerRemoved(false);
  }

  function handleBannerRemove() {
    if (prevBannerUrlRef.current) {
      URL.revokeObjectURL(prevBannerUrlRef.current);
      prevBannerUrlRef.current = null;
    }
    setPendingBannerFile(null);
    setBannerPreviewUrl(null);
    // Only a SAVED banner needs a DELETE on save; dropping a staged file
    // just returns to the saved state.
    setBannerRemoved(!!user?.banner_url);
  }

  function handleLanguageChange(language: string) {
    setPendingLanguage(language);
  }

  async function handleSave() {
    const saveOwnerId = user?.id;
    const saveGeneration = getAuthGeneration();
    const isCurrentSave = () => mountedRef.current && Boolean(saveOwnerId) &&
      getAuthGeneration() === saveGeneration && useAuthStore.getState().user?.id === saveOwnerId;
    if (!canSave || saveInProgressRef.current || !isCurrentSave()) return;
    const requestContext = { expectedUserId: saveOwnerId, isCurrent: isCurrentSave };

    const saveSequence = ++saveSequenceRef.current;
    saveInProgressRef.current = true;
    setIsSaving(true);
    try {
      if (pendingAvatarFile) {
        if (!isCurrentSave()) return;
        const avatarRes = await profileApi.uploadAvatar(pendingAvatarFile, requestContext);
        if (!isCurrentSave()) return;
        if (avatarRes.success && avatarRes.data) {
          // Cache-bust: server reuses the same path on overwrite, so the
          // <img src=...> reference stays identical and the browser keeps
          // serving the stale image from disk cache. Append a timestamp
          // query string so every upload yields a fresh URL — the auth
          // store + WS member_update broadcast carry this version forward
          // to every other UI consumer (sidebar, voice tile, member list).
          const cacheBustedUrl = withCacheBust(avatarRes.data.avatar_url ?? "");
          updateUser({ avatar_url: cacheBustedUrl, avatar_animated_url: avatarRes.data.avatar_animated_url ?? null });
          setPendingAvatarFile(null);
          if (prevPreviewUrlRef.current) {
            URL.revokeObjectURL(prevPreviewUrlRef.current);
            prevPreviewUrlRef.current = null;
          }
          setAvatarPreviewUrl(null);
        } else {
          showApiError(avatarRes, { fallbackKey: "settings:avatarUploadError" });
          setIsSaving(false);
          return;
        }
      }

      if (pendingBannerFile || bannerRemoved) {
        if (!isCurrentSave()) return;
        const bannerRes = pendingBannerFile
          ? await profileApi.uploadBanner(pendingBannerFile, requestContext)
          : await profileApi.deleteBanner(requestContext);
        if (!isCurrentSave()) return;
        if (bannerRes.success && bannerRes.data) {
          updateUser({ banner_url: bannerRes.data.banner_url ?? null, banner_animated_url: bannerRes.data.banner_animated_url ?? null });
          setPendingBannerFile(null);
          setBannerRemoved(false);
          if (prevBannerUrlRef.current) {
            URL.revokeObjectURL(prevBannerUrlRef.current);
            prevBannerUrlRef.current = null;
          }
          setBannerPreviewUrl(null);
        } else {
          showApiError(bannerRes, { fallbackKey: "settings:profileBannerUploadError" });
          setIsSaving(false);
          return;
        }
      }

      const profileChanged =
        username !== (user?.username ?? "") ||
        displayName !== (user?.display_name ?? "") ||
        customStatus !== (user?.custom_status ?? "") ||
        pendingLanguage !== (user?.language ?? "en") ||
        pendingDMPrivacy !== (user?.dm_privacy ?? "message_request") ||
        bioChanged ||
        pronounsChanged ||
        accentChanged;

      if (profileChanged) {
        if (!isCurrentSave()) return;
        const res = await profileApi.updateProfile({
          ...(username !== (user?.username ?? "") ? { username } : {}),
          display_name: displayName,
          custom_status: customStatus,
          language: pendingLanguage,
          dm_privacy: pendingDMPrivacy,
          // Omitted = unchanged; "" clears on the server.
          ...(bioChanged ? { bio: normalizedBio } : {}),
          ...(pronounsChanged ? { pronouns: normalizedPronouns } : {}),
          ...(accentChanged ? { accent_color: accentColor } : {}),
        }, requestContext);

        if (!isCurrentSave()) return;
        if (res.success && res.data) {
          if (pendingLanguage !== (user?.language ?? "en")) {
            i18n.changeLanguage(pendingLanguage);
          }
          updateUser({
            username: res.data.username,
            display_name: res.data.display_name,
            custom_status: res.data.custom_status,
            language: pendingLanguage,
            dm_privacy: pendingDMPrivacy,
            bio: res.data.bio ?? null,
            pronouns: res.data.pronouns ?? null,
            accent_color: res.data.accent_color ?? null,
          });
        } else {
          showApiError(res, { fallbackKey: "settings:profileSaveError" });
          setIsSaving(false);
          return;
        }
      }

      setPendingAvatarFile(null);
      if (prevPreviewUrlRef.current) {
        URL.revokeObjectURL(prevPreviewUrlRef.current);
        prevPreviewUrlRef.current = null;
      }
      setAvatarPreviewUrl(null);
      setPendingBannerFile(null);
      setBannerRemoved(false);
      if (prevBannerUrlRef.current) {
        URL.revokeObjectURL(prevBannerUrlRef.current);
        prevBannerUrlRef.current = null;
      }
      setBannerPreviewUrl(null);
      addToast("success", t("profileSaved"));
    } catch {
      if (isCurrentSave()) addToast("error", t("profileSaveError"));
    } finally {
      if (saveSequenceRef.current === saveSequence) {
        saveInProgressRef.current = false;
        if (mountedRef.current) setIsSaving(false);
      }
    }
  }

  if (!user) return null;

  return (
    <div className="settings-section">
      <h2 className="settings-section-title">{t("profile")}</h2>

      {/* Avatar upload */}
      <AvatarUpload
        currentUrl={user.avatar_url}
        previewUrl={avatarPreviewUrl}
        fallbackText={user.display_name ?? user.username}
        onUpload={handleAvatarSelect}
      />

      {/* Username */}
      <div className="settings-field">
        <label htmlFor="username" className="settings-label">
          {t("username")}
        </label>
        <input
          id="username"
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value.replace(/[^a-zA-Z0-9_]/g, ""))}
          placeholder={t("usernamePlaceholder")}
          maxLength={32}
          className="settings-input"
        />
        <span className="settings-field-hint">{t("usernameHint")}</span>
      </div>

      {/* Display Name */}
      <div className="settings-field">
        <label htmlFor="displayName" className="settings-label">
          {t("displayName")}
        </label>
        <input
          id="displayName"
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder={t("displayNamePlaceholder")}
          maxLength={32}
          className="settings-input"
        />
      </div>

      {/* Custom Status */}
      <div className="settings-field">
        <label htmlFor="customStatus" className="settings-label">
          {t("customStatus")}
        </label>
        <input
          id="customStatus"
          type="text"
          value={customStatus}
          onChange={(e) => setCustomStatus(e.target.value)}
          placeholder={t("customStatusPlaceholder")}
          maxLength={128}
          className="settings-input"
        />
      </div>

      {/* Pronouns */}
      <div className="settings-field">
        <label htmlFor="pronouns" className="settings-label">
          {t("profilePronouns")}
        </label>
        <input
          id="pronouns"
          type="text"
          value={pronouns}
          onChange={(e) => setPronouns(e.target.value)}
          placeholder={t("profilePronounsPlaceholder")}
          maxLength={PRONOUNS_MAX}
          className="settings-input"
        />
      </div>

      {/* About me (bio) */}
      <div className="settings-field">
        <label htmlFor="bio" className="settings-label">
          {t("profileBio")}
        </label>
        <textarea
          id="bio"
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          placeholder={t("profileBioPlaceholder")}
          maxLength={BIO_MAX_RUNES}
          rows={4}
          className="settings-input"
          style={{ resize: "vertical", fontFamily: "inherit" }}
        />
        <span
          className="settings-field-hint"
          style={runeCount(normalizedBio) > BIO_MAX_RUNES ? { color: "var(--red)" } : undefined}
        >
          {runeCount(normalizedBio)}/{BIO_MAX_RUNES}
        </span>
      </div>

      {/* Accent colour */}
      <div className="settings-field">
        <span className="settings-label">{t("profileAccentColor")}</span>
        <ColorPicker value={accentColor} onChange={(c) => setAccentColor(c.toLowerCase())} />
        {accentColor && (
          <button
            type="button"
            className="settings-btn settings-btn-secondary"
            style={{ marginTop: 8, alignSelf: "flex-start" }}
            onClick={() => setAccentColor("")}
          >
            {t("profileAccentColorReset")}
          </button>
        )}
      </div>

      {/* Banner */}
      <BannerUpload
        currentUrl={user.banner_url ?? null}
        previewUrl={bannerPreviewUrl}
        removed={bannerRemoved}
        onSelect={handleBannerSelect}
        onRemove={handleBannerRemove}
        disabled={isSaving}
      />

      {/* Live preview of the profile card with the draft values */}
      <ProfilePreviewCard
        username={username || user.username}
        displayName={displayName}
        avatarUrl={avatarPreviewUrl ?? user.avatar_url}
        animatedUrl={avatarPreviewUrl ? null : user.avatar_animated_url ?? null}
        bannerUrl={bannerPreviewUrl ?? (bannerRemoved ? null : user.banner_url ?? null)}
        animatedBannerUrl={bannerPreviewUrl ? null : user.banner_animated_url ?? null}
        accentColor={accentValid ? accentColor : user.accent_color ?? ""}
        bio={bio}
        pronouns={pronouns}
        customStatus={customStatus}
      />

      {/* Language */}
      <LanguageSelector
        currentLanguage={pendingLanguage}
        onChange={handleLanguageChange}
      />

      {/* DM Privacy */}
      <div className="settings-field">
        <label htmlFor="dmPrivacy" className="settings-label">
          {t("dmPrivacy")}
        </label>
        <select
          id="dmPrivacy"
          value={pendingDMPrivacy}
          onChange={(e) => setPendingDMPrivacy(e.target.value as "everyone" | "message_request" | "friends_only")}
          className="settings-input"
        >
          <option value="everyone">{t("dmPrivacyEveryone")}</option>
          <option value="message_request">{t("dmPrivacyMessageRequest")}</option>
          <option value="friends_only">{t("dmPrivacyFriendsOnly")}</option>
        </select>
        <span className="settings-field-hint">{t("dmPrivacyHint")}</span>
      </div>

      {/* Separator */}
      <div className="settings-separator" />

      <ProfileShowcaseEditor />

      {/* Save */}
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <button
          onClick={handleSave}
          disabled={!canSave || isSaving}
          className="settings-btn"
        >
          {isSaving ? t("saveChanges") + "..." : t("saveChanges")}
        </button>
        {hasChanges && (
          <span style={{ fontSize: 13, color: "var(--primary)" }}>{t("unsavedChanges")}</span>
        )}
      </div>
    </div>
  );
}

export default ProfileSettings;
