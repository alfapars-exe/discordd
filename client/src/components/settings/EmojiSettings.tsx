/**
 * EmojiSettings — server custom emoji management (Faz D1).
 *
 * Lists the active server's emojis with static/animated counters, uploads
 * new ones (display name → auto slug, editable), renames, toggles the
 * creator-only `copyable` license and deletes. All checks here are UX only;
 * the server (ManageExpressions gate, decoder K-021, slug/steering rules,
 * caps) is authoritative.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "../../stores/authStore";
import { useEmojiStore } from "../../stores/emojiStore";
import { useActiveMembers } from "../../stores/memberStore";
import { useServerStore } from "../../stores/serverStore";
import { useToastStore } from "../../stores/toastStore";
import { useConfirm } from "../../hooks/useConfirm";
import { hasPermission, Permissions } from "../../utils/permissions";
import { sniffImageKind } from "../../utils/imageSniff";
import {
  EXPRESSION_NAME,
  MAX_ANIMATED_EMOJIS,
  MAX_EMOJI_UPLOAD_BYTES,
  MAX_STATIC_EMOJIS,
  isValidDisplayName,
  slugifyExpressionName,
} from "../../utils/expressionTokens";
import type { APIResponse } from "../../types";
import type { ServerEmoji } from "../../types/expression";
import CustomEmoji from "../shared/CustomEmoji";
import ExpressionCloneSection from "./ExpressionCloneSection";
import "../../styles/expressions.css";

const ACCEPTED_TYPES = "image/png,image/jpeg,image/gif,image/webp";

const ERROR_KEYS: Record<string, string> = {
  EXPRESSION_NAME_INVALID: "nameInvalid",
  EXPRESSION_DISPLAY_NAME_INVALID: "displayNameInvalid",
  EXPRESSION_NAME_TAKEN: "nameTaken",
  EXPRESSION_LIMIT_REACHED: "limitReached",
  EXPRESSION_LICENSE_CREATOR_ONLY: "copyableCreatorOnly",
};

/** Map a failed API response to an `expressions` i18n key. */
function expressionErrorKey(res: Pick<APIResponse, "code" | "status" | "error">): string {
  if (res.code && ERROR_KEYS[res.code]) return ERROR_KEYS[res.code];
  if (res.status === 409) return "nameTaken";
  if (res.error && /too large/i.test(res.error)) return "fileTooLarge";
  return "uploadFailed";
}

function EmojiSettings() {
  const { t } = useTranslation("expressions");
  const { t: tSettings } = useTranslation("settings");
  const serverId = useServerStore((s) => s.activeServerId);
  const userId = useAuthStore((s) => s.user?.id);
  const members = useActiveMembers();
  const perms = members.find((m) => m.id === userId)?.effective_permissions ?? 0;
  const canManage = hasPermission(perms, Permissions.ManageExpressions);

  const emojis = useEmojiStore((s) => (serverId ? s.byServer[serverId] : undefined));
  const fetchServer = useEmojiStore((s) => s.fetchServer);
  const createEmoji = useEmojiStore((s) => s.createEmoji);
  const updateEmoji = useEmojiStore((s) => s.updateEmoji);
  const deleteEmoji = useEmojiStore((s) => s.deleteEmoji);
  const addToast = useToastStore((s) => s.addToast);
  const confirm = useConfirm();

  const [file, setFile] = useState<File | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [shortcode, setShortcode] = useState("");
  const [shortcodeEdited, setShortcodeEdited] = useState(false);
  const [copyable, setCopyable] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (serverId) void fetchServer(serverId);
  }, [serverId, fetchServer]);

  const list = useMemo(() => emojis ?? [], [emojis]);
  const staticCount = list.filter((e) => !e.animated).length;
  const animatedCount = list.length - staticCount;

  const handleDisplayNameChange = (value: string) => {
    setDisplayName(value);
    if (!shortcodeEdited) setShortcode(slugifyExpressionName(value) ?? "");
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0] ?? null;
    e.target.value = "";
    if (!picked) return;
    if (picked.size > MAX_EMOJI_UPLOAD_BYTES) {
      addToast("error", t("fileTooLarge"));
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
    setIsUploading(true);
    const res = await createEmoji(serverId, {
      file,
      display_name: displayName.trim(),
      name: name || undefined,
      copyable,
    });
    setIsUploading(false);
    if (res.success) {
      resetForm();
    } else {
      addToast("error", t(expressionErrorKey(res)));
    }
  };

  const fail = useCallback(
    (res: APIResponse<unknown>) => addToast("error", t(expressionErrorKey(res))),
    [addToast, t],
  );

  if (!serverId) return null;

  return (
    <div className="settings-section">
      <h2 className="settings-section-title">{t("emojis")}</h2>

      <div className="emoji-settings-counts">
        <span>{t("staticCount", { count: staticCount, max: MAX_STATIC_EMOJIS })}</span>
        <span>{t("animatedCount", { count: animatedCount, max: MAX_ANIMATED_EMOJIS })}</span>
      </div>

      {canManage && (
        <div className="emoji-settings-form">
          <div className="settings-field" style={{ marginBottom: 0 }}>
            <label className="settings-label">{t("uploadEmoji")}</label>
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
              {file ? file.name : t("uploadEmoji")}
            </button>
          </div>

          <div className="settings-field" style={{ marginBottom: 0 }}>
            <label className="settings-label" htmlFor="emoji-display-name">{t("displayName")}</label>
            <input
              id="emoji-display-name"
              className="settings-input"
              value={displayName}
              maxLength={64}
              onChange={(e) => handleDisplayNameChange(e.target.value)}
            />
          </div>

          <div className="settings-field" style={{ marginBottom: 0 }}>
            <label className="settings-label" htmlFor="emoji-shortcode">{t("shortcode")}</label>
            <input
              id="emoji-shortcode"
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
            disabled={!file || !displayName.trim() || isUploading}
            onClick={handleUpload}
          >
            {t("uploadEmoji")}
          </button>
        </div>
      )}

      <div style={{ height: 1, background: "var(--b1)", marginBottom: 16 }} />

      {list.length === 0 ? (
        <p style={{ fontSize: 13, color: "var(--t2)" }}>{t("noEmojis")}</p>
      ) : (
        <div className="emoji-settings-list">
          {list.map((emoji) => (
            <EmojiRow
              key={emoji.id}
              emoji={emoji}
              canManage={canManage}
              isCreator={!!userId && emoji.created_by === userId}
              onRename={async (patch) => {
                const res = await updateEmoji(serverId, emoji.id, patch);
                if (!res.success) fail(res);
                return res.success;
              }}
              onCopyable={async (value) => {
                const res = await updateEmoji(serverId, emoji.id, { copyable: value });
                if (!res.success) fail(res);
              }}
              onDelete={async () => {
                const ok = await confirm({
                  message: t("deleteConfirm", { name: emoji.name }),
                  confirmLabel: t("delete"),
                  danger: true,
                });
                if (!ok) return;
                const res = await deleteEmoji(serverId, emoji.id);
                if (!res.success) fail(res);
              }}
            />
          ))}
        </div>
      )}

      <ExpressionCloneSection kind="emoji" serverId={serverId} />
    </div>
  );
}

type EmojiRowProps = {
  emoji: ServerEmoji;
  canManage: boolean;
  isCreator: boolean;
  onRename: (patch: { name?: string; display_name?: string }) => Promise<boolean>;
  onCopyable: (value: boolean) => Promise<void>;
  onDelete: () => Promise<void>;
};

function EmojiRow({ emoji, canManage, isCreator, onRename, onCopyable, onDelete }: EmojiRowProps) {
  const { t } = useTranslation("expressions");
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState(emoji.display_name);
  const [name, setName] = useState(emoji.name);

  // Creator owns the license; with the creator account gone, managers may
  // only withdraw it (copyable → false). Mirrors the server rule (D-15).
  // Clones (Faz D2) are licence-locked.
  const canToggleCopyable =
    emoji.cloned_from === null &&
    canManage && (isCreator || (emoji.created_by === null && emoji.copyable));

  const startEdit = () => {
    setDisplayName(emoji.display_name);
    setName(emoji.name);
    setEditing(true);
  };

  const save = async () => {
    if (!isValidDisplayName(displayName)) return;
    if (!EXPRESSION_NAME.test(name)) return;
    const patch: { name?: string; display_name?: string } = {};
    if (name !== emoji.name) patch.name = name;
    if (displayName.trim() !== emoji.display_name) patch.display_name = displayName.trim();
    if (Object.keys(patch).length === 0) {
      setEditing(false);
      return;
    }
    if (await onRename(patch)) setEditing(false);
  };

  return (
    <div className="emoji-settings-row">
      <CustomEmoji id={emoji.id} name={emoji.name} animated={emoji.animated} still />
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
        </div>
      ) : (
        <div className="emoji-settings-names">
          <span className="emoji-settings-display">{emoji.display_name}</span>
          <span className="emoji-settings-code">:{emoji.name}:</span>
        </div>
      )}
      {emoji.animated && <span className="emoji-settings-badge">{t("animated")}</span>}
      <label
        className="emoji-settings-hint"
        title={
          emoji.cloned_from !== null
            ? t("cloneLocked")
            : canToggleCopyable
              ? t("copyableHint")
              : t("copyableCreatorOnly")
        }
      >
        <input
          type="checkbox"
          checked={emoji.copyable}
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

export default EmojiSettings;
