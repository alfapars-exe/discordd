import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { getAuthSessionSnapshot, subscribeAuthGenerationChanges, subscribeAuthOwnerChanges } from "../../api/authSessionEvents";
import { useAuthStore } from "../../stores/authStore";
import { useE2EEStore } from "../../stores/e2eeStore";
import { useToastStore } from "../../stores/toastStore";

function subscribeAuthSession(listener: () => void): () => void {
  const unsubscribeOwner = subscribeAuthOwnerChanges(listener);
  const unsubscribeGeneration = subscribeAuthGenerationChanges(listener);
  return () => { unsubscribeOwner(); unsubscribeGeneration(); };
}

function authSessionKey(): string {
  const snapshot = getAuthSessionSnapshot();
  return `${snapshot.ownerId ?? ""}:${snapshot.generation}`;
}

/** Keying by auth and archive identity remounts local consent on either change. */
export default function LegacyKeyRecoveryPrompt() {
  const sessionKey = useSyncExternalStore(subscribeAuthSession, authSessionKey, authSessionKey);
  const initStatus = useE2EEStore((s) => s.initStatus);
  const archive = useE2EEStore((s) => s.legacyArchive);
  if (initStatus !== "legacy-recovery") return null;
  const archiveKey = archive?.status === "eligible"
    ? `${archive.status}:${archive.identityFingerprint}`
    : archive?.status ?? "none";
  return <LegacyKeyRecoveryDialog key={`${sessionKey}:${archiveKey}`} sessionKey={sessionKey} />;
}

/** Blocking, explicit choice for legacy key archives; it intentionally has no dismiss path. */
function LegacyKeyRecoveryDialog({ sessionKey }: { sessionKey: string }) {
  const { t } = useTranslation("e2ee");
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const capturedAuth = useRef(getAuthSessionSnapshot()).current;
  const initStatus = useE2EEStore((s) => s.initStatus);
  const initError = useE2EEStore((s) => s.initError);
  const archive = useE2EEStore((s) => s.legacyArchive);
  const initialize = useE2EEStore((s) => s.initialize);
  const resolveLegacyArchive = useE2EEStore((s) => s.resolveLegacyArchive);
  const addToast = useToastStore((s) => s.addToast);
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirmFresh, setConfirmFresh] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const mountedRef = useRef(false);
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    mountedRef.current = true;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const controls = () => Array.from(dialog?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])") ?? []);
    controls()[0]?.focus();
    function containFocus(event: FocusEvent) {
      if (!dialog?.contains(event.target as Node)) controls()[0]?.focus();
    }
    function trapKeyboard(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.key !== "Tab") return;
      const items = controls();
      const first = items[0];
      const last = items.at(-1);
      if (event.shiftKey && (document.activeElement === first || !dialog?.contains(document.activeElement))) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog?.contains(document.activeElement))) {
        event.preventDefault();
        first?.focus();
      }
    }
    document.addEventListener("focusin", containFocus);
    document.addEventListener("keydown", trapKeyboard, true);
    return () => {
      mountedRef.current = false;
      document.removeEventListener("focusin", containFocus);
      document.removeEventListener("keydown", trapKeyboard, true);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);

  const isCurrentScope = () => {
    const current = getAuthSessionSnapshot();
    return mountedRef.current && authSessionKey() === sessionKey &&
      current.ownerId === capturedAuth.ownerId && current.generation === capturedAuth.generation &&
      current.ownerId === userId;
  };

  if (initStatus !== "legacy-recovery") return null;

  async function resolve(choice: "import" | "fresh") {
    if (pendingRef.current || !isCurrentScope() || (choice === "import" && (!acknowledged || archive?.status !== "eligible"))) return;
    pendingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const success = await resolveLegacyArchive(choice);
      if (!isCurrentScope()) return;
      if (success) {
        addToast("success", t(choice === "import" ? "legacyRecoverySuccessImport" : "legacyRecoverySuccessFresh"));
      } else {
        setError(t(choice === "import" ? "legacyRecoveryImportFailed" : "legacyRecoveryFreshFailed"));
      }
    } catch {
      if (!isCurrentScope()) return;
      setError(t(choice === "import" ? "legacyRecoveryImportFailed" : "legacyRecoveryFreshFailed"));
    } finally {
      pendingRef.current = false;
      if (isCurrentScope()) {
        setBusy(false);
        setConfirmFresh(false);
      }
    }
  }

  async function retry() {
    if (!userId || pendingRef.current || !isCurrentScope()) return;
    pendingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await initialize(userId);
      if (!isCurrentScope()) return;
      if (useE2EEStore.getState().initError) setError(t("legacyRecoveryRetryFailed"));
    } catch {
      if (!isCurrentScope()) return;
      setError(t("legacyRecoveryRetryFailed"));
    } finally {
      pendingRef.current = false;
      if (isCurrentScope()) setBusy(false);
    }
  }

  const statusCopy = archive?.status === "eligible"
    ? "legacyRecoveryEligible"
    : archive?.status === "foreign"
      ? "legacyRecoveryForeign"
      : archive?.status === "unverified"
        ? "legacyRecoveryUnverified"
        : "legacyRecoveryNone";
  const visibleError = error ?? (initError ? t("legacyRecoveryRetryFailed") : null);

  return (
    <div className="modal-backdrop" data-testid="legacy-key-recovery-backdrop">
      <section
        ref={dialogRef}
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="legacy-key-recovery-title"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); }
        }}
      >
        <header className="modal-header">
          <h2 id="legacy-key-recovery-title" className="modal-title">{t("legacyRecoveryTitle")}</h2>
        </header>
        <p className="e2ee-setup-description">{t("legacyRecoveryDescription")}</p>
        <div className="e2ee-setup-hint" role="status">{t(statusCopy)}</div>
        <p className="e2ee-setup-description">{t("legacyRecoveryPreservedNotice")}</p>

        {archive?.status === "eligible" && (
          <>
            <p className="e2ee-setup-hint">
              {t("legacyRecoveryFingerprint", { fingerprint: archive.identityFingerprint })}
            </p>
            <p className="e2ee-setup-description">{t("legacyRecoveryIdentityProofLimit")}</p>
            <label className="e2ee-setup-description" style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
              <input
                type="checkbox"
                checked={acknowledged}
                disabled={busy}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              <span>{t("legacyRecoveryOwnershipAck")}</span>
            </label>
          </>
        )}

        {confirmFresh ? (
          <div role="group" aria-label={t("legacyRecoveryFreshConfirmTitle")}>
            <p className="e2ee-setup-hint">{t("legacyRecoveryFreshWarning")}</p>
            <div className="e2ee-setup-actions">
              <button className="settings-btn e2ee-setup-btn-primary" disabled={busy} onClick={() => void resolve("fresh")}>
                {busy ? t("legacyRecoveryWorking") : t("legacyRecoveryFreshConfirm")}
              </button>
              <button className="settings-btn e2ee-setup-btn-secondary" disabled={busy} onClick={() => setConfirmFresh(false)}>
                {t("setupBackToChoice")}
              </button>
            </div>
          </div>
        ) : (
          <div className="e2ee-setup-actions">
            {archive?.status === "eligible" && (
              <button className="settings-btn e2ee-setup-btn-primary" disabled={!acknowledged || busy} onClick={() => void resolve("import")}>
                {busy ? t("legacyRecoveryWorking") : t("legacyRecoveryImport")}
              </button>
            )}
            {archive?.status !== "eligible" && (
              <button className="settings-btn e2ee-setup-btn-secondary" disabled={busy} onClick={() => void retry()}>
                {busy ? t("legacyRecoveryWorking") : t("legacyRecoveryRetry")}
              </button>
            )}
            <button className="settings-btn settings-btn-secondary" disabled={busy} onClick={() => setConfirmFresh(true)}>
              {t("legacyRecoveryFresh")}
            </button>
          </div>
        )}
        {visibleError && <p role="alert" className="e2ee-setup-hint">{visibleError}</p>}
      </section>
    </div>
  );
}
