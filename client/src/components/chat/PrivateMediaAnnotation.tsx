import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { deleteMediaLabel, getMediaLabel, setMediaLabel, type MediaLabelReference, type UserMediaLabel } from "../../api/mediaLabels";
import { getAuthGeneration } from "../../api/client";
import { useAuthStore } from "../../stores/authStore";
import { useE2EEStore } from "../../stores/e2eeStore";
import { useLightboxStore } from "../../stores/lightboxStore";
import { invalidateMediaLabels, subscribeMediaLabelChanges } from "../../utils/mediaLabelSync";

export type MediaAnnotationSource = Omit<MediaLabelReference, "fingerprint">;
const labels: UserMediaLabel[] = ["ordinary", "sexual", "disturbing", "both"];

/** The parent keys this component by owner, source, revision and media identity. */
export default function PrivateMediaAnnotation({ source, identity, owner, onVisibilityReset, children }: {
  source: MediaAnnotationSource; identity: string; owner: string;
  onVisibilityReset?: () => void;
  children: (label: UserMediaLabel | undefined, canAnalyze: boolean) => ReactNode;
}) {
  const { t } = useTranslation("chat");
  const [reference, setReference] = useState<MediaLabelReference>();
  const [label, setLabel] = useState<UserMediaLabel>();
  const [version, setVersion] = useState("");
  const [selection, setSelection] = useState<UserMediaLabel | "">("");
  const [status, setStatus] = useState<"loading" | "ready" | "saving" | "error" | "conflict">("loading");
  const draftPending = useRef(false);
  const [retry, setRetry] = useState(0);
  const lifecycle = useRef<{ controller: AbortController; generation: number; deviceId: string | null; saving: boolean } | null>(null);
  const { source_kind, channel_id, message_id, revision } = source;
  useEffect(() => subscribeMediaLabelChanges(owner, { source_kind, channel_id, message_id }, () => {
    onVisibilityReset?.();
    if (useLightboxStore.getState().item?.messageId === message_id) useLightboxStore.getState().close();
    setLabel(undefined);
    // Let an atomic version-checked write finish, including its own socket echo.
    if (lifecycle.current?.saving) return;
    lifecycle.current?.controller.abort();
    if (draftPending.current) { setStatus("conflict"); return; }
    setStatus("loading");
    setRetry((value) => value + 1);
  }), [owner, source_kind, channel_id, message_id, onVisibilityReset]);
  useEffect(() => {
    const controller = new AbortController();
    const generation = getAuthGeneration();
    const deviceId = useE2EEStore.getState().localDeviceId;
    lifecycle.current = { controller, generation, deviceId, saving: false };
    const current = () => !controller.signal.aborted && getAuthGeneration() === generation && useAuthStore.getState().user?.id === owner && useE2EEStore.getState().localDeviceId === deviceId;
    void (async () => {
      try {
        // Hash only the source/media identity locally. Never send URL, content or media bytes.
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([source_kind, channel_id, message_id, revision, identity])));
        if (!current()) return;
        const fingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
        const ref = { source_kind, channel_id, message_id, revision, fingerprint };
        const result = await getMediaLabel(ref, { signal: controller.signal, isCurrent: current });
        if (!current()) return;
        onVisibilityReset?.();
        if (useLightboxStore.getState().item?.messageId === message_id) useLightboxStore.getState().close();
        if (!result.success || !result.data) { setStatus("error"); return; }
        const annotation = result.data.annotation;
        // Do not trust a mismatched or malformed server response to reveal content.
        if (annotation && (Object.entries(ref).some(([key, value]) => annotation[key as keyof MediaLabelReference] !== value) || !labels.includes(annotation.label) || typeof annotation.version !== "string" || !/^(legacy|[a-f0-9]{32})$/.test(annotation.version))) {
          setStatus("error"); return;
        }
        setReference(ref);
        setLabel(annotation?.label);
        setVersion(annotation?.version ?? "");
        draftPending.current = false;
        setSelection(annotation?.label ?? "");
        setStatus("ready");
      } catch {
        if (current()) {
          onVisibilityReset?.();
          if (useLightboxStore.getState().item?.messageId === message_id) useLightboxStore.getState().close();
          setStatus("error");
        }
      }
    })();
    return () => controller.abort();
  }, [owner, source_kind, channel_id, message_id, revision, identity, retry, onVisibilityReset]);

  const save = async () => {
    const active = lifecycle.current;
    if (!reference || !active || active.saving || status !== "ready") return;
    const current = () => !active.controller.signal.aborted && getAuthGeneration() === active.generation && useAuthStore.getState().user?.id === owner && useE2EEStore.getState().localDeviceId === active.deviceId;
    if (!current()) return;
    active.saving = true;
    setStatus("saving");
    try {
      const options = { signal: active.controller.signal, isCurrent: current, expectedVersion:version };
      const result = selection ? await setMediaLabel(reference, selection, options) : await deleteMediaLabel(reference, options);
      if (!current()) return;
      onVisibilityReset?.();
      useLightboxStore.getState().close();
      if (!result.success || !result.data?.success) { setStatus(result.code === "CONFLICT" ? "conflict" : "error"); return; }
      // A detached lightbox must not keep displaying media after reclassification.
      setLabel(selection || undefined);
      setStatus("ready");
      draftPending.current = false;
      active.saving = false;
      // Also synchronize other mounted copies if the owner's socket is offline.
      invalidateMediaLabels(owner, reference);
    } catch { if (current()) { onVisibilityReset?.(); useLightboxStore.getState().close(); setStatus("error"); } }
    finally { active.saving = false; }
  };

  return <div className="private-media-annotation">
    {children(status === "error" || status === "conflict" ? undefined : label, status === "ready" && !label)}
    <details>
      <summary>{t("mediaAnnotationTitle")}</summary>
      <p>{t("mediaAnnotationPrivate")}</p>
      {status === "loading" && <p role="status">{t("mediaAnnotationLoading")}</p>}
      {status === "error" || status === "conflict" ? <div role="alert"><p>{t(status === "conflict" ? "mediaAnnotationConflict" : "mediaAnnotationError")}</p><button type="button" onClick={() => { setLabel(undefined); setStatus("loading"); setRetry((value) => value + 1); }}>{t("mediaAnnotationRetry")}</button></div> : reference && <>
        <label>{t("mediaAnnotationTitle")} <select value={selection} disabled={status !== "ready"} onChange={(event) => { draftPending.current = event.target.value !== (label ?? ""); setSelection(event.target.value as UserMediaLabel | ""); }}>
          <option value="">{t("mediaAnnotationUnset")}</option>
          {labels.map((value) => <option key={value} value={value}>{t(`mediaAnnotation_${value}`)}</option>)}
        </select></label>
        <button type="button" disabled={status !== "ready" || selection === (label ?? "")} onClick={() => void save()}>{t("mediaAnnotationSave")}</button>
        {status === "saving" && <p role="status">{t("mediaAnnotationSaving")}</p>}
      </>}
    </details>
  </div>;
}
