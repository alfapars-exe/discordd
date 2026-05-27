/** ChannelSettings — Channel and category management (two-tab panel). */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useChannelStore } from "../../stores/channelStore";
import { useToastStore } from "../../stores/toastStore";
import { useConfirm } from "../../hooks/useConfirm";
import * as channelApi from "../../api/channels";
import { useServerStore } from "../../stores/serverStore";
import ChannelPermissionEditor from "./ChannelPermissionEditor";
import CreateChannelModal from "../channels/CreateChannelModal";
import EmojiPicker from "../shared/EmojiPicker";
import type { Channel, Category } from "../../types";

type SettingsTab = "channels" | "categories";

function ChannelSettings() {
  const { t } = useTranslation("channels");
  const { t: tSettings } = useTranslation("settings");
  const categories = useChannelStore((s) => s.categories);
  const addToast = useToastStore((s) => s.addToast);
  const confirm = useConfirm();

  // ─── Tab State ───
  const [activeTab, setActiveTab] = useState<SettingsTab>("channels");

  // Flatten all channels
  const allChannels = categories
    .flatMap((cg) => cg.channels)
    .sort((a, b) => a.position - b.position);

  // Real categories (excluding uncategorized)
  const realCategories = categories
    .filter((cg) => cg.category.id !== "")
    .map((cg) => cg.category);

  // ─── Channels Tab State ───
  //
  // We track only the SELECTED ID and derive the live channel object
  // via useMemo. This removes the two cascading-render useEffects that
  // previously (a) mirrored the store's renamed-channel back into local
  // state and (b) reset the rename buffer on selection change — the
  // first now resolves naturally on every render, and the second uses
  // the ChannelEditPanel `key={selectedChannelId}` remount trick below
  // to discard the buffer when the user picks a different channel.
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const selectedChannel = useMemo<Channel | null>(
    () => (selectedChannelId ? allChannels.find((ch) => ch.id === selectedChannelId) ?? null : null),
    [allChannels, selectedChannelId],
  );

  // ─── Create Modal State ───
  const [showCreateModal, setShowCreateModal] = useState(false);

  // ─── Channel Rename State (per-selection local buffers — reset via
  // key={selectedChannelId} on the edit panel JSX further down). ───
  const [editName, setEditName] = useState("");
  const [isSavingName, setIsSavingName] = useState(false);

  // ─── Channel Category State ───
  const [editCategoryId, setEditCategoryId] = useState("");
  const [isSavingCategory, setIsSavingCategory] = useState(false);

  // ─── Emoji picker state ───
  const [showChEmojiPicker, setShowChEmojiPicker] = useState(false);
  const [showCatEmojiPicker, setShowCatEmojiPicker] = useState(false);

  // ─── Categories Tab State (same ID-derived pattern as channels) ───
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const selectedCategory = useMemo<Category | null>(
    () =>
      selectedCategoryId
        ? realCategories.find((c) => c.id === selectedCategoryId) ?? null
        : null,
    [realCategories, selectedCategoryId],
  );
  const [editCatName, setEditCatName] = useState("");
  const [isSavingCatName, setIsSavingCatName] = useState(false);

  // ─── Channel Handlers ───

  async function handleDeleteChannel(channelId: string, channelName: string) {
    const ok = await confirm({
      message: t("deleteConfirm", { name: channelName }),
      confirmLabel: t("deleteChannel"),
      danger: true,
    });
    if (!ok) return;

    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;
    const res = await channelApi.deleteChannel(serverId, channelId);
    if (res.success) {
      addToast("success", t("channelDeleted"));
      if (selectedChannel?.id === channelId) setSelectedChannelId(null);
    } else {
      addToast("error", t("channelDeleteError"));
    }
  }

  async function handleRenameChannel() {
    if (!selectedChannel) return;
    const trimmed = editName.trim();
    if (!trimmed || trimmed === selectedChannel.name) return;

    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;

    setIsSavingName(true);
    const res = await channelApi.updateChannel(serverId, selectedChannel.id, {
      name: trimmed,
    });

    if (res.success) {
      addToast("success", t("channelUpdated"));
    } else {
      addToast("error", t("channelUpdateError"));
      setEditName(selectedChannel.name);
    }
    setIsSavingName(false);
  }

  async function handleChangeCategory(newCategoryId: string) {
    if (!selectedChannel) return;
    const currentCatId = selectedChannel.category_id ?? "";
    if (newCategoryId === currentCatId) return;

    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;

    setEditCategoryId(newCategoryId);
    setIsSavingCategory(true);
    const res = await channelApi.updateChannel(serverId, selectedChannel.id, {
      category_id: newCategoryId,
    });

    if (res.success) {
      addToast("success", t("channelUpdated"));
    } else {
      addToast("error", t("channelUpdateError"));
      setEditCategoryId(currentCatId);
    }
    setIsSavingCategory(false);
  }

  const channelNameChanged = selectedChannel
    ? editName.trim() !== selectedChannel.name
    : false;

  // ─── Category Handlers ───

  async function handleDeleteCategory(catId: string, catName: string) {
    const ok = await confirm({
      message: t("deleteCategoryConfirm", { name: catName }),
      confirmLabel: t("deleteCategory"),
      danger: true,
    });
    if (!ok) return;

    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;
    const res = await channelApi.deleteCategory(serverId, catId);
    if (res.success) {
      addToast("success", t("categoryDeleted"));
      if (selectedCategory?.id === catId) setSelectedCategoryId(null);
    } else {
      addToast("error", t("categoryDeleteError"));
    }
  }

  async function handleRenameCategory() {
    if (!selectedCategory) return;
    const trimmed = editCatName.trim();
    if (!trimmed || trimmed === selectedCategory.name) return;

    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;

    setIsSavingCatName(true);
    const res = await channelApi.updateCategory(serverId, selectedCategory.id, {
      name: trimmed,
    });

    if (res.success) {
      addToast("success", t("categoryUpdated"));
    } else {
      addToast("error", t("categoryUpdateError"));
      setEditCatName(selectedCategory.name);
    }
    setIsSavingCatName(false);
  }

  const catNameChanged = selectedCategory
    ? editCatName.trim() !== selectedCategory.name
    : false;

  return (
    <div className="channel-settings-wrapper">
      {/* Left Panel */}
      <div className="role-list">
        {/* Tab toggle */}
        <div className="channel-settings-tabs">
          <button
            className={`channel-settings-tab${activeTab === "channels" ? " active" : ""}`}
            onClick={() => setActiveTab("channels")}
          >
            {t("tabChannels")}
          </button>
          <button
            className={`channel-settings-tab${activeTab === "categories" ? " active" : ""}`}
            onClick={() => setActiveTab("categories")}
          >
            {t("tabCategories")}
          </button>
        </div>

        {/* Header with + button */}
        <div className="channel-settings-header">
          <span className="channel-settings-header-label">
            {activeTab === "channels" ? t("channelsTitle") : t("categoriesTitle")}
          </span>
          <button
            onClick={() => setShowCreateModal(true)}
            className="settings-btn channel-settings-header-btn"
          >
            +
          </button>
        </div>

        {/* ═══ Channels Tab — left panel ═══ */}
        {activeTab === "channels" && (
          <div className="channel-settings-ch-list">
            {allChannels.map((ch) => (
              <div
                key={ch.id}
                className={`role-list-item channel-settings-ch-row${ch.id === selectedChannel?.id ? " active" : ""}`}
                onClick={() => {
                  setSelectedChannelId(ch.id);
                  // Seed the rename buffer with the channel's current
                  // name/category so the edit panel opens populated. The
                  // panel's key={selectedChannelId} below remounts when
                  // ID flips, so this seed becomes the fresh initial
                  // state for the new selection.
                  setEditName(ch.name);
                  setEditCategoryId(ch.category_id ?? "");
                }}
              >
                <span className="channel-settings-ch-icon">
                  {ch.type === "voice" ? "\uD83D\uDD0A" : "#"}
                </span>
                <span className="role-list-name">{ch.name}</span>
                <button
                  className="channel-settings-delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteChannel(ch.id, ch.name);
                  }}
                  title={t("deleteChannel")}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        {/* ═══ Categories Tab — left panel ═══ */}
        {activeTab === "categories" && (
          <div className="channel-settings-ch-list">
            {realCategories.length === 0 ? (
              <div className="no-channel" style={{ padding: "16px 8px" }}>
                {t("noCategoriesYet")}
              </div>
            ) : (
              realCategories.map((cat) => (
                <div
                  key={cat.id}
                  className={`role-list-item channel-settings-ch-row${cat.id === selectedCategory?.id ? " active" : ""}`}
                  onClick={() => {
                    setSelectedCategoryId(cat.id);
                    setEditCatName(cat.name);
                  }}
                >
                  <span className="channel-settings-ch-icon">&#x25BC;</span>
                  <span className="role-list-name">{cat.name}</span>
                  <button
                    className="channel-settings-delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteCategory(cat.id, cat.name);
                    }}
                    title={t("deleteCategory")}
                  >
                    ✕
                  </button>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Right Panel */}
      <div className="settings-content channel-settings-right">
        {/* ═══ Channels Tab — right panel ═══ */}
        {activeTab === "channels" && (
          selectedChannel ? (
            <div className="channel-perm-section">
              <h2 className="settings-section-title channel-settings-right-title">
                {selectedChannel.type === "voice" ? "\uD83D\uDD0A" : "#"} {selectedChannel.name}
              </h2>

              {/* Channel name edit */}
              <div className="channel-settings-rename-row">
                <label className="settings-label">{t("channelName")}</label>
                <div className="channel-settings-rename-input-row">
                  <div className="name-input-with-emoji">
                    <input
                      className="settings-input"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && channelNameChanged) handleRenameChannel();
                        if (e.key === "Escape") setEditName(selectedChannel.name);
                      }}
                      maxLength={50}
                    />
                    <button
                      type="button"
                      className="name-emoji-btn"
                      onClick={() => setShowChEmojiPicker((p) => !p)}
                      title={t("emoji", { ns: "chat" })}
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10" />
                        <path d="M8 14s1.5 2 4 2 4-2 4-2" />
                        <line x1="9" y1="9" x2="9.01" y2="9" />
                        <line x1="15" y1="9" x2="15.01" y2="9" />
                      </svg>
                    </button>
                    {showChEmojiPicker && (
                      <div className="name-emoji-picker-wrap">
                        <EmojiPicker
                          onSelect={(emoji) => {
                            setEditName((prev) => {
                              const next = prev + emoji;
                              return [...next].length <= 50 ? next : prev;
                            });
                            setShowChEmojiPicker(false);
                          }}
                          onClose={() => setShowChEmojiPicker(false)}
                        />
                      </div>
                    )}
                  </div>
                  {channelNameChanged && (
                    <button
                      className="settings-btn"
                      onClick={handleRenameChannel}
                      disabled={isSavingName}
                    >
                      {isSavingName ? "..." : tSettings("save")}
                    </button>
                  )}
                </div>
              </div>

              {/* Channel category select */}
              <div className="channel-settings-cat-row">
                <label className="settings-label">{t("moveToCategory")}</label>
                <select
                  className="channel-settings-cat-select"
                  value={editCategoryId}
                  onChange={(e) => handleChangeCategory(e.target.value)}
                  disabled={isSavingCategory}
                >
                  <option value="">{t("channelNoCategory")}</option>
                  {realCategories.map((cat) => (
                    <option key={cat.id} value={cat.id}>
                      {cat.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Voice-only: bitrate slider (Track T1).
                  8 kbps minimum (intelligible speech), 384 kbps maximum
                  (matches user request — Opus stereo at full quality).
                  Discord presets: 64 / 96 / 128 / 256 / 384 kbps. */}
              {selectedChannel.type === "voice" && (
                // key= forces a remount when the user picks a different
                // channel, so ChannelBitrateRow's local `value` state
                // re-initialises from the new channel.bitrate without a
                // sync useEffect (which the lint flags as a
                // cascading-render anti-pattern).
                <ChannelBitrateRow key={selectedChannel.id} channel={selectedChannel} />
              )}

              {/* Channel permissions */}
              <ChannelPermissionEditor channel={selectedChannel} />
            </div>
          ) : (
            <div className="no-channel">
              {tSettings("selectChannelToEdit")}
            </div>
          )
        )}

        {/* ═══ Categories Tab — right panel ═══ */}
        {activeTab === "categories" && (
          selectedCategory ? (
            <div className="channel-perm-section">
              <h2 className="settings-section-title channel-settings-right-title">
                {selectedCategory.name}
              </h2>

              {/* Category name edit */}
              <div className="channel-settings-rename-row">
                <label className="settings-label">{t("categoryName")}</label>
                <div className="channel-settings-rename-input-row">
                  <div className="name-input-with-emoji">
                    <input
                      className="settings-input"
                      value={editCatName}
                      onChange={(e) => setEditCatName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && catNameChanged) handleRenameCategory();
                        if (e.key === "Escape") setEditCatName(selectedCategory.name);
                      }}
                      maxLength={50}
                    />
                    <button
                      type="button"
                      className="name-emoji-btn"
                      onClick={() => setShowCatEmojiPicker((p) => !p)}
                      title={t("emoji", { ns: "chat" })}
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10" />
                        <path d="M8 14s1.5 2 4 2 4-2 4-2" />
                        <line x1="9" y1="9" x2="9.01" y2="9" />
                        <line x1="15" y1="9" x2="15.01" y2="9" />
                      </svg>
                    </button>
                    {showCatEmojiPicker && (
                      <div className="name-emoji-picker-wrap">
                        <EmojiPicker
                          onSelect={(emoji) => {
                            setEditCatName((prev) => {
                              const next = prev + emoji;
                              return [...next].length <= 50 ? next : prev;
                            });
                            setShowCatEmojiPicker(false);
                          }}
                          onClose={() => setShowCatEmojiPicker(false)}
                        />
                      </div>
                    )}
                  </div>
                  {catNameChanged && (
                    <button
                      className="settings-btn"
                      onClick={handleRenameCategory}
                      disabled={isSavingCatName}
                    >
                      {isSavingCatName ? "..." : tSettings("save")}
                    </button>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="no-channel">
              {t("selectCategoryToEdit")}
            </div>
          )
        )}
      </div>

      {/* Create Channel/Category Modal */}
      {showCreateModal && (
        <CreateChannelModal onClose={() => setShowCreateModal(false)} />
      )}
    </div>
  );
}

/**
 * ChannelBitrateRow — voice-channel bitrate slider (Track T1).
 *
 * Discord preset ladder: 64 / 96 / 128 / 256 / 384 kbps. We snap the slider
 * value to one of those steps on release. The server-side model layer
 * Validate() already enforces 8000–384000, so the UI doesn't need to clamp
 * defensively; it just exposes the meaningful presets.
 *
 * Saving fires immediately on selection (no separate "Save" button) — same
 * pattern the category dropdown above uses. PATCH /channels/{id} with the
 * single `bitrate` field; failure shows a toast and rolls the UI back to the
 * server-confirmed value on next channel store sync.
 */
function ChannelBitrateRow({ channel }: { channel: Channel }) {
  const { t } = useTranslation("channels");
  const addToast = useToastStore((s) => s.addToast);
  const activeServerId = useServerStore((s) => s.activeServerId);
  const [pending, setPending] = useState(false);
  // Local controlled value. Remount-on-id-change (caller passes
  // `key={channel.id}`) re-initialises this from the new channel's
  // bitrate, so we don't need a sync useEffect that the lint would
  // flag as set-state-in-effect.
  const [value, setValue] = useState(channel.bitrate ?? 64000);

  const presets = [8000, 64000, 96000, 128000, 256000, 384000];

  async function commit(next: number) {
    if (!activeServerId || next === channel.bitrate) return;
    setPending(true);
    const res = await channelApi.updateChannel(activeServerId, channel.id, {
      bitrate: next,
    });
    setPending(false);
    if (!res.success) {
      setValue(channel.bitrate ?? 64000);
      addToast("error", t("channelUpdateError"));
    }
  }

  return (
    <div className="channel-settings-cat-row">
      <label className="settings-label">
        {t("channelBitrate", { defaultValue: "Ses Kalitesi" })}
        <span style={{ marginLeft: 8, color: "var(--t3)", fontWeight: 400 }}>
          {Math.round(value / 1000)} kbps
        </span>
      </label>
      <div className="acc-slider-track">
        <div className="acc-slider-ticks">
          {presets.map((p) => (
            <span key={p} className="acc-slider-tick">{Math.round(p / 1000)}k</span>
          ))}
        </div>
        <input
          type="range"
          min={8000}
          max={384000}
          step={1000}
          value={value}
          onChange={(e) => setValue(Number(e.target.value))}
          onMouseUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
          onTouchEnd={(e) => commit(Number((e.target as HTMLInputElement).value))}
          onKeyUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
          disabled={pending}
          className="vs-range"
          aria-label={t("channelBitrate", { defaultValue: "Ses Kalitesi" })}
        />
      </div>
      <div className="vs-desc" style={{ marginTop: 6 }}>
        {t("channelBitrateDesc", {
          defaultValue:
            "Daha yüksek bitrate = daha net ses, daha fazla bant genişliği. 384 kbps stüdyo kalitesi.",
        })}
      </div>
    </div>
  );
}

export default ChannelSettings;
