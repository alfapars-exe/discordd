/**
 * ModDurationPicker — small modal-ish picker for moderator durations.
 * Used by the timeout (mute) and temp-ban actions in MemberCard.
 *
 * Discord-style preset buttons keep the UX fast: 99 % of moderation
 * choices are "60 seconds, 5 minutes, an hour…", not arbitrary
 * timestamps. No custom input on purpose — it would invite typos and
 * 999999 seconds.
 *
 * Caller wires the title + button-set (timeout vs temp-ban) + the
 * onPick callback. Picker is fully controlled — closes itself when
 * onPick fires or the user clicks the backdrop / presses Escape.
 */

import { useEffect } from "react";
import { useTranslation } from "react-i18next";

export type DurationPreset = {
  /** Duration in seconds — sent verbatim to the timeout/ban API. */
  seconds: number;
  /** i18n key under "members" namespace, e.g. "dur_60s". */
  labelKey: string;
};

type Props = {
  title: string;
  /** Optional secondary line — e.g. "alfapars3 kullanıcısı için". */
  subtitle?: string;
  /** Variant just tweaks the confirm-button colour (red for ban). */
  variant?: "timeout" | "ban";
  presets: DurationPreset[];
  onPick: (seconds: number) => void;
  onCancel: () => void;
};

/** Defaults Discord uses — short to mid range. The 28 d cap matches
 *  the server's max in models/member_timeout.go. */
export const TIMEOUT_PRESETS: DurationPreset[] = [
  { seconds: 60, labelKey: "dur_60s" },
  { seconds: 5 * 60, labelKey: "dur_5m" },
  { seconds: 10 * 60, labelKey: "dur_10m" },
  { seconds: 60 * 60, labelKey: "dur_1h" },
  { seconds: 24 * 60 * 60, labelKey: "dur_1d" },
  { seconds: 7 * 24 * 60 * 60, labelKey: "dur_1w" },
];

/** Temp ban presets — wider range (minutes to a month) since
 *  removing someone for 60 s is rarely worth the audit row. */
export const TEMPBAN_PRESETS: DurationPreset[] = [
  { seconds: 10 * 60, labelKey: "dur_10m" },
  { seconds: 60 * 60, labelKey: "dur_1h" },
  { seconds: 6 * 60 * 60, labelKey: "dur_6h" },
  { seconds: 24 * 60 * 60, labelKey: "dur_1d" },
  { seconds: 7 * 24 * 60 * 60, labelKey: "dur_1w" },
  { seconds: 30 * 24 * 60 * 60, labelKey: "dur_30d" },
];

function ModDurationPicker({ title, subtitle, variant = "timeout", presets, onPick, onCancel }: Props) {
  const { t } = useTranslation("common");

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="mod-picker-overlay" onClick={onCancel}>
      <div className="mod-picker" onClick={(e) => e.stopPropagation()}>
        <div className="mod-picker-title">{title}</div>
        {subtitle && <div className="mod-picker-subtitle">{subtitle}</div>}
        <div className="mod-picker-grid">
          {presets.map((p) => (
            <button
              key={p.seconds}
              className={`mod-picker-btn${variant === "ban" ? " mod-picker-btn-danger" : ""}`}
              onClick={() => onPick(p.seconds)}
            >
              {t(p.labelKey)}
            </button>
          ))}
        </div>
        <div className="mod-picker-footer">
          <button className="mod-picker-cancel" onClick={onCancel}>
            {t("cancel", { defaultValue: "İptal" })}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ModDurationPicker;
