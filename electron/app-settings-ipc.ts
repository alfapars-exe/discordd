import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { isAppSettingKey, type AppSettings } from "./settings";

// Diagnostic verbosity has a separate IPC contract.
const APP_SETTING_VALIDATORS: Record<string, (value: unknown) => value is boolean> = {
  openAtLogin: (value): value is boolean => typeof value === "boolean",
  startMinimized: (value): value is boolean => typeof value === "boolean",
  closeToTray: (value): value is boolean => typeof value === "boolean",
  transparentBackground: (value): value is boolean => typeof value === "boolean",
  hardwareAcceleration: (value): value is boolean => typeof value === "boolean",
};

type SettingsOperations = {
  trusted: (event: IpcMainInvokeEvent) => void;
  getSettings: () => AppSettings;
  setSetting: (key: string, value: boolean) => void;
  getLoginItemSettings: () => { openAtLogin: boolean };
  setLoginItemSettings: (settings: { openAtLogin: boolean }) => void;
};

export function registerAppSettingsIPC(ipc: Pick<IpcMain, "handle">, operations: SettingsOperations): void {
  ipc.handle("get-app-settings", () => {
    const live = operations.getLoginItemSettings();
    const cached = operations.getSettings();
    cached.openAtLogin = live.openAtLogin;
    return cached;
  });
  ipc.handle("set-app-setting", (event, key: unknown, value: unknown) => {
    operations.trusted(event);
    if (!isAppSettingKey(key)) {
      throw new TypeError(`unknown app setting: ${String(key)}`);
    }
    if (!APP_SETTING_VALIDATORS[key]?.(value)) {
      throw new TypeError(`invalid value for ${key}: expected boolean, got ${typeof value}`);
    }
    operations.setSetting(key, value);
    if (key === "openAtLogin") operations.setLoginItemSettings({ openAtLogin: value });
  });
}
