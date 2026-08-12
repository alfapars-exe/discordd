#!/usr/bin/env bash
# §0.10 — teslim öncesi zorunlu öz-tarama (SECURE-CODING v1.5).
# BLOK eşleşmesi = exit 1. İNCELEME eşleşmeleri FAIL etmez; "$OUT" dosyasına
# yazılır ve B4 raporunun 7. bölümüne eklenir.
#
# Dil kapsamı (§0.11 madde 3.5 — repo'daki HER dil zorunlu):
#   - JS/TS  : §0.10 taban seti (client/, electron/, e2e/, build/)
#   - Go     : §0.10.3 HiChat seti — bu repo için türetildi, aşağıya bak
#   - CI/YAML: §0.10.2 seti (.github/workflows/)
#   - Shell  : §0.5 çevre kod seti (deploy/*.sh) — 777/TLS-bypass BLOK;
#              uzak-boru kurulum ve eval İNCELEME (deploy kiti operatör-koşumlu,
#              tek bilinen boru sahası deploy/livekit-setup.sh; agent-time
#              eşdeğeri policies/agent-tools.yml F5'te zaten YASAK).
# Python seti (§0.10.1) bilinçli olarak yok: repo'da Python üretim kodu yok
# (security/tools/*.py geliştirme aracıdır, ürün yüzeyi değildir).
#
# Kullanım: security/tools/self-scan.sh [KAYNAK_DIZIN] [CIKTI_DOSYASI]
set -u
FAIL=0
SRC="${1:-.}"
OUT="${2:-self-scan-inceleme.txt}"
: > "$OUT"

INC='--include=*.ts --include=*.tsx --include=*.js --include=*.jsx'
INC_GO='--include=*.go'
INC_CI='--include=*.yml --include=*.yaml'
INC_SH='--include=*.sh'
# dtln: client/public altındaki emscripten/WASM ses bundle'ı — üçüncü taraf,
# minified, tek satır; SECURITY-SCOPE.yml'de "dependency-metadata" sınıfında.
# NOT: kök build/ BİLİNÇLİ dışlanmıyor — electron-builder paketleme hook'ları
# (after-pack.js) birinci taraf koddur ve taranır; "build" adı çıktı dizini
# değildir bu repo'da (çıktılar dist/ ve release/ altındadır).
EXC='--exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.next
     --exclude-dir=vendor --exclude-dir=coverage --exclude-dir=venv --exclude-dir=.venv
     --exclude-dir=site-packages --exclude-dir=__pycache__ --exclude-dir=.git
     --exclude-dir=release --exclude-dir=playwright-report --exclude-dir=test-results
     --exclude-dir=dtln'

blok() { local d="$1" p="$2"
  if grep -RInE $INC $EXC -e "$p" "$SRC"; then
    echo "❌ BLOK: $d"; FAIL=1; fi; }
incele() { local d="$1" p="$2"
  # sed ayracı '|' — etiketlerde '/' bulunur; '/' ayracı s komutunu kırar.
  grep -RInE $INC $EXC -e "$p" "$SRC" | sed "s|^|🔎 İNCELEME [$d]: |" | tee -a "$OUT" || true; }

blok_go() { local d="$1" p="$2"
  if grep -RInE $INC_GO $EXC -e "$p" "$SRC"; then
    echo "❌ BLOK: $d"; FAIL=1; fi; }
incele_go() { local d="$1" p="$2"
  grep -RInE $INC_GO $EXC -e "$p" "$SRC" | sed "s|^|🔎 İNCELEME [$d]: |" | tee -a "$OUT" || true; }

incele_ci() { local d="$1" p="$2"
  grep -RInE $INC_CI $EXC -e "$p" "$SRC" | sed "s|^|🔎 İNCELEME [$d]: |" | tee -a "$OUT" || true; }

# --exclude=self-scan.sh: desen tanımları ('curl[^|]*--insecure' gibi) kendi
# kaynak satırlarıyla eşleşir; agent-bypass kuralındaki emsalin aynısı.
blok_sh() { local d="$1" p="$2"
  if grep -RInE $INC_SH --exclude=self-scan.sh $EXC -e "$p" "$SRC"; then
    echo "❌ BLOK: $d"; FAIL=1; fi; }
incele_sh() { local d="$1" p="$2"
  grep -RInE $INC_SH --exclude=self-scan.sh $EXC -e "$p" "$SRC" | sed "s|^|🔎 İNCELEME [$d]: |" | tee -a "$OUT" || true; }

# ============================================================
# §0.10 taban seti — JS / TS
# ============================================================
blok "SQLi template literal"        '\.query\(\s*`[^`]*\$\{'
blok "SQLi string concat"           '\.query\([A-Za-z_]+\s*\+'
blok "jwt.decode"                   'jwt\.decode\('
blok "Set-Cookie ham header"        "setHeader\(\s*['\"]Set-Cookie"
blok "document.cookie yazımı"       'document\.cookie\s*='
blok "err response'a sızıyor"       'json\([^)]*\berr(or)?\.(message|stack)'
blok "Ham err nesnesi yanıtta"      'json\([^)]*[:({,]\s*err\b'
blok "Ham err/req/res loglama"      'logger\.(error|warn|info|debug)\(\s*(err|error|req|res)\b'
blok "eval ailesi"                  '\beval\(|new Function\(|set(Timeout|Interval)\(\s*['\''"`]'
blok "TLS bypass"                   'rejectUnauthorized\s*:\s*false|verify\s*=\s*False|InsecureSkipVerify|NODE_TLS_REJECT_UNAUTHORIZED|_create_unverified_context|check_hostname\s*=\s*False|sslmode=disable|insecure_channel|--insecure-skip-tls-verify'
blok "DOM XSS sink (insert/write)"  '\.insertAdjacentHTML\(|document\.write(ln)?\('
blok "child_process exec/shell"     'child_process\.exec\(|\bexecSync\(|shell\s*:\s*true'
blok "createCipher (IV'siz)"        'crypto\.create(De)?Cipher\('
blok "AES ECB modu"                 '['\''"]aes-[0-9]+-ecb['\''"]'
# NOT: `(-R\s+)?` biçimi bilinçli olarak açıldı — plugin'in (security-guidance
# 2.0.6) ReDoS sezgiseli "içinde niceleyici olan grup + niceleyici" şeklini
# eleyeceği için desen orada SESSİZCE düşerdi. Alternation eşdeğerdir.
blok "777 izinler (JS/sh)"          '0o777|chmod\s+777|chmod\s+-R\s+777|umask\(\s*0+\s*\)'

# httpOnly'siz res.cookie (iki aşama)
if grep -RInE $INC $EXC -e 'res\.cookie\(' "$SRC" | grep -v httpOnly; then
  echo "❌ BLOK: res.cookie httpOnly'siz"; FAIL=1; fi

# innerHTML/outerHTML ataması — boş dizge literali sink DEĞİLDİR (test teardown
# deseni: document.body.innerHTML = ""). İki aşama, çünkü güvenli biçim
# ("" ataması) deseni üretiyor.
if grep -RInE $INC $EXC -e '\.(innerHTML|outerHTML)\s*=' "$SRC" \
     | grep -vE '\.(innerHTML|outerHTML)\s*=\s*(""|'\'''\'')\s*;?\s*$'; then
  echo "❌ BLOK: innerHTML/outerHTML ataması"; FAIL=1; fi

# noopener'sız target=_blank — DOSYA BAZINDA sayım.
# Standardın referans script'indeki satır-kapsamlı `grep -v noopener` çok satırlı
# JSX'te BOZUKTUR: rel="noopener noreferrer" bir alt satırdadır, target satırı
# filtreden geçer ve her güvenli kullanım BLOK üretir (2026-08-07'de bu repoda
# 17/17 güvenli kullanım yanlış bloklandı). Sayım karşılaştırması hem çok satırlı
# hem tek satırlı biçimde doğru çalışır.
for f in $(grep -RIlE $INC $EXC -e 'target=["'\'']_blank' "$SRC"); do
  t=$(grep -cE 'target=["'\'']_blank' "$f")
  n=$(grep -cE 'rel=["'\''][^"'\'']*noopener' "$f")
  if [ "$t" -gt "$n" ]; then
    echo "$f: target=_blank $t adet, noopener $n adet"
    echo "❌ BLOK: target=_blank noopener'sız"; FAIL=1; fi
done
# Web storage'da hassas veri (iki aşama): test dosyaları, "bu anahtara
# DOKUNULMADIĞINI" sınamak için anahtar adını yazmak zorundadır
# (draftStorage.test.ts "auth-store" korunuyor mu testi). Üretim kodunda BLOK,
# test kodunda İNCELEME — §0.5 gereği testler kapsam dışı bırakılmaz, görünür kalır.
if grep -RInE $INC $EXC -e '(localStorage|sessionStorage)\.setItem\([^)]*(session|token|user|auth|password)' "$SRC" \
     | grep -vE '\.(test|spec)\.(ts|tsx|js|jsx):'; then
  echo "❌ BLOK: Web storage'da hassas veri"; FAIL=1; fi
grep -RInE $INC $EXC -e '(localStorage|sessionStorage)\.setItem\([^)]*(session|token|user|auth|password)' "$SRC" \
  | grep -E '\.(test|spec)\.(ts|tsx|js|jsx):' \
  | sed 's|^|🔎 İNCELEME [test kodunda web storage anahtarı]: |' | tee -a "$OUT" || true

# toPublic* DTO'suz servis dönüşü (iki aşama)
if grep -RInE $INC $EXC -e 'res\.(status\([0-9]+\)\.)?json\([^)]*\b(user|session|account)\b' "$SRC" | grep -v toPublic; then
  echo "❌ BLOK: Secret Leak response (toPublic DTO'suz)"; FAIL=1; fi

incele "dangerouslySetInnerHTML/v-html" 'dangerouslySetInnerHTML|v-html'
incele "destructured exec"          '(^|[^A-Za-z0-9_.$])exec\('
incele "zayıf hash (md5/sha1)"      'createHash\(\s*['\''"](md5|sha1)'
incele "SSRF fetch/axios"           '\bfetch\(\s*[A-Za-z_`]|\baxios[a-z.]*\(\s*[A-Za-z_`]'
incele "postMessage/message dinleyici" '\.postMessage\(|addEventListener\(\s*['\''"]message'
incele "JS hardcoded secret"        '(PASSWORD|PASSWD|SECRET|TOKEN|API_KEY)[A-Z_]*\s*[:=]\s*['\''"][^'\''"]{8,}'
incele "kısa randomBytes (<16B)"    'randomBytes\(\s*([1-9]|1[0-5])\s*\)'
incele "spoofable header yetkisi"   '[Xx]-[Ff]orwarded-[Ff]or|[Xx]-[Rr]eal-[Ii][Pp]|X-(User|Role)-'
incele "jwt.sign payload PII"       'jwt\.sign\('
incele "Math.random"                'Math\.random\('
incele "__proto__ / merge"          '__proto__'
incele "0.0.0.0 bind"               '(host\s*[:=]\s*|listen\(\s*)["'\'']0\.0\.0\.0'
# Açık yönlendirme: konum ataması sabit dizge değil (ErrorBoundary vakası, 2026-08-07)
incele "client açık yönlendirme"    'location\.(href|assign|replace)\s*(=|\()\s*[^"'\'')]'

# ============================================================
# §0.10.3 Go Desen Seti — HiChat (2026-08-07 Checkmarx taramasından türetildi)
#
# Standardın §0.10 tablosu JS/TS + Python + CI/YAML kapsıyordu; Go seti
# "stack'e girince eklenir" hükmüyle boş bırakılmıştı. Aşağıdaki desenler,
# scan 1000882'de doğan bulgu ailelerinin Go tarafındaki birebir karşılığıdır.
# BLOK sınıfı yalnız güvenli biçimin deseni ÜRETEMEYECEĞİ yerlerde:
# pkg.ErrText(err) hiçbir zaman ".Error()" içermez, bind'li sorgu hiçbir zaman
# Sprintf/concat içermez.
# ============================================================

# --- Secret/Privacy Leak in Logs + Error Messages (CWE-209/532) ---
# Değişken adı err OLMAYABİLİR (sendErr/lastErr/copyErr) — iki süpürme bu yüzden kaçırdı.
blok_go "app_logs/log map'ine ham err"   '"error":\s*[A-Za-z_]*[Ee]rr\.Error\(\)'
blok_go "truncate ile ham err"           'truncate\(\s*[A-Za-z_]*[Ee]rr\.Error\(\)'
blok_go "yanıt gövdesine ham err"        '(ErrorWithMessage|ErrorWithCode)\([^)]*[A-Za-z_]*[Ee]rr\.Error\(\)'
blok_go "sentinel wrap'inde ham err"     'fmt\.Errorf\([^)]*%w[^)]*[A-Za-z_]*[Ee]rr\.Error\(\)'
# Kalan .Error() kullanımları: sınıflandırma (strings.Contains) meşrudur — İNCELEME.
grep -RInE $INC_GO $EXC -e '[A-Za-z_]*[Ee]rr\.Error\(\)' "$SRC" \
  | grep -vE '(strings\.Contains|containsString|^\s*//|//.*\.Error\(\))' \
  | sed 's|^|🔎 İNCELEME [Go ham .Error() kullanımı]: |' | tee -a "$OUT" || true

# --- Injection (§6) ---
blok_go "SQL Sprintf ile kuruluyor"      '\.(Query|QueryRow|Exec)(Context)?\([^)]*fmt\.Sprintf'
blok_go "SQL string concat"              '\.(Query|QueryRow|Exec)(Context)?\([^)]*[A-Za-z_]+\s*\+'
blok_go "shell -c ile komut"             'exec\.Command(Context)?\([^)]*"(sh|bash|cmd|powershell)"'
blok_go "HTTP yanıtında text/template"   '"text/template"'

# --- Kriptografi ve rastgelelik (§3) ---
# JWT none algoritması (iki aşama): alg=none'ın REDDEDİLDİĞİNİ sınayan negatif
# güvenlik testi bu sabitleri kullanmak zorundadır (auth_service_test.go —
# TestValidateToken alg-confusion vakası). Üretim kodunda BLOK, testte İNCELEME.
if grep -RInE $INC_GO $EXC -e 'SigningMethodNone|UnsafeAllowNoneSignatureType' "$SRC" \
     | grep -v '_test\.go:'; then
  echo "❌ BLOK: JWT none algoritması"; FAIL=1; fi
grep -RInE $INC_GO $EXC -e 'SigningMethodNone|UnsafeAllowNoneSignatureType' "$SRC" \
  | grep '_test\.go:' \
  | sed 's|^|🔎 İNCELEME [negatif test: alg=none reddi]: |' | tee -a "$OUT" || true
blok_go "zayıf hash (md5/sha1)"          '"crypto/(md5|sha1)"'
blok_go "AES ECB / IV'siz mod"           'NewECBEncrypter|NewECBDecrypter'
incele_go "math/rand kullanımı"          '"math/rand"'
incele_go "jwt.Parse (keyfunc alg kontrolü doğrulanmalı)" 'jwt\.Parse(WithClaims)?\('

# --- Dosya ve yol (§11) ---
blok_go "777 izinler"                    '0o?777|chmod\s+777|chmod\s+-R\s+777'
incele_go "değişkenle dosya açma (SafeJoin şart)" '(os\.(Open|OpenFile|ReadFile|Create|WriteFile)|ioutil\.ReadFile)\(\s*[A-Za-z_]'
incele_go "öngörülebilir temp (mktemp deseni)" 'TempDir\(\)\s*\+|"/tmp/'

# --- Kaynak tüketimi (§13) ---
incele_go "sınırsız gövde okuma (LimitReader/MaxBytes şart)" 'io\.ReadAll\(\s*(r|req)\.Body'
incele_go "Atoi sonrası clamp gerekir"   'strconv\.Atoi\('

# --- Konfigürasyon ve sır (§4, §16) ---
incele_go "Go hardcoded secret"          '(Secret|Token|Password|APIKey|ApiKey)[A-Za-z_]*\s*[:=]+\s*"[^"]{8,}"'
incele_go "plaintext dinleme"            'ListenAndServe\('
incele_go "0.0.0.0 bind"                 '"0\.0\.0\.0'
# Gerekçesiz #nosec (§0.6: suppression teknik gerekçe ister)
grep -RInE $INC_GO $EXC -e '#nosec' "$SRC" \
  | grep -vE '#nosec[^"]*(--|—)' \
  | sed 's|^|🔎 İNCELEME [gerekçesiz #nosec]: |' | tee -a "$OUT" || true
# HttpOnly'siz çerez (iki aşama; Go struct literal çok satırlı olabilir → İNCELEME)
grep -RInE $INC_GO $EXC -e 'http\.Cookie\{' "$SRC" \
  | sed 's|^|🔎 İNCELEME [çerez bayrakları doğrulanmalı]: |' | tee -a "$OUT" || true

# ============================================================
# §0.10.2 CI / Workflow YAML seti
# ============================================================
incele_ci "GHA untrusted context"   '\$\{\{\s*github\.(event\.(issue|pull_request|comment|review|commits|head_commit|pages|client_payload)|head_ref)'
incele_ci "pwn request trigger"     'pull_request_target|workflow_run'
incele_ci "orchestrator template"   '\{\{\s*(dag_run\.conf|params\.)|\{\{\s*workflow\.parameters|\$\(params\.'
incele_ci "OIDC trust kapsamı"      'token\.actions\.githubusercontent\.com'
# SHA pin'siz üçüncü taraf action (üç aşama)
grep -RInE $INC_CI $EXC -e 'uses:\s*[A-Za-z0-9_.-]+/' "$SRC" \
  | grep -vE '@[0-9a-f]{40}' | grep -vE 'uses:\s*(actions|github)/' \
  | sed 's|^|🔎 İNCELEME [SHA pinsiz 3. taraf action]: |' | tee -a "$OUT" || true
# Agent izin bypass bayrağı — tüm konfigürasyon/script dosyalarında BLOK
if grep -RIn $EXC --include='*.yml' --include='*.yaml' --include='*.sh' --include='*.json' \
     --exclude=self-scan.sh -e 'dangerously-skip-permissions' -e 'bypassPermissions' "$SRC"; then
  echo "❌ BLOK: agent izin bypass bayrağı"; FAIL=1; fi

# ============================================================
# §0.5 Shell (çevre kod) seti — deploy/*.sh
# ============================================================
# umask: yalnız tüm-sıfır (000/0000) BLOK'tur; umask 022 idiomatik ve güvenlidir.
blok_sh "777 izinler (sh)"          'chmod\s+777|chmod\s+-R\s+777|umask\s+0+\b'
blok_sh "TLS bypass (sh)"           'curl[^|]*--insecure|curl[^|]*\s-k\b|wget[^|]*--no-check-certificate'
# Uzak boru kurulum: bilinen tek saha deploy/livekit-setup.sh (operatör-koşumlu
# VM kurulum kiti; ağ hattı TLS). Agent-time eşdeğeri policies/agent-tools.yml
# F5'te YASAK — burada İNCELEME olarak görünür kalır, build'i kırmaz.
incele_sh "uzak kaynaktan boru kurulum" '(curl|wget)[^|]*\|\s*(ba|z)?sh\b'
# eval: deploy kitinin prompt/ssh-agent idiomları; görünür kalsın diye İNCELEME.
incele_sh "shell eval"              '\beval\b'

echo "---"
echo "İNCELEME satırı: $(wc -l < "$OUT")  →  $OUT (B4 raporu 7. bölümüne eklenir)"
if [ "$FAIL" -eq 0 ]; then echo "✅ BLOK deseni: 0 eşleşme"; else echo "⛔ BLOK eşleşmesi var — teslim edilemez"; fi
exit $FAIL
