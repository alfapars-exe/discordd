import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { parseCS2SteamInvite } from "../../../../electron/cs2-join-contract";
import { useGameJoinStore } from "../../stores/gameJoinStore";

/** An explicit short-lived invitation; Steam identity and lobby access remain Steam's responsibility. */
export default function CS2JoinOfferPanel({ gameId, eligible }: { gameId: string; eligible: boolean }) {
  const { t } = useTranslation("settings");
  const [invite, setInvite] = useState("");
  const [error, setError] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const pending = useGameJoinStore(s => s.pendingId);
  const state = useGameJoinStore(s => s.state);
  const sourceGameId = useGameJoinStore(s => s.sourceGameId);
  const connected = useGameJoinStore(s => s.sendWS !== null);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1_000); return () => window.clearInterval(timer); }, []);
  const active = sourceGameId === gameId && eligible && state?.accepted === true && !!state.expires_at && Date.parse(state.expires_at) > now;
  function send(stop: boolean) {
    const recipe = stop ? null : parseCS2SteamInvite(invite);
    if ((!stop && !recipe) || !useGameJoinStore.getState().offer(gameId, recipe)) { setError(true); return; }
    setError(false);
  }
  return <section className="settings-field" aria-label={t("cs2OfferTitle")}>
    <h3>{t("cs2OfferTitle")}</h3><p className="settings-hint">{t("cs2OfferHint")}</p>
    <label>{t("cs2OfferLink")}<input className="settings-input" type="text" value={invite} maxLength={64} autoComplete="off"
      onChange={event => setInvite(event.currentTarget.value)} disabled={!eligible || !!pending} /></label>
    <button type="button" disabled={!eligible || !connected || !!pending} onClick={() => send(false)}>{t(active ? "cs2OfferRenew" : "cs2OfferShare")}</button>
    <button type="button" disabled={!connected || !!pending} onClick={() => send(true)}>{t("cs2OfferStop")}</button>
    {pending && <p role="status">{t("cs2OfferPending")}</p>}
    {active && <p role="status">{t("cs2OfferActive", { seconds: Math.ceil((Date.parse(state!.expires_at!) - now) / 1000) })}</p>}
    {(error || state?.accepted === false) && <p role="alert">{t("cs2OfferError")}</p>}
  </section>;
}
