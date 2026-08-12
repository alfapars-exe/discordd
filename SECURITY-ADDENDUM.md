# SECURITY-ADDENDUM.md — HiChat proje-özel güvenlik beyanları

> SECURE-CODING v1.5 Bölüm E2 şablonuna göre. Bu dosya çekirdek standardı **daraltır**, gevşetemez.
> İlk sürüm: 2026-08-07 (Checkmarx ilk tam taraması kapanışı ile birlikte).

## 1. Stack ve dağıtım varsayımları

- **TLS sonlandırma**: Prod, HuggingFace Space `infinayazilim/discord` tek konteyneridir (port 7860). TLS, HF edge'inde sonlanır; Go süreci bilinçli olarak `ListenAndServe` (plaintext, konteyner-içi) çalıştırır (`server/main.go`, Dockerfile `SERVER_PORT=7860`). Konteyner dışına plaintext trafik çıkmaz. Self-host senaryosunda TLS, reverse proxy'ye (Caddy/nginx) aittir (`deploy/SELF_HOST.md`).
  - Checkmarx "Plain Text Transport Layer in Server" bulguları bu trust beyanıyla kapatılır (R10) — `SECURITY-EXCEPTIONS.yml: SEC-EX-2026-0004`.
- **LiveKit**: Oracle VM'de self-hosted, `wss://` üzerinden; ses/video medya yolu SRTP.

## 2. Çerez politikası (kayıtlı trust beyanı)

| Çerez | Kapsam | Bayraklar | Gerekçe |
|---|---|---|---|
| `hichat_refresh` | `/api/auth` | HttpOnly + Secure + SameSite=Strict (web) / None (Electron `app://`, Capacitor) | Shell istemcilerde cross-site zorunluluğu; CSRF, custom-header şartıyla kapalı (`handlers/auth.go`) |
| `hichat_media` | `/api/uploads` | HttpOnly + Secure + SameSite=None | `<img>` alt kaynakları shell'lerde cross-site; telafiler: GET-only idempotent handler, 8-bayt rastgele URL öneki, istek başına yetki kontrolü, ACAO yok |

`SameSite=None` seçimi bilinçlidir ve değiştirilemez varsayılan değildir; gerekçe ve telafi kontrolleri `handlers/auth.go:164-186` yorumunda kodla birlikte yaşar.

## 3. Kabul edilmiş riskler (Accepted Risk — iş kararı)

- **Access token TTL 24h** (`JWT_ACCESS_EXPIRY_MINUTES` default 1440): N-10 kararı (PROJECT_MEMORY K-030, 2026-08) — oturum tasarımı kullanıcı kararıyla böyle daraltıldı; telafiler: `tv` (token_version) revocation claim + refresh rotasyonu + kullanılmış-token izleme. Sıkılaştırma env ile mümkün.
- **Media token TTL 7g, revocation'sız**: `services/auth_service.go` MediaTokenTTL yorumunda belgeli; kapsamı yalnız `GET /api/uploads/*`.

## 4. İstemci veri saklama

- Access token **yalnız bellek-içi** (`client/src/api/client.ts` — localStorage bilinçli kaldırıldı, savunmacı temizlik korunur).
- E2EE anahtar materyali **IndexedDB**'de düz yazılır; koruma OS düzeyi tam disk şifrelemesidir — Signal Desktop / Element ile aynı model (`client/src/crypto/keyStorage.ts` güvenlik notu).
- localStorage yalnız UI tercihi + sunucu URL'i taşır; credential taşımaz.

## 5. Dışa giden istek allowlist'i

| Hedef | Kod | Koruma |
|---|---|---|
| `https://api.klipy.com` (GIF) | `handlers/gif.go` | Sabit base URL const + `HasPrefix(url, base+"/")` + `url.QueryEscape` + 1MB yanıt limiti + 10s timeout + `CheckRedirect` (yalnız aynı host, maks 3 hop — 2026-08-07 eklendi) |
| LiveKit API | `services/voice_*` | Konfigüre instance URL'leri, admin-yönetimli |
| yt-dlp (music bot) | `services/music_bot_*` | Host+yol allowlist, kanoniklik kontrolü, extractor kilidi (H-08/N-06 kapanışı, 2026-08) |
| Resend (e-posta) | `services/email*` | Sabit API host |

## 6. Hata yanıtı sözleşmesi (G2.7 uyarlaması — 2026-08-07)

Zarf: `{ "success": false, "error": "<client-safe mesaj>", "code": "<STABLE_CODE>", "correlation_id": "<request id>" }`.
- Ham `err.Error()` yanıt gövdesine giremez; iç detay yalnız `slog` + `pkg.ErrText` (redaksiyon) ile loglanır.
- Stable code kapalı listesi: `NOT_FOUND, UNAUTHORIZED, FORBIDDEN, ALREADY_EXISTS, BAD_REQUEST, CONFLICT, INVALID_KEY, INTERNAL, VALIDATION_FAILED, RATE_LIMITED, PAYLOAD_TOO_LARGE`. Liste client i18n kataloğu ile senkron (`client/src/utils/apiError.ts`); genişletme iki tarafı birlikte değiştirir.
- İstisna: doğrulama hatalarının statik, alan-adı düzeyi mesajları client-safe kabul edilir ve `error` alanında korunur (kullanıcı yönlendirmesi için).
- Çoklu-dosya yükleme yanıtlarındaki `uploadFailures[].Error` alanı yalnız iki değer alır: domain (`pkg.ErrBadRequest`) hatalarında `pkg.ErrText` metni, diğer her şeyde statik `"upload failed"` (+sunucu logu) — altyapı hatası (yol/driver metni) istemciye çıkmaz.

## 7. Loglama redaksiyon matrisi

- Merkez: `pkg.ErrText` (`server/pkg/redact.go`) — DSN/authToken/password/apikey/secret/token/ticket parametreleri maskelenir. Hata metni log'a **yalnız** bu sarmalayıcıdan girer (2026-08-07 itibarıyla `err.Error()` log/yanıt sahaları sıfırlandı).
- `X-Request-Id` dar alfabe doğrulaması + UUID değişimi (`middleware/request_logger.go`) — log forging (CWE-117) kapalı.
- Kullanıcı-türevli string'ler log'a `strconv.Quote` ile girer (`startup_repair.go` deseni).

## 8. Scanner uyum notları

- gosec: `.golangci.yml` ile CI'da; `#nosec` gerekçeleri kodda yaşar (27 saha).
- Checkmarx: `#nosec` okumaz → karşılıklar `SECURITY-EXCEPTIONS.yml`'de. Portal state değişiklikleri yalnız kullanıcı/AppSec tarafından uygulanır.
- §0.12 guardrail katmanı **kuruldu (2026-08-07)**: plugin `security-guidance` 2.0.6 (marketplace `anthropics/claude-plugins-official`). Repo dosyaları `security/tools/sync_agent_guardrail.py` tarafından ÜRETİLİR, elle düzenlenmez:
  - `.claude/security-patterns.yaml` ← `security/tools/self-scan.sh` (49 kural; plugin sınırı 50)
  - `.claude/claude-security-guidance.md` ← `security/policies/guidance-org.md` + `guidance-project.md` (6524/8192 bayt)
  - Drift kapısı CI'da: `sync_agent_guardrail.py --check`
- **Bilinçli sapma:** `.claude/settings.json`'a ortam değişkeni pin'i (`ANTHROPIC_BASE_URL`, `SECURITY_REVIEW_MODEL`, `SG_AGENTIC_MODEL`) **yazılmadı**. §0.12.2 bu pin'lerin şeffaf kopyasını ister ama gerçek değerleri BT yönetimindedir; repo'ya placeholder yazmak Claude Code oturumlarını kırar. Gereksinim `security/policies/agent-tools.yml → env_policy` altında kayıtlıdır; doldurulması BT/AppSec işidir.
- **Bilinen sınır:** plugin'in 3. katman agentic reviewer'ı `claude-security-guidance.md`'yi okumaz; proje politikasının etkisi 1–2. katmanla sınırlıdır (§0.12.3b).
- **Çalışma zamanı bağımlılığı:** plugin YAML okumak için PyYAML ister; yoksa `security-patterns.yaml` sessizce yok sayılır. Geliştirici makinelerinde `python -c "import yaml"` çalışmalıdır.
