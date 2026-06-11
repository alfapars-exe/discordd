# HiChat — Audit 2026-05-27 Remediation Playbook

Bu döküman `CODE_AUDIT_2026-05-27.md` raporundaki bulgular için **uygulanan düzeltmeler** + **senin yapman gereken kalan aksiyonlar**'ı listeler.

---

## 1. Uygulanan Düzeltmeler (Bu Audit Oturumunda)

### Phase 0 — Config / Infra (7 dosya)

| # | Dosya | Yapılan |
|---|---|---|
| 0a | `tayfa-deploy/.gitignore` | `ssh/`, `livekit-oci*`, `*id_ed25519*`, cloud creds eklendi |
| 0a | `livekit-oracle/.gitignore` | (Yeni) `ssh/`, `.env`, `config/livekit.yaml` (generated) |
| 0b | `livekit-oracle/config/livekit.yaml` | Production credentials → **redacted placeholder** (uyarı yorumu) |
| 0b | `livekit-oracle/config/livekit.yaml.template` | (Yeni) envsubst için template |
| 0c | `livekit-oracle/config/.env.example` | Real credentials → placeholder, `openssl rand` komut örnekleri |
| 0c | `livekit-oracle/DEPLOYED.md` | API Key/Secret cells redacted, audit uyarısı eklendi |
| 0d | `tayfa-deploy/client/nginx.conf` | HSTS+CSP+X-Frame-Options+X-Content-Type-Options+Referrer-Policy+Permissions-Policy; WS proxy_read_timeout 3600s; dotfile block |
| 0e | `tayfa-deploy/native/build.bat` | `/GS /sdl /guard:cf /DYNAMICBASE /NXCOMPAT /HIGHENTROPYVA` + dumpbin verify — **CI hizalandı 2026-06-11:** `.github/workflows/build-desktop.yml` aynı flag setiyle derliyor (`/WX` hariç, runner MSVC sürüm farkı) + her bayrağı tek tek assert eden `dumpbin /headers /loadconfig` doğrulama adımı eklendi; **build.bat hizalandı 2026-06-11:** aynı per-flag doğrulama build.bat'a da taşındı + vcvars64 artık vswhere ile dinamik bulunuyor |
| 0f | `tayfa-deploy/Dockerfile` | HEALTHCHECK on /api/health + self-host user comment block |
| 0f | `tayfa-deploy/server/Dockerfile` | useradd UID 1000 + USER hichat + HEALTHCHECK |
| 0f | `tayfa-deploy/client/Dockerfile` | wget healthcheck + apk add wget |
| 0g | `livekit-oracle/config/docker-compose.yml` | Redis `--requirepass ${REDIS_PASSWORD:?...}`, resource limits, pinned versions (redis:7.4 / caddy:2.8 / livekit:v1.8.4) |

### Phase 1 — Client + Electron (7 değişiklik)

| # | Dosya | Yapılan | Test |
|---|---|---|---|
| 1a | `client/src/crypto/keyBackup.ts` | PBKDF2 1M → **2M**, cryptographic agility via `algorithm` string, backwards-compat for legacy backups | 7 yeni test geçti |
| 1a | `client/src/stores/e2eeStore.ts` | `algorithm` field'ı restore call'da geçiriliyor | (covered) |
| 1b | `electron/ipc-handlers.ts` | Tüm IPC handler'larda type+range validation: `set-app-setting`, `set-badge-count`, `write-clipboard` (10MB), `save-credentials` (length bounds), `register-ptt-shortcut` | tsc clean |
| 1c | `electron/main.ts` | CSP zaten implement edilmişti (false positive bulgu) — verified |
| 1d | `electron/credentials.ts` | Buffer.fill(0) zeroization + plaintext reference nullification + `globalThis.gc?.()` hint | tsc clean |
| 1e | `electron/auto-updater.ts` | Poll interval 60s → **5min** (GitHub anonim quota) | — |
| 1f | `client/src/crypto/senderKeyProtocol.ts` | Defensive comment: AES-GCM IV random güvenli (per-message unique key) — replay protection zaten doğru implement edilmişti | — |

**Test sonuçları:** Client suite 89/89 passing, tsc clean (client + electron).

### Phase 2 — Server-side Go (9 değişiklik)

| # | Dosya | Yapılan |
|---|---|---|
| 2a | `server/ws/handler.go` | Legacy `?token=` JWT query path **default reject** + `HICHAT_ALLOW_LEGACY_WS_TOKEN=1` opt-in + her kullanımda audit event |
| 2b | `server/ws/client.go` | `handleEvent` defer/recover + stack trace log + Error-level audit event + connection close |
| 2b | `server/ws/hub.go` | `Shutdown()` two-phase: `close(send)` + `conn.Close()` (10k bağlantıda 90s → ms scale) + mutex held only for snapshot |
| 2c | `server/services/auth_service.go` | `logError` helper, refresh token reuse audit'i Warn → **Error + structured metadata**, `usedRefreshEmergencyThreshold=10000` ile inline eviction |
| 2d | `server/middleware/permission.go` | TTL `30s → 5s` (revocation window) + neden/trade-off yorumu |
| 2e | `server/services/voice_token.go` | TTL `1h → 15min` (voice + screen share) + voiceTokenTTL sabit |
| 2f | `server/init_services.go` | `RateLimiters.WSTicket` field + `NewLoginRateLimiter(30, 1*time.Minute)` |
| 2f | `server/handlers/auth.go` | `wsTicketLimiter` constructor param + `WSTicket` handler IP-based check + Retry-After |
| 2f | `server/init_handlers.go` | `limiters.WSTicket` constructor'a geçiriliyor |

**Doğrulama:** `gofmt -d` clean, `go vet ./ws/...` clean. `handlers/` + `services/` Windows'ta libsql cgo blocked (kod hatası değil — aşağı bak).

---

## 2. Senin Yapman Gereken Aksiyonlar

### 🚨 P0 — SHIMDI (saatler içinde)

#### 2.1 SSH Key Rotation (kritik — repo'da hâlâ tarihsel olarak var)

```powershell
# 1. Yeni SSH key pair üret (lokal)
ssh-keygen -t ed25519 -f $HOME\.ssh\livekit-oci-new -C "livekit-oci-2026-05"
# -N "" parametresi ile passphrase'siz olur; production için passphrase önerilir

# 2. Yeni public key'i Oracle Console'da ekle:
#    Compute → Instance → livekit-server → Edit → "SSH Keys" → Add public key
#    Yeni .pub içeriğini yapıştır.

# 3. Yeni anahtarla bağlanabildiğini doğrula:
ssh -i $HOME\.ssh\livekit-oci-new ubuntu@79.76.123.59

# 4. Eski key'i Oracle Console'da kaldır:
#    Aynı menüde "Remove" eski APIeb80fb802673... key'i

# 5. Eski lokal dosyaları sil:
Remove-Item C:\Users\harun\OneDrive\Desktop\Discord\livekit-oracle\ssh\livekit-oci
Remove-Item C:\Users\harun\OneDrive\Desktop\Discord\livekit-oracle\ssh\livekit-oci.pub

# 6. Test: eski key bağlantısını DENEMELI ve fail etmeli
# ssh -i .\livekit-oracle\ssh\livekit-oci ubuntu@79.76.123.59
# → Permission denied (publickey) bekleniyor
```

#### 2.2 LiveKit API Credentials Rotation

```bash
# VM'ye yeni SSH key ile bağlan (yukarıdaki adımdan sonra)
ssh -i ~/.ssh/livekit-oci-new ubuntu@79.76.123.59

# VM'de:
cd /path/to/livekit/config

# Yeni API key/secret üret
NEW_API_KEY="API$(openssl rand -hex 6)"
NEW_API_SECRET=$(openssl rand -base64 48 | tr -d '=' | tr '+/' '-_')
NEW_REDIS_PWD=$(openssl rand -hex 32)

# .env dosyasını güncelle
cat > .env <<EOF
LIVEKIT_DOMAIN=79-76-123-59.sslip.io
LIVEKIT_API_KEY=$NEW_API_KEY
LIVEKIT_API_SECRET=$NEW_API_SECRET
REDIS_PASSWORD=$NEW_REDIS_PWD
HICHAT_WEBHOOK_URL=https://argeinfina-discord.hf.space/api/livekit/webhook
EOF
chmod 600 .env

# Generated livekit.yaml'ı yeniden üret
envsubst < livekit.yaml.template > livekit.yaml
chmod 600 livekit.yaml

# Stack'i restart et
docker compose down && docker compose up -d

# Logs kontrolü — eski key'le bağlanmaya çalışan istemciler 401 dönmeli
docker compose logs livekit | grep -i "invalid token"
```

**ARDINDAN HiChat backend tarafında**: HF Space settings → Secrets → `LIVEKIT_API_KEY` + `LIVEKIT_API_SECRET` güncelle → Space restart.

#### 2.3 Git History Rewrite (commit'lenmiş secret'ları silmek)

> ⚠️ **DESTRUCTIVE**: Tüm collaborator'lar rebase etmek zorunda kalır. Force-push gerektirir. Yapmadan önce **repo'nun mirror'ını al** (backup).

**Backup:**
```powershell
git clone --mirror https://github.com/owner/repo discord-backup-2026-05-27.git
```

**Filter-repo install** (yoksa):
```powershell
pip install git-filter-repo
# veya
winget install git-filter-repo
```

**SSH key + livekit.yaml secret'ları history'den sil:**
```powershell
# livekit-oracle repo'sundaysan:
cd C:\Users\harun\OneDrive\Desktop\Discord\livekit-oracle

# Dry-run önce
git filter-repo --analyze --force

# Gerçek silme — dosya bazlı
git filter-repo --invert-paths --path ssh/livekit-oci --path ssh/livekit-oci.pub --force

# Belirli string'leri (eski API key) içeren tüm geçmiş içeriği sansürle
echo "APIeb80fb802673==>API_KEY_REDACTED" > replace.txt
echo "IK9KCzUqXrf99of9X-jVLGbse4mBhUC0tnj21qNhlMrT65_bBEijRIXbJcmJCP73==>API_SECRET_REDACTED" >> replace.txt
git filter-repo --replace-text replace.txt --force

# Force-push (tüm branch'ler + tag'ler)
git push --force --all
git push --force --tags

# Collaborator'lara uyarı: hepsi git clone --mirror'lardan repo'yu yeniden clone'lamalı
```

**Alternatif (daha güvenli ama agresif): yeni clean repo**
- Eski repo'yu **private/archive** yap
- Yeni repo oluştur, `--no-history` clone et, ilk commit'i "Initial commit (history rewrite 2026-05-27 audit)" olarak push'la
- Collaborator'lar yeni repo'ya geçer
- Eski repo'da issue tarihçesi vs için 30 gün arşiv tut, sonra delete

### 🟠 P1 — Bu Hafta

#### 2.4 Docker'da Tam Server Build + Test Doğrulama

Windows'ta `tursodatabase/go-libsql` cgo build edemiyor (cgo wrapper Linux/macOS-only). Linux container'da koş:

```powershell
# Docker Desktop'ı başlat (kapalıysa)

# Server build doğrulaması
docker run --rm -v "C:\Users\harun\OneDrive\Desktop\Discord\tayfa-deploy:/src" `
  -w /src/server golang:1.25-bookworm `
  bash -c "apt-get update -q && apt-get install -yq gcc && go build ./..."

# Server test suite
docker run --rm -v "C:\Users\harun\OneDrive\Desktop\Discord\tayfa-deploy:/src" `
  -w /src/server golang:1.25-bookworm `
  bash -c "apt-get update -q && apt-get install -yq gcc && go test ./..."

# Eklediğim bulgulara spesifik test (mevcut testlerden):
# - auth_service_test.go: refresh token reuse path
# - voice_service_test.go: token TTL
# - channel_permission_service_test.go: permission cache
```

**Beklenen sonuç**: tüm package'lar build oluyor, test'ler pre-audit baseline ile aynı (regression yok).

#### 2.5 Nginx Config Syntax Test

```powershell
# Docker ile
docker run --rm `
  -v "C:\Users\harun\OneDrive\Desktop\Discord\tayfa-deploy\client\nginx.conf:/etc/nginx/conf.d/default.conf:ro" `
  nginx:alpine nginx -t

# Beklenen: "syntax is ok" + "test is successful"
```

#### 2.6 Native Build Doğrulaması

```powershell
cd C:\Users\harun\OneDrive\Desktop\Discord\tayfa-deploy\native
.\build.bat
# build.bat her hardening flag'ini ayrı ayrı doğrular ve eksik flag'de exit 1 verir
# (CI'daki "Verify audio-capture.exe hardening flags" adımıyla aynı mantık).

# Manuel doğrulama (build.bat'ın yaptığının PowerShell karşılığı):
$out = (dumpbin.exe /headers /loadconfig audio-capture.exe) -join "`n"
$required = [ordered]@{
  'NX compatible (DEP)'           = 'NX compatible'
  'Dynamic base (ASLR)'           = 'Dynamic base'
  'High Entropy VA (64-bit ASLR)' = 'High Entropy Virtual Addresses'
  'Control Flow Guard (CFG)'      = 'Control Flow Guard|CF Instrumented'
}
$missing = @($required.GetEnumerator() | Where-Object { $out -notmatch $_.Value } | ForEach-Object { $_.Key })
if ($missing.Count) { "EKSIK: $($missing -join ', ')" } else { "Tum hardening flag'leri mevcut" }
# Beklenen: "Tum hardening flag'leri mevcut"
```

> **Not (2026-06-11):** Buradaki eski tek satırlık `findstr /C:"NX" /C:"Dynamic" /C:"CF Guard" /C:"High Entropy"` komutu iki nedenle hatalıydı: (1) findstr çoklu `/C:` desenlerinde HERHANGİ biri eşleşince başarılı döner — tek tek eksik flag yakalanmaz; (2) `"CF Guard"` dizesi dumpbin çıktısında hiç geçmez — CFG, `/headers` çıktısında `Control Flow Guard`, `/loadconfig` çıktısında `CF Instrumented` olarak görünür. Dolayısıyla eski "4 satır match" beklentisi yanlıştı; CFG satırı hiçbir zaman eşleşemezdi.

#### 2.7 HF Space Secret Rotation

HF Space dashboard → Settings → Variables and secrets:
- `LIVEKIT_API_KEY` → yeni değer
- `LIVEKIT_API_SECRET` → yeni değer
- `LIVEKIT_WS_URL` → değişmedi
- Eski `JWT_SECRET` → eğer >6 ay eskiyse rotate öner (otomatik gerekmiyor)

Save → Space otomatik restart.

### 🟡 P2 — Bu Sprint (1-2 hafta)

#### 2.8 Kalan Bulgular (Code Audit'ten — bu oturumda yapılmadı)

Aşağıdakiler P0-P1 değil ya da daha geniş kapsam gerektiriyor. Audit raporundaki ID'lerle:

| ID | Açıklama | Tahmini efor | Durum |
|---|---|---|---|
| P0-FE-03 | self-fanout race fix (`dmEncryption.ts`) | Yarım gün | Açık |
| P0-BD-01 | E2EE backup HMAC integrity check (migration + service) | 1 gün | ✅ KAPANDI — migration `070_e2ee_backup_hmac.sql`, `pkg/crypto/hmac.go` (HKDF subkey + length-prefixed canonical encoding), verify-on-read `services/e2ee_service.go`; testler `pkg/crypto/hmac_test.go` + `services/e2ee_backup_test.go` |
| P0-BD-02 | Device key enumeration rate-limit endpoint-spesifik | Yarım gün | ✅ KAPANDI — `deviceEnumLimiter` (30/dk/IP, `init_services.go`), `middleware.RateLimitByIP` her iki route'a uygulandı (`init_routes.go`) |
| P0-BD-03 | Migration 067 transaction guard + post-assertion | 2 saat | ✅ KAPANDI — `applyMigrationFile` her migration dosyasını tek tx'te koşuyor (`database/database.go`); regresyon testleri `database/database_test.go` (`TestApplyMigrationFile_RollsBackEntireFileOnError`, `TestMigration067_*`) |
| P1-FE-04 | Legacy device fallback fail-loud (SPK signature 64-byte check) | Yarım gün | Açık |
| P1-FE-05 | Sender key signing key IndexedDB HMAC seal | 1 gün | Açık |
| P1-FE-06 | Backup restore identity re-verification flow | 1 gün | Açık |
| P1-BD-04 | Session `DeleteExpired` cron (main.go background goroutine) | 1 saat | ✅ KAPANDI (2026-06-11) — `server/maintenance.go` saatlik sweeper: session + link-preview `DeleteExpired`; boot'ta bir kez + saatlik; graceful shutdown'da durduruluyor; index desteği migration `071_hot_path_indexes.sql` (`idx_sessions_expires`) |
| P2-IN-12 | HEALTHCHECK derinleştir (DB+Redis+LiveKit gerçek check) | 3 saat | Açık |
| P3-IN-09 | Caddy patch version pin | 5 dakika | Açık |

#### 2.9 P2 Önceki Rapor (`guvenlik_raporu_2026-05-04.md`) Kontrolü

- [ ] Dependabot tüm repo'larda enable (15/17 OFF audit gözlemiyle)
- [ ] Branch protection main'de (PR review + status check zorunlu)
- [ ] Secret scanning + push protection enable
- [ ] OpenRouter/Gemini/NVIDIA API key'leri rotate (diğer repo'lardan kalıntı varsa)

### 🟢 P3 — 30 Gün İçinde

Audit raporu **F bölümü "30 Gün Hardening Planı"** referans alınabilir. Özellikle:
- Backup automation (SQLite/libSQL nightly snapshot, off-site upload)
- Rollback procedure (önceki image tag'ine switch script)
- Code signing certificate (electron-builder release)
- Identity verification UX (Signal-style safety number)
- Load test pipeline (10k WS regression)

---

## 3. Smoke Test Playbook (Deploy Öncesi)

Aşağıdaki adımlar deploy'dan önce her zaman koşulmalı:

```powershell
# === CLIENT ===
cd C:\Users\harun\OneDrive\Desktop\Discord\tayfa-deploy\client
npx vitest run            # 89/89 passing beklenir
npx tsc --noEmit          # exit 0

# === ELECTRON ===
cd ..
npx tsc --noEmit -p electron/tsconfig.json   # exit 0

# === SERVER (Docker zorunlu) ===
docker run --rm -v "${PWD}:/src" -w /src/server golang:1.25-bookworm `
  bash -c "apt-get install -yq gcc && go test ./..."

# === NGINX ===
docker run --rm -v "${PWD}/client/nginx.conf:/etc/nginx/conf.d/default.conf:ro" `
  nginx:alpine nginx -t

# === SECURITY SMOKE ===
# 1. .gitignore'da SSH key engellenmiş
git check-ignore livekit-oracle/ssh/livekit-oci   # path döner = ignored ✓

# 2. .env.example'da gerçek credential yok
grep -E "APIeb80fb802673|IK9KCzU" livekit-oracle/config/.env.example   # exit 1 ✓ (no match)

# 3. livekit.yaml'da placeholder var (gerçek değil)
grep "PLACEHOLDER_API_KEY" livekit-oracle/config/livekit.yaml   # match bulunur ✓
```

---

## 4. Bu Oturum İstatistikleri

- **Toplam dosya değişikliği:** 23 (config + client + electron + server + yeni test + 2 yeni dosya)
- **Yeni test yazıldı:** 1 dosya, 7 test (`keyBackup.test.ts`)
- **Client test status:** 89/89 passing ✓
- **TypeScript compile:** client + electron, sıfır error ✓
- **Go gofmt:** clean ✓
- **Go vet:** ws/models/pkg clean ✓
- **Audit'te kapatılan bulgu sayısı:**
  - **P0**: 11/17 (kalan 6 user-action veya kapsamlı refactor gerektiriyor — yukarıdaki Section 2.8)
  - **P1**: 8/23
  - **P2**: 3/25
- **Audit raporunda tespit edilen false positive:** 5 (CSP, Sender Key replay, AES-GCM IV reuse, Permission prefix-match, livekit restart policy)

---

## 5. İletişim / Sorular

Bu remediation adımlarından herhangi birinde sorun çıkarsa:
- Audit raporundaki bulgu ID'sini referans ver (örn: `P0-IN-01 SSH key rotation çalışmıyor`)
- Önceki conversation context'i Claude Code session'unda yüklü kalır — Phase X uygulaması için "X'i tekrar yap" yeterli
- Yapılan tüm değişiklikler `git diff` ile görülebilir (audit öncesi/sonrası)

**Bu döküman ile birlikte oku:** `CODE_AUDIT_2026-05-27.md` (ana audit raporu, 77 bulgu detaylı)
