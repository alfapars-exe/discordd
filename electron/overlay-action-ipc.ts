import type { BrowserWindow, IpcMain } from "electron";

type OverlayActionOperations = Pick<typeof import("./voice-overlay"), "takeVoiceOverlayAction" | "takeVoiceOverlayOpenInboxIntent" | "confirmVoiceOverlayOpenInbox" | "takeVoiceOverlayNotificationReplyIntent" | "confirmVoiceOverlayNotificationReply" | "takeVoiceOverlayOpenChatIntent" | "confirmVoiceOverlayOpenChat" | "takeVoiceOverlayOpenChatComposerIntent" | "sendOverlayChatMessage" | "closeOverlayChatComposer" | "resolveOverlayChatSend"> & {
  getMainWindow: () => BrowserWindow | null;
};

/** Keep authorization/session decisions in their owners and route only accepted intents. */
export function registerOverlayActionIPC(ipc: Pick<IpcMain, "handle">, operations: OverlayActionOperations): void {
  const { takeVoiceOverlayAction, takeVoiceOverlayOpenInboxIntent, confirmVoiceOverlayOpenInbox, takeVoiceOverlayNotificationReplyIntent, confirmVoiceOverlayNotificationReply, takeVoiceOverlayOpenChatIntent, confirmVoiceOverlayOpenChat, takeVoiceOverlayOpenChatComposerIntent, sendOverlayChatMessage, closeOverlayChatComposer, resolveOverlayChatSend, getMainWindow } = operations;
  ipc.handle("overlay-voice-action", (event, action: unknown, session: unknown) => {
    const request = takeVoiceOverlayAction(event, action, session);
    const main = getMainWindow();
    if (!request || !main || main.isDestroyed()) return false;
    main.webContents.send("overlay-voice-action", request);
    return true;
  });
  ipc.handle("overlay-open-inbox", (event, session: unknown) => {
    const request = takeVoiceOverlayOpenInboxIntent(event, session);
    const main = getMainWindow();
    if (!request || !main || main.isDestroyed()) return false;
    main.webContents.send("overlay-open-inbox", request);
    return true;
  });
  ipc.handle("confirm-overlay-open-inbox", (event, session: unknown) => {
    return confirmVoiceOverlayOpenInbox(event, session, getMainWindow());
  });
  ipc.handle("overlay-prepare-notification-reply", (event, raw: unknown) => {
    const request = takeVoiceOverlayNotificationReplyIntent(event, raw), main = getMainWindow();
    if (!request || !main || main.isDestroyed()) return false;
    main.webContents.send("overlay-prepare-notification-reply", request); return true;
  });
  ipc.handle("confirm-overlay-prepare-notification-reply", (event, raw: unknown) => confirmVoiceOverlayNotificationReply(event, raw, getMainWindow()));
  ipc.handle("overlay-open-chat", (event, session: unknown) => {
    const request = takeVoiceOverlayOpenChatIntent(event, session);
    const main = getMainWindow();
    if (!request || !main || main.isDestroyed()) return false;
    main.webContents.send("overlay-open-chat", request);
    return true;
  });
  ipc.handle("confirm-overlay-open-chat", (event, session: unknown) => {
    return confirmVoiceOverlayOpenChat(event, session, getMainWindow());
  });
  ipc.handle("overlay-open-chat-composer", (event, session: unknown) => {
    return !!takeVoiceOverlayOpenChatComposerIntent(event, session, getMainWindow());
  });
  ipc.handle("overlay-chat-send", (event, request: unknown) => sendOverlayChatMessage(event, request, getMainWindow()));
  ipc.handle("close-overlay-chat-composer", (event, session: unknown) => closeOverlayChatComposer(event, session));
  ipc.handle("resolve-overlay-chat-send", (event, request: unknown) => resolveOverlayChatSend(event, request, getMainWindow()));
}
