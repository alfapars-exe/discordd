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
 *
 * Preset arrays + DurationPreset type live in ./modDurationPresets so
 * this module only exports the component (react-refresh boundary).
 */

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { DurationPreset } from "./modDurationPresets";

type Props = {
  title: string;
  /** Optional secondary line — e.g. "alfapars3 kullanıcısı için". */
  subtitle?: string;
  /** Variant just tweaks the confirm-button colour (red for ban). */
  variant?: "timeout" | "ban";
  /** Optional explanatory line under the subtitle — a soft hint for
   *  timeout (stays in server, just muted) or a danger-toned warning
   *  for temp-ban (removes the user from the server). */
  hint?: string;
  presets: DurationPreset[];
  onPick: (seconds: number) => void;
  onCancel: () => void;
};

function ModDurationPicker({ title, subtitle, variant = "timeout", hint, presets, onPick, onCancel }: Props) {
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
        {hint && (
          <div className={variant === "ban" ? "mod-picker-warning" : "mod-picker-hint"}>
            {hint}
          </div>
        )}
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
