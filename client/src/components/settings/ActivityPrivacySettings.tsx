import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { getAuthGeneration } from "../../api/client";
import { useAuthStore } from "../../stores/authStore";
import { usePreferencesStore } from "../../stores/preferencesStore";
import { useServerStore } from "../../stores/serverStore";

const MAX_SERVER_OVERRIDES = 1024;
type Audience = "all" | "small" | "none";
type OverrideMap = Record<string, boolean>;

function validActivityOverrides(value: unknown): value is OverrideMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= MAX_SERVER_OVERRIDES && entries.every(([id, allowed]) =>
    id.length > 0 && id.length <= 256 && typeof allowed === "boolean");
}

function enableCurrentServerOverrides(current: unknown, serverIds: string[]): OverrideMap | null {
  if (!validActivityOverrides(current) || serverIds.some((id) => !id || id.length > 256)) return null;
  const next = { ...current };
  for (const id of serverIds) next[id] = true;
  return Object.keys(next).length <= MAX_SERVER_OVERRIDES ? next : null;
}

export default function ActivityPrivacySettings() {
  const { t } = useTranslation("settings");
  const userId = useAuthStore((state) => state.user?.id ?? null);
  const preferenceAccountId = usePreferencesStore((state) => state.accountId);
  const isLoaded = usePreferencesStore((state) => state.isLoaded);
  const data = usePreferencesStore((state) => state.data);
  const servers = useServerStore((state) => state.servers);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"name" | "sidebar">("name");
  const [limitError, setLimitError] = useState(false);
  const renderAuthGeneration = getAuthGeneration();
  const enabled = userId !== null && preferenceAccountId === userId && isLoaded;
  const privacy = enabled && data.privacy && typeof data.privacy === "object" && !Array.isArray(data.privacy)
    ? data.privacy as Record<string, unknown> : {};
  const shareAll = privacy.shareGameActivity === true;
  const audience: Audience = privacy.gameActivityNewServerAudience === "all"
    || privacy.gameActivityNewServerAudience === "small" ? privacy.gameActivityNewServerAudience : "none";
  const overrides = validActivityOverrides(privacy.gameActivityServerOverrides)
    ? privacy.gameActivityServerOverrides : {};
  const invalidOverrides = privacy.gameActivityServerOverrides !== undefined
    && !validActivityOverrides(privacy.gameActivityServerOverrides);

  const visibleServers = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    const filtered = enabled ? servers.filter((server) => server.name.toLocaleLowerCase().includes(needle)) : [];
    return sort === "name"
      ? [...filtered].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) || left.id.localeCompare(right.id))
      : filtered;
  }, [enabled, servers, search, sort]);

  function write(patch: Record<string, unknown>) {
    const auth = useAuthStore.getState();
    const prefs = usePreferencesStore.getState();
    if (!enabled || getAuthGeneration() !== renderAuthGeneration || auth.user?.id !== userId
      || prefs.accountId !== userId || !prefs.isLoaded) return;
    prefs.set({ privacy: patch });
    setLimitError(false);
  }

  function bulkEnable() {
    if (!enabled) return;
    const latestPrivacy = usePreferencesStore.getState().data.privacy;
    const latest = latestPrivacy && typeof latestPrivacy === "object" && !Array.isArray(latestPrivacy)
      ? latestPrivacy as Record<string, unknown> : {};
    const next = enableCurrentServerOverrides(latest.gameActivityServerOverrides ?? {}, useServerStore.getState().servers.map((server) => server.id));
    if (!next) {
      setLimitError(true);
      return;
    }
    write({ gameActivityServerOverrides: Object.fromEntries(useServerStore.getState().servers.map((server) => [server.id, true])) });
  }

  function setServerSharing(serverId: string, allowed: boolean) {
    if (!enabled || !serverId || serverId.length > 256) return;
    const latestPrivacy = usePreferencesStore.getState().data.privacy;
    const latest = latestPrivacy && typeof latestPrivacy === "object" && !Array.isArray(latestPrivacy)
      ? latestPrivacy as Record<string, unknown> : {};
    if (!validActivityOverrides(latest.gameActivityServerOverrides ?? {})) return;
    const next = { ...(latest.gameActivityServerOverrides as OverrideMap | undefined ?? {}) };
    if (!Object.prototype.hasOwnProperty.call(next, serverId) && Object.keys(next).length >= MAX_SERVER_OVERRIDES) {
      setLimitError(true);
      return;
    }
    write({ gameActivityServerOverrides: { [serverId]: allowed } });
  }

  return <div className="activity-privacy-settings">
    <h2 className="settings-section-title">{t("activityPrivacyTitle")}</h2>
    <p>{t("activityPrivacyDescription")}</p>
    {!enabled && <p role="status">{t("activityPrivacyWaiting")}</p>}
    <h3 className="settings-section-subtitle" id="activity-sharing" data-settings-section="activity-sharing">{t("activityPrivacyMaster")}</h3>
    <label className="settings-toggle-row">
      <span><small>{t("activityPrivacyMasterHint")}</small></span>
      <span className="vs-switch"><input type="checkbox" role="switch" aria-label={t("activityPrivacyMaster")} checked={shareAll} disabled={!enabled}
        onChange={(event) => write({ shareGameActivity: event.currentTarget.checked })} /><span className="vs-switch-slider" aria-hidden="true" /></span>
    </label>
    <h3 className="settings-section-subtitle" id="activity-new-server" data-settings-section="activity-new-server">{t("activityPrivacyNewServer")}</h3>
    <fieldset disabled={!enabled} aria-label={t("activityPrivacyNewServer")}>
      <p className="settings-hint">{t("activityPrivacyNewServerHint")}</p>
      {(["none", "small", "all"] as const).map((value) => <label className="settings-toggle-row" key={value}>
        <span>{value === "none" ? t("activityPrivacyAudienceNone") : value === "small" ? t("activityPrivacyAudienceSmall") : t("activityPrivacyAudienceAll")}</span>
        <input type="radio" aria-label={value === "none" ? t("activityPrivacyAudienceNone") : value === "small" ? t("activityPrivacyAudienceSmall") : t("activityPrivacyAudienceAll")} name="game-activity-audience" value={value} checked={audience === value}
          onChange={() => write({ gameActivityNewServerAudience: value })} />
      </label>)}
    </fieldset>
    <p className="settings-hint">{t("activityPrivacyLocalNotice")}</p>
    <p className="settings-hint">{t("activityPrivacySelfReportedNotice")}</p>
    <h3 className="settings-section-subtitle" id="game-joining" data-settings-section="game-joining">{t("gameJoinPrivacyTitle")}</h3>
    <p className="settings-hint">{t("gameJoinPrivacyHint")}</p>
    {(["allowFriendsToJoinGame", "allowVoiceParticipantsToJoinGame"] as const).map((key) => <label className="settings-toggle-row" key={key}>
      <span>{t(key)}</span>
      <span className="vs-switch"><input type="checkbox" role="switch" aria-label={t(key)} checked={privacy[key] === true} disabled={!enabled}
        onChange={(event) => write({ [key]: event.currentTarget.checked })} /><span className="vs-switch-slider" aria-hidden="true" /></span>
    </label>)}
    <h3 className="settings-section-subtitle" id="activity-servers" data-settings-section="activity-servers">{t("activityPrivacyServers")}</h3>
    <p className="settings-hint">{t("activityPrivacyServerHint")}</p>
    <div className="settings-field">
      <label htmlFor="activity-privacy-search">{t("activityPrivacySearch")}</label>
      <input id="activity-privacy-search" className="settings-input" value={search}
        onChange={(event) => setSearch(event.currentTarget.value)} disabled={!enabled} />
    </div>
    <label className="settings-field">
      <span>{t("activityPrivacySort")}</span>
      <select className="settings-select" value={sort} onChange={(event) => setSort(event.currentTarget.value as "name" | "sidebar")} disabled={!enabled}>
        <option value="name">{t("activityPrivacySortName")}</option>
        <option value="sidebar">{t("activityPrivacySortSidebar")}</option>
      </select>
    </label>
    <button type="button" className="settings-btn" onClick={bulkEnable} disabled={!enabled || invalidOverrides || servers.length === 0}>
      {t("activityPrivacyEnableCurrent")}
    </button>
    {invalidOverrides && <p role="alert">{t("activityPrivacyInvalidOverrides")}</p>}
    {limitError && <p role="alert">{t("activityPrivacyLimit", { limit: MAX_SERVER_OVERRIDES })}</p>}
    {!enabled ? null : !servers.length ? <p className="settings-hint">{t("activityPrivacyNoServers")}</p>
      : visibleServers.length === 0 ? <p className="settings-hint">{t("activityPrivacyNoResults")}</p>
        : visibleServers.map((server) => <label className="settings-toggle-row" key={server.id}>
          <span><strong>{server.name}</strong></span>
          <span className="vs-switch"><input type="checkbox" role="switch" aria-label={server.name} checked={Object.prototype.hasOwnProperty.call(overrides, server.id) ? overrides[server.id] === true : server.game_activity_audience === true} disabled={!enabled || invalidOverrides}
            onChange={(event) => setServerSharing(server.id, event.currentTarget.checked)} /><span className="vs-switch-slider" aria-hidden="true" /></span>
        </label>)}
  </div>;
}
