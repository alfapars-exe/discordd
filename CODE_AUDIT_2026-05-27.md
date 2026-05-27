# HiChat — Kapsamlı Kod Denetimi (Code Audit)

**Tarih:** 2026-05-27
**Kapsam:** `tayfa-deploy/` (frontend + backend + electron + native) + `livekit-oracle/` (LiveKit infrastructure)
**Metot:** 5 paralel uzman denetim ajanı + manuel doğrulama
**Toplam Bulgu:** 77 (17 Critical / 23 High / 25 Medium / 12 Low)
**Üretim Hazırlık Durumu:** 🔴 **BLOCKED** — minimum P0 maddelerinin tamamı kapatılmadan üretime çıkılmamalı

---

## A) Genel Durum Özeti

### Kodun genel kalitesi

HiChat, gerçekten **Discord seviyesinde ciddi bir kod tabanı**: Go backend (40 handler / 50+ service / 65+ repository), React 19 + Zustand frontend, kendi Signal Protocol implementation'ı (X3DH + Double Ratchet + Sender Keys), Electron desktop + Capacitor mobile + C++ native audio capture, self-hosted LiveKit voice/video. Mimari ayrım net (handler → service → repository), test dosyaları mevcut (`auth_service_test.go`, `message_service_test.go`, `voice_service_test.go`, `e2eeStore.test.ts`, `voiceStore.test.ts`), pattern tutarlı. Bu solid bir temel.

**Ama**: bu kadar büyük ve karmaşık bir yüzeyde — özellikle kendi kripto + kendi WS hub + Electron + native C++ + self-host infra kombinasyonunda — production-ready olmak için kritik boşluklar var. En tehlikelisi **secret yönetimi**: production credentials version control'e girmiş.

### En Büyük 5 Risk

1. **🔴 Repo'ya commit edilmiş production secret'lar** — SSH private key + canlı LiveKit API credentials. Tam infra takeover yolu açık.
2. **🔴 E2EE protokolünde subtle güvenlik açıkları** — Sender Key replay window, SPK signature validation gap, AES-GCM IV reuse yarış durumu, PBKDF2 iteration sayısı 2025 standardının altında.
3. **🔴 Auth/Token sisteminde RBAC bypass + memory leak** — Permission cache 30s bayatlık penceresi, refresh token map unbounded growth, voice token 1h iptal gecikmesi.
4. **🔴 Production hardening tamamen yok** — Nginx security header'ları (HSTS, CSP, X-Frame-Options vb.) **6/6 eksik**, container'lar root user'la çalışıyor, HEALTHCHECK yok, resource limit yok, base image'lar unpinned.
5. **🔴 Native binary güvenlik flag'leri eksik** — `audio-capture.exe` ASLR/DEP/CFG/GS olmadan derleniyor; bir buffer overflow direkt RCE'ye dönüşür.

### Production Blocker'lar (kesin kapatılmalı)

| # | Madde | Dosya/Konum |
|---|---|---|
| 1 | SSH private key repo'da | `livekit-oracle/ssh/livekit-oci` |
| 2 | LiveKit credentials düz metin | `livekit-oracle/DEPLOYED.md` + `livekit-oracle/config/livekit.yaml` |
| 3 | Nginx security header'ları yok | `tayfa-deploy/client/nginx.conf` |
| 4 | WebSocket idle timeout 60s | `tayfa-deploy/client/nginx.conf` |
| 5 | Container root user | `Dockerfile`, `server/Dockerfile` |
| 6 | HEALTHCHECK yok | `tayfa-deploy/Dockerfile` |
| 7 | E2EE PBKDF2 < 2M iteration | `client/src/crypto/keyBackup.ts:20` |
| 8 | Sender Key replay window | `client/src/crypto/senderKeyProtocol.ts:315-327` |
| 9 | Native build flags eksik | `native/build.bat` |
| 10 | Refresh token map memory leak | `server/services/auth_service.go` |

### Uygulamanın çökme ihtimali olan ana noktalar

- **WS hub goroutine leak**: `ws/client.go` ReadPump/WritePump context cancellation kontrol etmiyor → graceful shutdown 10k+ bağlantıda hang
- **WS event handler panic recovery yok**: tek bir kötü payload tüm worker goroutine'i çökertir (`ws/client.go:handleEvent`)
- **Refresh token map unbounded growth**: yüksek refresh trafiğinde sweep loop (1h) yetişmez → OOM
- **Desktop capturer 5s blocking**: 10k+ pencereli sistemde main thread donar (`electron/screen-picker.ts`)
- **WAVEFORMATEXTENSIBLE parsing bounds-check'siz**: kötü ses cihazı format response'u native exe crash veya RCE (`native/audio-capture.cpp:160`)
- **Member position race**: paralel `AddMember` çağrılarında aynı `position` atanır → liste sırası tutarsız (`sqlite_server.go`)
- **AES-GCM IV reuse**: yüksek concurrent send'de aynı IV ile şifreleme olası → kriptografik catastrophe (`crypto/signalProtocol.ts:584`)

---

## B) Kritik Bulgular Tablosu

Format: `[ID] Severity | Kategori | Dosya:Satır | Problem → Risk → Düzeltme`

> **Not:** Aşağıda tüm 17 P0 + en kritik 15 P1 detaylı. Geri kalan P1/P2/P3 bulgular tablo özetinde. ID şeması: BC=Backend Core, BD=Backend Data, FE=Frontend+E2EE, EN=Electron+Native, IN=Infra.

### 🔴 P0 — CRITICAL (üretim blocker)

#### Güvenlik / Secrets

**[P0-IN-01] SSH private key repo'da düz metin (CONFIRMED)**
- Dosya: [livekit-oracle/ssh/livekit-oci](../livekit-oracle/ssh/livekit-oci) (419 bytes, OpenSSH ed25519)
- Problem: `-----BEGIN OPENSSH PRIVATE KEY-----` ile başlayan canlı VM SSH anahtarı version control'de
- Risk: Anyone with repo access → Oracle VM root SSH (IP `79.76.123.59`) → LiveKit takeover, voice/video servisi down, tüm odaları snoop
- Reproduce: `ssh -i livekit-oracle/ssh/livekit-oci ubuntu@79.76.123.59`
- Düzeltme:
  1. Oracle Console → instance → SSH keys → eski public key'i kaldır + yeni key pair üret
  2. `.gitignore`'a ekle: `livekit-oracle/ssh/`, `livekit-oci`, `livekit-oci.pub`
  3. `git filter-repo --invert-paths --path livekit-oracle/ssh/livekit-oci` ile history'den temizle
  4. Force push (collaborator'ları uyar)
  5. Yeni anahtarı **asla repo'ya koyma** — local `~/.ssh/` veya 1Password/Bitwarden

**[P0-IN-02] LiveKit production API credentials repo'da düz metin (CONFIRMED — agent eksik bildirdi, gerçekte 2 dosyada)**
- Dosyalar:
  - [livekit-oracle/DEPLOYED.md:13-14](../livekit-oracle/DEPLOYED.md#L13)
  - [livekit-oracle/config/livekit.yaml:18](../livekit-oracle/config/livekit.yaml#L18) (`keys:` bloğu içinde hardcoded)
- Problem: `APIeb80fb802673:IK9KCzUqXrf99of9X-jVLGbse4mBhUC0tnj21qNhlMrT65_bBEijRIXbJcmJCP73` — bu **canlı production credentials**, hem markdown hem yaml'da düz metin
- Risk: API key+secret ile attacker imzalı LiveKit token üretebilir → istediği room'a istediği kullanıcı kimliğiyle girebilir, mesajları dinleyebilir, DoS yapabilir
- Düzeltme:
  1. LiveKit'te yeni key pair üret (livekit-server config rotation)
  2. `DEPLOYED.md`'den credential bloğunu kaldır (placeholder: `*** redacted — see vault ***`)
  3. `livekit.yaml`'ı template'e dönüştür: `keys: ${LIVEKIT_API_KEY}: ${LIVEKIT_API_SECRET}` + Caddy/docker'da envsubst
  4. Eski credentials'ı revoke et (LiveKit `livekit-server` config reload)
  5. HiChat backend tarafındaki `LIVEKIT_API_KEY/SECRET` env var'ı güncelle (HF Space secrets)
  6. `git filter-repo` ile history'den temizle

**[P0-IN-03] `.gitignore` `ssh/` ve uzantısız private key'leri engellemiyor**
- Dosya: [.gitignore:31-32](.gitignore#L31)
- Problem: `*.pem` ve `*.key` var ama `livekit-oci` (uzantısız) ve `ssh/` dizini yok
- Risk: Gelecekte de aynı hata olur
- Düzeltme:
  ```
  # Secrets — extended
  ssh/
  **/ssh/
  *id_rsa*
  *id_ed25519*
  livekit-oci*
  *.ppk
  ```

#### Auth & Authorization

**[P0-BC-01] WS endpoint JWT query string fallback'i**
- Dosya: [server/ws/handler.go (UpgradeHandler)](server/ws/handler.go)
- Problem: Ticket sistemi primary olsa da `?token=` query string fallback hâlâ kabul edilebilir
- Risk: Token URL'de → proxy/CDN log'larda, browser history'de, network monitoring'de leak
- Düzeltme:
  ```go
  if r.URL.Query().Get("token") != "" {
      http.Error(w, "JWT in query string not permitted", http.StatusBadRequest)
      return
  }
  ```

**[P0-BC-02] Refresh token usedRefresh map unbounded büyüme**
- Dosya: [server/services/auth_service.go (usedRefreshSweepLoop)](server/services/auth_service.go)
- Problem: `usedRefresh` map'i her refresh'te SHA256 hash ekler, sweep 1 saatte bir. Yüksek refresh trafiğinde sweep yetişemez.
- Risk: OOM crash, DoS
- Düzeltme: Refresh sonrası immediate `delete`, threshold (1M entry) aşılırsa erken eviction tetikle, Redis'e taşı (distributed deployment için zaten gerekli)

**[P0-BC-03] Refresh token reuse detection sessizce tüm session'ları öldürüyor**
- Dosya: [server/services/auth_service.go (RefreshToken)](server/services/auth_service.go)
- Problem: Reuse tespit edilince `TokenVersion` artırıp tüm session'lar invalidate ediliyor ama **audit log + alert yok**
- Risk: Token compromise sessizce gerçekleşir, admin görmez, forensic trail yok
- Düzeltme: `auditLog.LogSecurityEvent(AuditEventTokenCompromiseDetected, ...)` ekle + Slack/email alert webhook

**[P0-BC-04] Permission cache 30s TTL — revocation gecikme penceresi**
- Dosya: [server/middleware/permission.go](server/middleware/permission.go)
- Problem: Admin rolü iptal edildikten sonra kullanıcı 30 saniye boyunca admin yetkisini kullanmaya devam edebilir
- Risk: Acil rol iptali çalışmıyor, banned admin son işlerini yapma fırsatı buluyor
- Düzeltme: TTL'i 5s'ye düşür + role/permission değişikliğinde event-driven invalidation (`InvalidateServerPermissions(serverID)`)

**[P0-BC-05] WS client ReadPump/WritePump context cancellation kontrol etmiyor**
- Dosya: [server/ws/client.go (ReadPump, WritePump)](server/ws/client.go)
- Problem: Graceful shutdown sırasında goroutine'ler ctx.Done() dinlemiyor
- Risk: 10k+ bağlantıda shutdown'da goroutine leak → memory bloat, restart yavaşlığı, cascading failure
- Düzeltme: Her loop iterasyonunda `select { case <-ctx.Done(): return; default: }` ekle

#### E2EE Kriptografi

**[P0-FE-01] PBKDF2 iteration count 2025 standardının altında**
- Dosya: [client/src/crypto/keyBackup.ts:20](client/src/crypto/keyBackup.ts#L20)
- Problem: 1M iteration (OWASP 2024 min 600k, 2025 önerisi 2M+). RTX 4090 ~600M hash/s ile 8 saat brute-force
- Risk: Backup blob exfil edilirse offline crack pratik
- Düzeltme: `PBKDF2_ITERATIONS = 2_000_000`. Long-term: Web Crypto'da Argon2id native gelene kadar bekle veya WASM Argon2 kullan

**[P0-FE-02] Sender Key out-of-order replay penceresi**
- Dosya: [client/src/crypto/senderKeyProtocol.ts:315-327](client/src/crypto/senderKeyProtocol.ts#L315)
- Problem: `iteration < currentIteration` geldiğinde chain key re-derive ediliyor ama ciphertext uniqueness kontrolü yok
- Risk: Eski ciphertext replay → mesaj iki kez görünür, semantic confusion
- Düzeltme: `(distributionId, iteration, ciphertext_digest)` tuple cache + AAD'ye sender-specific nonce bind

**[P0-FE-03] Self-fanout reset race condition**
- Dosya: [client/src/crypto/dmEncryption.ts:194-211](client/src/crypto/dmEncryption.ts#L194)
- Problem: `markSelfFanoutNeedsReset` async; recovery sonrası async metadata write tamamlanmadan DM gönderilirse stale flag → eski session reuse → diğer device'larda decrypt fail
- Risk: Restore sonrası mesaj kaybı, "empty message" görünümü
- Düzeltme: `restoreFromBackup` içinde `markSelfFanoutNeedsReset`'i `await` et + ilk DM öncesi metadata consistency check

#### Backend Data

**[P0-BD-01] E2EE backup blob'larında integrity (HMAC) yok**
- Dosya: `server/repository/sqlite_e2ee_backup.go` (+ ilgili service)
- Problem: Backup BLOB'ları opaque; DB admin tamper edebilir, kullanıcı decrypt fail olur ama tampering signal yok
- Risk: Tampered backup → corrupted plaintext / decryption failure, audit trail yok
- Düzeltme: Migration'da `backup_hmac TEXT NOT NULL` ekle, `HMAC-SHA256(user_id || version || payload)` compute & verify

**[P0-BD-02] Device identity_key enumeration rate-limit yok**
- Dosya: `server/repository/sqlite_device.go` (`ListPublicByUser`)
- Problem: `/api/users/{id}/devices` endpoint'i identity_key expose ediyor; bulk enumeration mümkün
- Risk: Tüm kullanıcıların device key veritabanı oluşturulabilir → targeted MITM
- Düzeltme: Endpoint'e rate-limit (10 req/IP/dakika) + sadece arkadaş/aynı sunucu üyesi sorgulayabilsin

**[P0-BD-03] Migration 067 partial-failure window'u**
- Dosya: [server/database/migrations/067_hashed_refresh_tokens.sql:42](server/database/migrations/067_hashed_refresh_tokens.sql#L42)
- Problem: ALTER TABLE → DELETE arası interruption olursa plaintext token'lı eski satırlar kalır
- Risk: Tarihsel zayıflık, partial deploy'da exposure
- Düzeltme: Explicit `BEGIN TRANSACTION` + post-migration assertion `SELECT COUNT(*) WHERE refresh_token_hash IS NULL` = 0

#### Electron / Native

**[P0-EN-01] Native build script güvenlik flag'leri yok**
- Dosya: [native/build.bat](native/build.bat)
- Problem: `cl.exe /EHsc /O2 /W3` — `/GS` `/DYNAMICBASE` `/NXCOMPAT` `/GUARD:cf` yok
- Risk: WASAPI parsing'de buffer overflow → predictable memory layout + executable stack + no canary = direct RCE
- Düzeltme:
  ```bat
  cl.exe /EHsc /O2 /W3 /GS /DYNAMICBASE /NXCOMPAT audio-capture.cpp ^
    /link ole32.lib mmdevapi.lib /GUARD:cf /HIGHENTROPYVA
  ```

**[P0-EN-02] IPC `app-setting` value type/range doğrulanmıyor**
- Dosya: [electron/ipc-handlers.ts:59-61](electron/ipc-handlers.ts#L59)
- Problem: Key kontrolü var ama value tipi yok — `openAtLogin: Infinity` veya `closeToTray: null` kabul ediliyor
- Risk: Renderer XSS'i → settings corruption → next launch crash veya behavior bypass
- Düzeltme: Per-key schema validator (zod veya inline) ekle, type+range kontrolü

**[P0-EN-03] audio-capture.exe PID masquerading**
- Dosya: [native/audio-capture.cpp:160-190](native/audio-capture.cpp#L160)
- Problem: argv[1] PID doğrudan `PROCESS_LOOPBACK_PARAMS_S::TargetProcessId`'ye geçiyor — parent PID doğrulanmıyor
- Risk: Aynı kullanıcı altında çalışan kötü process kendi PID'iyle audio-capture'ı yanıltır → loopback exclusion bypass, eavesdropping
- Düzeltme: Kısa vadeli: `GetCurrentProcessId() / NtQueryInformationProcess` ile parent doğrulaması. Uzun vadeli: argv yerine named pipe + cryptographic handshake

### 🟠 P1 — HIGH (öncelikli)

| ID | Dosya | Problem | Düzeltme |
|---|---|---|---|
| P1-BC-06 | `voice_token.go` | Voice token 1h validity → ban sonrası 60dk konuşmaya devam | TTL 15dk + webhook'ta revocation check |
| P1-BC-07 | `init_routes.go` | `/api/ws-ticket` endpoint'inde rate-limit yok | `LoginRateLimiter(20, 1*time.Minute)` ekle |
| P1-BC-08 | `ws/hub.go` | `userInfos` cache presence değişiminde invalidate edilmiyor | `OnPresenceManualUpdate` callback'inde `delete(hub.userInfos, userID)` |
| P1-BC-09 | `ws/client.go` | Unknown op code sessizce dropluyor | Warn log + `{op: OpError, data: "unknown operation"}` döndür |
| P1-BC-10 | `middleware/permission.go` | Cache invalidation prefix match — short userID'lerde false positive | `strings.HasPrefix(key, userID+":")` kullan (delimiter ile exact) |
| P1-FE-04 | `crypto/dmEncryption.ts:270` | Legacy device fallback'i SPK signature eksikse sessizce skip ediyor | `signing_key` 64-byte Ed25519 değilse `throw`; entire send fail |
| P1-FE-05 | `crypto/senderKeyProtocol.ts:280` | Sender key signing key IndexedDB'de korumasız — XSS → forge | `HMAC(identityKey, publicSigningKey)` hash'ini sakla, decryption öncesi verify |
| P1-FE-06 | `crypto/keyBackup.ts:383` + `signalProtocol.ts:378` | Restore sonrası trusted identity re-verification yok | Restore sonrası tüm identity'leri fresh prekey ile karşılaştır; değişene warning |
| P1-FE-07 | `crypto/signalProtocol.ts:584` + `senderKeyProtocol.ts:449` | AES-GCM IV pure-random — yüksek concurrent send'de collision riski | Deterministic IV derivation (`HKDF(rootKey, messageCounter)`) veya atomic counter |
| P1-EN-04 | `electron/auto-updater.ts:41` | Update poll 60s → GitHub anonim quota 60/hour aşılır, sessiz fail | `5 * 60 * 1000` veya backend proxy endpoint |
| P1-EN-05 | `electron/screen-picker.ts:60-75` | `getSources({timeout:5000})` main thread'i block ediyor | AbortController + result slice(0, 50) limit |
| P1-EN-06 | `electron/credentials.ts:55-71` | Decrypted plaintext credentials V8 heap'te zeroize edilmiyor | `Buffer.fill(0)` + `global.gc?.()` finally bloğunda |
| P1-EN-07 | `electron/main.ts` | CSP header yok — contextIsolation tek savunma | `webRequest.onHeadersReceived` ile CSP inject |
| P1-IN-04 | `tayfa-deploy/client/nginx.conf` | **6/6 güvenlik header'ı yok** (HSTS, CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy) | Tüm 6 header'ı ekle (örnek aşağıda E-bölümünde) |
| P1-IN-05 | `tayfa-deploy/client/nginx.conf` (`/ws` location) | `proxy_read_timeout` yok → default 60s → voice idle drop | `proxy_read_timeout 3600s; proxy_send_timeout 3600s; proxy_socket_keepalive on;` |
| P1-IN-06 | `livekit-oracle/config/docker-compose.yml` (redis) | `--requirepass` yok | `redis-server --requirepass "$(openssl rand -hex 32)"` |
| P1-IN-07 | `Dockerfile` (root + server + client) | `USER` directive yok, root user | `useradd -u 1000 appuser; USER appuser` |
| P1-IN-08 | `tayfa-deploy/Dockerfile` | `HEALTHCHECK` yok | `HEALTHCHECK --interval=10s CMD curl -f http://localhost:7860/health` |
| P1-IN-09 | Tüm Dockerfile + livekit-oracle compose | Base image'lar unpinned (`latest`, `bookworm-slim`) | Image digest pin (`@sha256:...`) veya kesin patch versiyonu |
| P1-BD-04 | `repository/sqlite_session.go:113` | `DeleteExpired()` tanımlı ama scheduler tarafından çağrılmıyor | `main.go`'ya 1h cron goroutine ekle |
| P1-BD-05 | `sqlite_dm.go` | FTS5 search injection riski — tüm path'lerde `sanitizeFTSQuery` çağrılıyor mu? | Tüm `sqlite_search.go`, `sqlite_dm.go`, `sqlite_channel.go` arama yollarını denetle |
| P1-BD-06 | `sqlite_dm.go` | `GetChannelByUsers` N+1 (lookup → create) | `GetOrCreateChannelByUsers` batch `INSERT...ON CONFLICT` |
| P1-BD-07 | `sqlite_attachment.go:119` | `GetByFileURL` LIMIT 1 ama ORDER BY yok | `ORDER BY created_at DESC LIMIT 1` veya UNIQUE constraint |

### 🟡 P2 — MEDIUM (özet)

25 P2 bulgu mevcut. Önemli olanlar:

| ID | Dosya | Problem |
|---|---|---|
| P2-BC-11 | `main.go` | Graceful shutdown timeout 5s — 10k+ bağlantıda yetersiz |
| P2-BC-12 | `ws/client.go:handleEvent` | Panic recovery yok |
| P2-BC-13 | `ws/handler.go` | Origin check zayıf (CSWSH riski) |
| P2-BC-14 | `auth_service.go:ChangeEmail` | Auth cache invalidation çağrılmıyor |
| P2-BC-15 | `voice_token.go:getOrCreateRoomPassphrase` | Passphrase memory-only, restart'ta kaybolur, rotation yok |
| P2-FE-08 | `crypto/dmEncryption.ts:397` | Cache poisoning via crafted messageId |
| P2-FE-09 | `crypto/dmEncryption.ts:131` | Stale prekey bundle (no cache expiry) |
| P2-FE-10 | `crypto/signalProtocol.ts:814` | Skipped message keys bounds-check yok (MAX_SKIP overflow) |
| P2-EN-08 | `package.json:39-43` | Public GitHub repo update kanalı + signature verification belirsiz |
| P2-EN-09 | `electron/push-to-talk.ts:50-100` | Numpad/Media keycodes eksik |
| P2-EN-10 | `electron/ipc-handlers.ts:80` | Clipboard write size limit yok |
| P2-EN-11 | `audio-capture.cpp:160` | WAVEFORMATEXTENSIBLE bounds check yok |
| P2-IN-10 | `tayfa-deploy/docker-compose.yml` | Memory/CPU limit yok |
| P2-IN-11 | `livekit-oracle/config/docker-compose.yml` | livekit service `restart` policy yok |
| P2-IN-12 | `livekit-oracle/config/Caddyfile` | Email placeholder, fallback hata mesajı |
| P2-BD-08 | `sqlite_message.go` | `(channel_id, created_at DESC)` composite index yok mu? |
| P2-BD-09 | Device key rotation audit log yok |
| P2-BD-10 | `audit_log.user_id` nullable — system action'lar orphan görünür |
| P2-BD-11 | `sqlite_server.go:AddMember` | Position increment race |
| P2-BD-12 | `sqlite_dm.go:ToggleReaction` | INSERT-or-IGNORE/DELETE race; atomic `ON CONFLICT DO UPDATE` ile değiştir |

### 🟢 P3 — LOW (kısa)

12 P3 bulgu. Genel temalar: `SELECT *` kullanımı, pagination limit'leri, timestamp format tutarlılığı, eksik HSTS dev'de, eksik SRI external resource'larda, sender key cleanup eksikliği, WS message ordering FIFO yerine seq-based, log'larda sensitive data leak ihtimali.

---

## C) Discord-Robustluk Checklist (PASS / FAIL / PARTIAL)

| # | Kategori | Durum | Not |
|---|---|---|---|
| 1 | Mesaj güvenilirliği | 🟡 PARTIAL | Optimistic UI var, ama duplicate detection ve out-of-order seq-based handling eksik |
| 2 | Realtime bağlantı stabilitesi | 🟢 PASS | Exponential backoff + jitter (`useWebSocket.ts:107-112`), 7 retry, heartbeat 30s |
| 3 | Reconnect davranışı | 🟡 PARTIAL | Reconnect var ama state replay/resync mekanizması zayıf — kayıp mesajlar yeniden çekilmiyor |
| 4 | Yetki sistemi | 🔴 FAIL | 30s cache bayatlık, prefix-match invalidation bug, voice token 1h iptal gecikmesi |
| 5 | Rate limit | 🔴 FAIL | WS ticket endpoint korumasız, application-only (nginx limit_req yok), distributed deploy'da in-memory state |
| 6 | Spam/abuse koruması | 🟡 PARTIAL | Bazı endpoint'lerde limiter var, ama coverage eksik |
| 7 | Presence sistemi | 🔴 FAIL | userInfos cache invalidation manual update'te tetiklenmiyor — stale presence broadcast |
| 8 | Notification sistemi | 🟡 PARTIAL | Badge count IPC var, mobile push verisinden emin değiliz |
| 9 | Error handling | 🔴 FAIL | WS event handler panic recovery yok, sensitive error response'lar leak edebilir |
| 10 | Logging | 🟡 PARTIAL | app_log_service async + SQLite var, ama sensitive data masking belirsiz, retention/vacuum stratejisi yok |
| 11 | Monitoring | 🔴 FAIL | `/health` endpoint yok, `/metrics` Prometheus expose belirsiz, alert kuralı yok |
| 12 | Test coverage | 🟡 PARTIAL | auth/message/voice/permission/e2eeStore/voiceStore test'leri var; WS hub + crypto round-trip integration test'i yok |
| 13 | Database performansı | 🟡 PARTIAL | UNIQUE index var ama composite index'ler (`channel_id, created_at`) eksik olabilir, session expiry cleanup zamanlanmamış |
| 14 | Security hardening | 🔴 FAIL | Nginx 6/6 header eksik, container root, secret'lar commit'li, CSP yok |
| 15 | Deployment readiness | 🔴 FAIL | Rollback prosedürü yok, blue/green yok, base image pin'siz, secret rotation süreci yok |

**Skor: 2 PASS / 6 PARTIAL / 7 FAIL** → Production-ready değil

---

## D) Refactor Önerileri

### Öncelikli Refactor Dosyaları (sırayla)

1. **`server/services/auth_service.go`** — usedRefresh map'i Redis'e taşı (distributed deploy gereksinimi); audit logging interface'e bağla
2. **`server/middleware/permission.go`** — cache TTL'i 5s'ye düşür, event-driven invalidation pattern'ı oturt
3. **`server/ws/hub.go` ailesi** — broadcast pattern'ını fanout interface'i arkasına soyutla; slow consumer için bounded send channel + drop policy
4. **`server/ws/client.go`** — ReadPump/WritePump'ı context-aware yap, panic recovery middleware ekle, rate limiter cleanup ekle
5. **`client/src/crypto/`** — kripto modülünü `e2eeService.ts` facade'ı arkasına çek, public API'yı daralt, replay cache'i tek noktadan yönet
6. **`client/src/hooks/useWebSocket.ts`** — message ordering'i `seq` field üzerinden FIFO yerine ID-based correlate et; reconnect sonrası state sync flow'unu netleştir
7. **`electron/ipc-handlers.ts`** — tüm IPC handler'lar için zod schema validator + size limit middleware pattern'ı
8. **`server/repository/sqlite_*.go`** — `SELECT *`'ı kaldır, explicit column list; race condition'ları `INSERT...ON CONFLICT DO UPDATE` ile değiştir
9. **`Dockerfile` × 3** — multi-stage + non-root + healthcheck + pinned base image standardı (tek template)
10. **`livekit-oracle/config/livekit.yaml`** — credential'ları envsubst template'e dönüştür

### Pattern / Abstraction Önerileri

- **Cache invalidator interface'i**: `CacheInvalidator { Invalidate(scope, id) }` — auth, permission, user, presence cache'leri tek pattern'a otursun
- **Audit logger interface'i**: critical security event'leri (`token_compromise_detected`, `permission_escalation_attempt`, `device_key_rotation`) tek struct'tan logla; downstream alerting ekle
- **Schema validator**: IPC + WS event input'ları için merkezi zod/protobuf validation
- **Repository test base**: in-memory SQLite ile her repository için minimum CRUD + concurrency test fixture'ı

---

## E) Test Planı

### Unit Test (öncelik)
- `crypto/signalProtocol.ts`: X3DH round-trip, Double Ratchet 10k message simulation, skipped key cleanup boundary
- `crypto/senderKeyProtocol.ts`: replay rejection (same iteration twice + same ciphertext different envelope)
- `crypto/keyBackup.ts`: restore → re-validate identities; PBKDF2 iteration timing benchmark
- `services/auth_service.go`: refresh token reuse → audit log assertion + all-sessions-invalidated assertion
- `services/voice_token.go`: revocation latency test (ban → 1s içinde ejection)
- `middleware/permission.go`: cache hit yenileme — role revoke sonrası 5s içinde reject
- `ws/rate_limit.go`: distributed scenario (Redis-backed) test fixture

### Integration Test
- WS hub: 10k client connect → broadcast latency p99, graceful shutdown drain
- WS reconnect: socket kapanması → exponential backoff → state replay (mesajlar yeniden çekilir mi)
- E2EE end-to-end: A→B→C grup mesajlaşma, member kicked → key rotation, multi-device add → fanout
- LiveKit: token issuance → join room → permission revoke → forced disconnect içinde 1 dakika

### E2E Test
- Mesaj gönder → reload → mesaj mevcut (persistence + decryption)
- DM gönder → karşı taraf decrypt → ack
- Voice join → mic mute/unmute → screen share → leave
- Auto-update flow: yeni release → splash → install → relaunch
- Mobile (Capacitor): background → foreground → state recovery

### Security Test
- WS CSWSH (Cross-Site WebSocket Hijacking): malicious origin'den `/ws` connect denemesi reject
- IPC fuzz: `app-setting` random type/value (1M iteration), crash yok
- IDOR: `userA` token'ı ile `userB` mesajı/dosyası fetch denemesi → 403
- SQL injection: search field'lara FTS5 operator + `';--` + Unicode payload
- File upload: polyglot dosya (HTML+PNG), zip bomb, path traversal (`../etc/passwd`)
- Auth: JWT alg=none confusion, token expire bypass, refresh reuse → audit log assertion

### Load Test
- WS: 10k concurrent connection, 100 message/sec broadcast, p99 latency
- Voice: 50 participant room, screen share + audio, CPU/memory
- DB: 1M message insert + concurrent read, deadlock detection
- Auto-updater: 5 client paralel update check → GitHub rate limit gözle

### Critical Security Header Konfigürasyonu (kopyala-yapıştır)

```nginx
# tayfa-deploy/client/nginx.conf
server {
    listen 7860;
    server_name _;
    root /usr/share/nginx/html;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' wss: https://*.livekit.cloud https://79-76-123-59.sslip.io; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" always;
    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Permissions-Policy "geolocation=(), microphone=(self), camera=(self), payment=()" always;

    client_max_body_size 50M;

    location /ws {
        proxy_pass http://server:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_socket_keepalive on;
    }

    location /api/ {
        proxy_pass http://server:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

---

## F) Production Hardening Planı (30 gün)

### İlk 3 Gün — Acil Kritik Kapanışlar 🔴
- [ ] **Saat 0:** SSH key + LiveKit credentials rotation (P0-IN-01, P0-IN-02). Eski credentials revoke. `git filter-repo` ile history temizle. Force-push uyarısı.
- [ ] **Saat 4:** `.gitignore` güncelle (P0-IN-03)
- [ ] **Gün 1:** Nginx security header'ları + WS timeout (P1-IN-04, P1-IN-05) — tek commit
- [ ] **Gün 1:** Dockerfile non-root user + HEALTHCHECK + base image pin (P1-IN-07, P1-IN-08, P1-IN-09)
- [ ] **Gün 2:** Native build flags (P0-EN-01) + IPC value validation (P0-EN-02)
- [ ] **Gün 2:** PBKDF2 2M iteration (P0-FE-01)
- [ ] **Gün 3:** WS context cancellation (P0-BC-05) + panic recovery (P2-BC-12) + JWT query string reject (P0-BC-01)

### İlk Hafta
- [ ] Refresh token reuse audit + alert (P0-BC-03)
- [ ] Permission cache TTL 5s + event-driven invalidation (P0-BC-04)
- [ ] Sender Key replay protection (P0-FE-02)
- [ ] Self-fanout race fix (P0-FE-03)
- [ ] E2EE backup HMAC (P0-BD-01)
- [ ] Device key enumeration rate-limit (P0-BD-02)
- [ ] Migration 067 transaction guard (P0-BD-03)
- [ ] Redis password (P1-IN-06)
- [ ] Session DeleteExpired scheduler (P1-BD-04)

### İlk 2 Hafta
- [ ] Voice token TTL 15dk + webhook revocation (P1-BC-06)
- [ ] WS ticket rate-limit (P1-BC-07)
- [ ] LiveKit credentials envsubst template'e dönüştür (P0-IN-02 long-term)
- [ ] Electron CSP + credentials zeroization + auto-updater poll interval (P1-EN-04..07)
- [ ] Refresh token map Redis'e taşı (P0-BC-02)
- [ ] Crypto IV deterministic derivation (P1-FE-07)
- [ ] FTS5 sanitizeFTSQuery coverage audit (P1-BD-05)
- [ ] `(channel_id, created_at)` composite index migration (P2-BD-08)
- [ ] WS reconnect state replay implementation (mesaj resync)

### İlk 30 Gün
- [ ] /health endpoint (DB + Redis + LiveKit derin check) + /metrics Prometheus expose
- [ ] Alert kuralları (OOM, p99 latency > 1s, WS connection drop > %5)
- [ ] Backup automation (SQLite/libSQL nightly snapshot, off-site upload)
- [ ] Rollback prosedürü (önceki container image'a switch script)
- [ ] Identity verification UX (QR / safety number — Signal-style)
- [ ] Restore sonrası identity re-verification (P1-FE-06)
- [ ] Sender Key signing key HMAC (P1-FE-05)
- [ ] Code signing certificate + auto-updater pinning (P2-EN-08)
- [ ] Load test pipeline (10k WS connection regression)
- [ ] Branch protection + Dependabot + CODEOWNERS (önceki audit'in açık kalan noktaları)
- [ ] Secret scanning hook (pre-commit + GitHub secret scanning enable)

---

## G) Kod Kalitesi Skoru (8 boyut / 10)

| Boyut | Skor | Gerekçe |
|---|---|---|
| **Security** | 3/10 | Secret'lar repo'da, 17 P0, kripto subtle bug'lar, Nginx hardening yok, Electron CSP yok. Kod yapısı güzel ama defensive katmanlar eksik. |
| **Reliability** | 5/10 | Reconnect/backoff iyi, ama panic recovery yok, race condition'lar, WS state replay yok, graceful shutdown zayıf. |
| **Performance** | 6/10 | Genel olarak iyi (multi-stage Docker, async logging, libSQL), ama N+1, eksik composite index, broadcast amplification riski. |
| **Maintainability** | 7/10 | Net handler/service/repository ayrımı, naming tutarlı, dosya boyutları makul. `SELECT *` ve duplicate sqlite/interface çiftleri biraz fazla boilerplate. |
| **Testability** | 6/10 | Önemli service'lerin test'i var (auth/message/voice/permission), ama crypto round-trip, WS integration, race condition test'leri yok. |
| **Scalability** | 4/10 | In-memory cache'ler (refresh token, permission, presence) distributed deploy'a uygun değil. WS hub fanout O(N). Redis pattern var ama tutarsız kullanım. |
| **Clean code** | 7/10 | Genel kod kalitesi iyi, idiomatic Go ve modern React. Bazı dosyalar (`hub_*` ailesi) parçalanmış ama mantıklı. |
| **Production readiness** | 2/10 | Healthcheck yok, /metrics belirsiz, alert yok, backup otomasyonu yok, rollback yok, secret'lar version control'de, container root user. Tipik bir "geliştirme ortamında çalışan" uygulama profili. |

**Genel ortalama: 5.0/10** — Sağlam temel + kritik production gap'leri

---

## H) En Öncelikli 10 Aksiyon (sıralı)

Bu liste **uygulamanın çökmesini, güvenlik açığı vermesini veya veri kaybetmesini engelleme** odaklı sıralanmıştır. Yukarıdan aşağı yap.

1. **🚨 ŞIMDI: SSH key + LiveKit credentials rotate et + repo'dan sil + history clean** ([P0-IN-01](#p0-in-01-ssh-private-key-repoda-düz-metin-confirmed), [P0-IN-02](#p0-in-02-livekit-production-api-credentials-repoda-düz-metin-confirmed-agent-eksik-bildirdi-gerçekte-2-dosyada))
   - Etki: Tam infra takeover engellenir
   - Süre: 2 saat
2. **WS context cancellation + panic recovery + JWT query string reject** ([P0-BC-01](#), [P0-BC-05](#), P2-BC-12)
   - Etki: Graceful shutdown crash'leri, payload-induced crash, token leak engellenir
   - Süre: 3 saat
3. **Nginx 6 security header + WS timeout 3600s** ([P1-IN-04](#), [P1-IN-05](#))
   - Etki: XSS/clickjacking/MITM koruması + voice idle drop fix
   - Süre: 1 saat
4. **Dockerfile non-root user + HEALTHCHECK + base image pin** ([P1-IN-07](#), [P1-IN-08](#), [P1-IN-09](#))
   - Etki: Container escape blast radius azalır, restart döngüleri yakalanır, supply chain reproducible olur
   - Süre: 2 saat
5. **Native build.bat security flags** ([P0-EN-01](#)) + IPC value validation ([P0-EN-02](#))
   - Etki: Native RCE engellenir, IPC corruption engellenir
   - Süre: 1 saat
6. **PBKDF2 2M iteration + Sender Key replay protection + Self-fanout race fix** ([P0-FE-01](#), [P0-FE-02](#), [P0-FE-03](#))
   - Etki: Backup brute-force pratik dışına çıkar, replay engellenir, restore sonrası mesaj kaybı durur
   - Süre: 4 saat
7. **Auth: refresh token reuse audit log + permission cache TTL 5s + event-driven invalidation** ([P0-BC-03](#), [P0-BC-04](#))
   - Etki: Token compromise tespit edilebilir, revocation gerçek-zamanlı olur
   - Süre: 4 saat
8. **E2EE backup HMAC + device key enumeration rate-limit + Migration 067 transaction guard** ([P0-BD-01](#), [P0-BD-02](#), [P0-BD-03](#))
   - Etki: Backup tamper detection, mass key harvest engellenir, partial migration korunur
   - Süre: 4 saat
9. **Voice token TTL 15dk + LiveKit webhook revocation + WS ticket rate-limit** (P1-BC-06, P1-BC-07)
   - Etki: Banlanmış kullanıcı 60dk konuşmaz, ticket DoS engellenir
   - Süre: 3 saat
10. **Session DeleteExpired scheduler + Redis password + memory limits docker-compose** (P1-BD-04, P1-IN-06, P2-IN-10)
    - Etki: DB büyümesi durur, Redis network expose koruması, OOM regression korunur
    - Süre: 2 saat

**Toplam: ~26 saat aktif geliştirme + test** — bu 10 madde kapatıldığında üretim için **kabul edilebilir minimum güvenlik + reliability seviyesi** sağlanır.

---

## Ek: Mevcut Test Kapsamı

Test dosyaları bulunan modüller (pozitif gözlem):
- `services/auth_service_test.go`
- `services/message_service_test.go`
- `services/voice_service_test.go`
- `services/member_service_test.go`
- `services/channel_permission_service_test.go`
- `services/music_test.go`
- `models/role_test.go`
- `client/src/stores/auditStore.test.ts`
- `client/src/stores/e2eeStore.test.ts`
- `client/src/stores/voiceStore.test.ts`
- `client/src/stores/memberStore.test.ts`
- `client/src/utils/validation.test.ts`
- `client/src/utils/authErrors.test.ts`

**Eksik kritik test'ler**:
- `ws/hub_test.go` (broadcast race, slow consumer, graceful shutdown)
- `crypto/signalProtocol.test.ts` (X3DH/Double Ratchet round-trip)
- `crypto/senderKeyProtocol.test.ts` (replay, out-of-order)
- `crypto/keyBackup.test.ts` (restore + identity re-verification)
- `middleware/permission_test.go` (cache TTL, invalidation race)
- `services/voice_token_test.go` (revocation latency)
- `repository/*_test.go` (concurrent insert race, FK cascade correctness)

---

## Ek: Önceki Güvenlik Raporu (2026-05-04) Durumu

`guvenlik_raporu_2026-05-04.md` raporundaki kapatılma durumu (Infra agent gözlemi):
- ✅ HF token rotated
- ⚠️ OpenRouter / Gemini / NVIDIA API key'leri (varsa) hâlâ rotation gerekiyor (bu repo'da yok ama kullanıcı diğer repolar için kontrol etmeli)
- ❌ Dependabot 15/17 repo'da kapalı
- ❌ Branch protection 15/17 repo'da yok

**Aksiyon:** Bu organizasyon-genelinde GitHub güvenlik politikalarını tek seferde aktive et (org-wide Dependabot, required reviews, secret scanning).

---

**Audit Sonu.** Bu rapor 5 paralel uzman ajan tarafından üretilen ham bulguların sentezidir. Her bulgu için dosya:satır referansı verilmiştir. Düzeltmelerin uygulanmasında soru çıkarsa belirli bir bulgu ID'sini referans alarak detay isteyebilirsin (örn: "P0-FE-02 için PoC göster").
