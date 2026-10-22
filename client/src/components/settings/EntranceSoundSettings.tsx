/**
 * EntranceSoundSettings — user settings tab "Entrance Sound" (Faz E).
 *
 * Sections:
 *   1. Which sound plays — a global selection plus optional per-server
 *      overrides; each is none / one of your clips / a parametric preset.
 *   2. Clip library (≤5) — pick any browser-decodable audio/video file, trim
 *      it (0.1–5 s), render to mono 24 kHz 16-bit WAV locally and upload.
 *      The server re-parses, measures and re-writes the WAV (Karar E-4).
 *   3. Hearing others — listener on/off + volume (preferences, Karar E-12).
 * Every check here is UX only; the server is authoritative.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useEntranceStore, MAX_ENTRANCE_CLIPS } from "../../stores/entranceStore";
import { useServerStore } from "../../stores/serverStore";
import { useToastStore } from "../../stores/toastStore";
import { useVoiceStore } from "../../stores/voiceStore";
import { useConfirm } from "../../hooks/useConfirm";
import { useEntranceListenerPrefs } from "../../hooks/useEntranceListenerPrefs";
import { entranceErrorKey } from "../../api/entrance";
import {
  DEFAULT_ENTRANCE_PRESET,
  ENTRANCE_CLIP_URL,
  ENTRANCE_THEMES,
  ENTRANCE_WAVEFORMS,
  PRESET_DURATION_MAX_MS,
  PRESET_DURATION_MIN_MS,
  PRESET_PITCH_MAX,
  PRESET_PITCH_MIN,
  parseEntrancePreset,
  playEntrancePreset,
} from "../../utils/entrancePreset";
import { renderClipToWav } from "../../utils/wavEncode";
import { resolveAssetUrl } from "../../utils/constants";
import WaveformTrimmer from "../soundboard/WaveformTrimmer";
import type { EntranceSelection, EntranceSelectionInput, EntranceSound, EntrancePreset } from "../../types/entrance";
import "../../styles/expressions.css";

const ACCEPTED_TYPES = "audio/*,video/mp4";
const CLIP_MIN_MS = 100;
const CLIP_MAX_MS = 5000;
const MAX_UPLOAD_BYTES = 1 << 20;
const NAME_MAX_RUNES = 32;
const GLOBAL_SCOPE = "global";

function runeCount(s: string): number {
  return [...s].length;
}

function isValidName(name: string): boolean {
  const n = runeCount(name.trim());
  return n >= 1 && n <= NAME_MAX_RUNES;
}

function clipNameFromFile(fileName: string): string {
  return [...fileName.replace(/\.[^.]+$/, "")].slice(0, NAME_MAX_RUNES).join("");
}

/** Effective preview volume: listener volume × voice master volume (0–1). */
function previewVolume(listenerPct: number): number {
  const master = useVoiceStore.getState().masterVolume;
  const v = (listenerPct / 100) * (Math.min(100, Math.max(0, master)) / 100);
  return Math.min(1, Math.max(0, v));
}

function formatSeconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}

// ─── Range input with aria-valuetext ───

type RangeFieldProps = {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  valueText: string;
  onChange: (value: number) => void;
};

function RangeField({ id, label, value, min, max, step = 1, valueText, onChange }: RangeFieldProps) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="settings-field" style={{ marginBottom: 12 }}>
      <label className="settings-label" htmlFor={id}>
        {label}
      </label>
      <div className="vs-slider-row">
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          aria-valuetext={valueText}
          onChange={(e) => onChange(Number(e.target.value))}
          className="vs-range"
          style={{
            background: `linear-gradient(to right, var(--primary) ${pct}%, var(--bg-5) ${pct}%)`,
          }}
        />
        <span className="vs-slider-value">{valueText}</span>
      </div>
    </div>
  );
}

// ─── Preset designer ───

type PresetDesignerProps = {
  idPrefix: string;
  value: EntrancePreset;
  onChange: (preset: EntrancePreset) => void;
  listenerVolume: number;
};

function PresetDesigner({ idPrefix, value, onChange, listenerVolume }: PresetDesignerProps) {
  const { t } = useTranslation("entrance");
  const [playing, setPlaying] = useState(false);
  const stopRef = useRef<(() => void) | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stop = useCallback(() => {
    stopRef.current?.();
    stopRef.current = null;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setPlaying(false);
  }, []);

  useEffect(
    () => () => {
      stopRef.current?.();
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const togglePreview = () => {
    if (playing) {
      stop();
      return;
    }
    const preset = parseEntrancePreset(value);
    if (!preset) return;
    stopRef.current = playEntrancePreset(preset, preset.duration_ms, previewVolume(listenerVolume || 70));
    setPlaying(true);
    timerRef.current = setTimeout(stop, preset.duration_ms + 50);
  };

  return (
    <div className="entrance-preset">
      <div className="settings-field" style={{ marginBottom: 12 }}>
        <label className="settings-label" htmlFor={`${idPrefix}-theme`}>
          {t("theme")}
        </label>
        <select
          id={`${idPrefix}-theme`}
          className="vs-select"
          value={value.theme}
          onChange={(e) => {
            const theme = ENTRANCE_THEMES.find((x) => x === e.target.value);
            if (theme) onChange({ ...value, theme });
          }}
        >
          {ENTRANCE_THEMES.map((theme) => (
            <option key={theme} value={theme}>
              {t(`themes.${theme}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="settings-field" style={{ marginBottom: 12 }}>
        <label className="settings-label" htmlFor={`${idPrefix}-wave`}>
          {t("waveform")}
        </label>
        <select
          id={`${idPrefix}-wave`}
          className="vs-select"
          value={value.waveform}
          onChange={(e) => {
            const waveform = ENTRANCE_WAVEFORMS.find((x) => x === e.target.value);
            if (waveform) onChange({ ...value, waveform });
          }}
        >
          {ENTRANCE_WAVEFORMS.map((wave) => (
            <option key={wave} value={wave}>
              {t(`waveforms.${wave}`)}
            </option>
          ))}
        </select>
      </div>
      <RangeField
        id={`${idPrefix}-pitch`}
        label={t("pitch")}
        value={value.pitch}
        min={PRESET_PITCH_MIN}
        max={PRESET_PITCH_MAX}
        valueText={value.pitch > 0 ? `+${value.pitch}` : String(value.pitch)}
        onChange={(pitch) => onChange({ ...value, pitch })}
      />
      <RangeField
        id={`${idPrefix}-duration`}
        label={t("duration")}
        value={value.duration_ms}
        min={PRESET_DURATION_MIN_MS}
        max={PRESET_DURATION_MAX_MS}
        step={50}
        valueText={t("seconds", { value: formatSeconds(value.duration_ms) })}
        onChange={(duration_ms) => onChange({ ...value, duration_ms })}
      />
      <button type="button" className="settings-btn settings-btn-secondary" onClick={togglePreview}>
        {playing ? t("stop") : t("preview")}
      </button>
    </div>
  );
}

// ─── Selection editor (one scope) ───

type DraftKind = "none" | "clip" | "preset";

type SelectionEditorProps = {
  scope: string;
  title: string;
  selection: EntranceSelection | undefined;
  sounds: EntranceSound[];
  listenerVolume: number;
  onRemove?: () => void;
};

function SelectionEditor({ scope, title, selection, sounds, listenerVolume, onRemove }: SelectionEditorProps) {
  const { t } = useTranslation("entrance");
  const setSelection = useEntranceStore((s) => s.setSelection);
  const addToast = useToastStore((s) => s.addToast);

  const [kind, setKind] = useState<DraftKind>(selection?.kind ?? "none");
  const [soundId, setSoundId] = useState<string>(selection?.sound_id ?? "");
  const [preset, setPreset] = useState<EntrancePreset>(
    parseEntrancePreset(selection?.preset) ?? DEFAULT_ENTRANCE_PRESET,
  );
  const [saving, setSaving] = useState(false);

  const clipValid = sounds.some((s) => s.id === soundId);
  const canSave =
    !saving &&
    (kind === "none" ? !!selection : kind === "clip" ? clipValid : parseEntrancePreset(preset) !== null);

  const save = async () => {
    let body: EntranceSelectionInput;
    if (kind === "clip") body = { scope, kind, sound_id: soundId };
    else if (kind === "preset") {
      const clean = parseEntrancePreset(preset);
      if (!clean) {
        addToast("error", t("errors.presetInvalid"));
        return;
      }
      body = { scope, kind, preset: clean };
    } else body = { scope, kind: "none" };
    setSaving(true);
    const res = await setSelection(body);
    setSaving(false);
    if (!res.success) addToast("error", t(entranceErrorKey(res)));
  };

  const idPrefix = `entrance-${scope}`;

  return (
    <div className="emoji-settings-form" style={{ display: "block" }}>
      <div className="vs-toggle-row" style={{ marginBottom: 8 }}>
        <div className="vs-label" style={{ marginBottom: 0 }}>
          {title}
        </div>
        {onRemove && (
          <button type="button" className="settings-btn settings-btn-secondary" onClick={onRemove}>
            {t("removeOverride")}
          </button>
        )}
      </div>
      <div role="radiogroup" aria-label={title} style={{ display: "flex", flexWrap: "wrap", marginBottom: 12 }}>
        {(["none", "clip", "preset"] as const).map((k) => (
          <label key={k} className="emoji-settings-hint" style={{ marginRight: 16 }}>
            <input
              type="radio"
              name={`${idPrefix}-kind`}
              checked={kind === k}
              onChange={() => setKind(k)}
            />{" "}
            {t(k)}
          </label>
        ))}
      </div>

      {kind === "clip" && (
        <div className="settings-field" style={{ marginBottom: 12 }}>
          <label className="settings-label" htmlFor={`${idPrefix}-clip`}>
            {t("clip")}
          </label>
          <select
            id={`${idPrefix}-clip`}
            className="vs-select"
            value={clipValid ? soundId : ""}
            onChange={(e) => setSoundId(e.target.value)}
          >
            <option value="" disabled>
              {t("selectClip")}
            </option>
            {sounds.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {kind === "preset" && (
        <PresetDesigner idPrefix={idPrefix} value={preset} onChange={setPreset} listenerVolume={listenerVolume} />
      )}

      <div style={{ marginTop: 12 }}>
        <button type="button" className="settings-btn" disabled={!canSave} onClick={() => void save()}>
          {t("save")}
        </button>
      </div>
    </div>
  );
}

// ─── Library row ───

type ClipRowProps = {
  sound: EntranceSound;
};

function ClipRow({ sound }: ClipRowProps) {
  const { t } = useTranslation("entrance");
  const rename = useEntranceStore((s) => s.rename);
  const remove = useEntranceStore((s) => s.remove);
  const addToast = useToastStore((s) => s.addToast);
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(sound.name);

  const save = async () => {
    if (!isValidName(name)) {
      addToast("error", t("errors.nameInvalid"));
      return;
    }
    const trimmed = name.trim();
    if (trimmed === sound.name) {
      setEditing(false);
      return;
    }
    const res = await rename(sound.id, trimmed);
    if (res.success) setEditing(false);
    else addToast("error", t(entranceErrorKey(res)));
  };

  const handleDelete = async () => {
    const ok = await confirm({
      message: t("deleteConfirm", { name: sound.name }),
      confirmLabel: t("delete"),
      danger: true,
    });
    if (!ok) return;
    const res = await remove(sound.id);
    if (!res.success) addToast("error", t(entranceErrorKey(res)));
  };

  const playable = ENTRANCE_CLIP_URL.test(sound.url);

  return (
    <div className="emoji-settings-row">
      {editing ? (
        <div className="emoji-settings-names">
          <input
            className="settings-input"
            aria-label={t("name")}
            value={name}
            maxLength={NAME_MAX_RUNES * 2}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
      ) : (
        <div className="emoji-settings-names">
          <span className="emoji-settings-display">{sound.name}</span>
          <span className="emoji-settings-hint">{t("seconds", { value: formatSeconds(sound.duration_ms) })}</span>
        </div>
      )}
      {playable && (
        <audio controls preload="none" src={resolveAssetUrl(sound.url)} aria-label={t("preview")} style={{ height: 32 }} />
      )}
      <div className="emoji-settings-actions">
        {editing ? (
          <>
            <button type="button" className="settings-btn" onClick={() => void save()}>
              {t("save")}
            </button>
            <button
              type="button"
              className="settings-btn settings-btn-secondary"
              onClick={() => {
                setName(sound.name);
                setEditing(false);
              }}
            >
              {t("cancel")}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="settings-btn settings-btn-secondary"
              onClick={() => {
                setName(sound.name);
                setEditing(true);
              }}
            >
              {t("rename")}
            </button>
            <button type="button" className="settings-btn settings-btn-danger" onClick={() => void handleDelete()}>
              {t("delete")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Upload form ───

function ClipUploader({ disabled }: { disabled: boolean }) {
  const { t } = useTranslation("entrance");
  const upload = useEntranceStore((s) => s.upload);
  const addToast = useToastStore((s) => s.addToast);

  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [totalMs, setTotalMs] = useState(0);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopPreview = useCallback(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    if (playTimerRef.current) clearTimeout(playTimerRef.current);
    playTimerRef.current = null;
    setIsPlaying(false);
  }, []);

  useEffect(() => {
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      audioRef.current?.pause();
      audioRef.current = null;
      if (playTimerRef.current) clearTimeout(playTimerRef.current);
    };
  }, [objectUrl]);

  const trimmedMs = trimEnd - trimStart;
  const rangeOk = trimmedMs >= CLIP_MIN_MS && trimmedMs <= CLIP_MAX_MS;
  const canUpload = !!file && totalMs > 0 && rangeOk && isValidName(name) && !busy && !disabled;

  const resetForm = () => {
    stopPreview();
    setFile(null);
    setName("");
    setObjectUrl(null);
    setTotalMs(0);
    setTrimStart(0);
    setTrimEnd(0);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0] ?? null;
    e.target.value = "";
    if (!picked) return;
    stopPreview();
    const url = URL.createObjectURL(picked);
    setFile(picked);
    setObjectUrl(url);
    setTotalMs(0);
    if (!name) setName(clipNameFromFile(picked.name));
    const probe = new Audio(url);
    probe.addEventListener("loadedmetadata", () => {
      const ms = Math.round(probe.duration * 1000);
      if (!Number.isFinite(ms) || ms <= 0) {
        addToast("error", t("decodeFailed"));
        return;
      }
      setTotalMs(ms);
      setTrimStart(0);
      setTrimEnd(Math.min(ms, CLIP_MAX_MS));
    });
    probe.addEventListener("error", () => addToast("error", t("decodeFailed")));
  };

  const togglePreview = () => {
    if (isPlaying) {
      stopPreview();
      return;
    }
    if (!objectUrl) return;
    const audio = new Audio(objectUrl);
    audioRef.current = audio;
    audio.currentTime = trimStart / 1000;
    audio.volume = previewVolume(70);
    audio.play().catch(() => {});
    setIsPlaying(true);
    playTimerRef.current = setTimeout(stopPreview, Math.max(0, trimmedMs));
    audio.addEventListener("ended", stopPreview);
  };

  const handleUpload = async () => {
    if (!file || !canUpload) return;
    stopPreview();
    setBusy(true);
    let wav: Blob;
    try {
      wav = await renderClipToWav(file, trimStart, trimEnd);
    } catch {
      setBusy(false);
      addToast("error", t("decodeFailed"));
      return;
    }
    if (wav.size > MAX_UPLOAD_BYTES) {
      setBusy(false);
      addToast("error", t("errors.tooLarge"));
      return;
    }
    const res = await upload(wav, name.trim());
    setBusy(false);
    if (res.success) resetForm();
    else addToast("error", t(entranceErrorKey(res)));
  };

  return (
    <div className="emoji-settings-form" style={{ display: "block" }}>
      <input
        ref={fileRef}
        type="file"
        accept={ACCEPTED_TYPES}
        style={{ display: "none" }}
        onChange={handleFileChange}
      />
      <button
        type="button"
        className="settings-btn settings-btn-secondary"
        disabled={disabled || busy}
        onClick={() => fileRef.current?.click()}
      >
        {file ? t("changeFile") : t("selectFile")}
      </button>

      {file && objectUrl && totalMs > 0 && (
        <div style={{ marginTop: 12 }}>
          <WaveformTrimmer
            fileUrl={objectUrl}
            totalDurationMs={totalMs}
            maxDurationMs={CLIP_MAX_MS}
            trimStart={trimStart}
            trimEnd={trimEnd}
            onTrimChange={(s, e) => {
              setTrimStart(s);
              setTrimEnd(e);
            }}
            isPlaying={isPlaying}
            onTogglePlay={togglePreview}
          />
          <p className="emoji-settings-hint" role="status">
            {t("trim", { seconds: formatSeconds(Math.max(0, trimmedMs)), max: CLIP_MAX_MS / 1000 })}
          </p>
        </div>
      )}

      {file && (
        <div className="settings-field" style={{ marginTop: 12, marginBottom: 12 }}>
          <label className="settings-label" htmlFor="entrance-clip-name">
            {t("name")}
          </label>
          <input
            id="entrance-clip-name"
            className="settings-input"
            value={name}
            maxLength={NAME_MAX_RUNES * 2}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
      )}

      {file && (
        <button type="button" className="settings-btn" disabled={!canUpload} onClick={() => void handleUpload()}>
          {busy ? t("uploading") : t("upload")}
        </button>
      )}
    </div>
  );
}

// ─── Main tab ───

function EntranceSoundSettings() {
  const { t } = useTranslation("entrance");
  const sounds = useEntranceStore((s) => s.sounds);
  const selections = useEntranceStore((s) => s.selections);
  const status = useEntranceStore((s) => s.status);
  const load = useEntranceStore((s) => s.load);
  const setSelection = useEntranceStore((s) => s.setSelection);
  const servers = useServerStore((s) => s.servers);
  const addToast = useToastStore((s) => s.addToast);
  const { prefs, update } = useEntranceListenerPrefs();

  const [pendingScopes, setPendingScopes] = useState<string[]>([]);
  const [addPick, setAddPick] = useState("");

  useEffect(() => {
    if (status === "idle") void load();
  }, [status, load]);

  const globalSelection = selections.find((s) => s.scope === GLOBAL_SCOPE);
  const serverScopes = useMemo(() => {
    const saved = selections.filter((s) => s.scope !== GLOBAL_SCOPE).map((s) => s.scope);
    return [...saved, ...pendingScopes.filter((id) => !saved.includes(id))];
  }, [selections, pendingScopes]);

  const availableServers = servers.filter((s) => !serverScopes.includes(s.id));
  const serverName = (id: string) => servers.find((s) => s.id === id)?.name ?? id;

  const removeScope = async (scope: string) => {
    setPendingScopes((list) => list.filter((id) => id !== scope));
    if (!selections.some((s) => s.scope === scope)) return;
    const res = await setSelection({ scope, kind: "none" });
    if (!res.success) addToast("error", t(entranceErrorKey(res)));
  };

  return (
    <div className="settings-section">
      <h2 className="settings-section-title">{t("title")}</h2>
      <p className="vs-desc" style={{ marginBottom: 16 }}>
        {t("intro")}
      </p>

      {/* 1. Selections */}
      <div className="vs-section">
        <div className="vs-label">{t("selection")}</div>
        <SelectionEditor
          key={`${GLOBAL_SCOPE}:${globalSelection?.updated_at ?? "none"}`}
          scope={GLOBAL_SCOPE}
          title={t("scopeGlobal")}
          selection={globalSelection}
          sounds={sounds}
          listenerVolume={prefs.volume}
        />
        {serverScopes.map((scope) => {
          const sel = selections.find((s) => s.scope === scope);
          return (
            <SelectionEditor
              key={`${scope}:${sel?.updated_at ?? "pending"}`}
              scope={scope}
              title={t("scopeServer", { server: serverName(scope) })}
              selection={sel}
              sounds={sounds}
              listenerVolume={prefs.volume}
              onRemove={() => void removeScope(scope)}
            />
          );
        })}
        {availableServers.length > 0 && (
          <div className="settings-field" style={{ marginBottom: 0 }}>
            <label className="settings-label" htmlFor="entrance-add-server">
              {t("addServerOverride")}
            </label>
            <select
              id="entrance-add-server"
              className="vs-select"
              value={addPick}
              onChange={(e) => {
                const id = e.target.value;
                setAddPick("");
                if (id) setPendingScopes((list) => (list.includes(id) ? list : [...list, id]));
              }}
            >
              <option value="">{t("pickServer")}</option>
              {availableServers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* 2. Library */}
      <div className="vs-section">
        <div className="vs-label">{t("library")}</div>
        <p className="vs-desc" style={{ marginBottom: 12 }}>
          {t("uploadHint", { max: CLIP_MAX_MS / 1000, count: sounds.length, limit: MAX_ENTRANCE_CLIPS })}
        </p>
        <ClipUploader disabled={sounds.length >= MAX_ENTRANCE_CLIPS} />
        {sounds.length === 0 ? (
          <p className="vs-desc">{t("noClips")}</p>
        ) : (
          <div className="emoji-settings-list">
            {sounds.map((sound) => (
              <ClipRow key={sound.id} sound={sound} />
            ))}
          </div>
        )}
      </div>

      {/* 3. Listener */}
      <div className="vs-section">
        <div className="vs-label">{t("listenerTitle")}</div>
        <div className="vs-toggle-row" style={{ marginBottom: 12 }}>
          <div className="vs-desc" id="entrance-listener-enabled-label">
            {t("listenerEnabled")}
          </div>
          <label className="vs-switch">
            <input
              type="checkbox"
              aria-labelledby="entrance-listener-enabled-label"
              checked={prefs.enabled}
              onChange={(e) => update({ enabled: e.target.checked })}
            />
            <span className="vs-switch-slider" />
          </label>
        </div>
        <RangeField
          id="entrance-listener-volume"
          label={t("listenerVolume")}
          value={prefs.volume}
          min={0}
          max={100}
          valueText={`${prefs.volume}%`}
          onChange={(volume) => update({ volume })}
        />
      </div>
    </div>
  );
}

export default EntranceSoundSettings;
