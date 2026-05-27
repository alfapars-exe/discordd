/**
 * AppearanceSettings — theme picker, wallpaper, and overlay-effect toggles.
 *
 * Polished in Track S to match the Discord pattern the user referenced:
 *   1. A live preview block at the top so theme + accessibility changes
 *      show up immediately without scrolling around the app.
 *   2. Effect toggles (blur, transparent) collapsed into a single
 *      "Overlay effects" group instead of three separate H2s.
 *   3. Drag-and-drop wallpaper area instead of the file-picker button.
 *   4. Theme cards keep the swatch layout but get a hover lift +
 *      stronger active ring so the selected one is impossible to miss.
 */

import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/settingsStore";
import { useAuthStore } from "../../stores/authStore";
import { useToastStore } from "../../stores/toastStore";
import { uploadWallpaper, deleteWallpaper } from "../../api/profile";
import { resolveAssetUrl } from "../../utils/constants";
import { clearWallpaperCache } from "../../utils/wallpaperCache";
import { THEMES, THEME_ORDER, type ThemeId } from "../../styles/themes";
import { isElectron } from "../../utils/constants";

function AppearanceSettings() {
  const { t } = useTranslation("settings");
  const themeId = useSettingsStore((s) => s.themeId);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const blurEnabled = useSettingsStore((s) => s.blurEnabled);
  const setBlurEnabled = useSettingsStore((s) => s.setBlurEnabled);
  const wallpaperEnabled = useSettingsStore((s) => s.wallpaperEnabled);
  const setWallpaperEnabled = useSettingsStore((s) => s.setWallpaperEnabled);
  const transparentBackground = useSettingsStore((s) => s.transparentBackground);
  const setTransparentBackground = useSettingsStore((s) => s.setTransparentBackground);
  const lightningEnabled = useSettingsStore((s) => s.lightningEnabled);
  const setLightningEnabled = useSettingsStore((s) => s.setLightningEnabled);
  const lightningBlur = useSettingsStore((s) => s.lightningBlur);
  const setLightningBlur = useSettingsStore((s) => s.setLightningBlur);
  const neonEnabled = useSettingsStore((s) => s.neonEnabled);
  const setNeonEnabled = useSettingsStore((s) => s.setNeonEnabled);
  const neonIntensity = useSettingsStore((s) => s.neonIntensity);
  const setNeonIntensity = useSettingsStore((s) => s.setNeonIntensity);
  const setPendingWallpaperPreviewUrl = useSettingsStore((s) => s.setPendingWallpaperPreviewUrl);
  const user = useAuthStore((s) => s.user);
  const updateUser = useAuthStore((s) => s.updateUser);
  const addToast = useToastStore((s) => s.addToast);

  // Track initial value to detect change — restart needed in either
  // direction. useState with a lazy initializer freezes the value at
  // mount; we never call the setter, so it stays the mount-time
  // snapshot. (useRef.current was flagged by react-hooks/refs as a
  // render-time ref read; useMemo([]) lies about deps.)
  const [initialTransparent] = useState(() => transparentBackground);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [pendingPreviewUrl, setPendingPreviewUrl] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  function acceptFile(file: File) {
    if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl);
    const blobUrl = URL.createObjectURL(file);
    setPendingFile(file);
    setPendingPreviewUrl(blobUrl);
    setPendingWallpaperPreviewUrl(blobUrl);
  }

  function handleWallpaperSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) acceptFile(file);
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    // Match the <input>'s accept list — only image/jpeg, image/png, image/webp.
    if (!/^image\/(jpe?g|png|webp)$/.test(file.type)) {
      addToast("error", t("wallpaperBadType", { defaultValue: "Unsupported file type" }));
      return;
    }
    acceptFile(file);
  }

  function handleCancelPending() {
    if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl);
    setPendingFile(null);
    setPendingPreviewUrl(null);
    setPendingWallpaperPreviewUrl(null);
  }

  async function handleSavePending() {
    if (!pendingFile) return;

    setIsUploading(true);
    const res = await uploadWallpaper(pendingFile);
    setIsUploading(false);

    if (res.success && res.data) {
      await clearWallpaperCache();
      updateUser({ wallpaper_url: res.data.wallpaper_url });
      setPendingWallpaperPreviewUrl(null);
      if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl);
      setPendingFile(null);
      setPendingPreviewUrl(null);
      addToast("success", t("wallpaperUpdated"));
    } else {
      addToast("error", t("wallpaperUploadError"));
    }
  }

  async function handleRemoveWallpaper() {
    const res = await deleteWallpaper();
    if (res.success) {
      await clearWallpaperCache();
      updateUser({ wallpaper_url: null });
      addToast("success", t("wallpaperRemoved"));
    } else {
      addToast("error", t("wallpaperRemoveError"));
    }
  }

  function handleSelectTheme(id: ThemeId) {
    setTheme(id);
  }

  const currentWallpaperUrl = pendingPreviewUrl
    ?? (user?.wallpaper_url ? resolveAssetUrl(user.wallpaper_url) : null);

  return (
    <div>
      {/* ─── Live preview block — same shape as AccessibilitySettings ─── */}
      <div className="vs-section acc-preview-section">
        <div className="vs-label">{t("acc.preview")}</div>
        <div className="acc-preview">
          <div className="acc-preview-msg">
            <div className="acc-preview-avatar" />
            <div className="acc-preview-body">
              <div className="acc-preview-head">
                <span className="acc-preview-author">{user?.display_name ?? user?.username ?? "ALFAP4RS"}</span>
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
              <div className="acc-preview-text">
                {t("acc.previewMsg2")}{" "}
                <a href="#" onClick={(e) => e.preventDefault()}>
                  https://tayfa.app/themes
                </a>
              </div>
              <button type="button" className="acc-preview-button">
                {t("acc.previewButton")}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ─── Theme picker ──────────────────────────────────────────── */}
      <h2 className="settings-section-title">{t("themeTitle")}</h2>
      <p className="theme-section-desc">{t("themeDescription")}</p>

      <div className="theme-grid">
        {THEME_ORDER.map((id) => {
          const theme = THEMES[id];
          const isActive = id === themeId;

          return (
            <button
              key={id}
              className={`theme-card${isActive ? " theme-card-active" : ""}`}
              onClick={() => handleSelectTheme(id)}
              type="button"
              aria-pressed={isActive}
            >
              <div className="theme-swatches">
                {theme.swatches.map((color, i) => (
                  <span
                    key={i}
                    className="theme-swatch"
                    style={{ background: color }}
                  />
                ))}
              </div>

              <span className="theme-card-name">{t(theme.nameKey)}</span>
              <span className="theme-card-desc">{t(theme.descKey)}</span>

              {isActive && <span className="theme-card-check">&#10003;</span>}
            </button>
          );
        })}
      </div>

      {/* ─── Wallpaper — drag-drop zone ─────────────────────────────── */}
      <h2 className="settings-section-title" style={{ marginTop: 28 }}>{t("wallpaperTitle")}</h2>
      <p className="theme-section-desc">{t("wallpaperDescription")}</p>

      <label className="settings-toggle-row">
        <span>{t("wallpaperEnable")}</span>
        <button
          className={`ub-switch${wallpaperEnabled ? " active" : ""}`}
          onClick={() => setWallpaperEnabled(!wallpaperEnabled)}
          role="switch"
          aria-checked={wallpaperEnabled}
          type="button"
        >
          <span className="ub-switch-thumb" />
        </button>
      </label>

      <div
        className={`wallpaper-dropzone${isDragging ? " dragging" : ""}${currentWallpaperUrl ? " has-image" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        onClick={() => !pendingFile && fileInputRef.current?.click()}
        role="button"
        tabIndex={0}
        aria-label={t("wallpaperChoose")}
      >
        {currentWallpaperUrl ? (
          <>
            <img src={currentWallpaperUrl} alt="" className="wallpaper-dropzone-img" />
            <div className="wallpaper-dropzone-overlay">
              {t("wallpaperReplaceHint", { defaultValue: "Click or drop a new image to replace" })}
            </div>
          </>
        ) : (
          <div className="wallpaper-dropzone-empty">
            <div className="wallpaper-dropzone-icon">🖼️</div>
            <div className="wallpaper-dropzone-text">
              {t("wallpaperDropHint", { defaultValue: "Click or drag an image here" })}
            </div>
            <div className="wallpaper-dropzone-types">JPEG · PNG · WebP</div>
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          hidden
          onChange={handleWallpaperSelect}
        />
      </div>

      <div className="wallpaper-actions">
        {pendingFile ? (
          <>
            <button
              type="button"
              className="settings-btn"
              onClick={handleSavePending}
              disabled={isUploading}
            >
              {isUploading ? t("loading") : t("saveChanges")}
            </button>
            <button
              type="button"
              className="settings-btn settings-btn-secondary"
              onClick={handleCancelPending}
              disabled={isUploading}
            >
              {t("cancel", { ns: "common" })}
            </button>
          </>
        ) : (
          user?.wallpaper_url && (
            <button
              type="button"
              className="settings-btn settings-btn-danger"
              onClick={handleRemoveWallpaper}
            >
              {t("wallpaperRemove")}
            </button>
          )
        )}
      </div>

      {/* ─── Overlay effects — blur + transparent grouped ───────────── */}
      <h2 className="settings-section-title" style={{ marginTop: 28 }}>
        {t("overlayEffects", { defaultValue: "Görsel Efektler" })}
      </h2>
      <p className="theme-section-desc">{t("blurDescription")}</p>

      <label className="settings-toggle-row">
        <span>{t("blurTitle")}</span>
        <button
          className={`ub-switch${blurEnabled ? " active" : ""}`}
          onClick={() => setBlurEnabled(!blurEnabled)}
          role="switch"
          aria-checked={blurEnabled}
          type="button"
        >
          <span className="ub-switch-thumb" />
        </button>
      </label>

      {/* Neon decorations — edge halo + ambient aurora. Toggle gates the
          slider, slider scales --neon-intensity. Lightning has its own
          control further down. */}
      <label className="settings-toggle-row" style={{ marginTop: 16 }}>
        <span>{t("neonTitle", { defaultValue: "Neon efektleri" })}</span>
        <button
          className={`ub-switch${neonEnabled ? " active" : ""}`}
          onClick={() => setNeonEnabled(!neonEnabled)}
          role="switch"
          aria-checked={neonEnabled}
          type="button"
        >
          <span className="ub-switch-thumb" />
        </button>
      </label>
      <p className="theme-section-desc">
        {t("neonDescription", {
          defaultValue: "Pencere kenarındaki ışıltı ve ana paneldeki aurora arka planı. Düşük donanımda yoğunluğu azaltın veya kapatın.",
        })}
      </p>

      {neonEnabled && (
        <label className="settings-toggle-row" style={{ alignItems: "center", gap: 12 }}>
          <span style={{ minWidth: 140 }}>
            {t("neonIntensityLabel", { defaultValue: "Neon yoğunluğu" })}
          </span>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={neonIntensity}
            onChange={(e) => setNeonIntensity(parseInt(e.target.value, 10))}
            style={{ flex: 1, accentColor: "var(--primary)" }}
            aria-label={t("neonIntensityLabel", { defaultValue: "Neon yoğunluğu" })}
          />
          <span style={{ minWidth: 38, textAlign: "right", color: "var(--t2)", fontVariantNumeric: "tabular-nums" }}>
            {neonIntensity}%
          </span>
        </label>
      )}

      {isElectron() && (
        <>
          <label className="settings-toggle-row">
            <span>{t("transparentEnable")}</span>
            <button
              className={`ub-switch${transparentBackground ? " active" : ""}`}
              onClick={() => setTransparentBackground(!transparentBackground)}
              role="switch"
              aria-checked={transparentBackground}
              type="button"
            >
              <span className="ub-switch-thumb" />
            </button>
          </label>
          {transparentBackground !== initialTransparent && (
            <p className="theme-section-desc" style={{ color: "var(--yellow)", marginTop: 4 }}>
              {t("transparentRestart")}
            </p>
          )}
        </>
      )}

      {/* Lightning bolts — opt-in (Track X). Slider appears below when on. */}
      <label className="settings-toggle-row" style={{ marginTop: 16 }}>
        <span>{t("lightningTitle", { defaultValue: "Yıldırım efekti" })}</span>
        <button
          className={`ub-switch${lightningEnabled ? " active" : ""}`}
          onClick={() => setLightningEnabled(!lightningEnabled)}
          role="switch"
          aria-checked={lightningEnabled}
          type="button"
        >
          <span className="ub-switch-thumb" />
        </button>
      </label>
      <p className="theme-section-desc">
        {t("lightningDescription", {
          defaultValue: "Ana panelde animasyonlu neon yıldırımlar çakar. Düşük donanımda kapatın.",
        })}
      </p>

      {lightningEnabled && (
        <label className="settings-toggle-row" style={{ alignItems: "center", gap: 12 }}>
          <span style={{ minWidth: 140 }}>
            {t("lightningBlurLabel", { defaultValue: "Yıldırım yumuşaklığı" })}
          </span>
          <input
            type="range"
            min={0}
            max={20}
            step={1}
            value={lightningBlur}
            onChange={(e) => setLightningBlur(parseInt(e.target.value, 10))}
            style={{ flex: 1, accentColor: "var(--primary)" }}
            aria-label={t("lightningBlurLabel", { defaultValue: "Yıldırım yumuşaklığı" })}
          />
          <span style={{ minWidth: 38, textAlign: "right", color: "var(--t2)", fontVariantNumeric: "tabular-nums" }}>
            {lightningBlur}px
          </span>
        </label>
      )}
    </div>
  );
}

export default AppearanceSettings;
