import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { previewTextToSpeech, supportsTextToSpeech } from "../../utils/textToSpeech";
import { usePreferencesStore } from "../../stores/preferencesStore";
import { ensureNotificationPermission } from "../../utils/notifications";
import { DEFAULT_NOTIFICATION_PREFERENCES, type NotificationPreferences } from "../../utils/notificationPreferences";
import { previewIncomingCallSound, playVoiceEventSound, VOICE_SOUND_EVENTS, VOICE_SOUND_PREFERENCES } from "../../utils/sounds";
import { useAccessibilityStore } from "../../stores/accessibilityStore";
import { isCapacitor } from "../../utils/constants";

type EmailPreferences = {
  communication: boolean; social: boolean; announcements: boolean;
  tips: boolean; recommendations: boolean; marketingUnsubscribed: boolean;
};
const DEFAULT_EMAIL: EmailPreferences = { communication: true, social: true, announcements: true, tips: true, recommendations: true, marketingUnsubscribed: false };

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function Toggle({ label, description, checked, onChange, disabled = false }: { label: string; description: string; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return <div className="vs-toggle-row"><div><div className="vs-label">{label}</div><div className="vs-desc">{description}</div></div>
    <label className="vs-switch"><input type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} /><span className="vs-switch-slider" /></label></div>;
}

export default function NotificationSettings() {
  const { t } = useTranslation("settings");
  const data = usePreferencesStore((state) => state.data);
  const set = usePreferencesStore((state) => state.set);
  const notifications = { ...DEFAULT_NOTIFICATION_PREFERENCES, ...object(data.notifications) } as NotificationPreferences;
  const email = { ...DEFAULT_EMAIL, ...object(data.email_preferences) } as EmailPreferences;
  const notificationDuration = useAccessibilityStore((state) => state.notificationDuration);
  const setNotificationDuration = useAccessibilityStore((state) => state.setNotificationDuration);
  const notificationSoundVolume = useAccessibilityStore((state) => state.notificationSoundVolume);
  const setNotificationSoundVolume = useAccessibilityStore((state) => state.setNotificationSoundVolume);
  const ttsEnabled = useAccessibilityStore((state) => state.ttsEnabled);
  const setTtsEnabled = useAccessibilityStore((state) => state.setTtsEnabled);
  const ttsRate = useAccessibilityStore((state) => state.ttsRate);
  const setTtsRate = useAccessibilityStore((state) => state.setTtsRate);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  );
  useEffect(() => {
    let active = true;
    let status: PermissionStatus | undefined;
    const refresh = () => {
      if (active) setPermission(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    if (typeof Notification !== "undefined" && navigator.permissions?.query) {
      void navigator.permissions.query({ name: "notifications" }).then(result => {
        if (!active) return;
        status = result;
        status.addEventListener("change", refresh);
        refresh();
      }).catch(() => { /* Focus/visibility refresh supports browsers without this query. */ });
    }
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      status?.removeEventListener("change", refresh);
    };
  }, []);
  const updateNotification = <K extends keyof NotificationPreferences>(key: K, value: NotificationPreferences[K]) => set({ notifications: { [key]: value } });
  const updateEmail = <K extends keyof EmailPreferences>(key: K, value: EmailPreferences[K]) => set({ email_preferences: { [key]: value } });
  const showDesktopDelay = !isCapacitor();
  const supportsSpeechSynthesis = supportsTextToSpeech();

  return <div className="vs-container">
    <h2 className="vs-title">{t("notifications.title")}</h2>
    <section className="vs-section" data-settings-section="desktop">
      <div className="vs-section-header">{t("notifications.desktop")}</div>
      <div className="vs-desc" role="status">{t(`notifications.permission.${permission}`)}</div>
      {permission === "default" && <button className="settings-btn" type="button" onClick={() => void ensureNotificationPermission().then(setPermission)}>{t("notifications.requestPermission")}</button>}
      <Toggle label={t("notifications.desktopEnabled")} description={t("notifications.desktopEnabledDesc")} checked={notifications.desktopEnabled} disabled={permission === "unsupported" || permission === "denied"} onChange={(value) => updateNotification("desktopEnabled", value)} />
      <Toggle label={t("notifications.taskbarFlash")} description={t("notifications.taskbarFlashDesc")} checked={notifications.taskbarFlash} onChange={(value) => updateNotification("taskbarFlash", value)} />
      <Toggle label={t("notifications.unreadBadge")} description={t("notifications.unreadBadgeDesc")} checked={notifications.unreadBadge} onChange={(value) => updateNotification("unreadBadge", value)} />
      <Toggle label={t("notifications.channelMessages")} description={t("notifications.channelMessagesDesc")} checked={notifications.channelMessageNotifications} onChange={(value) => updateNotification("channelMessageNotifications", value)} />
      <Toggle label={t("notifications.focused")} description={t("notifications.focusedDesc")} checked={notifications.notifyWhenFocused} onChange={(value) => updateNotification("notifyWhenFocused", value)} />
      <label className="vs-label" htmlFor="reaction-mode">{t("notifications.reactions")}</label>
      <select id="reaction-mode" className="vs-select" value={notifications.reactionMode} onChange={(event) => updateNotification("reactionMode", event.target.value as NotificationPreferences["reactionMode"])}>
        <option value="all">{t("notifications.reactionAll")}</option><option value="direct">{t("notifications.reactionDirect")}</option><option value="none">{t("notifications.reactionNone")}</option>
      </select>
      <Toggle label={t("notifications.stream")} description={t("notifications.streamDesc")} checked={notifications.streamNotifications} onChange={(value) => updateNotification("streamNotifications", value)} />
      <Toggle label={t("notifications.onlineFriends")} description={t("notifications.onlineFriendsDesc")} checked={notifications.onlineFriendNotifications} onChange={(value) => updateNotification("onlineFriendNotifications", value)} />
      <Toggle label={t("notifications.anniversary")} description={t("notifications.anniversaryDesc")} checked={notifications.friendAnniversaryNotifications} onChange={(value) => updateNotification("friendAnniversaryNotifications", value)} />
      <Toggle label={t("notifications.profileUpdates")} description={t("notifications.profileUpdatesDesc")} checked={notifications.profileUpdateNotifications} onChange={(value) => updateNotification("profileUpdateNotifications", value)} />
      <Toggle label={t("notifications.upcomingEvents")} description={t("notifications.upcomingEventsDesc")} checked={notifications.upcomingEventNotifications} onChange={(value) => updateNotification("upcomingEventNotifications", value)} />
    </section>
    <section className="vs-section" data-settings-section="sounds">
      <div className="vs-section-header">{t("notifications.sounds")}</div>
      <Toggle label={t("notifications.muteAll")} description={t("notifications.muteAllDesc")} checked={notifications.muteAllSounds} onChange={(value) => updateNotification("muteAllSounds", value)} />
      <Toggle label={t("notifications.messageSound")} description={t("notifications.messageSoundDesc")} checked={notifications.messageSound} disabled={notifications.muteAllSounds} onChange={(value) => updateNotification("messageSound", value)} />
      <Toggle label={t("notifications.currentChannelSound")} description={t("notifications.currentChannelSoundDesc")} checked={notifications.currentChannelSound} disabled={notifications.muteAllSounds} onChange={(value) => updateNotification("currentChannelSound", value)} />
      <Toggle label={t("notifications.incomingCallSound")} description={t("notifications.incomingCallSoundDesc")} checked={notifications.incomingCallSound} disabled={notifications.muteAllSounds} onChange={(value) => updateNotification("incomingCallSound", value)} />
      <button className="settings-btn" type="button" disabled={notifications.muteAllSounds || !notifications.incomingCallSound} onClick={previewIncomingCallSound}>{t("notifications.previewIncomingCall")}</button>
      <p className="vs-desc">{t("notifications.voiceEffectsDesc")}</p>
      {VOICE_SOUND_EVENTS.map(event => <div key={event}>
        <Toggle label={t(`notifications.voiceEffects.${event}`)} description="" checked={notifications[VOICE_SOUND_PREFERENCES[event]]} disabled={notifications.muteAllSounds} onChange={value => updateNotification(VOICE_SOUND_PREFERENCES[event],value)} />
        <button type="button" className="settings-btn" disabled={notifications.muteAllSounds || !notifications[VOICE_SOUND_PREFERENCES[event]]} aria-label={t("notifications.voiceEffectPreview",{event:t(`notifications.voiceEffects.${event}`)})} onClick={()=>playVoiceEventSound(event)}>{t("notifications.voiceEffectPreview",{event:t(`notifications.voiceEffects.${event}`)})}</button>
      </div>)}
      <label className="vs-label" htmlFor="sound-pack">{t("notifications.soundPack")}</label>
      <select id="sound-pack" className="vs-select" value={notifications.soundPack} disabled={notifications.muteAllSounds} onChange={(event) => updateNotification("soundPack", event.target.value as NotificationPreferences["soundPack"])}>
        <option value="classic">{t("notifications.soundClassic")}</option><option value="soft">{t("notifications.soundSoft")}</option><option value="minimal">{t("notifications.soundMinimal")}</option>
      </select>
    </section>
    <section className="vs-section" data-settings-section="advanced">
      <details>
        <summary className="vs-section-header">{t("notifications.advanced")}</summary>
        <p className="vs-desc">{t("notifications.advancedDescription")}</p>
        <p className="vs-desc" role="note">{t("notifications.backgroundLimits")}</p>
        {showDesktopDelay && <>
          <label className="vs-label" htmlFor="desktop-notification-delay">{t("notifications.delay")}</label>
          <p className="vs-desc">{t("notifications.delayDesc")}</p>
          <select id="desktop-notification-delay" className="vs-select" value={notifications.desktopDelaySeconds} disabled={!notifications.desktopEnabled || permission === "unsupported" || permission === "denied"} onChange={(event) => updateNotification("desktopDelaySeconds", Number(event.target.value) as NotificationPreferences["desktopDelaySeconds"])}>
            <option value={0}>{t("notifications.delayNone")}</option>
            {[3, 5, 10].map((seconds) => <option key={seconds} value={seconds}>{t("notifications.delaySeconds", { count: seconds })}</option>)}
          </select>
        </>}
        <div className="vs-slider-row">
          <div className="vs-label">{t("acc.notificationDuration")}</div>
          <div className="vs-desc">{t("acc.notificationDurationDesc")}</div>
          <select className="vs-select" value={notificationDuration} onChange={(event) => setNotificationDuration(Number(event.target.value) as 3 | 5 | 10 | 15 | 20)}>
            {[3, 5, 10, 15, 20].map((seconds) => <option key={seconds} value={seconds}>{seconds} sn</option>)}
          </select>
        </div>
        <div className="vs-slider-row">
          <div className="vs-label">{t("acc.notificationVolume")}</div>
          <div className="vs-desc">{t("acc.notificationVolumeDesc")}</div>
          <input type="range" min={0} max={100} step={1} value={notificationSoundVolume} onChange={(event) => setNotificationSoundVolume(Number(event.target.value))} className="vs-range" aria-label={t("acc.notificationVolume")} />
        </div>
        <Toggle label={t("acc.ttsEnabled")} description={t("acc.ttsEnabledDesc")} checked={ttsEnabled} disabled={!supportsSpeechSynthesis} onChange={setTtsEnabled} />
        <div className="vs-slider-row">
          <div className="vs-label">{t("acc.ttsRate")}</div>
          <div className="vs-desc">{t("acc.ttsRateDesc", { rate: ttsRate.toFixed(1) })}</div>
          <input type="range" min={0.5} max={2} step={0.1} aria-label={t("acc.ttsRate")} value={ttsRate} disabled={!supportsSpeechSynthesis} onChange={(event) => setTtsRate(Number(event.target.value))} className="vs-range" />
          <button type="button" className="settings-btn-secondary" disabled={!supportsSpeechSynthesis} onClick={() => previewTextToSpeech(t("acc.ttsPreviewText"))}>{t("acc.ttsPreview")}</button>
        </div>
      </details>
    </section>
    <section className="vs-section" data-settings-section="email">
      <div className="vs-section-header">{t("notifications.email")}</div>
      <p className="vs-desc">{t("notifications.emailDesc")}</p>
      {(["communication", "social", "announcements", "tips", "recommendations"] as const).map((key) => <Toggle key={key} label={t(`notifications.emailCategories.${key}`)} description={t(`notifications.emailCategories.${key}Desc`)} checked={!email.marketingUnsubscribed && email[key]} disabled={email.marketingUnsubscribed} onChange={(value) => updateEmail(key, value)} />)}
      <Toggle label={t("notifications.unsubscribe")} description={t("notifications.unsubscribeDesc")} checked={email.marketingUnsubscribed} onChange={(value) => updateEmail("marketingUnsubscribed", value)} />
      <p className="vs-desc">{t("notifications.securityEmailNote")}</p>
    </section>
  </div>;
}
