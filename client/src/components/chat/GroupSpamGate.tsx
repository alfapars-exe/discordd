import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useSpamVisibility } from "../../hooks/useSpamVisibility";
import type { GroupDMMessage } from "../../types/groupDM";
import type { MessageAction } from "./messageActionRegistry";
import { focusMessageComposer, runMessageShortcut } from "../../utils/messageShortcuts";
import { useShortcutBindingsStore } from "../../stores/shortcutBindingsStore";
import { useShortcutCaptureStore } from "../../stores/shortcutCaptureStore";
import { useIgnoredMessageVisibility } from "../../hooks/useIgnoredMessage";

export default function GroupSpamGate({ message, children, keyboardActions = [] }: { message: GroupDMMessage; children: ReactNode; keyboardActions?: MessageAction[] }) {
  const { t } = useTranslation("chat");
  const spam = useSpamVisibility({ ...message, content: message.content ?? null }, { kind: "group", channelId: message.group_id });
  const ignored = useIgnoredMessageVisibility(message, `group:${message.group_id}`);
  return <div data-message-shortcuts tabIndex={0} role="group" onKeyDown={(event) => {
    if (event.target !== event.currentTarget || useShortcutCaptureStore.getState().active) return;
    if (event.ctrlKey && event.code === "KeyC" && window.getSelection()?.toString()) return;
    runMessageShortcut(event.nativeEvent, keyboardActions, spam.hidden || ignored.hidden || message.content === null, useShortcutBindingsStore.getState().bindings, () => focusMessageComposer(event.currentTarget));
  }}>{!spam.hidden ? ignored.hidden ? <div role="note"><p>{t("ignoredMessage")}</p><button type="button" onClick={ignored.reveal}>{t("showIgnoredMessage")}</button></div> : children : <div role="note">
    <p>{t("spamHidden")}</p>
    <p>{spam.reasons.map((reason) => t(`spamReason.${reason}`)).join(" · ")}</p>
    <button type="button" onClick={() => void spam.restore()}>{t("spamRestore")}</button>
    {spam.syncError && <p role="alert">{t("spamSyncFailed")} <button type="button" onClick={spam.retry}>{t("spamRetry")}</button></p>}
  </div>}</div>;
}
