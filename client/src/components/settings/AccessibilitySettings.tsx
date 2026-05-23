/**
 * AccessibilitySettings — five-section settings panel covering text
 * readability, visual density, color contrast, reduced motion, and
 * audio/screen reader prefs.
 *
 * Visual structure mirrors Discord's "Erişilebilirlik" page: a sticky
 * live-preview block at the top, then five `vs-section` groups (same
 * shell pattern VoiceSettings.tsx uses) with sliders / radios /
 * toggles bound directly to useAccessibilityStore. Every interaction
 * re-applies CSS variables via the store subscribe → the preview
 * panel reflects changes in real time without any local mirror state.
 */

import { useTranslation } from "react-i18next";
import { useAccessibilityStore } from "../../stores/accessibilityStore";
import type { Density, MessageStyle } from "../../styles/accessibility";

function AccessibilitySettings() {
  const { t } = useTranslation("settings");

  // Pull every field individually so re-renders stay scoped to the
  // section that actually owns the changed value. This matches the
  // selector discipline already used in VoiceSettings.
  const chatFontSize = useAccessibilityStore((s) => s.chatFontSize);
  const alwaysUnderlineLinks = useAccessibilityStore((s) => s.alwaysUnderlineLinks);
  const showDisplayNameStyles = useAccessibilityStore((s) => s.showDisplayNameStyles);
  const density = useAccessibilityStore((s) => s.density);
  const messageStyle = useAccessibilityStore((s) => s.messageStyle);
  const messageGroupGapPx = useAccessibilityStore((s) => s.messageGroupGapPx);
  const saturation = useAccessibilityStore((s) => s.saturation);
  const saturateCustomColors = useAccessibilityStore((s) => s.saturateCustomColors);
  const reduceMotion = useAccessibilityStore((s) => s.reduceMotion);
  const disableAnimatedEmoji = useAccessibilityStore((s) => s.disableAnimatedEmoji);
  const autoplayGifs = useAccessibilityStore((s) => s.autoplayGifs);
  const notificationSoundVolume = useAccessibilityStore((s) => s.notificationSoundVolume);
  const ttsEnabled = useAccessibilityStore((s) => s.ttsEnabled);

  // Setters — pulled separately for the same selector-discipline reason.
  const setChatFontSize = useAccessibilityStore((s) => s.setChatFontSize);
  const setAlwaysUnderlineLinks = useAccessibilityStore((s) => s.setAlwaysUnderlineLinks);
  const setShowDisplayNameStyles = useAccessibilityStore((s) => s.setShowDisplayNameStyles);
  const setDensity = useAccessibilityStore((s) => s.setDensity);
  const setMessageStyle = useAccessibilityStore((s) => s.setMessageStyle);
  const setMessageGroupGapPx = useAccessibilityStore((s) => s.setMessageGroupGapPx);
  const setSaturation = useAccessibilityStore((s) => s.setSaturation);
  const setSaturateCustomColors = useAccessibilityStore((s) => s.setSaturateCustomColors);
  const setReduceMotion = useAccessibilityStore((s) => s.setReduceMotion);
  const setDisableAnimatedEmoji = useAccessibilityStore((s) => s.setDisableAnimatedEmoji);
  const setAutoplayGifs = useAccessibilityStore((s) => s.setAutoplayGifs);
  const setNotificationSoundVolume = useAccessibilityStore((s) => s.setNotificationSoundVolume);
  const setTtsEnabled = useAccessibilityStore((s) => s.setTtsEnabled);

  return (
    <div className="vs-container">
      <h2 className="vs-title">{t("accessibility")}</h2>

      {/* ─── Live preview ─────────────────────────────────────────── */}
      <div className="vs-section acc-preview-section">
        <div className="vs-label">{t("acc.preview")}</div>
        <div className="acc-preview">
          <div className="acc-preview-msg">
            <div className="acc-preview-avatar" />
            <div className="acc-preview-body">
              <div className="acc-preview-head">
                <span className="acc-preview-author">ALFAP4RS</span>
                <span className="acc-preview-time">21:38</span>
              </div>
              <div className="acc-preview-text">{t("acc.previewMsg1")}</div>
              <div className="acc-preview-reactions">
                <span className="acc-preview-react">🌱 3</span>
                <span className="acc-preview-react">🦜 1</span>
              </div>
            </div>
          </div>
          <div className="acc-preview-msg">
            <div className="acc-preview-avatar" />
            <div className="acc-preview-body">
              <div className="acc-preview-head">
                <span className="acc-preview-author">ALFAP4RS</span>
                <span className="acc-preview-time">21:38</span>
              </div>
              <div className="acc-preview-text">
                {t("acc.previewMsg2")}{" "}
                <a href="#" onClick={(e) => e.preventDefault()}>
                  https://tayfa.app/accessibility
                </a>
              </div>
              <button type="button" className="acc-preview-button">
                {t("acc.previewButton")}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ─── A. Metin Okunabilirliği ───────────────────────────────── */}
      <div className="vs-section">
        <div className="vs-section-header">{t("acc.textReadability")}</div>

        <div className="vs-slider-row">
          <div className="vs-label">{t("acc.chatFontSize")}</div>
          <div className="vs-desc">{t("acc.chatFontSizeDesc")}</div>
          <div className="acc-slider-track">
            <div className="acc-slider-ticks">
              {[12, 14, 15, 16, 18, 20, 24].map((px) => (
                <span key={px} className="acc-slider-tick">{px}px</span>
              ))}
            </div>
            <input
              type="range"
              min={12}
              max={24}
              step={1}
              value={chatFontSize}
              onChange={(e) => setChatFontSize(Number(e.target.value))}
              className="vs-range"
              aria-label={t("acc.chatFontSize")}
            />
          </div>
        </div>

        <div className="vs-toggle-row">
          <div>
            <div className="vs-label">{t("acc.alwaysUnderlineLinks")}</div>
            <div className="vs-desc">{t("acc.alwaysUnderlineLinksDesc")}</div>
          </div>
          <label className="vs-switch">
            <input
              type="checkbox"
              checked={alwaysUnderlineLinks}
              onChange={(e) => setAlwaysUnderlineLinks(e.target.checked)}
            />
            <span className="vs-switch-slider" />
          </label>
        </div>

        <div className="vs-toggle-row">
          <div>
            <div className="vs-label">{t("acc.showDisplayNameStyles")}</div>
            <div className="vs-desc">{t("acc.showDisplayNameStylesDesc")}</div>
          </div>
          <label className="vs-switch">
            <input
              type="checkbox"
              checked={showDisplayNameStyles}
              onChange={(e) => setShowDisplayNameStyles(e.target.checked)}
            />
            <span className="vs-switch-slider" />
          </label>
        </div>
      </div>

      {/* ─── B. Görsel Yoğunluk ────────────────────────────────────── */}
      <div className="vs-section">
        <div className="vs-section-header">{t("acc.visualDensity")}</div>

        <div className="vs-radio-row">
          <div className="vs-label">{t("acc.uiDensity")}</div>
          <div className="vs-desc">{t("acc.uiDensityDesc")}</div>
          <div className="acc-radio-group">
            {(["compact", "default", "cozy"] as Density[]).map((d) => (
              <label key={d} className="acc-radio-option">
                <input
                  type="radio"
                  name="ui-density"
                  value={d}
                  checked={density === d}
                  onChange={() => setDensity(d)}
                />
                <span>
                  {d === "compact" && t("acc.densityCompact")}
                  {d === "default" && t("acc.densityDefault")}
                  {d === "cozy" && t("acc.densityCozy")}
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="vs-radio-row">
          <div className="vs-label">{t("acc.messageStyle")}</div>
          <div className="vs-desc">{t("acc.messageStyleDesc")}</div>
          <div className="acc-radio-group">
            {(["default", "compact"] as MessageStyle[]).map((m) => (
              <label key={m} className="acc-radio-option">
                <input
                  type="radio"
                  name="msg-style"
                  value={m}
                  checked={messageStyle === m}
                  onChange={() => setMessageStyle(m)}
                />
                <span>
                  {m === "default" && t("acc.densityDefault")}
                  {m === "compact" && t("acc.densityCompact")}
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="vs-slider-row">
          <div className="vs-label">{t("acc.messageGroupGap")}</div>
          <div className="vs-desc">{t("acc.messageGroupGapDesc")}</div>
          <div className="acc-slider-track">
            <div className="acc-slider-ticks">
              {[0, 4, 8, 16, 24].map((px) => (
                <span key={px} className="acc-slider-tick">{px}px</span>
              ))}
            </div>
            <input
              type="range"
              min={0}
              max={24}
              step={1}
              value={messageGroupGapPx}
              onChange={(e) => setMessageGroupGapPx(Number(e.target.value))}
              className="vs-range"
              aria-label={t("acc.messageGroupGap")}
            />
          </div>
        </div>
      </div>

      {/* ─── C. Renk ve Karşıtlık ──────────────────────────────────── */}
      <div className="vs-section">
        <div className="vs-section-header">{t("acc.colorContrast")}</div>

        <div className="vs-slider-row">
          <div className="vs-label">{t("acc.saturation")}</div>
          <div className="vs-desc">{t("acc.saturationDesc")}</div>
          <div className="acc-slider-track">
            <div className="acc-slider-ticks">
              {[0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((pct) => (
                <span key={pct} className="acc-slider-tick">{pct}%</span>
              ))}
            </div>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={saturation}
              onChange={(e) => setSaturation(Number(e.target.value))}
              className="vs-range"
              aria-label={t("acc.saturation")}
            />
          </div>
        </div>

        <div className="vs-toggle-row">
          <div>
            <div className="vs-label">{t("acc.saturateCustom")}</div>
            <div className="vs-desc">{t("acc.saturateCustomDesc")}</div>
          </div>
          <label className="vs-switch">
            <input
              type="checkbox"
              checked={saturateCustomColors}
              onChange={(e) => setSaturateCustomColors(e.target.checked)}
            />
            <span className="vs-switch-slider" />
          </label>
        </div>
      </div>

      {/* ─── D. Azaltılmış Hareketlilik ────────────────────────────── */}
      <div className="vs-section">
        <div className="vs-section-header">{t("acc.reducedMotion")}</div>

        <div className="vs-toggle-row">
          <div>
            <div className="vs-label">{t("acc.reduceMotion")}</div>
            <div className="vs-desc">{t("acc.reduceMotionDesc")}</div>
          </div>
          <label className="vs-switch">
            <input
              type="checkbox"
              checked={reduceMotion}
              onChange={(e) => setReduceMotion(e.target.checked)}
            />
            <span className="vs-switch-slider" />
          </label>
        </div>

        <div className="vs-toggle-row">
          <div>
            <div className="vs-label">{t("acc.disableAnimatedEmoji")}</div>
            <div className="vs-desc">{t("acc.disableAnimatedEmojiDesc")}</div>
          </div>
          <label className="vs-switch">
            <input
              type="checkbox"
              checked={disableAnimatedEmoji}
              onChange={(e) => setDisableAnimatedEmoji(e.target.checked)}
            />
            <span className="vs-switch-slider" />
          </label>
        </div>

        <div className="vs-toggle-row">
          <div>
            <div className="vs-label">{t("acc.autoplayGifs")}</div>
            <div className="vs-desc">{t("acc.autoplayGifsDesc")}</div>
          </div>
          <label className="vs-switch">
            <input
              type="checkbox"
              checked={autoplayGifs}
              onChange={(e) => setAutoplayGifs(e.target.checked)}
            />
            <span className="vs-switch-slider" />
          </label>
        </div>
      </div>

      {/* ─── E. Ses ve Ekran Okuyucu ───────────────────────────────── */}
      <div className="vs-section">
        <div className="vs-section-header">{t("acc.audioScreenReader")}</div>

        <div className="vs-desc acc-screen-reader-note">
          {t("acc.screenReaderNote")}
        </div>

        <div className="vs-slider-row">
          <div className="vs-label">{t("acc.notificationVolume")}</div>
          <div className="vs-desc">{t("acc.notificationVolumeDesc")}</div>
          <div className="acc-slider-track">
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={notificationSoundVolume}
              onChange={(e) => setNotificationSoundVolume(Number(e.target.value))}
              className="vs-range"
              aria-label={t("acc.notificationVolume")}
            />
          </div>
        </div>

        <div className="vs-toggle-row">
          <div>
            <div className="vs-label">{t("acc.ttsEnabled")}</div>
            <div className="vs-desc">{t("acc.ttsEnabledDesc")}</div>
          </div>
          <label className="vs-switch">
            <input
              type="checkbox"
              checked={ttsEnabled}
              onChange={(e) => setTtsEnabled(e.target.checked)}
            />
            <span className="vs-switch-slider" />
          </label>
        </div>
      </div>
    </div>
  );
}

export default AccessibilitySettings;
