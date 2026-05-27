/**
 * LiveKitQuotaPanel — admin "LiveKit Kota Yönetimi" page.
 *
 * Lists every LiveKit instance (LiveKit Cloud + self-hosted) with the
 * current month's usage, remaining quota minutes, and days until reset.
 * Cloud rows show a progress bar + auto-switch toggle + threshold input;
 * self-hosted rows render an "♾️ Sınırsız" badge and skip the quota
 * controls entirely (they aren't part of the rotation).
 *
 * The auto-switch policy (see useAudioProcessor / voice_token.go):
 *   When a cloud instance's remaining minutes fall below its
 *   switch_threshold_minutes, the next voice-token request migrates the
 *   server to the lowest-priority cloud instance that still has budget.
 *   Self-hosted instances are never picked as migration targets.
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useToastStore } from "../../stores/toastStore";
import { getLiveKitQuota, updateLiveKitQuotaSettings } from "../../api/admin";
import type { LiveKitInstanceQuotaView } from "../../types";

function formatMinutes(min: number): string {
  if (min <= 0) return "0";
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m} dk`;
  if (m === 0) return `${h} sa`;
  return `${h} sa ${m} dk`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

function usagePercent(view: LiveKitInstanceQuotaView): number {
  if (view.monthly_quota_minutes <= 0) return 0;
  const pct = (view.used_minutes / view.monthly_quota_minutes) * 100;
  return Math.min(100, Math.max(0, Math.round(pct)));
}

/** Bar colour shifts as usage approaches the configured switch threshold. */
function progressColor(view: LiveKitInstanceQuotaView): string {
  if (view.remaining_minutes <= view.switch_threshold_minutes) return "var(--red)";
  if (view.remaining_minutes <= view.switch_threshold_minutes * 3) return "var(--yellow)";
  return "var(--green)";
}

function LiveKitQuotaPanel() {
  const { t } = useTranslation("settings");
  const addToast = useToastStore((s) => s.addToast);

  const [rows, setRows] = useState<LiveKitInstanceQuotaView[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await getLiveKitQuota();
      if (res.success && res.data) {
        setRows(res.data);
      } else {
        addToast("error", res.error ?? t("quotaLoadError", { defaultValue: "Yüklenemedi" }));
      }
    } finally {
      setIsLoading(false);
    }
  }, [addToast, t]);

  useEffect(() => {
    queueMicrotask(() => refresh());
  }, [refresh]);

  const patch = useCallback(
    async (id: string, body: Parameters<typeof updateLiveKitQuotaSettings>[1]) => {
      setSavingId(id);
      try {
        const res = await updateLiveKitQuotaSettings(id, body);
        if (res.success && res.data) {
          setRows((prev) => prev.map((r) => (r.id === id ? res.data! : r)));
        } else {
          addToast("error", res.error ?? t("quotaSaveError", { defaultValue: "Kaydedilemedi" }));
        }
      } finally {
        setSavingId(null);
      }
    },
    [addToast, t],
  );

  return (
    <div className="settings-section" style={{ padding: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0 }}>{t("platformLiveKitQuota")}</h2>
          <p style={{ margin: "4px 0 0", color: "var(--t2)", fontSize: 13 }}>
            {t("quotaPanelDesc", {
              defaultValue:
                "Her LiveKit Cloud sunucusunun aylık kullanımını takip et. Kalan dakika eşiğin altına düşünce sıradaki uygun sunucuya otomatik geçilir. Self-hosted sunucular kotaya tabi değildir.",
            })}
          </p>
        </div>
        <button
          onClick={refresh}
          disabled={isLoading}
          style={{
            background: "var(--bg-3)",
            color: "var(--t0)",
            border: "1px solid var(--panel-border)",
            borderRadius: 6,
            padding: "6px 14px",
            cursor: isLoading ? "default" : "pointer",
            fontSize: 13,
            opacity: isLoading ? 0.6 : 1,
          }}
        >
          {isLoading ? t("loading", { defaultValue: "Yükleniyor…" }) : t("refresh", { defaultValue: "Yenile" })}
        </button>
      </div>

      {rows.length === 0 && !isLoading && (
        <div style={{ color: "var(--t2)", fontSize: 14, padding: 16 }}>
          {t("quotaEmpty", { defaultValue: "Henüz LiveKit sunucusu yok." })}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {rows.map((row) => (
          <QuotaRow
            key={row.id}
            row={row}
            saving={savingId === row.id}
            onPatch={(body) => patch(row.id, body)}
          />
        ))}
      </div>
    </div>
  );
}

interface QuotaRowProps {
  row: LiveKitInstanceQuotaView;
  saving: boolean;
  onPatch: (body: Parameters<typeof updateLiveKitQuotaSettings>[1]) => void;
}

function QuotaRow({ row, saving, onPatch }: QuotaRowProps) {
  const { t } = useTranslation("settings");
  const isCloud = row.is_platform_managed;
  const pct = usagePercent(row);
  const bar = progressColor(row);

  // Local input state so users can type without firing a PATCH per keystroke.
  const [priority, setPriority] = useState(row.priority);
  const [quotaMinutes, setQuotaMinutes] = useState(row.monthly_quota_minutes);
  const [resetDay, setResetDay] = useState(row.quota_reset_day);
  const [threshold, setThreshold] = useState(row.switch_threshold_minutes);

  // Server may have refreshed values (after PATCH); keep inputs in sync.
  // Deferred via microtask to satisfy react-hooks/set-state-in-effect.
  useEffect(() => {
    queueMicrotask(() => {
      setPriority(row.priority);
      setQuotaMinutes(row.monthly_quota_minutes);
      setResetDay(row.quota_reset_day);
      setThreshold(row.switch_threshold_minutes);
    });
  }, [row.priority, row.monthly_quota_minutes, row.quota_reset_day, row.switch_threshold_minutes]);

  const cellLabelStyle: React.CSSProperties = {
    fontSize: 11,
    color: "var(--t3)",
    textTransform: "uppercase",
    letterSpacing: ".04em",
    marginBottom: 2,
  };

  return (
    <div
      style={{
        background: "var(--bg-3)",
        border: "1px solid var(--panel-border)",
        borderRadius: 10,
        padding: 16,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontFamily: "monospace", fontSize: 13, color: "var(--t0)" }}>{row.url}</span>
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                padding: "2px 8px",
                borderRadius: 999,
                background: isCloud ? "rgba(34,197,94,0.15)" : "rgba(124,58,237,0.15)",
                color: isCloud ? "var(--green)" : "#a78bfa",
              }}
            >
              {isCloud
                ? t("quotaTypeCloud", { defaultValue: "Cloud" })
                : t("quotaTypeSelfHosted", { defaultValue: "Self-Hosted" })}
            </span>
          </div>
          <div style={{ fontSize: 12, color: "var(--t2)", marginTop: 4 }}>
            {t("quotaCreatedAt", { defaultValue: "Eklenme" })}: {formatDate(row.created_at)} • {t("quotaServerCount", { defaultValue: "Sunucu" })}: {row.server_count}
          </div>
        </div>
      </div>

      {!isCloud ? (
        <div
          style={{
            marginTop: 14,
            padding: "10px 14px",
            borderRadius: 8,
            background: "rgba(124,58,237,0.08)",
            color: "#c4b5fd",
            fontSize: 13,
            fontWeight: 500,
          }}
        >
          ♾️ {t("quotaSelfHostedUnlimited", { defaultValue: "Self-hosted sunucular kotasızdır ve otomatik geçişe dahil edilmez." })}
        </div>
      ) : (
        <>
          <div style={{ marginTop: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6 }}>
              <span>
                {t("quotaUsed", { defaultValue: "Kullanılan" })}: <b>{formatMinutes(row.used_minutes)}</b> / {formatMinutes(row.monthly_quota_minutes)}
              </span>
              <span style={{ color: "var(--t2)" }}>
                {t("quotaRemaining", { defaultValue: "Kalan" })}: <b style={{ color: bar }}>{formatMinutes(row.remaining_minutes)}</b>
                {" • "}
                {t("quotaResetIn", { defaultValue: "Reset" })}: {row.days_until_reset} {t("quotaDays", { defaultValue: "gün" })}
              </span>
            </div>
            <div
              style={{
                height: 10,
                borderRadius: 999,
                background: "rgba(255,255,255,0.06)",
                overflow: "hidden",
              }}
              aria-label={`${pct}% used`}
            >
              <div
                style={{
                  width: `${pct}%`,
                  height: "100%",
                  background: bar,
                  transition: "width .25s ease, background .25s ease",
                }}
              />
            </div>
          </div>

          <div
            style={{
              marginTop: 14,
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
              gap: 12,
              alignItems: "end",
            }}
          >
            <label style={{ display: "block" }}>
              <div style={cellLabelStyle}>{t("quotaPriority", { defaultValue: "Öncelik" })}</div>
              <input
                type="number"
                min={0}
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value))}
                onBlur={() => {
                  if (priority !== row.priority) onPatch({ priority });
                }}
                disabled={saving}
                style={inputStyle}
              />
            </label>
            <label style={{ display: "block" }}>
              <div style={cellLabelStyle}>{t("quotaMonthlyMinutes", { defaultValue: "Aylık Dakika" })}</div>
              <input
                type="number"
                min={0}
                value={quotaMinutes}
                onChange={(e) => setQuotaMinutes(Number(e.target.value))}
                onBlur={() => {
                  if (quotaMinutes !== row.monthly_quota_minutes) onPatch({ monthly_quota_minutes: quotaMinutes });
                }}
                disabled={saving}
                style={inputStyle}
              />
            </label>
            <label style={{ display: "block" }}>
              <div style={cellLabelStyle}>{t("quotaResetDay", { defaultValue: "Reset Günü (1-28)" })}</div>
              <input
                type="number"
                min={1}
                max={28}
                value={resetDay}
                onChange={(e) => setResetDay(Number(e.target.value))}
                onBlur={() => {
                  if (resetDay !== row.quota_reset_day) onPatch({ quota_reset_day: resetDay });
                }}
                disabled={saving}
                style={inputStyle}
              />
            </label>
            <label style={{ display: "block" }}>
              <div style={cellLabelStyle}>{t("quotaThreshold", { defaultValue: "Geçiş Eşiği (dk)" })}</div>
              <input
                type="number"
                min={0}
                value={threshold}
                onChange={(e) => setThreshold(Number(e.target.value))}
                onBlur={() => {
                  if (threshold !== row.switch_threshold_minutes) onPatch({ switch_threshold_minutes: threshold });
                }}
                disabled={saving}
                style={inputStyle}
              />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: saving ? "default" : "pointer" }}>
              <input
                type="checkbox"
                checked={row.auto_switch_enabled}
                onChange={(e) => onPatch({ auto_switch_enabled: e.target.checked })}
                disabled={saving}
              />
              <span>{t("quotaAutoSwitch", { defaultValue: "Otomatik Geçiş" })}</span>
            </label>
          </div>
        </>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "var(--input-bg)",
  color: "var(--t0)",
  border: "1px solid var(--panel-border)",
  borderRadius: 6,
  padding: "6px 10px",
  fontSize: 13,
};

export default LiveKitQuotaPanel;
