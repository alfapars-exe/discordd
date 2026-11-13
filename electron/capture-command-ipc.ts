import type { IpcMain, IpcMainInvokeEvent } from "electron";

type CaptureOperations = Pick<typeof import("./audio-capture"),
  "startCapture" | "stopCapture" | "getCaptureStatus" | "startDiagnosticCapture" | "stopDiagnosticCapture">;

/** Keep native ownership in the capture worker; preserve the existing per-channel sender policy. */
export function registerCaptureCommandIPC(ipc: Pick<IpcMain, "handle">, trusted: (event: IpcMainInvokeEvent) => void, operations: CaptureOperations): void {
  ipc.handle("start-system-capture", event => { trusted(event); return operations.startCapture(); });
  ipc.handle("stop-system-capture", event => { trusted(event); return operations.stopCapture(); });
  ipc.handle("get-system-capture-status", () => operations.getCaptureStatus());
  ipc.handle("start-system-capture-diagnostic", () => operations.startDiagnosticCapture());
  ipc.handle("stop-system-capture-diagnostic", (_event, token: unknown) => {
    if (typeof token !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)) {
      throw new TypeError("diagnostic capture token is invalid");
    }
    return operations.stopDiagnosticCapture(token);
  });
}
