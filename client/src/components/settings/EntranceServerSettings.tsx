/**
 * EntranceServerSettings — server settings tab "Entrance Sounds" (Faz E).
 *
 * ManageSoundboard → server on/off, max length (500–5000 ms) and per voice
 * channel on/off. MuteMembers → list of members whose entrance sound is
 * muted on this server, with unmute. A section the viewer lacks the
 * permission for is not rendered; the server re-checks every call.
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "../../stores/authStore";
import { useActiveMembers } from "../../stores/memberStore";
import { useChannelStore } from "../../stores/channelStore";
import { useServerStore } from "../../stores/serverStore";
import { useToastStore } from "../../stores/toastStore";
import { hasPermission, Permissions } from "../../utils/permissions";
import * as entranceApi from "../../api/entrance";
import type { ServerEntranceSettings } from "../../types/entrance";

const MAX_DURATION_MIN = 500;
const MAX_DURATION_MAX = 5000;
const MAX_DURATION_STEP = 100;

function clampDuration(ms: number): number {
  const stepped = Math.round(ms / MAX_DURATION_STEP) * MAX_DURATION_STEP;
  return Math.min(MAX_DURATION_MAX, Math.max(MAX_DURATION_MIN, stepped));
}

function SettingsSection({ serverId }: { serverId: string }) {
  const { t } = useTranslation("entrance");
  const addToast = useToastStore((s) => s.addToast);
  const categories = useChannelStore((s) => s.categories);
  const [settings, setSettings] = useState<ServerEntranceSettings | null>(null);
  const [draftMax, setDraftMax] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void entranceApi.getServerSettings(serverId).then((res) => {
      if (cancelled) return;
      if (res.success && res.data) {
        setSettings({
          ...res.data,
          disabled_channel_ids: Array.isArray(res.data.disabled_channel_ids) ? res.data.disabled_channel_ids : [],
        });
      } else {
        addToast("error", t(entranceApi.entranceErrorKey(res)));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [serverId, addToast, t]);

  const voiceChannels = useMemo(
    () => categories.flatMap((cg) => cg.channels).filter((ch) => ch.type === "voice"),
    [categories],
  );

  if (!settings) return null;

  const maxValue = draftMax ?? settings.max_duration_ms;
  const pct = ((maxValue - MAX_DURATION_MIN) / (MAX_DURATION_MAX - MAX_DURATION_MIN)) * 100;

  const patch = async (body: entranceApi.ServerEntranceSettingsPatch) => {
    setBusy(true);
    const res = await entranceApi.patchServerSettings(serverId, body);
    setBusy(false);
    if (res.success && res.data) {
      const data = res.data;
      setSettings((prev) => ({
        ...data,
        disabled_channel_ids: Array.isArray(data.disabled_channel_ids)
          ? data.disabled_channel_ids
          : (prev?.disabled_channel_ids ?? []),
      }));
      setDraftMax(null);
    } else {
      addToast("error", t(entranceApi.entranceErrorKey(res)));
    }
  };

  const toggleChannel = async (channelId: string, enabled: boolean) => {
    const res = await entranceApi.setChannelEnabled(serverId, channelId, enabled);
    if (!res.success) {
      addToast("error", t(entranceApi.entranceErrorKey(res)));
      return;
    }
    setSettings((prev) => {
      if (!prev) return prev;
      const rest = prev.disabled_channel_ids.filter((id) => id !== channelId);
      return { ...prev, disabled_channel_ids: enabled ? rest : [...rest, channelId] };
    });
  };

  return (
    <div className="vs-section">
      <div className="vs-label">{t("serverTitle")}</div>
      <div className="vs-toggle-row" style={{ marginBottom: 12 }}>
        <div className="vs-desc" id="entrance-server-enabled-label">
          {t("serverEnabled")}
        </div>
        <label className="vs-switch">
          <input
            type="checkbox"
            aria-labelledby="entrance-server-enabled-label"
            checked={settings.enabled}
            disabled={busy}
            onChange={(e) => void patch({ enabled: e.target.checked })}
          />
          <span className="vs-switch-slider" />
        </label>
      </div>

      <div className="settings-field" style={{ marginBottom: 12 }}>
        <label className="settings-label" htmlFor="entrance-max-duration">
          {t("maxDuration")}
        </label>
        <div className="vs-slider-row">
          <input
            id="entrance-max-duration"
            type="range"
            min={MAX_DURATION_MIN}
            max={MAX_DURATION_MAX}
            step={MAX_DURATION_STEP}
            value={maxValue}
            aria-valuetext={t("seconds", { value: (maxValue / 1000).toFixed(1) })}
            onChange={(e) => setDraftMax(clampDuration(Number(e.target.value)))}
            className="vs-range"
            style={{ background: `linear-gradient(to right, var(--primary) ${pct}%, var(--bg-5) ${pct}%)` }}
          />
          <span className="vs-slider-value">{t("seconds", { value: (maxValue / 1000).toFixed(1) })}</span>
        </div>
        {draftMax !== null && draftMax !== settings.max_duration_ms && (
          <button
            type="button"
            className="settings-btn"
            style={{ marginTop: 8 }}
            disabled={busy}
            onClick={() => void patch({ max_duration_ms: draftMax })}
          >
            {t("save")}
          </button>
        )}
      </div>

      <div className="vs-label" style={{ marginTop: 16 }}>
        {t("channelsTitle")}
      </div>
      {voiceChannels.length === 0 ? (
        <p className="vs-desc">{t("noVoiceChannels")}</p>
      ) : (
        voiceChannels.map((ch) => {
          const enabled = !settings.disabled_channel_ids.includes(ch.id);
          const labelId = `entrance-ch-${ch.id}`;
          return (
            <div key={ch.id} className="vs-toggle-row" style={{ marginBottom: 8 }}>
              <div className="vs-desc" id={labelId}>
                {t("channelEnabled", { channel: ch.name })}
              </div>
              <label className="vs-switch">
                <input
                  type="checkbox"
                  aria-labelledby={labelId}
                  checked={enabled}
                  onChange={(e) => void toggleChannel(ch.id, e.target.checked)}
                />
                <span className="vs-switch-slider" />
              </label>
            </div>
          );
        })
      )}
    </div>
  );
}

function MutesSection({ serverId }: { serverId: string }) {
  const { t } = useTranslation("entrance");
  const addToast = useToastStore((s) => s.addToast);
  const members = useActiveMembers();
  const [userIds, setUserIds] = useState<string[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void entranceApi.listMutes(serverId).then((res) => {
      if (cancelled) return;
      if (res.success && res.data && Array.isArray(res.data.user_ids)) setUserIds(res.data.user_ids);
      else addToast("error", t(entranceApi.entranceErrorKey(res)));
    });
    return () => {
      cancelled = true;
    };
  }, [serverId, addToast, t]);

  if (!userIds) return null;

  const nameOf = (id: string) => {
    const m = members.find((x) => x.id === id);
    if (!m) return t("unknownMember");
    return m.nickname || m.display_name || m.username;
  };

  const unmute = async (id: string) => {
    const res = await entranceApi.unmuteMember(serverId, id);
    if (!res.success) {
      addToast("error", t(entranceApi.entranceErrorKey(res)));
      return;
    }
    setUserIds((list) => (list ?? []).filter((x) => x !== id));
  };

  return (
    <div className="vs-section">
      <div className="vs-label">{t("mutedTitle")}</div>
      {userIds.length === 0 ? (
        <p className="vs-desc">{t("noMuted")}</p>
      ) : (
        userIds.map((id) => (
          <div key={id} className="vs-toggle-row" style={{ marginBottom: 8 }}>
            <span className="vs-desc">{nameOf(id)}</span>
            <button type="button" className="settings-btn settings-btn-secondary" onClick={() => void unmute(id)}>
              {t("unmute")}
            </button>
          </div>
        ))
      )}
    </div>
  );
}

function EntranceServerSettings() {
  const { t } = useTranslation("entrance");
  const serverId = useServerStore((s) => s.activeServerId);
  const userId = useAuthStore((s) => s.user?.id);
  const members = useActiveMembers();
  const perms = members.find((m) => m.id === userId)?.effective_permissions ?? 0;
  const canManage = hasPermission(perms, Permissions.ManageSoundboard);
  const canMute = hasPermission(perms, Permissions.MuteMembers);

  if (!serverId || (!canManage && !canMute)) return null;

  return (
    <div className="settings-section">
      <h2 className="settings-section-title">{t("serverTitle")}</h2>
      {canManage && <SettingsSection key={`s:${serverId}`} serverId={serverId} />}
      {canMute && <MutesSection key={`m:${serverId}`} serverId={serverId} />}
    </div>
  );
}

export default EntranceServerSettings;
