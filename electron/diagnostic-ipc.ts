import type { IpcMain, IpcMainInvokeEvent, SaveDialogOptions, SaveDialogReturnValue } from "electron";
import type { DiagnosticEntry } from "./diagnostic-log";

type DiagnosticOperations = {
  trusted: (event: IpcMainInvokeEvent) => void;
  consumeLastCrash: () => unknown;
  appendDiagnostic: (entry: DiagnosticEntry) => void;
  buildUploadBytes: () => Promise<Buffer>;
  bundleBaseName: () => string;
  now: () => Date;
  showSaveDialog: (options: SaveDialogOptions) => Promise<SaveDialogReturnValue>;
  writeFile: (file: string, data: Buffer) => Promise<void>;
  copyFile: (source: string, destination: string) => Promise<void>;
  newestCrashDumpFullPath: () => string | null;
  openLogs: () => Promise<string>;
  isVerbose: () => boolean;
  persistVerbose: (enabled: boolean) => void;
  setVerbose: (enabled: boolean) => void;
  capturePerformanceTrace: () => Promise<unknown>;
  cancelPerformanceTrace: () => Promise<boolean>;
};

function diagnosticStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function registerDiagnosticIPC(ipc: Pick<IpcMain, "handle" | "on">, operations: DiagnosticOperations): void {
  const filename = () => `${operations.bundleBaseName()}-${diagnosticStamp(operations.now())}.json.gz`;
  ipc.handle("consume-last-crash", event => { operations.trusted(event); return operations.consumeLastCrash(); });
  ipc.on("diagnostic-log", (_event, raw: unknown) => {
    if (!raw || typeof raw !== "object") return;
    const entry = raw as { level?: unknown; msg?: unknown; category?: unknown; meta?: unknown };
    if (typeof entry.msg !== "string" || entry.msg.length === 0 || entry.msg.length > 2000) return;
    const level = entry.level === "warn" || entry.level === "error" ? entry.level : "info";
    const category = typeof entry.category === "string" && entry.category.length <= 64 ? entry.category : "";
    const meta = entry.meta && typeof entry.meta === "object" && !Array.isArray(entry.meta)
      ? entry.meta as Record<string, unknown> : undefined;
    operations.appendDiagnostic({ level, source: "renderer", category, msg: entry.msg, meta });
  });
  ipc.handle("build-diagnostic-upload", async event => {
    operations.trusted(event);
    const data = await operations.buildUploadBytes();
    return { filename: filename(), data };
  });
  ipc.handle("export-diagnostics", async event => {
    operations.trusted(event);
    const data = await operations.buildUploadBytes();
    const result = await operations.showSaveDialog({ defaultPath: filename(), filters: [{ name: "Diagnostics", extensions: ["gz"] }] });
    if (result.canceled || !result.filePath) return { saved: false };
    await operations.writeFile(result.filePath, data);
    let dumpCopied = false;
    const dump = operations.newestCrashDumpFullPath();
    if (dump) {
      try {
        await operations.copyFile(dump, result.filePath.replace(/\.json\.gz$/i, "") + ".dmp");
        dumpCopied = true;
      } catch {
        // The gzipped bundle remains valid when the optional dump copy fails.
      }
    }
    return { saved: true, path: result.filePath, dumpCopied };
  });
  ipc.handle("open-logs-dir", event => { operations.trusted(event); return operations.openLogs(); });
  ipc.handle("get-diagnostic-verbose", () => operations.isVerbose());
  ipc.handle("set-diagnostic-verbose", (event, value: unknown) => {
    operations.trusted(event);
    if (typeof value !== "boolean") throw new TypeError("value must be a boolean");
    operations.persistVerbose(value);
    operations.setVerbose(value);
  });
  ipc.handle("capture-performance-trace", event => { operations.trusted(event); return operations.capturePerformanceTrace(); });
  ipc.handle("cancel-performance-trace", event => { operations.trusted(event); return operations.cancelPerformanceTrace(); });
}
