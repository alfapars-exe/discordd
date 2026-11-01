import { useState } from "react";
import { exportDeviceHandoff } from "../../crypto/deviceHandoff";
import { preferencesForDeviceHandoff } from "../../stores/preferencesStore";
export default function DeviceHandoffSettings({
  ownerId,
}: {
  ownerId: string;
}) {
  const [intent, setIntent] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  async function transfer() {
    setBusy(true);
    setMessage("");
    try {
      const capsule = await exportDeviceHandoff(
        intent,
        preferencesForDeviceHandoff(ownerId),
      );
      const url = URL.createObjectURL(
        new Blob([capsule], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = "hichat-device-handoff.json";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      setMessage(
        "Bu cihazın şifreleme yazımı durduruldu. Dosyayı hedef istemcide açın. Dosya kaybolursa aynı hedef koduyla yeniden indirin.",
      );
    } catch (e) {
      const code = e instanceof Error ? e.message : "";
      setMessage(
        code === "handoff_other_clients_open"
          ? "Diğer HiChat pencereleri açık. Onları kapatıp yeniden deneyin."
          : `Devir tamamlanamadı: ${code}`,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-section">
      <h3>Cihazı yeni istemciye devret</h3>
      <p>
        Hedef istemcideki cihaz devri kodunu girin. Dosya oluştuğunda bu istemci
        aynı cihaz anahtarlarıyla mesaj gönderemez. Eski veriler silinmez.
      </p>
      <textarea
        aria-label="Hedef cihaz devri kodu"
        value={intent}
        disabled={busy}
        onChange={(e) => setIntent(e.target.value)}
      />
      <button
        type="button"
        className="settings-btn"
        disabled={busy || !intent.trim()}
        onClick={() => void transfer()}
      >
        {busy
          ? "Devir hazırlanıyor…"
          : "Eski cihazı durdur ve devir dosyasını oluştur"}
      </button>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
