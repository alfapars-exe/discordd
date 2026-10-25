import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ElectronRegisteredGame, ElectronRegisteredGamesSnapshot } from "../../types/electron";
import { useConfirm } from "../../hooks/useConfirm";
import { formatDateTime } from "../../utils/dateFormat";
import FeedbackCreateForm from "./FeedbackCreateForm";

type Game = ElectronRegisteredGame;
const invalidName = (name: string) => !name.trim() || name.length > 80 || [...name].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char === "/" || char === "\\");
type Detection = ElectronRegisteredGamesSnapshot["detection"] | "web";

function RegisteredGamesSettings() {
  const { t } = useTranslation("settings");
  const [games, setGames] = useState<Game[]>([]);
  const [detection, setDetection] = useState<Detection>(window.electronAPI ? "unavailable" : "web");
  const [overlaySupport, setOverlaySupport] = useState<NonNullable<ElectronRegisteredGamesSnapshot["overlaySupport"]> | "unknown">("unknown");
  const [backgroundDetectionEnabled, setBackgroundDetectionEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [registryLoaded, setRegistryLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [reportingIssue, setReportingIssue] = useState(false);
  const mounted = useRef(false);
  const busyRef = useRef(false);
  const requestSequence = useRef(0);
  const mutationSequence = useRef(0);
  const confirm = useConfirm();

  const refresh = useCallback(async () => {
    const api = window.electronAPI;
    if (!api?.getRegisteredGames) {
      setDetection("web");
      setLoading(false);
      return;
    }
    if (busyRef.current) return;
    const request = ++requestSequence.current;
    const mutation = mutationSequence.current;
    try {
      const snapshot = await api.getRegisteredGames();
      if (!mounted.current || request !== requestSequence.current || mutation !== mutationSequence.current) return;
      setGames(snapshot.games);
      setDetection(snapshot.detection);
      setOverlaySupport(snapshot.overlaySupport ?? "unknown");
      setBackgroundDetectionEnabled(snapshot.backgroundDetectionEnabled);
      setRegistryLoaded(true);
      setError("");
    } catch {
      if (mounted.current && request === requestSequence.current && mutation === mutationSequence.current) {
        setDetection("unavailable");
        setError(t("registeredGamesLoadError"));
      }
    } finally {
      if (mounted.current && request === requestSequence.current) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    mounted.current = true;
    const initialLoad = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => {
      mounted.current = false;
      window.clearTimeout(initialLoad);
      window.clearInterval(timer);
    };
  }, [refresh]);

  function beginMutation(): boolean {
    if (!mounted.current || busyRef.current || !registryLoaded) return false;
    busyRef.current = true;
    mutationSequence.current += 1;
    requestSequence.current += 1;
    setBusy(true);
    setError("");
    return true;
  }

  function finishMutation(): void {
    busyRef.current = false;
    if (mounted.current) setBusy(false);
  }

  async function addGame() {
    const api = window.electronAPI;
    if (!api?.addRegisteredGame || !beginMutation()) return;
    let shouldRefresh = false;
    try {
      const added = await api.addRegisteredGame();
      if (added && mounted.current) {
        setGames((current) => current.some((item) => item.id === added.id) ? current : [...current, added]);
        shouldRefresh = true;
      }
    } catch {
      if (mounted.current) setError(t("registeredGamesSaveError"));
    } finally {
      finishMutation();
    }
    if (shouldRefresh && mounted.current) void refresh();
  }

  async function removeGame(game: Game) {
    const api = window.electronAPI;
    if (!api?.removeRegisteredGame || busyRef.current) return;
    const accepted = await confirm({ message: t("registeredGamesRemoveConfirm"), danger: true });
    if (!accepted || !beginMutation()) return;
    try {
      const removed = await api.removeRegisteredGame(game.id);
      if (!mounted.current) return;
      if (!removed) throw new Error("registry update rejected");
      setGames((current) => current.filter((item) => item.id !== game.id));
    } catch {
      if (mounted.current) setError(t("registeredGamesSaveError"));
    } finally {
      finishMutation();
    }
  }

  async function setSharing(game: Game, allowed: boolean) {
    const api = window.electronAPI;
    if (!api?.setRegisteredGameSharing || !beginMutation()) return;
    try {
      const updated = await api.setRegisteredGameSharing(game.id, allowed);
      if (!mounted.current) return;
      if (!updated) throw new Error("registry update rejected");
      setGames((current) => current.map((item) => item.id === game.id ? { ...item, shareAllowed: allowed } : item));
    } catch {
      if (mounted.current) setError(t("registeredGamesSaveError"));
    } finally {
      finishMutation();
    }
  }

  async function setGameOverlay(game: Game, allowed: boolean) {
    const api = window.electronAPI;
    if (!api?.setRegisteredGameOverlay || !beginMutation()) return;
    try {
      const updated = await api.setRegisteredGameOverlay(game.id, allowed);
      if (!mounted.current) return;
      if (!updated) throw new Error("game overlay update rejected");
      setGames((current) => current.map((item) => item.id === game.id ? { ...item, overlayAllowed: allowed } : item));
    } catch {
      if (mounted.current) setError(t("registeredGamesSaveError"));
    } finally {
      finishMutation();
    }
  }

  async function setBackgroundDetection(enabled: boolean) {
    const api = window.electronAPI;
    if (!api?.setRegisteredGamesBackgroundDetection || !beginMutation()) return;
    try {
      const updated = await api.setRegisteredGamesBackgroundDetection(enabled);
      if (!mounted.current) return;
      if (!updated) throw new Error("background detection update rejected");
      setBackgroundDetectionEnabled(enabled);
    } catch {
      if (mounted.current) setError(t("registeredGamesSaveError"));
    } finally {
      finishMutation();
    }
  }

  async function saveName() {
    const draft = editing;
    const name = draft?.name.trim();
    const api = window.electronAPI;
    if (!draft || !name || invalidName(draft.name) || !api?.setRegisteredGameName || !beginMutation()) return;
    try {
      if (!await api.setRegisteredGameName(draft.id, name)) throw new Error("game name update rejected");
      if (!mounted.current) return;
      setGames(current => current.map(game => game.id === draft.id ? { ...game, displayName: name } : game));
      setEditing(null);
    } catch {
      if (mounted.current) setError(t("registeredGamesSaveError"));
    } finally { finishMutation(); }
  }

  const currentGames = games.filter((game) => game.availability === "available" && game.running === true);
  const inactiveGames = games.filter((game) => game.availability !== "available" || game.running !== true);
  const recentGames = inactiveGames.filter(game => game.lastSeenAt && Number.isFinite(Date.parse(game.lastSeenAt)))
    .sort((left, right) => Date.parse(right.lastSeenAt!) - Date.parse(left.lastSeenAt!) || left.id.localeCompare(right.id));
  const addedGames = inactiveGames.filter(game => !game.lastSeenAt || !Number.isFinite(Date.parse(game.lastSeenAt)));

  function renderGame(game: Game) {
    return (
      <section className="general-setting-row" key={game.id} aria-label={game.displayName}>
        <div className="general-setting-info">
          <strong className="general-setting-label">{game.displayName}</strong>
          {window.electronAPI?.setRegisteredGameName && (editing?.id === game.id ? <div>
            <label>{t("registeredGamesName")}<input maxLength={80} value={editing.name} disabled={busy} aria-invalid={invalidName(editing.name)} aria-describedby={invalidName(editing.name) ? `game-name-error-${game.id}` : undefined}
              onChange={event => setEditing({ id: game.id, name: event.target.value })} /></label>
            {invalidName(editing.name) && <small id={`game-name-error-${game.id}`}>{t("registeredGamesNameInvalid")}</small>}
            <button type="button" disabled={busy || invalidName(editing.name)} onClick={() => void saveName()}>{t("registeredGamesNameSave")}</button>
            <button type="button" disabled={busy} onClick={() => setEditing(null)}>{t("registeredGamesNameCancel")}</button>
          </div> : <button type="button" disabled={busy} onClick={() => setEditing({ id: game.id, name: game.displayName })}>{t("registeredGamesRename")}</button>)}
          <span className="general-setting-desc">{game.executableName}</span>
          <span className="general-setting-desc">
            {game.availability === "missing"
              ? t("registeredGamesFileMissing")
              : game.availability === "unreadable"
                ? t("registeredGamesFileUnreadable")
                : game.running === true
              ? t("registeredGamesRunning")
              : game.running === false ? t("registeredGamesNotRunning") : t("registeredGamesStatusUnknown")}
            {game.lastSeenAt
              ? ` · ${t("registeredGamesLastSeen", { date: formatDateTime(game.lastSeenAt, { dateStyle: "short", timeStyle: "short" }) })}`
              : ` · ${t("registeredGamesNeverSeen")}`}
          </span>
          {game.availability !== "available" && <span className="general-setting-desc">{t("registeredGamesFileRecovery")}</span>}
          <label>
            <input
              type="checkbox"
              checked={game.shareAllowed}
              disabled={busy}
              onChange={(event) => void setSharing(game, event.currentTarget.checked)}
            />
            {t("registeredGamesShare")}
          </label>
          {window.electronAPI?.setRegisteredGameOverlay && (
            <>
              <label>
                <input
                  type="checkbox"
                  checked={game.overlayAllowed}
                  disabled={busy}
                  onChange={(event) => void setGameOverlay(game, event.currentTarget.checked)}
                />
                {t("registeredGamesOverlayOptIn")}
              </label>
              <span className="general-setting-desc">{t("registeredGamesOverlayDescription")}</span>
            </>
          )}
        </div>
        <button type="button" onClick={() => void removeGame(game)} disabled={busy}>
          {t("registeredGamesRemove")}
        </button>
      </section>
    );
  }

  return (
    <div>
      <h2 className="settings-section-title">{t("registeredGamesTitle")}</h2>
      <p>{t("registeredGamesDescription")}</p>

      {detection === "web" && <p role="status">{t("registeredGamesWebUnsupported")}</p>}
      {detection === "unsupported" && <p role="status">{t("registeredGamesUnsupported")}</p>}
      {detection === "unavailable" && !loading && <p role="status">{t("registeredGamesUnavailable")}</p>}
      {error && <p role="alert">{error}</p>}
      {loading && <p role="status">{t("registeredGamesLoading")}</p>}
      {detection === "unavailable" && !loading && !registryLoaded && <button type="button" onClick={() => void refresh()} disabled={busy}>{t("registeredGamesRetry")}</button>}

      {detection !== "web" && registryLoaded && (
        <>
          <p>{t("registeredGamesShareNotice")}</p>
          <p>{t("registeredGamesReportIssueDescription")}</p>
          <p role="status">{t({
            available: "registeredGamesOverlaySupportAvailable",
            unavailable: "registeredGamesOverlaySupportUnavailable",
            unsupported: "registeredGamesOverlaySupportUnsupported",
            unknown: "registeredGamesOverlaySupportUnknown",
          }[overlaySupport])}</p>
          {!reportingIssue ? (
            <button type="button" className="settings-btn settings-btn-secondary" onClick={() => setReportingIssue(true)}>
              {t("registeredGamesReportIssue")}
            </button>
          ) : (
            <FeedbackCreateForm onSubmitted={() => setReportingIssue(false)} onClose={() => setReportingIssue(false)} />
          )}
          {detection !== "unsupported" && window.electronAPI?.setRegisteredGamesBackgroundDetection && (
            <section className="general-setting-row">
              <label className="general-setting-info">
                <strong className="general-setting-label">{t("registeredGamesBackgroundDetection")}</strong>
                <span className="general-setting-desc">{t("registeredGamesBackgroundDetectionDescription")}</span>
                <input
                  type="checkbox"
                  checked={backgroundDetectionEnabled}
                  disabled={busy || !registryLoaded}
                  onChange={(event) => void setBackgroundDetection(event.currentTarget.checked)}
                />
              </label>
            </section>
          )}
          <button type="button" onClick={() => void refresh()} disabled={busy}>{t("registeredGamesRetry")}</button>
          {detection !== "unsupported" && <button type="button" onClick={() => void addGame()} disabled={busy || loading}>
            {t("registeredGamesAdd")}
          </button>}
          {!games.length && <p>{t("registeredGamesEmpty")}</p>}
          <div className="general-settings-list">
            <div id="registered-games-current" data-settings-section="registered-games-current">
              <h3 className="settings-section-subtitle">{t("registeredGamesCurrent")}</h3>
              {currentGames.length ? currentGames.map(renderGame) : <p>{t("registeredGamesNoCurrent")}</p>}
            </div>
            <div id="registered-games-recent" data-settings-section="registered-games-recent">
              <h3 className="settings-section-subtitle">{t("registeredGamesRecent")}</h3>
              {recentGames.map(renderGame)}
            </div>
            <div>
              <h3 className="settings-section-subtitle">{t("registeredGamesAddedUnseen")}</h3>
              {addedGames.map(renderGame)}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default RegisteredGamesSettings;
