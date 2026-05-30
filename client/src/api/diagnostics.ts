/**
 * diagnostics — user-facing diagnostics actions: report-with-logs (upload via
 * the existing feedback channel), export-to-file, and open-logs-folder.
 *
 * Electron builds the bundle in the MAIN process (it owns the rolling log files,
 * crash dumps, and OS/GPU info) and returns the gzipped bytes over IPC. Web /
 * Capacitor have no local file, so we build a smaller JSON bundle from the
 * in-memory ring buffer (diagnosticBuffer.ts) plus navigator-derived sysinfo.
 *
 * Delivery reuses the feedback system end-to-end: the bundle rides as a `files[]`
 * attachment on a feedback ticket, so it lands in AdminFeedbackList for a
 * maintainer to download — no new server endpoint.
 *
 * Privacy: the bundle carries the same events + metadata as server telemetry —
 * no message bodies / tokens / E2EE keys.
 */

import { apiClient } from "./client";
import { isElectron } from "../utils/constants";
import { serializeDiagnostics } from "./diagnosticBuffer";
import { createFeedbackTicket } from "./feedback";

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
    d.getMinutes(),
  )}${p(d.getSeconds())}`;
}

function webSystemInfo(): Record<string, unknown> {
  const nav: Navigator | Record<string, never> =
    typeof navigator !== "undefined" ? navigator : {};
  const n = nav as Navigator;
  return {
    platform: "web",
    userAgent: typeof n.userAgent === "string" ? n.userAgent.slice(0, 512) : "",
    language: n.language ?? "",
    online: typeof n.onLine === "boolean" ? n.onLine : undefined,
    appVersion: typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "",
    screenWidth: typeof window !== "undefined" ? window.screen?.width : undefined,
    screenHeight: typeof window !== "undefined" ? window.screen?.height : undefined,
    devicePixelRatio: typeof window !== "undefined" ? window.devicePixelRatio : undefined,
  };
}

/** Build the diagnostics bundle as a File ready to attach to a feedback ticket. */
export async function buildDiagnosticsFile(): Promise<File> {
  if (isElectron() && window.electronAPI?.buildDiagnosticUpload) {
    const { filename, data } = await window.electronAPI.buildDiagnosticUpload();
    // `data` is a Uint8Array (Node Buffer marshalled over IPC). Copy into a
    // plain ArrayBuffer-backed view so it satisfies BlobPart (TS 5.7+ widens the
    // IPC type to Uint8Array<ArrayBufferLike>, which Blob/File reject).
    return new File([new Uint8Array(data)], filename, { type: "application/gzip" });
  }
  // Web / Capacitor — uncompressed JSON from the in-memory ring + light sysinfo.
  const bundle = {
    kind: "hichat-diagnostics",
    bundleVersion: 1,
    generatedAt: new Date().toISOString(),
    systemInfo: webSystemInfo(),
    logs: serializeDiagnostics(),
  };
  return new File([JSON.stringify(bundle)], `hichat-diagnostics-${stamp()}.json`, {
    type: "application/json",
  });
}

/**
 * Submit a "report a problem" feedback ticket with the diagnostics bundle
 * attached. `description` is the user's own account of the issue.
 */
export async function submitDiagnosticsReport(description: string) {
  const file = await buildDiagnosticsFile();
  const content = description.trim() || "Tanılama paketi (kullanıcı açıklaması yok)";

  // Two deliveries from one bundle:
  //   1. Feedback ticket → archives in AdminFeedbackList (durable copy).
  //   2. /diagnostics-report → server emails the admin via SMTP (best-effort;
  //      may fail if the host blocks outbound SMTP — that's why #1 is durable).
  // Success/failure is reported on the archive; a failed email doesn't fail
  // the whole report.
  const archive = createFeedbackTicket({
    type: "bug",
    subject: "Tanılama raporu",
    content,
    files: [file],
  });

  const form = new FormData();
  form.append("description", content);
  form.append("file", file);
  const emailReport = apiClient("/diagnostics-report", { method: "POST", body: form });

  const [archiveResult] = await Promise.allSettled([archive, emailReport]);
  if (archiveResult.status === "rejected") {
    throw archiveResult.reason;
  }
  return archiveResult.value;
}

/**
 * Save the bundle to a local file. Electron: native save dialog (and copies the
 * newest crash dump alongside when present). Web: triggers a browser download.
 */
export async function exportDiagnostics(): Promise<{
  saved: boolean;
  path?: string;
  dumpCopied?: boolean;
}> {
  if (isElectron() && window.electronAPI?.exportDiagnostics) {
    return window.electronAPI.exportDiagnostics();
  }
  const file = await buildDiagnosticsFile();
  const url = URL.createObjectURL(file);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
  return { saved: true };
}

/** Open the folder holding the rolling logs (Electron only; no-op elsewhere). */
export async function openLogsFolder(): Promise<void> {
  if (isElectron() && window.electronAPI?.openLogsDir) {
    await window.electronAPI.openLogsDir();
  }
}
