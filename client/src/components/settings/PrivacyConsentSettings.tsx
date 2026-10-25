import { useState } from "react";
import { useTranslation } from "react-i18next";
import { usePreferencesStore } from "../../stores/preferencesStore";
import { useServerStore } from "../../stores/serverStore";

export default function PrivacyConsentSettings() {
  const { t } = useTranslation("settings");
  const privacy = usePreferencesStore((state) => state.get<{
    improvementTelemetry?: boolean;
    profileAudience?: "all_servers" | "small_servers" | "friends_only";
    shareProfileUpdates?: boolean;
    shareOnlineUpdates?: boolean;
    shareStreamUpdates?: boolean;
    experiencePersonalization?: boolean;
    clipVoiceConsent?: boolean;
    friendRequests?: { everyone?: boolean; mutual?: boolean; server?: boolean };
    ignoredUsers?: Record<string, boolean>;
    personalizedFriendMessages?: boolean;
    spamFilter?: "all" | "nonfriends" | "off";
    serverDMDefault?: boolean;
    serverDMOverrides?: Record<string, boolean>;
    sensitiveMedia?: MediaPolicy;
    disturbingMedia?: MediaPolicy;
  }>("privacy"));
  const enabled = privacy?.improvementTelemetry === true;
  const profileAudience = privacy?.profileAudience ?? "all_servers";
  const shareProfileUpdates = privacy?.shareProfileUpdates !== false;
  const shareOnlineUpdates = privacy?.shareOnlineUpdates !== false;
  const shareStreamUpdates = privacy?.shareStreamUpdates === true;
  const experiencePersonalization = privacy?.experiencePersonalization === true;
  const clipVoiceConsent = privacy?.clipVoiceConsent === true;
  const friendRequests = privacy?.friendRequests ?? { everyone: true, mutual: true, server: true };
  const personalizedFriendMessages = privacy?.personalizedFriendMessages !== false;
  const spamFilter = privacy?.spamFilter ?? "nonfriends";
  const serverDMDefault = privacy?.serverDMDefault !== false;
  const sensitiveMedia = privacy?.sensitiveMedia ?? DEFAULT_MEDIA_POLICY;
  const disturbingMedia = privacy?.disturbingMedia ?? DEFAULT_MEDIA_POLICY;
  const [ignoredSearch, setIgnoredSearch] = useState("");
  const [serverSearch, setServerSearch] = useState("");
  const servers = useServerStore((state) => state.servers);
  const serverDMOverrides = privacy?.serverDMOverrides ?? {};
  const filteredServers = servers.filter((server) => server.name.toLocaleLowerCase().includes(serverSearch.trim().toLocaleLowerCase()));
  const ignoredUserIds = Object.entries(privacy?.ignoredUsers ?? {})
    .filter(([, ignored]) => ignored)
    .map(([id]) => id)
    .filter((id) => id.toLocaleLowerCase().includes(ignoredSearch.trim().toLocaleLowerCase()));

  const setFriendRequestRule = (key: "everyone" | "mutual" | "server", checked: boolean) => {
    usePreferencesStore.getState().set({
      privacy: { ...privacy, friendRequests: { ...friendRequests, [key]: checked } },
    });
  };

  return <>
    <div className="settings-divider" />
    <h3 className="settings-section-subtitle" data-settings-section="data-processing">{t("privacyControls.title")}</h3>
    <p className="settings-hint">{t("privacyControls.essential")}</p>
    <p className="settings-hint">{t("privacyControls.deleteLink")}</p>
    <h4 className="settings-section-subtitle">{t("privacyControls.contentFilters")}</h4>
    <MediaPolicyEditor label={t("privacyControls.sensitiveMedia")} value={sensitiveMedia} onChange={(value) => usePreferencesStore.getState().set({ privacy: { ...privacy, sensitiveMedia: value } })} t={t} />
    <MediaPolicyEditor label={t("privacyControls.disturbingMedia")} value={disturbingMedia} onChange={(value) => usePreferencesStore.getState().set({ privacy: { ...privacy, disturbingMedia: value } })} t={t} />
    <label className="settings-field">
      <span>{t("privacyControls.spamFilter")}</span>
      <select className="settings-select" value={spamFilter} onChange={(event) => usePreferencesStore.getState().set({ privacy: { ...privacy, spamFilter: event.target.value } })}>
        <option value="all">{t("privacyControls.spamAll")}</option>
        <option value="nonfriends">{t("privacyControls.spamNonfriends")}</option>
        <option value="off">{t("privacyControls.spamOff")}</option>
      </select>
    </label>
    <label className="settings-toggle-row">
      <span><strong>{t("privacyControls.serverDMDefault")}</strong><small>{t("privacyControls.serverDMDefaultHint")}</small></span>
      <input type="checkbox" role="switch" checked={serverDMDefault} onChange={(event) => usePreferencesStore.getState().set({ privacy: { ...privacy, serverDMDefault: event.target.checked } })} />
    </label>
    <p className="settings-hint">{t("privacyControls.serverDMOverrides", { count: Object.keys(serverDMOverrides).length })}</p>
    <input className="settings-input" value={serverSearch} onChange={(event) => setServerSearch(event.target.value)} placeholder={t("privacyControls.searchServers")} />
    {filteredServers.map((server) => {
      const hasOverride = Object.prototype.hasOwnProperty.call(serverDMOverrides, server.id);
      return <div className="settings-toggle-row" key={server.id}>
        <span><strong>{server.name}</strong><small>{hasOverride ? t("privacyControls.serverOverrideActive") : t("privacyControls.serverUsesDefault")}</small></span>
        <select className="settings-select" value={hasOverride ? String(serverDMOverrides[server.id]) : "default"} onChange={(event) => {
          const next = { ...serverDMOverrides };
          if (event.target.value === "default") delete next[server.id];
          else next[server.id] = event.target.value === "true";
          usePreferencesStore.getState().set({ privacy: { ...privacy, serverDMOverrides: next } });
        }}>
          <option value="default">{t("privacyControls.serverUseDefault")}</option>
          <option value="true">{t("privacyControls.serverAllow")}</option>
          <option value="false">{t("privacyControls.serverDeny")}</option>
        </select>
      </div>;
    })}
    <h4 className="settings-section-subtitle">{t("privacyControls.friendRequests")}</h4>
    <p className="settings-hint">{t("privacyControls.friendRequestsHint")}</p>
    {(["everyone", "mutual", "server"] as const).map((rule) => (
      <label className="settings-toggle-row" key={rule}>
        <span><strong>{t(`privacyControls.friendRequest${rule[0].toUpperCase()}${rule.slice(1)}`)}</strong></span>
        <input
          type="checkbox"
          role="switch"
          checked={friendRequests[rule] === true}
          onChange={(event) => setFriendRequestRule(rule, event.target.checked)}
        />
      </label>
    ))}
    <label className="settings-toggle-row">
      <span><strong>{t("privacyControls.personalizedFriendMessages")}</strong><small>{t("privacyControls.personalizedFriendMessagesHint")}</small></span>
      <input type="checkbox" role="switch" checked={personalizedFriendMessages} onChange={(event) => usePreferencesStore.getState().set({ privacy: { ...privacy, personalizedFriendMessages: event.target.checked } })} />
    </label>
    <h4 className="settings-section-subtitle">{t("privacyControls.ignoredUsers")}</h4>
    <p className="settings-hint">{t("privacyControls.ignoredUsersHint")}</p>
    <input className="settings-input" value={ignoredSearch} onChange={(event) => setIgnoredSearch(event.target.value)} placeholder={t("privacyControls.searchIgnoredUsers")} />
    {ignoredUserIds.length === 0 ? <p className="settings-hint">{t("privacyControls.noIgnoredUsers")}</p> : ignoredUserIds.map((id) => (
      <div className="settings-toggle-row" key={id}>
        <span><strong>{id}</strong></span>
        <button type="button" className="settings-btn" onClick={() => {
          const ignoredUsers = { ...(privacy?.ignoredUsers ?? {}) };
          delete ignoredUsers[id];
          usePreferencesStore.getState().set({ privacy: { ...privacy, ignoredUsers } });
        }}>{t("privacyControls.unignore")}</button>
      </div>
    ))}
    <label className="settings-field">
      <span>{t("privacyControls.profileAudience")}</span>
      <small>{t("privacyControls.profileAudienceHint")}</small>
      <select
        className="settings-select"
        value={profileAudience}
        onChange={(event) => usePreferencesStore.getState().set({
          privacy: { ...privacy, profileAudience: event.target.value },
        })}
      >
        <option value="all_servers">{t("privacyControls.profileAudienceAll")}</option>
        <option value="small_servers">{t("privacyControls.profileAudienceSmall")}</option>
        <option value="friends_only">{t("privacyControls.profileAudienceFriends")}</option>
      </select>
    </label>
    <label className="settings-toggle-row">
      <span>
        <strong>{t("privacyControls.clipVoiceConsent")}</strong>
        <small>{t("privacyControls.clipVoiceConsentHint")}</small>
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={clipVoiceConsent}
        onChange={(event) => usePreferencesStore.getState().set({ privacy: { ...privacy, clipVoiceConsent: event.target.checked } })}
      />
    </label>
    <label className="settings-toggle-row">
      <span>
        <strong>{t("privacyControls.personalization")}</strong>
        <small>{t("privacyControls.personalizationHint")}</small>
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={experiencePersonalization}
        onChange={(event) => usePreferencesStore.getState().set({ privacy: { ...privacy, experiencePersonalization: event.target.checked } })}
      />
    </label>
    <label className="settings-toggle-row">
      <span>
        <strong>{t("privacyControls.profileUpdates")}</strong>
        <small>{t("privacyControls.profileUpdatesHint")}</small>
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={shareProfileUpdates}
        onChange={(event) => usePreferencesStore.getState().set({ privacy: { ...privacy, shareProfileUpdates: event.target.checked } })}
      />
    </label>
    <label className="settings-toggle-row">
      <span>
        <strong>{t("privacyControls.shareOnlineUpdates")}</strong>
        <small>{t("privacyControls.shareOnlineUpdatesHint")}</small>
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={shareOnlineUpdates}
        onChange={(event) => usePreferencesStore.getState().set({ privacy: { ...privacy, shareOnlineUpdates: event.target.checked } })}
      />
    </label>
    <label className="settings-toggle-row">
      <span>
        <strong>{t("privacyControls.shareStreamUpdates")}</strong>
        <small>{t("privacyControls.shareStreamUpdatesHint")}</small>
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={shareStreamUpdates}
        onChange={(event) => usePreferencesStore.getState().set({ privacy: { ...privacy, shareStreamUpdates: event.target.checked } })}
      />
    </label>
    <label className="settings-toggle-row">
      <span>
        <strong>{t("privacyControls.telemetry")}</strong>
        <small>{t("privacyControls.telemetryHint")}</small>
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={enabled}
        onChange={(event) => usePreferencesStore.getState().set({ privacy: { ...privacy, improvementTelemetry: event.target.checked } })}
      />
    </label>
  </>;
}

type MediaMode = "show" | "blur" | "block";
type MediaPolicy = { friendDMs?: MediaMode; otherDMs?: MediaMode; channels?: MediaMode };
const DEFAULT_MEDIA_POLICY: MediaPolicy = { friendDMs: "show", otherDMs: "blur", channels: "blur" };

function MediaPolicyEditor({ label, value, onChange, t }: { label: string; value: MediaPolicy; onChange: (value: MediaPolicy) => void; t: (key: string) => string }) {
  return <fieldset className="settings-field">
    <legend>{label}</legend>
    {(["friendDMs", "otherDMs", "channels"] as const).map((scope) => <label className="settings-field" key={scope}>
      <span>{t(`privacyControls.mediaScope${scope[0].toUpperCase()}${scope.slice(1)}`)}</span>
      <select className="settings-select" value={value[scope] ?? DEFAULT_MEDIA_POLICY[scope]} onChange={(event) => onChange({ ...value, [scope]: event.target.value as MediaMode })}>
        <option value="show">{t("privacyControls.mediaShow")}</option>
        <option value="blur">{t("privacyControls.mediaBlur")}</option>
        <option value="block">{t("privacyControls.mediaBlock")}</option>
      </select>
    </label>)}
  </fieldset>;
}
