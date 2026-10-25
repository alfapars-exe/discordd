import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useFriendStore } from "../../stores/friendStore";
import { useDMStore } from "../../stores/dmStore";
import { useUIStore } from "../../stores/uiStore";
import { useMobileStore } from "../../stores/mobileStore";
import { useGroupDMStore } from "../../stores/groupDMStore";
import Avatar from "../shared/Avatar";
import type { FriendshipWithUser } from "../../types";

export default function NewConversationModal({ onClose, initialGroupMode = false }: { onClose: () => void; initialGroupMode?: boolean }) {
  const { t } = useTranslation("common");
  const friends = useFriendStore((s) => s.friends);
  const isLoading = useFriendStore((s) => s.isLoading);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [groupMode, setGroupMode] = useState(initialGroupMode);
  const [groupName, setGroupName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const dialog = useRef<HTMLDivElement>(null);
  const alive = useRef(false);
  const opening = useRef(false);
  const search = query.trim().toLocaleLowerCase();
  const visible = friends.filter((friend) => [friend.display_name, friend.username]
    .some((name) => name?.toLocaleLowerCase().includes(search)));

  useEffect(() => {
    alive.current = true;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLInputElement>("input")?.focus();
    return () => { alive.current = false; previous?.focus(); };
  }, []);

  async function openConversation(friend: FriendshipWithUser) {
    if (opening.current) return;
    opening.current = true;
    setPending(friend.user_id);
    setError(false);
    try {
      const channelId = await useDMStore.getState().createOrGetChannel(friend.user_id);
      if (!alive.current) return;
      if (!channelId) { setError(true); return; }
      const dm = useDMStore.getState();
      dm.selectDM(channelId);
      dm.clearDMUnread(channelId);
      void dm.fetchMessages(channelId);
      useUIStore.getState().openTab(channelId, "dm", friend.display_name || friend.username);
      useMobileStore.getState().closeAllDrawers();
      onClose();
    } catch {
      if (alive.current) setError(true);
    } finally {
      opening.current = false;
      if (alive.current) setPending(null);
    }
  }

  async function createGroup() {
    if (opening.current || !groupName.trim() || selected.length === 0) return;
    opening.current = true;
    setError(false);
    const group = await useGroupDMStore.getState().create(groupName.trim(), selected);
    opening.current = false;
    if (!alive.current) return;
    if (!group) { setError(true); return; }
    void useGroupDMStore.getState().fetchMessages(group.id);
    useUIStore.getState().openTab(group.id, "group-dm", group.name);
    useMobileStore.getState().closeAllDrawers();
    onClose();
  }

  return createPortal(
    <div className="new-conversation-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={dialog} className="new-conversation" role="dialog" aria-modal="true" aria-labelledby="new-conversation-title"
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.stopPropagation(); onClose(); }
          if (e.key !== "Tab") return;
          const items = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)');
          if (!items?.length) return;
          const first = items[0], last = items[items.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }}>
        <header><h2 id="new-conversation-title">{t("newConversation")}</h2><button onClick={onClose} aria-label={t("close")}>×</button></header>
        <div className="new-conversation-mode">
          <button type="button" className={!groupMode ? "active" : ""} onClick={() => setGroupMode(false)}>{t("directMessage")}</button>
          <button type="button" className={groupMode ? "active" : ""} onClick={() => setGroupMode(true)}>{t("groupMessage")}</button>
        </div>
        <p>{t(groupMode ? "chooseGroupMembers" : "chooseFriend")}</p>
        {groupMode && <input className="fv-search-input" value={groupName} onChange={(e) => setGroupName(e.target.value)} maxLength={100} placeholder={t("groupName")} aria-label={t("groupName")} />}
        <input className="fv-search-input" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("friendSearchPlaceholder")} aria-label={t("friendSearchPlaceholder")} />
        {error && <p role="alert" className="new-conversation-error">{t("dmOpenFailed")}</p>}
        <div className="new-conversation-list" aria-busy={pending !== null || isLoading}>
          {isLoading && friends.length === 0 ? <p role="status">{t("loading")}</p>
            : visible.length === 0 ? <p role="status">{t(search ? "noResults" : "noFriendsHint")}</p>
            : visible.map((friend) => <button key={friend.user_id} disabled={pending !== null} aria-pressed={groupMode ? selected.includes(friend.user_id) : undefined} onClick={() => {
              if (groupMode) setSelected((ids) => ids.includes(friend.user_id) ? ids.filter((id) => id !== friend.user_id) : ids.length < 9 ? [...ids, friend.user_id] : ids);
              else void openConversation(friend);
            }}>
              <Avatar name={friend.display_name || friend.username} avatarUrl={friend.avatar_url ?? undefined} size={32} />
              <span>{friend.display_name || friend.username}<small>@{friend.username}</small></span>
              {groupMode && <span aria-hidden="true">{selected.includes(friend.user_id) ? "✓" : "+"}</span>}
              {pending === friend.user_id && <small role="status">{t("openingConversation")}</small>}
            </button>)}
        </div>
        {groupMode && <button className="btn-primary" disabled={!groupName.trim() || selected.length === 0} onClick={() => void createGroup()}>{t("createGroup")}</button>}
        <button className="ch-tree-empty-action" onClick={() => {
          useUIStore.getState().openTab("friends", "friends", t("friends"));
          useMobileStore.getState().closeAllDrawers();
          onClose();
        }}>{t("findFriends")}</button>
      </div>
    </div>, document.body
  );
}
