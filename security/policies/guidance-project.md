## HiChat · proje invaryantları (SECURITY-ADDENDUM.md özeti)

**Mimari:** Go 1.26 sunucu + React 19 istemci + Electron/Capacitor kabuklar + LiveKit ses/video + Signal-tarzı E2EE. Prod, HuggingFace Space'te tek konteynerdir (:7860); **TLS kenar katmanda sonlanır**, bu yüzden `ListenAndServe` düz metindir ve bu bilinçlidir — konteyner dışına düz metin çıkmaz.

**Veri sınıfları:** kullanıcı adı (@handle) **kamuya açıktır**; e-posta, parola hash'i ve E2EE anahtar materyali gizlidir. `password_hash` hiçbir DTO'da dönmez. Bot hesaplarının `password_hash` sütunu sabit `'!disabled!'` taşır (bcrypt formatı değildir) — bot'lar parolayla giriş yapamaz.

**Kimlik ve oturum:** Access token 24 saat (bilinçli iş kararı; `tv` token_version revocation claim'i + refresh rotasyonu telafi eder). Refresh ve medya çerezleri **HttpOnly + Secure**; `SameSite=None` yalnız Electron `app://` ve Capacitor `capacitor://` kabuklarının cross-site alt kaynak yüklemesi için ve yalnız Path-scoped, GET-only, yetkisi her istekte yeniden kontrol edilen uçlarda kullanılır. Access token istemcide **yalnız bellekte** tutulur; localStorage yalnız UI tercihi taşır. E2EE anahtarları IndexedDB'de, koruma OS disk şifrelemesidir (Signal Desktop modeli).

**Kritik akışlar — bunlara dokunan diff'i sıkı incele:**
- `server/handlers/upload_download.go` — medya servisi; yetki fail-closed, yol üç katmanlı (prefix reddi + kanoniklik + `pkg.SafeJoin`). Kanoniklik kontrolünü gevşetmek pentest C-02'yi geri getirir.
- `server/services/media_access_service.go` — `badges/` gibi public allowlist girdileri; yeni girdi eklemek yetkisiz erişim açar.
- `client/src/crypto/**` — E2EE protokolü; payload formatını değiştirmek geriye dönük şifre çözmeyi kırar.
- `server/ws/**` — WebSocket; ticket TTL'i 30 saniyedir, mesajlar şema doğrulamasından geçer.
- Ses kodundaki mutex sahaları (`services/voice_*.go`, `p2p_call_service.go`): **63 saha bloklayıcı işten önce bilinçle `Unlock` eder** (LiveKit round-trip'i ~20 sn, hub broadcast, kanal gönderimi, aynı mutex'i yeniden alan çağrılar). Buralara `defer Unlock()` eklemek üretimde deadlock üretir — "defer daha güvenli" genellemesi bu kod tabanında geçerli değildir.

**Bu repo'da onaylı çıkış allowlist'i:** `api.klipy.com` (GIF; sabit base URL + `url.QueryEscape` + redirect kilidi), LiveKit instance URL'leri, Resend. Bunların dışına giden yeni bir outbound çağrı SSRF incelemesi ister.

**Tarama kaydı:** Kalıcı Checkmarx projesi `discord main` (id 104). Her tarama bu projeye yapılır; tarama başına yeni proje açmak baseline'ı yok eder ve yasaktır.
