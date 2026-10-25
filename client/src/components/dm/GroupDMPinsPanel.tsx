import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getAuthSessionSnapshot } from "../../api/authSessionEvents";
import { listPinnedGroupDMMessages, unpinGroupDMMessage } from "../../api/groupDM";
import { decryptGroupDMMessages } from "../../crypto/dmEncryption";
import { useAuthStore } from "../../stores/authStore";
import { useE2EEStore } from "../../stores/e2eeStore";
import { useGroupDMStore } from "../../stores/groupDMStore";
import type { GroupDMMessage } from "../../types/groupDM";
import { captureGroupDMPinScope, GROUP_DM_PINS_CHANGED, type GroupDMPinsChangedDetail } from "../../utils/groupDMPins";
import { formatDateTime } from "../../utils/dateFormat";
import GroupSpamGate from "../chat/GroupSpamGate";
import GroupDMMessageBody from "./GroupDMMessageBody";
import EncryptedAttachment from "../chat/EncryptedAttachment";
import UnclassifiedMediaGate from "../chat/UnclassifiedMediaGate";
import { groupAttachmentKey } from "../../utils/groupAttachmentKeys";

type PinState = { key: string; messages: GroupDMMessage[]; error: boolean };

export default function GroupDMPinsPanel({ groupId, onClose }: { groupId: string; onClose: () => void }) {
  const { t } = useTranslation("chat");
  const owner = useAuthStore((state) => state.user?.id);
  const generation = useAuthStore(() => getAuthSessionSnapshot().generation);
  const device = useE2EEStore((state) => state.localDeviceId);
  const cryptoStatus = useE2EEStore((state) => state.initStatus);
  const groups = useGroupDMStore((state) => state.groups);
  const groupsReady = useGroupDMStore((state) => state.groupsReady);
  const storeOwner = useGroupDMStore((state) => state.ownerId);
  const storeGeneration = useGroupDMStore((state) => state.authGeneration);
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<PinState | null>(null);
  const [mutation, setMutation] = useState<{ key: string; id: string; failed: boolean } | null>(null);
  const scope = captureGroupDMPinScope(groupId);
  const requestKey = scope ? `${scope.key}:${reload}` : null;
  const liveRequestKey = useRef<string | null>(null);
  useLayoutEffect(() => {
    liveRequestKey.current = requestKey;
    return () => { if (liveRequestKey.current === requestKey) liveRequestKey.current = null; };
  }, [requestKey]);
  const group = groups.find((entry) => entry.id === groupId);
  const eligible = !!scope;

  useEffect(() => {
    const captured = captureGroupDMPinScope(groupId);
    if (!captured) return;
    const listener = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail = event.detail as GroupDMPinsChangedDetail | undefined;
      if (captured.isCurrent() && detail?.groupId === groupId && detail.scopeKey === captured.key) setReload((value) => value + 1);
    };
    window.addEventListener(GROUP_DM_PINS_CHANGED, listener);
    return () => window.removeEventListener(GROUP_DM_PINS_CHANGED, listener);
  }, [groupId, owner, generation, device, cryptoStatus, groupsReady, storeOwner, storeGeneration, group?.key_epoch]);

  useEffect(() => {
    const captured = captureGroupDMPinScope(groupId);
    if (!captured || !requestKey) return;
    const controller = new AbortController();
    let active = true;
    const current = () => active && !controller.signal.aborted && captured.isCurrent();
    void (async () => {
      try {
        const result = await listPinnedGroupDMMessages(groupId, { expectedUserId: captured.owner, isCurrent: current, signal: controller.signal });
        if (!current()) return;
        if (!result.success || !Array.isArray(result.data?.messages)) throw new Error("pins_unavailable");
        const messages = result.data.messages;
        if (messages.some((message) => message.group_id !== groupId || !message.id)) throw new Error("pins_invalid");
        const decrypted = await decryptGroupDMMessages(messages, current);
        if (!current()) return;
        setState({ key: requestKey, messages: decrypted.filter((message) => message.group_id === groupId), error: false });
      } catch {
        if (current()) setState({ key: requestKey, messages: [], error: true });
      }
    })();
    return () => { active = false; controller.abort(); };
  }, [groupId, requestKey, owner, generation, device, cryptoStatus, groupsReady, storeOwner, storeGeneration]);

  const unpin = async (messageId: string) => {
    const captured = captureGroupDMPinScope(groupId);
    if (!captured || !requestKey || mutation?.key === requestKey && !mutation.failed) return;
    const key = requestKey;
    const current = () => liveRequestKey.current === key && captured.isCurrent();
    setMutation({ key, id: messageId, failed: false });
    try {
      const result = await unpinGroupDMMessage(groupId, messageId, { expectedUserId: captured.owner, isCurrent: current });
      if (!current()) return;
      if (!result.success || result.data?.status !== "unpinned") throw new Error("unpin_failed");
      setState((previous) => previous?.key === key ? { ...previous, messages: previous.messages.filter((message) => message.id !== messageId) } : previous);
      setMutation(null);
    } catch {
      if (current()) setMutation({ key, id: messageId, failed: true });
    }
  };
  const visible = eligible && state?.key === requestKey ? state : null;
  const pending = mutation?.key === requestKey && !mutation.failed;
  return <aside className="pinned-panel" aria-label={t("pinnedMessages")}>
    <header className="pinned-header"><span>{t("pinnedMessages")}</span><button type="button" onClick={onClose} aria-label={t("common:close")}>×</button></header>
    <div className="pinned-list">
      {!eligible ? <p role="note">{t("common:shortcutUnavailableHere")}</p> : !visible ? <p role="status">{t("common:loading")}</p> : visible.error ? <div role="alert"><p>{t("groupPinsLoadFailed")}</p><button type="button" onClick={() => setReload((value) => value + 1)}>{t("groupPinsRetry")}</button></div> : visible.messages.length === 0 ? <p className="pinned-empty">{t("noPinnedMessages")}</p> : visible.messages.map((message) => <article className="pinned-item" key={message.id}>
        <time>{formatDateTime(message.created_at)}</time>
        <GroupSpamGate message={message}>
          <GroupDMMessageBody message={message} members={group?.members ?? []} />
          {(message.attachments ?? []).map((attachment, index) => {
            const meta = groupAttachmentKey(message.e2ee_file_keys, attachment, index);
            if (!meta) return <p role="note" key={attachment.id}>{t("common:encryptedMessageUnavailable")}</p>;
            const author = message.user ?? group?.members.find((member) => member.id === message.user_id);
            const content = <EncryptedAttachment attachment={attachment} fileMeta={meta} authorName={author?.display_name || author?.username} createdAt={message.created_at} messageId={message.id} />;
            return /^(image|video)\//.test(meta.mimeType)
              ? <UnclassifiedMediaGate key={attachment.id} privateConversation sourceKind="group" sourceChannelId={groupId} messageId={message.id} revision={message.edited_at ?? "original"} authorId={message.user_id} identity={`${groupId}:${message.id}:${attachment.id}:pin`} mediaInputs={[{ url: attachment.file_url, mimeType: meta.mimeType, fileMeta: meta }]}>{content}</UnclassifiedMediaGate>
              : <span key={attachment.id}>{content}</span>;
          })}
        </GroupSpamGate>
        <button type="button" disabled={!!pending} onClick={() => void unpin(message.id)}>{t("unpinMessage")}</button>
        {mutation?.key === requestKey && mutation.id === message.id && mutation.failed && <div role="alert">{t("groupPinUpdateFailed")} <button type="button" onClick={() => void unpin(message.id)}>{t("groupPinsRetry")}</button></div>}
      </article>)}
    </div>
  </aside>;
}
