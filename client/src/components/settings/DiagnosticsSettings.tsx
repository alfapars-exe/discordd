/**
 * DiagnosticsSettings — user-facing diagnostics panel.
 *
 * Lets a user hand their local diagnostic log to support in two ways:
 *   1. "Sorun bildir + loglar"  → uploads the bundle on a feedback ticket
 *      (lands in AdminFeedbackList). Primary path.
 *   2. "Tanılamayı dışa aktar"  → saves the bundle to a file (Electron native
 *      save dialog + copies the newest crash dump; web downloads it). Offline.
 *
 * Plus an "Ayrıntılı log" (verbose) toggle (Electron, persisted) and a shortcut
 * to open the log folder. The privacy note states exactly what is and isn't
 * collected — events + metadata only, never message content / passwords / keys.
 */

import { useEffect, useState } from "react";
import { isElectron } from "../../utils/constants";
import { useToastStore } from "../../stores/toastStore";
import {
  exportDiagnostics,
  openLogsFolder,
  submitDiagnosticsReport,
} from "../../api/diagnostics";

const card: React.CSSProperties = {
  background: "var(--bg-3)",
  border: "1px solid var(--b1)",
  borderRadius: 10,
  padding: 16,
  marginBottom: 16,
};
const btn: React.CSSProperties = {
  padding: "8px 14px",
  borderRadius: 8,
  border: "1px solid var(--b1)",
  background: "var(--bg-4)",
  color: "var(--t1)",
  cursor: "pointer",
  fontSize: 14,
};
const btnPrimary: React.CSSProperties = {
  ...btn,
  background: "var(--primary)",
  borderColor: "var(--primary)",
  color: "#fff",
};

function DiagnosticsSettings() {
  const addToast = useToastStore((s) => s.addToast);
  const [description, setDescription] = useState("");
  const [reporting, setReporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [verbose, setVerbose] = useState(false);

  const electron = isElectron();

  useEffect(() => {
    if (electron && window.electronAPI?.getDiagnosticVerbose) {
      window.electronAPI.getDiagnosticVerbose().then(setVerbose).catch(() => {});
    }
  }, [electron]);

  async function handleReport() {
    setReporting(true);
    try {
      await submitDiagnosticsReport(description);
      setDescription("");
      addToast("success", "Tanılama raporu gönderildi. Teşekkürler!", 5000);
    } catch {
      addToast(
        "error",
        "Rapor gönderilemedi. Çevrimdışıysan 'Dışa aktar' ile kaydedip iletebilirsin.",
        7000,
      );
    } finally {
      setReporting(false);
    }
  }

  async function handleExport() {
    setExporting(true);
    try {
      const res = await exportDiagnostics();
      if (res.saved) {
        addToast(
          "success",
          res.dumpCopied
            ? "Tanılama dosyası kaydedildi (crash dump dahil)."
            : "Tanılama dosyası kaydedildi.",
          5000,
        );
      }
    } catch {
      addToast("error", "Dışa aktarma başarısız oldu.", 6000);
    } finally {
      setExporting(false);
    }
  }

  async function handleToggleVerbose() {
    const next = !verbose;
    setVerbose(next);
    try {
      await window.electronAPI?.setDiagnosticVerbose?.(next);
    } catch {
      setVerbose(!next); // revert on failure
      addToast("error", "Ayar kaydedilemedi.", 4000);
    }
  }

  return (
    <div style={{ maxWidth: 640 }}>
      <h2 style={{ fontSize: 20, fontWeight: 600, color: "var(--t1)", marginBottom: 4 }}>
        Tanılama
      </h2>
      <p style={{ color: "var(--t2)", fontSize: 14, marginBottom: 20 }}>
        Ses, görüntü, ekran paylaşımı, yazışma veya bağlantı sorunlarını teşhis etmemize
        yardımcı ol. Uygulama bu cihazda sürekli bir tanılama günlüğü tutar; aşağıdan bize
        iletebilirsin.
      </p>

      {/* Report with logs */}
      <div style={card}>
        <h3 style={{ fontSize: 15, fontWeight: 600, color: "var(--t1)", marginBottom: 8 }}>
          Sorun bildir + loglar
        </h3>
        <p style={{ color: "var(--t2)", fontSize: 13, marginBottom: 10 }}>
          Sorunu kısaca anlat; tanılama paketiyle birlikte bize ulaşır.
        </p>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Örn: Ekran paylaşırken ses gitmiyor, karşı taraf duymuyor…"
          rows={4}
          style={{
            width: "100%",
            resize: "vertical",
            borderRadius: 8,
            border: "1px solid var(--b1)",
            background: "var(--bg-0)",
            color: "var(--t1)",
            padding: 10,
            fontSize: 14,
            marginBottom: 10,
          }}
        />
        <button style={btnPrimary} onClick={handleReport} disabled={reporting}>
          {reporting ? "Gönderiliyor…" : "Gönder"}
        </button>
      </div>

      {/* Export / open */}
      <div style={card}>
        <h3 style={{ fontSize: 15, fontWeight: 600, color: "var(--t1)", marginBottom: 8 }}>
          Dışa aktar
        </h3>
        <p style={{ color: "var(--t2)", fontSize: 13, marginBottom: 10 }}>
          Tanılama paketini dosya olarak kaydet (çevrimdışıysan veya manuel iletmek
          istersen).
        </p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button style={btn} onClick={handleExport} disabled={exporting}>
            {exporting ? "Kaydediliyor…" : "Tanılamayı dışa aktar"}
          </button>
          {electron && (
            <button style={btn} onClick={() => void openLogsFolder()}>
              Log klasörünü aç
            </button>
          )}
        </div>
      </div>

      {/* Verbose toggle (Electron only) */}
      {electron && (
        <div style={card}>
          <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, cursor: "pointer" }}>
            <span>
              <span style={{ display: "block", fontSize: 15, fontWeight: 600, color: "var(--t1)" }}>
                Ayrıntılı log (Verbose)
              </span>
              <span style={{ display: "block", fontSize: 13, color: "var(--t2)", marginTop: 2 }}>
                Daha fazla ayrıntı kaydeder. Bir sorunu tekrar üretirken aç.
              </span>
            </span>
            <input type="checkbox" checked={verbose} onChange={handleToggleVerbose} style={{ width: 18, height: 18 }} />
          </label>
        </div>
      )}

      {/* Privacy note */}
      <p style={{ color: "var(--t3)", fontSize: 12, lineHeight: 1.5 }}>
        Gizlilik: Tanılama yalnızca <strong>olayları ve teknik bilgileri</strong> içerir
        (ne zaman ne oldu, hata kodları, cihaz/sürüm bilgisi). <strong>Mesaj içerikleri,
        şifreler, oturum anahtarları ve uçtan-uca şifreli veriler asla</strong> kaydedilmez
        veya gönderilmez.
      </p>
    </div>
  );
}

export default DiagnosticsSettings;
