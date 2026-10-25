/**
 * SoundUploadForm — Inline upload form shown inside SoundboardPanel (same popup).
 * Replaces the grid view when adding a new sound. No separate modal.
 */

import { useState, useRef, useCallback, useEffect } from "react";
import EmojiPicker from "../shared/EmojiPicker";
import WaveformTrimmer from "./WaveformTrimmer";
import { useTranslation } from "react-i18next";
import { captureSoundboardScope, isSoundboardScopeCurrent, useSoundboardStore } from "../../stores/soundboardStore";
import type { SoundboardPlayback } from "../../audio/soundboardPlayback";
import { awaitAudioStep } from "../../audio/audioOperation";
import * as soundboardApi from "../../api/soundboard";
import { audioBufferToWav, renderClipToWav } from "../../utils/wavEncode";

type Props = {
  onClose: () => void;
};

const MAX_DURATION_MS = 7000;
const ACCEPTED_TYPES =
  "audio/mpeg,audio/ogg,audio/wav,audio/webm,audio/mp4,audio/x-m4a,audio/aac,.m4a,video/mp4,.mp4";

function isVideoFile(file: File): boolean {
  return file.type === "video/mp4" || (file.name.toLowerCase().endsWith(".mp4") && !file.type.startsWith("audio/"));
}

async function extractAudioFromVideo(file: File): Promise<File> {
  const arrayBuffer = await file.arrayBuffer();
  const audioCtx = new AudioContext();
  try {
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    const wavBlob = audioBufferToWav(audioBuffer);
    const baseName = file.name.replace(/\.[^.]+$/, "");
    return new File([wavBlob], `${baseName}.wav`, { type: "audio/wav" });
  } finally {
    await audioCtx.close();
  }
}

function SoundUploadForm({ onClose }: Props) {
  const { t } = useTranslation("soundboard");
  const [scope] = useState(captureSoundboardScope);
  const playbackError = useSoundboardStore(state => state.error);
  const alive = useRef(true);
  const pending = useRef(false);
  const clipVersion = useRef(0);
  const fileVersion = useRef(0);
  const clipCache = useRef<{ file: File; start: number; end: number; blob: Blob; url: string; durationMs: number } | null>(null);
  const current = () => alive.current && !!scope && isSoundboardScopeCurrent(scope);

  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("");
  const [totalDurationMs, setTotalDurationMs] = useState(0);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const [isPreparingPreview, setIsPreparingPreview] = useState(false);
  const [error, setError] = useState("");
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isConverting, setIsConverting] = useState(false);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<SoundboardPlayback | null>(null);
  const metaAudioRef = useRef<HTMLAudioElement | null>(null);


  const trimmedDurationMs = trimEnd - trimStart;
  const durationError = trimmedDurationMs > MAX_DURATION_MS;
  const canSubmit = !!file && name.trim().length > 0 && !durationError && trimmedDurationMs > 0 && !isUploading && !isConverting && !isPreparingPreview;

  useEffect(() => {
    alive.current = true;
    const version = clipVersion, clips = clipCache, playback = audioRef, metadata = metaAudioRef;
    return () => { alive.current = false; version.current++; playback.current?.stop(); if (clips.current) URL.revokeObjectURL(clips.current.url); metadata.current?.pause(); };
  }, []);
  useEffect(() => () => { if (objectUrl) URL.revokeObjectURL(objectUrl); }, [objectUrl]);
  function invalidateClip() { clipVersion.current++; audioRef.current?.stop(); audioRef.current = null; setIsPlaying(false); if (clipCache.current) URL.revokeObjectURL(clipCache.current.url); clipCache.current = null; }
  async function buildClip() {
    if (!file || !current()) throw new DOMException("Obsolete soundboard draft", "AbortError");
    const cached = clipCache.current;
    if (cached?.file === file && cached.start === trimStart && cached.end === trimEnd) return cached;
    const version = clipVersion.current;
    const blob = await awaitAudioStep(renderClipToWav(file, trimStart, trimEnd), "Soundboard trim");
    if (!current() || clipVersion.current !== version) throw new DOMException("Obsolete soundboard draft", "AbortError");
    const bytes = await blob.arrayBuffer();
    if (!current() || clipVersion.current !== version) throw new DOMException("Obsolete soundboard draft", "AbortError");
    const header = new DataView(bytes);
    const durationMs = Math.round(header.getUint32(40, true) / header.getUint16(32, true) / header.getUint32(24, true) * 1000);
    if (!durationMs || durationMs > MAX_DURATION_MS) throw new Error("invalid trimmed duration");
    const result = { file, start: trimStart, end: trimEnd, blob, durationMs, url: URL.createObjectURL(blob) };
    clipCache.current = result; return result;
  }

  const loadAudioMeta = useCallback((audioFile: File, version: number) => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    const url = URL.createObjectURL(audioFile);
    setObjectUrl(url);

    metaAudioRef.current?.pause();
    const audio = new Audio(url);
    metaAudioRef.current = audio;
    audio.addEventListener("loadedmetadata", () => {
      if (!alive.current || !scope || !isSoundboardScopeCurrent(scope) || fileVersion.current !== version || metaAudioRef.current !== audio) return;
      const ms = Math.round(audio.duration * 1000);
      if (!Number.isFinite(ms) || ms <= 0) { setError(t("readError")); return; }
      setTotalDurationMs(ms);
      setTrimStart(0);
      setTrimEnd(Math.min(ms, MAX_DURATION_MS));
    });
    audio.addEventListener("error", () => { if (alive.current && scope && isSoundboardScopeCurrent(scope) && fileVersion.current === version && metaAudioRef.current === audio) setError(t("readError")); });
  }, [objectUrl, scope, t]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (!selected || pending.current || !current()) return;
    invalidateClip();
    const version = ++fileVersion.current;
    const selectedCurrent = () => current() && fileVersion.current === version;
    metaAudioRef.current?.pause();
    metaAudioRef.current = null;
    setFile(null);
    setTotalDurationMs(0);
    setTrimStart(0);
    setTrimEnd(0);
    setIsConverting(false);
    setError("");

    if (!name) {
      setName(selected.name.replace(/\.[^.]+$/, ""));
    }

    if (isVideoFile(selected)) {
      setIsConverting(true);
      try {
        const wavFile = await extractAudioFromVideo(selected);
        if (!selectedCurrent()) return;
        setFile(wavFile);
        loadAudioMeta(wavFile, version);
      } catch {
        if (selectedCurrent()) setError(t("videoConvertError"));
      } finally {
        if (selectedCurrent()) setIsConverting(false);
      }
    } else {
      setFile(selected);
      loadAudioMeta(selected, version);
    }
  };

  const handlePreview = async () => {
    if (isPlaying && audioRef.current) { audioRef.current.stop(); audioRef.current = null; setIsPlaying(false); return; }
    if (pending.current || !file || !current()) return;
    pending.current = true; setIsPreparingPreview(true); setError("");
    try {
      const clip = await buildClip(); if (!current()) return;
      const player = useSoundboardStore.getState().previewSound(clip.url, 0, clip.durationMs, () => { if (alive.current) setIsPlaying(false); });
      audioRef.current = player;
      if (!player) { setError(t("previewUnavailable")); return; }
      await player.ready;
      if (current() && player.isActive() && audioRef.current === player) setIsPlaying(true);
    } catch (failure) { if (current() && (failure as { name?: string }).name !== "AbortError") setError(t("playbackFailed")); }
    finally { pending.current = false; if (current()) setIsPreparingPreview(false); }
  };

  const handleSubmit = async () => {
    if (!file || !scope || !canSubmit || pending.current || !current()) return;
    pending.current = true; setIsUploading(true); setShowEmojiPicker(false); setError("");
    try {
      const clip = await buildClip(); if (!current()) return;
      const upload = new File([clip.blob], `${file.name.replace(/\.[^.]+$/, "")}.wav`, { type: "audio/wav" });
      const res = await soundboardApi.createSound(scope.serverId, upload, name.trim(), clip.durationMs, emoji.trim() || undefined, current);
      if (!current()) return;
      if (res.success) { if (res.data) useSoundboardStore.getState().handleSoundCreate(res.data); onClose(); }
      else setError(res.error ?? t("uploadFailed"));
    } catch { if (current()) setError(t("uploadFailed")); }
    finally { pending.current = false; if (current()) setIsUploading(false); }
  };

  return (
    <div className="sb-upload-view">
      <div className="sb-header">
        <button className="sb-back-btn" onClick={onClose}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" />
          </svg>
        </button>
        <span className="sb-title">{t("uploadSound")}</span>
      </div>

      <div className="sb-upload-body">
        {playbackError && <p role="alert" className="sb-error">{t(playbackError)}</p>}
        <input ref={fileRef} type="file" accept={ACCEPTED_TYPES} onChange={handleFileChange} disabled={isPreparingPreview || isUploading} className="sb-file-input" />
        <button className="sb-file-btn" onClick={() => fileRef.current?.click()} disabled={isPreparingPreview || isUploading}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z" />
          </svg>
          {isConverting ? t("converting") : file ? t("changeFile") : t("selectFile")}
        </button>
        <span className="sb-format-hint">{t("supportedFormats")}</span>

        {file && totalDurationMs > 0 && objectUrl && (
          <WaveformTrimmer
            fileUrl={objectUrl}
            totalDurationMs={totalDurationMs}
            maxDurationMs={MAX_DURATION_MS}
            trimStart={trimStart}
            trimEnd={trimEnd}
            onTrimChange={(s, e) => { if (!pending.current) { invalidateClip(); setTrimStart(s); setTrimEnd(e); } }}
            isPlaying={isPlaying}
            onTogglePlay={() => void handlePreview()}
          />
        )}

        <label className="sb-label">{t("soundName")}</label>
        <input
          type="text"
          className="sb-input"
          placeholder={t("soundNamePlaceholder")}
          value={name}
          onChange={(e) => { if (!pending.current) setName(e.target.value); }}
          disabled={isUploading || isPreparingPreview}
          maxLength={32}
        />

        <label className="sb-label">{t("emoji")}</label>
        <div className="sb-emoji-row">
          <button type="button" className="sb-emoji-btn" disabled={isUploading || isPreparingPreview} onClick={() => { if (!pending.current) setShowEmojiPicker((v) => !v); }}>
            {emoji || t("emojiPlaceholder")}
          </button>
          {emoji && (
            <button type="button" className="sb-emoji-clear" disabled={isUploading || isPreparingPreview} onClick={() => { if (!pending.current) setEmoji(""); }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18.3 5.7a1 1 0 0 0-1.4 0L12 10.6 7.1 5.7a1 1 0 0 0-1.4 1.4L10.6 12l-4.9 4.9a1 1 0 1 0 1.4 1.4L12 13.4l4.9 4.9a1 1 0 0 0 1.4-1.4L13.4 12l4.9-4.9a1 1 0 0 0 0-1.4z" />
              </svg>
            </button>
          )}
          {showEmojiPicker && (
            <EmojiPicker
              onSelect={(native) => { if (!pending.current) { setEmoji(native); setShowEmojiPicker(false); } }}
              onClose={() => setShowEmojiPicker(false)}
            />
          )}
        </div>

        {error && <p className="sb-error">{error}</p>}
      </div>

      <div className="sb-upload-footer">
        <button className="sb-cancel-btn" onClick={onClose}>{t("cancel")}</button>
        <button className="sb-submit-btn" onClick={handleSubmit} disabled={!canSubmit}>
          {isUploading ? t("uploading") : t("upload")}
        </button>
      </div>
    </div>
  );
}

export default SoundUploadForm;
