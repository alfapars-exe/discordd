/**
 * StickerSettings — server sticker management (Faz D2).
 *
 * Lists the active server's stickers (30 per server, static + animated),
 * uploads new ones (display name → auto slug, description, comma-separated
 * tags), edits metadata, toggles the creator-only `copyable` license (locked
 * on clones) and deletes. Below the list: "copy from your other servers".
 * All checks here are UX only; the server (ManageExpressions gate, decoder,
 * slug/steering/tag rules, cap) is authoritative.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "../../stores/authStore";
import { useStickerStore } from "../../stores/stickerStore";
import { useActiveMembers } from "../../stores/memberStore";
import { useServerStore } from "../../stores/serverStore";
import { useToastStore } from "../../stores/toastStore";
import { useConfirm } from "../../hooks/useConfirm";
import { hasPermission, Permissions } from "../../utils/permissions";
import { sniffImageKind } from "../../utils/imageSniff";
import { EXPRESSION_NAME, isValidDisplayName, slugifyExpressionName } from "../../utils/expressionTokens";
import {
  MAX_DESCRIPTION_RUNES,
  MAX_STICKERS,
  MAX_STICKER_UPLOAD_BYTES,
  MAX_TAGS,
  MAX_TAG_RUNES,
  isValidStickerDescription,
  parseTagInput,
} from "../../utils/stickerTokens";
import type { UpdateStickerPatch } from "../../api/stickers";
import type { APIResponse } from "../../types";
import type { ServerSticker } from "../../types/expression";
import StickerImage from "../shared/StickerImage";
import ExpressionCloneSection from "./ExpressionCloneSection";
import "../../styles/expressions.css";

const ACCEPTED_TYPES = "image/png,image/jpeg,image/gif,image/webp";

const ERROR_KEYS: Record<string, string> = {
  EXPRESSION_NAME_INVALID: "nameInvalid",
  EXPRESSION_DISPLAY_NAME_INVALID: "displayNameInvalid",
  EXPRESSION_DESCRIPTION_INVALID: "descriptionInvalid",
  EXPRESSION_TAGS_INVALID: "tagsInvalid",
  EXPRESSION_NAME_TAKEN: "nameTaken",
  EXPRESSION_LIMIT_REACHED: "stickerLimitReached",
  EXPRESSION_LICENSE_CREATOR_ONLY: "copyableCreatorOnly",
  EXPRESSION_LICENSE_LOCKED: "cloneLocked",
};

/** Map a failed API response to an `expressions` i18n key. */
function stickerErrorKey(res: Pick<APIResponse, "code" | "status" | "error">): string {
  if (res.code && ERROR_KEYS[res.code]) return ERROR_KEYS[res.code];
  if (res.status === 409) return "nameTaken";
  if (res.error && /too large/i.test(res.error)) return "stickerFileTooLarge";
  return "stickerUploadFailed";
}

function runeCount(s: string): number {
  return [...s].length;
}

function StickerSettings() {
  const { t } = useTranslation("expressions");
  const { t: tSettings } = useTranslation("settings");
  const serverId = useServerStore((s) => s.activeServerId);
  const userId = useAuthStore((s) => s.user?.id);
  const members = useActiveMembers();
  const perms = members.find((m) => m.id === userId)?.effective_permissions ?? 0;
  const canManage = hasPermission(perms, Permissions.ManageExpressions);

  const stickers = useStickerStore((s) => (serverId ? s.byServer[serverId] : undefined));
  const fetchServer = useStickerStore((s) => s.fetchServer);
  const createSticker = useStickerStore((s) => s.createSticker);
  const updateSticker = useStickerStore((s) => s.updateSticker);
  const deleteSticker = useStickerStore((s) => s.deleteSticker);
  const addToast = useToastStore((s) => s.addToast);
  const confirm = useConfirm();

  const [file, setFile] = useState<File | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [shortcode, setShortcode] = useState("");
  const [shortcodeEdited, setShortcodeEdited] = useState(false);
  const [description, setDescription] = useState("");
  const [tagInput, setTagInput] = useState("");
  const [copyable, setCopyable] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (serverId) void fetchServer(serverId);
  }, [serverId, fetchServer]);

  const list = useMemo(() => stickers ?? [], [stickers]);
  const tagPreview = useMemo(() => parseTagInput(tagInput), [tagInput]);

  const handleDisplayNameChange = (value: string) => {
    setDisplayName(value);
    if (!shortcodeEdited) setShortcode(slugifyExpressionName(value) ?? "");
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0] ?? null;
    e.target.value = "";
    if (!picked) return;
    if (picked.size > MAX_STICKER_UPLOAD_BYTES) {
      addToast("error", t("stickerFileTooLarge"));
      return;
    }
    if ((await sniffImageKind(picked)) === "webp-animated") {
      addToast("error", tSettings("avatarAnimatedWebpUnsupported"));
      return;
    }
    setFile(picked);
    if (!displayName) {
      const base = picked.name.replace(/\.[^.]+$/, "").slice(0, 32);
      handleDisplayNameChange(base);
    }
  };

  const resetForm = () => {
    setFile(null);
    setDisplayName("");
    setShortcode("");
    setShortcodeEdited(false);
    setDescription("");
    setTagInput("");
    setCopyable(false);
  };

  const handleUpload = async () => {
    if (!serverId || !file || isUploading) return;
    if (!isValidDisplayName(displayName)) {
      addToast("error", t("displayNameInvalid"));
      return;
    }
    const name = shortcode.trim();
    if (name && !EXPRESSION_NAME.test(name)) {
      addToast("error", t("nameInvalid"));
      return;
    }
    if (!isValidStickerDescription(description)) {
      addToast("error", t("descriptionInvalid"));
      return;
    }
    if (!tagPreview) {
      addToast("error", t("tagsInvalid"));
      return;
    }
    setIsUploading(true);
    const res = await createSticker(serverId, {
      file,
      display_name: displayName.trim(),
      name: name || undefined,
      description: description.trim() || undefined,
      tags: tagPreview,
      copyable,
    });
    setIsUploading(false);
    if (res.success) {
      resetForm();
    } else {
      addToast("error", t(stickerErrorKey(res)));
    }
  };

  const fail = useCallback(
    (res: APIResponse<unknown>) => addToast("error", t(stickerErrorKey(res))),
    [addToast, t],
  );

  if (!serverId) return null;

  return (
    <div className="settings-section">
      <h2 className="settings-section-title">{t("stickers")}</h2>

      <div className="emoji-settings-counts">
        <span>{t("stickerCount", { count: list.length, max: MAX_STICKERS })}</span>
      </div>

      {canManage && (
        <div className="emoji-settings-form">
          <div className="settings-field" style={{ marginBottom: 0 }}>
            <label className="settings-label">{t("uploadSticker")}</label>
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_TYPES}
              style={{ display: "none" }}
              onChange={handleFileChange}
            />
            <button
              type="button"
              className="settings-btn settings-btn-secondary"
              onClick={() => fileInputRef.current?.click()}
            >
              {file ? file.name : t("uploadSticker")}
            </button>
          </div>

          <div className="settings-field" style={{ marginBottom: 0 }}>
            <label className="settings-label" htmlFor="sticker-display-name">{t("displayName")}</label>
            <input
              id="sticker-display-name"
              className="settings-input"
              value={displayName}
              maxLength={64}
              onChange={(e) => handleDisplayNameChange(e.target.value)}
            />
          </div>

          <div className="settings-field" style={{ marginBottom: 0 }}>
            <label className="settings-label" htmlFor="sticker-shortcode">{t("shortcode")}</label>
            <input
              id="sticker-shortcode"
              className="settings-input"
              value={shortcode}
              maxLength={32}
              title={t("shortcodeHint")}
              onChange={(e) => {
                setShortcodeEdited(true);
                setShortcode(e.target.value.toLowerCase());
              }}
            />
          </div>

          <div className="settings-field sticker-settings-wide" style={{ marginBottom: 0 }}>
            <label className="settings-label" htmlFor="sticker-description">
              {t("description")}{" "}
              <span className="emoji-settings-hint">
                {runeCount(description.trim())}/{MAX_DESCRIPTION_RUNES}
              </span>
            </label>
            <input
              id="sticker-description"
              className="settings-input"
              value={description}
              maxLength={MAX_DESCRIPTION_RUNES * 2}
              title={t("descriptionHint")}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div className="settings-field sticker-settings-wide" style={{ marginBottom: 0 }}>
            <label className="settings-label" htmlFor="sticker-tags">{t("tags")}</label>
            <input
              id="sticker-tags"
              className="settings-input"
              value={tagInput}
              title={t("tagsHint", { max: MAX_TAGS })}
              placeholder={t("tagsHint", { max: MAX_TAGS })}
              onChange={(e) => setTagInput(e.target.value)}
            />
            <TagPreview tags={tagPreview} />
          </div>

          <label className="emoji-settings-hint" title={t("copyableHint")}>
            <input
              type="checkbox"
              checked={copyable}
              onChange={(e) => setCopyable(e.target.checked)}
            />{" "}
            {t("copyable")}
          </label>

          <button
            type="button"
            className="settings-btn"
            disabled={!file || !displayName.trim() || isUploading || list.length >= MAX_STICKERS}
            onClick={handleUpload}
          >
            {t("uploadSticker")}
          </button>
        </div>
      )}

      <div style={{ height: 1, background: "var(--b1)", marginBottom: 16 }} />

      {list.length === 0 ? (
        <p style={{ fontSize: 13, color: "var(--t2)" }}>{t("noStickers")}</p>
      ) : (
        <div className="emoji-settings-list">
          {list.map((sticker) => (
            <StickerRow
              key={sticker.id}
              sticker={sticker}
              canManage={canManage}
              isCreator={!!userId && sticker.created_by === userId}
              onSave={async (patch) => {
                const res = await updateSticker(serverId, sticker.id, patch);
                if (!res.success) fail(res);
                return res.success;
              }}
              onCopyable={async (value) => {
                const res = await updateSticker(serverId, sticker.id, { copyable: value });
                if (!res.success) fail(res);
              }}
              onDelete={async () => {
                const ok = await confirm({
                  message: t("stickerDeleteConfirm", { name: sticker.display_name }),
                  confirmLabel: t("delete"),
                  danger: true,
                });
                if (!ok) return;
                const res = await deleteSticker(serverId, sticker.id);
                if (!res.success) fail(res);
              }}
            />
          ))}
        </div>
      )}

      <ExpressionCloneSection kind="sticker" serverId={serverId} />
    </div>
  );
}

function TagPreview({ tags }: { tags: string[] | null }) {
  const { t } = useTranslation("expressions");
  if (tags === null) {
    return (
      <span className="sticker-settings-tags-error">
        {t("tagsInvalid")} ({MAX_TAGS} × {MAX_TAG_RUNES})
      </span>
    );
  }
  if (tags.length === 0) return null;
  return (
    <div className="expression-popover-tags">
      {tags.map((tag) => (
        <span key={tag} className="expression-popover-tag">
          {tag}
        </span>
      ))}
    </div>
  );
}

type StickerRowProps = {
  sticker: ServerSticker;
  canManage: boolean;
  isCreator: boolean;
  onSave: (patch: UpdateStickerPatch) => Promise<boolean>;
  onCopyable: (value: boolean) => Promise<void>;
  onDelete: () => Promise<void>;
};

function sameTags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function StickerRow({ sticker, canManage, isCreator, onSave, onCopyable, onDelete }: StickerRowProps) {
  const { t } = useTranslation("expressions");
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState(sticker.display_name);
  const [name, setName] = useState(sticker.name);
  const [description, setDescription] = useState(sticker.description);
  const [tagInput, setTagInput] = useState(sticker.tags.join(", "));

  const isClone = sticker.cloned_from !== null;
  // Creator owns the license; with the creator account gone, managers may
  // only withdraw it (copyable → false). Clones are locked (D2-14).
  const canToggleCopyable =
    !isClone && canManage && (isCreator || (sticker.created_by === null && sticker.copyable));
  const copyableTitle = isClone
    ? t("cloneLocked")
    : canToggleCopyable
      ? t("copyableHint")
      : t("copyableCreatorOnly");

  const startEdit = () => {
    setDisplayName(sticker.display_name);
    setName(sticker.name);
    setDescription(sticker.description);
    setTagInput(sticker.tags.join(", "));
    setEditing(true);
  };

  const save = async () => {
    if (!isValidDisplayName(displayName)) return;
    if (!EXPRESSION_NAME.test(name)) return;
    if (!isValidStickerDescription(description)) return;
    const tags = parseTagInput(tagInput);
    if (!tags) return;
    const patch: UpdateStickerPatch = {};
    if (name !== sticker.name) patch.name = name;
    if (displayName.trim() !== sticker.display_name) patch.display_name = displayName.trim();
    if (description.trim() !== sticker.description) patch.description = description.trim();
    if (!sameTags(tags, sticker.tags)) patch.tags = tags;
    if (Object.keys(patch).length === 0) {
      setEditing(false);
      return;
    }
    if (await onSave(patch)) setEditing(false);
  };

  return (
    <div className="emoji-settings-row">
      <StickerImage id={sticker.id} name={sticker.name} animated={sticker.animated} still size="settings" />
      {editing ? (
        <div className="emoji-settings-names" style={{ gap: 4 }}>
          <input
            className="settings-input"
            aria-label={t("displayName")}
            value={displayName}
            maxLength={64}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <input
            className="settings-input"
            aria-label={t("shortcode")}
            value={name}
            maxLength={32}
            onChange={(e) => setName(e.target.value.toLowerCase())}
          />
          <input
            className="settings-input"
            aria-label={t("description")}
            value={description}
            maxLength={MAX_DESCRIPTION_RUNES * 2}
            onChange={(e) => setDescription(e.target.value)}
          />
          <input
            className="settings-input"
            aria-label={t("tags")}
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
          />
        </div>
      ) : (
        <div className="emoji-settings-names">
          <span className="emoji-settings-display">{sticker.display_name}</span>
          <span className="emoji-settings-code">:{sticker.name}:</span>
          {sticker.description && <span className="emoji-settings-hint">{sticker.description}</span>}
          {sticker.tags.length > 0 && (
            <span className="emoji-settings-hint">{sticker.tags.join(", ")}</span>
          )}
        </div>
      )}
      {sticker.animated && <span className="emoji-settings-badge">{t("animated")}</span>}
      {isClone && <span className="emoji-settings-badge">{t("cloneOf")}</span>}
      <label className="emoji-settings-hint" title={copyableTitle}>
        <input
          type="checkbox"
          checked={sticker.copyable}
          disabled={!canToggleCopyable}
          onChange={(e) => void onCopyable(e.target.checked)}
        />{" "}
        {t("copyable")}
      </label>
      {canManage && (
        <div className="emoji-settings-actions">
          {editing ? (
            <>
              <button type="button" className="settings-btn" onClick={() => void save()}>
                {t("save")}
              </button>
              <button
                type="button"
                className="settings-btn settings-btn-secondary"
                onClick={() => setEditing(false)}
              >
                {t("cancel")}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="settings-btn settings-btn-secondary" onClick={startEdit}>
                {t("rename")}
              </button>
              <button
                type="button"
                className="settings-btn settings-btn-danger"
                onClick={() => void onDelete()}
              >
                {t("delete")}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default StickerSettings;
