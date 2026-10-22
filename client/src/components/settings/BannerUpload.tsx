/** BannerUpload — profile banner picker (5:2 preview box, click to choose,
 *  "Remove" button). No crop UI: the server centre-crops to 5:2 "cover",
 *  which the preview's `object-fit: cover` mirrors exactly. The choice is
 *  staged in the parent and applied on Save, like the avatar. */

import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { resolveAssetUrl } from "../../utils/constants";
import { sniffImageKind } from "../../utils/imageSniff";
import { useToastStore } from "../../stores/toastStore";
import "../../styles/profile.css";

const ACCEPTED_TYPES = "image/jpeg,image/png,image/gif,image/webp";
const MAX_FILE_SIZE = 8 * 1024 * 1024;

type Props = {
  /** Saved banner (server path), or null. */
  currentUrl: string | null;
  /** Object URL of a staged, not-yet-saved file. */
  previewUrl: string | null;
  /** True when the user staged a removal of the saved banner. */
  removed: boolean;
  onSelect: (file: File) => void;
  onRemove: () => void;
  disabled?: boolean;
};

function BannerUpload({ currentUrl, previewUrl, removed, onSelect, onRemove, disabled }: Props) {
  const { t } = useTranslation("settings");
  const addToast = useToastStore((s) => s.addToast);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const shownUrl = previewUrl ?? (!removed && currentUrl ? resolveAssetUrl(currentUrl) : null);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset so the same file can be re-selected.
    e.target.value = "";
    if (!file) return;
    if (file.size > MAX_FILE_SIZE) {
      addToast("error", t("avatarMaxSize"));
      return;
    }
    if ((await sniffImageKind(file)) === "webp-animated") {
      addToast("error", t("avatarAnimatedWebpUnsupported"));
      return;
    }
    onSelect(file);
  }

  return (
    <div className="settings-field banner-upload">
      <span className="settings-label">{t("profileBanner")}</span>
      <button
        type="button"
        className="banner-upload-box"
        onClick={() => fileInputRef.current?.click()}
        disabled={disabled}
        aria-label={t("profileBannerUpload")}
      >
        {shownUrl ? <img src={shownUrl} alt="" /> : <span>{t("profileBannerUpload")}</span>}
      </button>
      <div className="banner-upload-actions">
        <button
          type="button"
          className="settings-btn settings-btn-secondary"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled}
        >
          {t("profileBannerUpload")}
        </button>
        {shownUrl && (
          <button
            type="button"
            className="settings-btn settings-btn-danger"
            onClick={onRemove}
            disabled={disabled}
          >
            {t("profileBannerRemove")}
          </button>
        )}
      </div>
      <span className="settings-field-hint">{t("profileBannerHint")}</span>
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_TYPES}
        onChange={handleFileChange}
        style={{ display: "none" }}
        data-testid="banner-file-input"
      />
    </div>
  );
}

export default BannerUpload;
