import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import { registerOverlayActionIPC } from "./overlay-action-ipc";

function harness() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const ipc = { handle: (name, callback) => { handlers.set(name, callback); } } satisfies Pick<IpcMain, "handle">;
  const sent: unknown[][] = [];
  let main: BrowserWindow | null = { isDestroyed: () => false, webContents: { send: (...args: unknown[]) => { sent.push(args); } } } as unknown as BrowserWindow;
  const operations: Parameters<typeof registerOverlayActionIPC>[1] = {
    getMainWindow: () => main,
    takeVoiceOverlayAction: () => null,
    takeVoiceOverlayOpenInboxIntent: () => null,
    confirmVoiceOverlayOpenInbox: () => false,
    takeVoiceOverlayNotificationReplyIntent: () => null,
    confirmVoiceOverlayNotificationReply: () => false,
    takeVoiceOverlayOpenChatIntent: () => null,
    confirmVoiceOverlayOpenChat: () => false,
    takeVoiceOverlayOpenChatComposerIntent: () => null,
    sendOverlayChatMessage: async () => "unavailable",
    closeOverlayChatComposer: () => false,
    resolveOverlayChatSend: () => false,
  };
  const event = { sender: {}, senderFrame: {} } as IpcMainInvokeEvent;
  registerOverlayActionIPC(ipc, operations);
  return { operations, sent, handlers, event, main: () => main, removeMain: () => { main = null; }, invoke: (name: string, ...args: unknown[]) => handlers.get(name)!(event, ...args) };
}

const intents = [
  ["overlay-voice-action", "takeVoiceOverlayAction", ["mute", "grant"]],
  ["overlay-open-inbox", "takeVoiceOverlayOpenInboxIntent", ["grant"]],
  ["overlay-prepare-notification-reply", "takeVoiceOverlayNotificationReplyIntent", [{ session: "grant", notificationId: "opaque" }]],
  ["overlay-open-chat", "takeVoiceOverlayOpenChatIntent", ["grant"]],
] as const;

for (const [channel, operation, args] of intents) {
  test(`${channel} forwards only an accepted intent to a live main window`, () => {
    const h = harness();
    assert.equal(h.invoke(channel, ...args), false);
    assert.deepEqual(h.sent, []);
    const accepted = { session: "verified" };
    Reflect.set(h.operations, operation, (...received: unknown[]) => {
      assert.deepEqual(received, [h.event, ...args]);
      return accepted;
    });
    // Registrars capture their explicitly supplied operations, as production does.
    registerOverlayActionIPC({ handle: (name, callback) => h.handlers.set(name, callback) }, h.operations);
    assert.equal(h.invoke(channel, ...args), true);
    assert.deepEqual(h.sent, [[channel, accepted]]);
    h.main()!.isDestroyed = () => true;
    assert.equal(h.invoke(channel, ...args), false);
    h.removeMain();
    assert.equal(h.invoke(channel, ...args), false);
    assert.equal(h.sent.length, 1);
  });
}

test("confirmation and composer channels preserve original sender, raw request and current main identity", async () => {
  const h = harness();
  const routes = [
    ["confirm-overlay-open-inbox", "confirmVoiceOverlayOpenInbox"],
    ["confirm-overlay-prepare-notification-reply", "confirmVoiceOverlayNotificationReply"],
    ["confirm-overlay-open-chat", "confirmVoiceOverlayOpenChat"],
    ["overlay-open-chat-composer", "takeVoiceOverlayOpenChatComposerIntent"],
    ["overlay-chat-send", "sendOverlayChatMessage"],
    ["resolve-overlay-chat-send", "resolveOverlayChatSend"],
  ];
  const raw = { session: "opaque", requestId: "request" };
  for (const [channel, operation] of routes) {
    Reflect.set(h.operations, operation, (...args: unknown[]) => {
      assert.deepEqual(args, [h.event, raw, h.main()]);
      return channel === "overlay-chat-send" ? Promise.resolve("failed") : true;
    });
  }
  Reflect.set(h.operations, "closeOverlayChatComposer", (...args: unknown[]) => { assert.deepEqual(args, [h.event, raw]); return true; });
  registerOverlayActionIPC({ handle: (name, callback) => h.handlers.set(name, callback) }, h.operations);
  assert.equal(h.handlers.size, 11);
  for (const [channel] of routes) assert.equal(await h.invoke(channel, raw), channel === "overlay-chat-send" ? "failed" : true);
  assert.equal(h.invoke("close-overlay-chat-composer", raw), true);
  assert.deepEqual(h.sent, []);
});
