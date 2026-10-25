import assert from "node:assert/strict";
import test from "node:test";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { registerOverlayGameNoticeClearIPC } from "./overlay-game-notice-ipc";
test("notice clear is main-frame-only and cannot carry replacement snapshot content", () => {
  let handler!: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
  const trusted = {} as IpcMainInvokeEvent; let clears = 0;
  registerOverlayGameNoticeClearIPC({ handle: (name, callback) => { assert.equal(name, "clear-overlay-game-notices"); handler = callback; } } as Pick<IpcMain, "handle">,
    event => { if (event !== trusted) throw new Error("untrusted frame"); }, () => { clears++; });
  assert.throws(() => handler({} as IpcMainInvokeEvent), /untrusted/);
  assert.throws(() => handler(trusted, { enabled: true, participants: [] }), TypeError);
  assert.throws(() => handler(trusted, ["12345678-1234-4234-8234-123456789abc"]), TypeError);
  assert.equal(clears, 0); handler(trusted); assert.equal(clears, 1);
});
