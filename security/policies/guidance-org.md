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
