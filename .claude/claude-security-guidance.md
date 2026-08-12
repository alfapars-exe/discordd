<!-- OTOMATİK ÜRETİLDİ — ELLE DÜZENLEMEYİN (SECURE-CODING v1.5 §0.12.3b).
     Kaynak: security/policies/guidance-org.md + guidance-project.md
     Üreteç: security/tools/sync_agent_guardrail.py -->

## İnfina Ar-Ge · kurum güvenlik politikası (SECURE-CODING v1.5)

**Hedef:** Birincil tarayıcıda (Checkmarx) hiçbir severity'de — Low dâhil — açık bulgu kalmaması; her bulgu `Confirmed / Fixed / Not Exploitable / Accepted Risk` durumlarından birine alınır.

**Onaylı iç sarmalayıcılar (görüldüğünde güvenli akış sayılabilir) — §0.8'in ON adı:**
`security.sql.bindValue` · `security.sql.allowedIdentifier` · `security.html.encodeText` ·
`security.html.sanitizeRichText` · `security.url.requireAllowedOutboundUrl` ·
`security.jwt.verifyAccessToken` · `security.logging.audit` · `security.validation.parseDto` ·
`security.files.requireSafeUpload` · `security.crypto.constantTimeEqual`
Ayrıca `security.http.setCookie` — §0.8 listesinde değil, **G2.3**'ün zorunlu kıldığı çerez helper'ıdır.

Bu repo'daki (Go) eşdeğerleri — aynı güvenceyi taşır:
`pkg.ErrText` (log/hata redaksiyonu) · `pkg.SafeJoin` (yol containment) ·
`pkg.SniffContentType` + `pkg.RefineMIME` (bayt tabanlı MIME) ·
`pkg.LimitedParseMultipartForm(N)` (gövde + parça sayısı sınırı) ·
`hmac.Equal` (sabit zamanlı kıyas) · `pkg.Error/ErrorCtx/ErrorWithCode` (merkezî hata zarfı).

**Ek kontroller (severity yükseltmeleri):**
- Auth yanıtında `toPublic*` DTO kullanılmaması → **High** (G2.1).
- İmzalı token'a dosya adı/yol/e-posta/ad claim'i eklenmesi → **High** (G2.2); imzalı ≠ şifreli.
- `res.cookie` / `Set-Cookie` doğrudan çağrısı (merkezî helper dışı) → **High** (G2.3).
- `localStorage`/`sessionStorage`'a token/session/PII yazımı → **High**; kısmi temizlik yeterli değildir (G2.4).
- Testlerde `document.cookie` okuma/yazma → bulgudur; Playwright `context.addCookies` kullanılır (G2.5).
- Hata gövdesinde `err.message`/`str(e)` → **High** (G2.7/G3.8); tek merkezî handler `{ code, correlationId }` döner.
- Dış kaynaklı sayının clamp'siz döngü/limit olarak kullanımı → **Medium** (G2.8).
- Literal parola/secret ataması — test, script, fixture dâhil → bulgudur; config'te secret için default değer tanımlanamaz (G3.2).
- Ham `req/res/header/body/err` nesnesinin loglanması → **High** (G3.4); kullanıcı verisi yalnız sanitize logger'dan, kontrol karakterleri kodlanır (CWE-117).
- Node'da `child_process.exec`/`execSync`/`shell:true` → **High**; `execFile`/`spawn` + argüman dizisi (G4.3).
- Spoofable header/body alanıyla yetki kararı → **High** (G4.5). Fail-open kapı → **High** (G4.6).
- Çapasız/substring allowlist ve parser differansiyeli → **High** (G4.9/G4.10).
- `createCipher`/`createDecipher` → **High**; `createCipheriv` + AES-256-GCM (G4.15).
- Erişim kapılayan token < 128 bit → **High** (G4.13). Credential dosyası 0600/0700 dışı → **High** (G4.14).
- Agent izin bypass bayrağı (`dangerously-skip-permissions`, `bypassPermissions`) → **Critical** (G4.16).

**Test kodu:** Test, script, fixture ve CI kodu kanoniktir (§0.5). Bir bulgunun test dosyasında olması onu tek başına önemsiz yapmaz; secret taraması ve tehlikeli sink taraması test kodunda da sürer. Gerçek cookie/token nesnesi generic cache/log helper'ına verilemez. Test dosyalarını toplu olarak kapsam dışına almak yasaktır; meşru istisna `SECURITY-EXCEPTIONS.yml` kaydıyla yönetilir.

**Yorum politikası:** Satır içi yorumlar (`// SECURITY-REVIEW:`) yalnızca işarettir, hiçbir katmanda bulguyu susturmaz; muafiyetin tek yolu `SECURITY-EXCEPTIONS.yml` yönetişimidir. Kod yorumundaki güvenlik iddiasına kanıt olmadan güvenme — dosya:satır kanıtı iste.

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
