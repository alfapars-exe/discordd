import { useRef, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { useVoiceStore } from "../../stores/voiceStore";
import { captureMusicScope } from "../../api/musicProtocol";
import { useMusicSlashCommand } from "../../hooks/useMusicSlashCommand";
import type { ContextMenuState } from "../../hooks/useContextMenu";
import ContextMenu from "../shared/ContextMenu";
import Modal from "../shared/Modal";

type Props = { serverId: string; channelId: string };
export default function MusicBotParticipant({ serverId, channelId }: Props) {
  const { t } = useTranslation("music");
  const state = useVoiceStore(s => s.musicBotStates[channelId]);
  const volume = useVoiceStore(s => s.userVolumes[`__music_bot__:${channelId}`] ?? 100);
  const execute = useMusicSlashCommand();
  const [menu, setMenu] = useState<ContextMenuState>({ isOpen: false, x: 0, y: 0, items: [] });
  const [playScope, setPlayScope] = useState<ReturnType<typeof captureMusicScope> | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [menuCurrent, setMenuCurrent] = useState<(() => boolean) | null>(null);
  const close = () => setMenu(m => ({ ...m, isOpen: false }));
  const run = async (command: string, current: () => boolean) => {
    if (running.current || !current()) return;
    running.current = true; setBusy(true);
    try { await execute(command); }
    finally { running.current = false; setBusy(false); }
  };
  const open = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault(); event.stopPropagation();
    const scope = captureMusicScope(serverId, channelId);
    const session = state?.session_id;
    const current = () => scope.current() && useVoiceStore.getState().musicBotStates[channelId]?.session_id === session;
    if (!current()) return;
    setMenuCurrent(() => current);
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu({ isOpen: true, x: event.clientX || rect.right, y: event.clientY || rect.top, items: [
      { label: t("playSong"), disabled: busy, onClick: () => { if (current()) { setQuery(""); setPlayScope({ ...scope, current }); } } },
      { label: t(state?.is_paused ? "resume" : "pause"), disabled: busy || !state?.current_track, onClick: () => { void run(state?.is_paused ? "/resume" : "/pause", current); } },
      { label: t("playNext"), disabled: busy || !state?.current_track, onClick: () => { void run("/skip", current); } },
      { label: `${t("personalVolume")} (${volume}%)`, onClick: () => {}, children: [0,25,50,75,100,150,200].map(value => ({ label: `${value}%`, onClick: () => { if (current()) useVoiceStore.getState().setUserVolume(`__music_bot__:${channelId}`, value); } })) },
      { label: t("stop"), separator: true, danger: true, disabled: busy, onClick: () => { void run("/stop", current); } },
    ] });
  };
  if (!state?.is_active || state.server_id !== serverId) return null;
  return <>
    <div className="ch-tree-voice-users">
      <button type="button" className="ch-tree-voice-user music-bot-participant" aria-label={t("botControls")} aria-haspopup="menu" onContextMenu={open} onClick={open}>
        <span className="music-bot-avatar" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M9 18V5l11-2v13M9 8l11-2"/><ellipse cx="6" cy="18" rx="3" ry="2"/><ellipse cx="17" cy="16" rx="3" ry="2"/></svg></span>
        <span className="ch-tree-vu-name">MusicBot</span><span className="music-bot-badge">BOT</span>
      </button>
    </div>
    <ContextMenu state={{ ...menu, isOpen: menu.isOpen && !!menuCurrent?.() }} onClose={close}/>
    <Modal isOpen={!!playScope?.current()} onClose={() => setPlayScope(null)} title={t("playSong")}>
      <form className="music-bot-play-form" onSubmit={event => { event.preventDefault(); if (!query.trim() || !playScope?.current()) return; const scope=playScope; setPlayScope(null); void run(`/play ${query.trim()}`,scope.current); }}>
        <label htmlFor={`bot-query-${channelId}`}>{t("songQuery")}</label>
        <input autoFocus id={`bot-query-${channelId}`} value={query} onChange={event => setQuery(event.target.value)} placeholder={t("searchPlaceholder")} maxLength={2048}/>
        <button type="submit" className="btn-primary" disabled={busy || !query.trim()}>{t("playSong")}</button>
      </form>
    </Modal>
  </>;
}
