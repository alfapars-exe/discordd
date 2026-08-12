#!/usr/bin/env python3
"""sync_agent_guardrail.py — SECURE-CODING v1.5 §0.12.3 guardrail üreteci.

Tek doğruluk kaynağı: ``security/tools/self-scan.sh``.
O script §0.10 / §0.10.2 / §0.10.3 desen tablolarının çalıştırılabilir hâlidir;
bu üreteç onu ayrıştırıp ``.claude/security-patterns.yaml`` dosyasını üretir, böylece
aynı desenler CI'da (build kıran) ve editörde (uyaran) TEK yerden yönetilir.

Senkron yönü TEK YÖNDÜR (§0.12.3a): self-scan.sh → security-patterns.yaml.
Üretilen dosyayı elle düzenlemek YASAK; yeni desen önce standart tablosuna,
sonra self-scan.sh'a girer, sonra bu üreteç koşar.

Kullanım:
    sync_agent_guardrail.py            # üret / güncelle
    sync_agent_guardrail.py --check    # drift kontrolü (CI): fark varsa exit 1

Neden META tablosu var: self-scan.sh yalnız (etiket, desen) taşır; plugin
reminder'ı ise "güvenli biçim" ve standart bölümü ister. META bunları etikete
bağlar ve EKSİK ETİKETTE HATA VERİR — yeni desen ekleyen kişi güvenli biçimi
yazmak zorunda kalır (sessiz kalite kaybını önler).
"""

import argparse
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
SELF_SCAN = os.path.join(HERE, "self-scan.sh")
POLICIES = os.path.join(REPO, "security", "policies")
GUIDANCE_SRC = [
    os.path.join(POLICIES, "guidance-org.md"),
    os.path.join(POLICIES, "guidance-project.md"),
]
OUT_PATTERNS = os.path.join(REPO, ".claude", "security-patterns.yaml")
OUT_GUIDANCE = os.path.join(REPO, ".claude", "claude-security-guidance.md")

# Plugin (security-guidance 2.0.6 hooks/extensibility.py) sabitleri.
PATTERN_MAX_RULES = 50
PATTERN_REMINDER_MAX_BYTES = 1024
GUIDANCE_MAX_BYTES = 8 * 1024

# §0.12.3b: dosya kontrol EKLEYEBİLİR / severity YÜKSELTEBİLİR; bulgu bastıramaz.
# Üreteç bastırma dili lint'i yapar — plugin'in kendi çerçevesiyle aynı yönde.
SUPPRESSION_LINT = [
    "false positive", "ignore", "yok say", "görmezden gel", "bastır",
    "suppress", "muaf tut", "raporlama", "flag etme", "atla",
]

PATHS = {
    "js": ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"],
    "go": ["**/*.go"],
    "ci": ["**/*.yml", "**/*.yaml"],
    "sh": ["**/*.sh"],
    # katlanmış çok dilli kurallar (FOLD sonucu)
    "any": ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.go", "**/*.sh"],
}
# build/ dışlanmaz: electron-builder hook'ları (build/after-pack.js) birinci
# taraf koddur; CI self-scan da build/'i tarar (EXC listesinden çıkarıldı).
EXCLUDES = ["**/node_modules/**", "**/dist/**", "**/dtln/**"]

# etiket -> (güvenli biçim, standart bölümü). Etiketler self-scan.sh ile birebir.
#
# ⚠️ "Güvenli biçim" metinleri standardın tablo hücrelerinin BİREBİR ALINTISI
# DEĞİLDİR: bu repo'nun diline (Go/TS API adları, pkg.* sarmalayıcıları)
# çevrilmiş hâlleridir. Yön daima daraltıcıdır (§0.0) — hiçbiri standardın
# gerektirdiğinden gevşek değildir. Normatif metin için standarda bakılır.
META = {
    # ---- §0.10 taban seti (JS/TS) ----
    "SQLi template literal": ("Bind/parametre (request.input) + identifier allowlist", "§6"),
    "SQLi string concat": ("Bind/parametre + identifier allowlist", "§6"),
    "jwt.decode": ("jwt.verify(...) — imza + alg + iss/aud + zaman claim'leri", "§2"),
    "Set-Cookie ham header": ("Merkezî cookie helper (httpOnly/secure/sameSite varsayılan)", "G2.3"),
    "document.cookie yazımı": ("Testte Playwright context.addCookies/clearCookies", "G2.5"),
    "err response'a sızıyor": ("Merkezî hata işleyici: { error: { code, correlationId } }", "G2.7"),
    "Ham err nesnesi yanıtta": ("Merkezî hata işleyici + generic mesaj", "G2.7"),
    "Ham err/req/res loglama": ("Safe-DTO logger; ham nesne serialize edilmez", "§20"),
    "eval ailesi": ("Sabit kod yolu; dinamik değerlendirme yok", "§7"),
    "TLS bypass": ("Sertifika doğrulaması hiçbir ortamda kapatılamaz", "§3"),
    "DOM XSS sink (insert/write)": ("textContent / güvenli DOM API + sanitizer", "§7"),
    "child_process exec/shell": ("execFile/spawn + argüman dizisi", "G4.3"),
    "createCipher (IV'siz)": ("createCipheriv + AES-256-GCM", "G4.15"),
    "AES ECB modu": ("AES-GCM veya AES-CBC+HMAC", "§3"),
    "777 izinler (JS/sh)": ("Oluşturma anında 0600/0700", "G4.14"),
    "res.cookie httpOnly'siz": ("Merkezî cookie helper; httpOnly varsayılan", "G2.3"),
    "innerHTML/outerHTML ataması": ("textContent veya sanitize edilmiş DOM API", "§7"),
    "target=_blank noopener'sız": ('rel="noopener noreferrer"', "§17"),
    "Web storage'da hassas veri": ("Session yalnız HttpOnly cookie'de", "G2.4"),
    "Secret Leak response (toPublic DTO'suz)": ("toPublic* DTO zorunlu", "G2.1"),
    "dangerouslySetInnerHTML/v-html": ("Sanitizer kanıtı (DOMPurify) + §0.6 kaydı", "§7"),
    "destructured exec": ("regex.exec/db.exec FP'leri gerekçelendirilir", "§6"),
    "zayıf hash (md5/sha1)": ("SHA-256+; güvenlik dışı kullanım gerekçelendirilir", "§3"),
    "SSRF fetch/axios": ("security.url.requireAllowedOutboundUrl (allowlist)", "§12"),
    "postMessage/message dinleyici": ("Gönderimde targetOrigin, alımda origin allowlist", "§17"),
    "JS hardcoded secret": ("Env + secret store", "§4"),
    "kısa randomBytes (<16B)": ("≥16 bayt = ≥128 bit", "G4.13"),
    "spoofable header yetkisi": ("Güvenilir proxy sözleşmesi + §0.6 kaydı", "G4.5"),
    "jwt.sign payload PII": ("Yalnız sub/exp/iat/jti(/scope) claim'leri", "G2.2"),
    "Math.random": ("CSPRNG (crypto.getRandomValues)", "§3"),
    "__proto__ / merge": ("Key allowlist; dinamik merge yok", "§5"),
    "0.0.0.0 bind": ("Yalnız konteyner/orchestrator arkasında; gerekçe B4'te", "§16"),
    "client açık yönlendirme": ("new URL(location.href) ile aynı-köken sabitleme", "§17"),
    "test kodunda web storage anahtarı": ("Negatif assertion; üretimde yasak", "G2.4"),
    # ---- FOLD hedefleri (katlanmış kurallar) ----
    "Go — ham err.Error() sızıntısı": ("pkg.ErrText(err); yanıtta statik mesaj + stable code", "§20/G2.7"),
    "Go — SQL string birleştirme": ("? bind parametreleri", "§6"),
    "JS — SQL string birleştirme": ("Bind/parametre + identifier allowlist", "§6"),
    "777 izinler (dosya modu)": ("Oluşturma anında 0600/0700", "G4.14"),
    # ---- §0.10.3 Go seti (bu repo için türetildi) ----
    "app_logs/log map'ine ham err": ("pkg.ErrText(err) — merkezî redaksiyon", "§20"),
    "truncate ile ham err": ("truncate(pkg.ErrText(err), N)", "§20"),
    "yanıt gövdesine ham err": ("Statik client-safe mesaj + stable code", "G2.7"),
    "sentinel wrap'inde ham err": ("fmt.Errorf(\"%w: %s\", sentinel, pkg.ErrText(err))", "§20"),
    "Go ham .Error() kullanımı": ("Sınıflandırma dışında pkg.ErrText(err)", "§20"),
    "SQL Sprintf ile kuruluyor": ("? bind parametreleri", "§6"),
    "SQL string concat": ("? bind parametreleri", "§6"),
    "shell -c ile komut": ("exec.Command(bin, args...) — shell yok", "G4.3"),
    "HTTP yanıtında text/template": ("html/template", "§7"),
    "JWT none algoritması": ("keyfunc'ta SigningMethod tip kontrolü", "§2"),
    "AES ECB / IV'siz mod": ("AES-256-GCM", "§3"),
    "math/rand kullanımı": ("crypto/rand", "§3"),
    "jwt.Parse (keyfunc alg kontrolü doğrulanmalı)": ("keyfunc *jwt.SigningMethodHMAC assert eder", "§2"),
    "777 izinler": ("Oluşturma anında 0600/0700", "G4.14"),
    "değişkenle dosya açma (SafeJoin şart)": ("pkg.SafeJoin(base, name) containment", "§11"),
    "öngörülebilir temp (mktemp deseni)": ("os.MkdirTemp / os.CreateTemp", "§21"),
    "sınırsız gövde okuma (LimitReader/MaxBytes şart)": ("http.MaxBytesReader + io.LimitReader", "§13"),
    "Atoi sonrası clamp gerekir": ("min(n, MAX) handler katmanında", "G2.8"),
    "Go hardcoded secret": ("Env + secret store; config'te secret default'u yok", "G3.2"),
    "plaintext dinleme": ("TLS kenar katmanda; ADDENDUM trust beyanı", "§16"),
    "gerekçesiz #nosec": ("#nosec G### -- <teknik gerekçe>", "§0.6"),
    "çerez bayrakları doğrulanmalı": ("HttpOnly + Secure + açık SameSite", "G2.3"),
    "negatif test: alg=none reddi": ("Negatif güvenlik testi — istenen desen", "§37"),
    # ---- §0.10.2 CI/YAML seti ----
    "GHA untrusted context": ("env: dolaylaması + tırnaklı \"$VAR\"", "§31"),
    "pwn request trigger": ("Branch filtresi, untrusted checkout yok, secret kısıtlı", "§31"),
    "orchestrator template": ("Ayrı argv elemanı veya env geçişi", "G4.17"),
    "OIDC trust kapsamı": ("sub claim'i tam eşleşme; ':*' StringLike yasak", "§19"),
    "SHA pinsiz 3. taraf action": ("40 karakter SHA pin", "§31"),
    # ---- §0.5 Shell (çevre kod) seti ----
    "777 izinler (sh)": ("Oluşturma anında 0600/0700; umask 022", "G4.14"),
    "TLS bypass (sh)": ("Sertifika doğrulaması hiçbir ortamda kapatılamaz", "§3"),
    "uzak kaynaktan boru kurulum": ("Sürümlü indirme + checksum doğrulaması", "§15"),
    "shell eval": ("Sabit kod yolu; dinamik değerlendirme gerekçelendirilir", "§7"),
}

# --- self-scan.sh ayrıştırma -------------------------------------------------

CALL_RE = re.compile(
    r"""^\s*(blok|incele|blok_go|incele_go|incele_ci|blok_sh|incele_sh)\s+   # fonksiyon
        (?P<lq>["'])(?P<label>.*?)(?P=lq)\s+               # etiket
        (?P<pq>["'])(?P<pat>.*)(?P=pq)\s*$                 # desen
    """,
    re.VERBOSE,
)
LANG = {"blok": "js", "incele": "js", "blok_go": "go", "incele_go": "go", "incele_ci": "ci",
        "blok_sh": "sh", "incele_sh": "sh"}
KLASS = {"blok": "BLOK", "blok_go": "BLOK", "incele": "İNCELEME", "incele_go": "İNCELEME", "incele_ci": "İNCELEME",
         "blok_sh": "BLOK", "incele_sh": "İNCELEME"}

# İki aşamalı kontroller doğrudan grep ile yazıldığından fonksiyon çağrısı
# olarak görünmez; birinci aşama desenleri burada elle eşlenir (etiket, sınıf,
# dil, desen). Etiketler script'teki `echo "❌ BLOK: ..."` metinleriyle aynıdır.
TWO_STAGE = [
    ("res.cookie httpOnly'siz", "BLOK", "js", r"res\.cookie\("),
    ("innerHTML/outerHTML ataması", "BLOK", "js", r"\.(innerHTML|outerHTML)\s*="),
    ("Web storage'da hassas veri", "BLOK", "js",
     r"(localStorage|sessionStorage)\.setItem\([^)]*(session|token|user|auth|password)"),
    ("Secret Leak response (toPublic DTO'suz)", "BLOK", "js",
     r"res\.(status\([0-9]+\)\.)?json\([^)]*\b(user|session|account)\b"),
    ("target=_blank noopener'sız", "BLOK", "js", r"target=[\"']_blank"),
    ("JWT none algoritması", "BLOK", "go", r"SigningMethodNone|UnsafeAllowNoneSignatureType"),
    ("test kodunda web storage anahtarı", "İNCELEME", "js",
     r"(localStorage|sessionStorage)\.setItem\([^)]*(session|token|user|auth|password)"),
    ("negatif test: alg=none reddi", "İNCELEME", "go", r"SigningMethodNone|UnsafeAllowNoneSignatureType"),
    ("Go ham .Error() kullanımı", "İNCELEME", "go", r"[A-Za-z_]*[Ee]rr\.Error\(\)"),
    ("gerekçesiz #nosec", "İNCELEME", "go", r"#nosec"),
    ("çerez bayrakları doğrulanmalı", "İNCELEME", "go", r"http\.Cookie\{"),
    ("SHA pinsiz 3. taraf action", "İNCELEME", "ci", r"uses:\s*[A-Za-z0-9_.-]+/"),
]


# --- kural bütçesi (§0.12.3a) -----------------------------------------------
# Plugin sınırı 50. Aşımda üreteç FAIL eder; sessiz kırpma kanıt kaybıdır.
# İki mekanizma, ikisi de AÇIK ve gerekçeli:
#   FOLD        — aynı aileyi tek kurala katlar (desenler alternation ile birleşir)
#   EDITOR_SKIP — editörde gürültü olan, CI self-scan'de zaten yakalanan kurallar
FOLD = {
    "Go — ham err.Error() sızıntısı": [
        "app_logs/log map'ine ham err",
        "truncate ile ham err",
        "yanıt gövdesine ham err",
        "sentinel wrap'inde ham err",
    ],
    "Go — SQL string birleştirme": ["SQL Sprintf ile kuruluyor", "SQL string concat"],
    "JS — SQL string birleştirme": ["SQLi template literal", "SQLi string concat"],
    "777 izinler (dosya modu)": ["777 izinler (JS/sh)", "777 izinler", "777 izinler (sh)"],
    "TLS bypass": ["TLS bypass", "TLS bypass (sh)"],
    "Web storage'da hassas veri": ["Web storage'da hassas veri", "test kodunda web storage anahtarı"],
    "JWT none algoritması": ["JWT none algoritması", "negatif test: alg=none reddi"],
}

EDITOR_SKIP = {
    "Atoi sonrası clamp gerekir": "22 saha; her pagination handler'ında uyarır, CI self-scan yeterli",
    "değişkenle dosya açma (SafeJoin şart)": "26 saha; tamamı SafeJoin arkasında, editörde saf gürültü",
    "çerez bayrakları doğrulanmalı": "11 saha; 4 üretim sahası #nosec G124 gerekçeli",
    "Go ham .Error() kullanımı": "13 saha; gerçek risk BLOK varyantlarında zaten kapsanıyor",
    "postMessage/message dinleyici": "6 saha; Electron/Capacitor köprüleri, tasarım gereği",
    "SSRF fetch/axios": "11 saha; client'ın aynı-köken API katmanı",
    "spoofable header yetkisi": "yetki kararı bu repo'da header'a bakmıyor; yüksek FP",
    "uzak kaynaktan boru kurulum": "tek saha: deploy/livekit-setup.sh (operatör-koşumlu VM kiti); CI self-scan görünür tutuyor",
    "shell eval": "3 saha; deploy kitinin prompt/ssh-agent idiomları, CI self-scan yeterli",
}


def apply_budget(rules):
    """FOLD ve EDITOR_SKIP uygular; ikisini de stderr'e raporlar."""
    by_label = {r["label"]: r for r in rules}
    folded, consumed = [], set()

    for target, members in FOLD.items():
        present = [by_label[m] for m in members if m in by_label]
        if not present:
            continue
        consumed.update(m["label"] for m in present)
        pats, langs = [], set()
        for m in present:
            if m["regex"] not in pats:
                pats.append(m["regex"])
            langs.add(m["lang"])
        folded.append({
            "label": target,
            # BLOK üyesi varsa katlanmış kural BLOK'tur (daha sert olan kazanır).
            "klass": "BLOK" if any(m["klass"] == "BLOK" for m in present) else "İNCELEME",
            "lang": "any" if len(langs) > 1 else next(iter(langs)),
            "regex": "|".join(pats),
        })
        print(f"katlandı: {target} ← {[m['label'] for m in present]}", file=sys.stderr)

    kept = []
    for r in rules:
        if r["label"] in consumed:
            continue
        if r["label"] in EDITOR_SKIP:
            print(f"editörde atlandı: {r['label']} — {EDITOR_SKIP[r['label']]}", file=sys.stderr)
            continue
        kept.append(r)
    return kept + folded


def parse_self_scan(path):
    rules, seen = [], set()
    with open(path, encoding="utf-8") as f:
        for line in f:
            m = CALL_RE.match(line)
            if not m:
                continue
            fn, label, pat = m.group(1), m.group("label"), m.group("pat")
            # Shell tek-tırnak kaçışı: '\'' → '
            pat = pat.replace("'\\''", "'")
            key = (label, pat)
            if key in seen:
                continue
            seen.add(key)
            rules.append({"label": label, "klass": KLASS[fn], "lang": LANG[fn], "regex": pat})
    for label, klass, lang, pat in TWO_STAGE:
        if (label, pat) in seen:
            continue
        seen.add((label, pat))
        rules.append({"label": label, "klass": klass, "lang": lang, "regex": pat})
    return rules


# --- plugin uyumluluk doğrulaması -------------------------------------------
# hooks/extensibility.py içindeki sezgiselin birebir karşılığı: üretilen dosya
# sessizce elenmesin diye ÜRETİM anında doğrularız.
_REDOS_SHAPES = [re.compile(r"\([^()]*[+*][^()]*\)[+*?]"), re.compile(r"\(\.\*[^()]*\)[+*]")]
_ALT_UNDER_REP = re.compile(r"\(([^()]*)\|([^()|]*)(?:\|[^()]*)*\)[+*]")


def has_redos_structure(regex):
    if any(p.search(regex) for p in _REDOS_SHAPES):
        return True
    for m in _ALT_UNDER_REP.finditer(regex):
        branches = [b for b in m.group(0).strip("()*+").split("|") if b]
        for i, a in enumerate(branches):
            for b in branches[i + 1:]:
                if a.startswith(b) or b.startswith(a):
                    return True
    return False


def build_reminder(label, klass, safe_form, section):
    txt = (
        f"[İnfina §0.10] {klass} — {label}: bu desen SECURE-CODING'de yasak/incelemeliktir. "
        f"Güvenli biçim: {safe_form}. Bkz. {section}. "
        f"BLOK desenleri pre-commit self-scan'de build'i kırar."
    )
    return txt[:PATTERN_REMINDER_MAX_BYTES]


def yaml_quote(s):
    return "'" + s.replace("'", "''") + "'"


def render(rules):
    out = [
        "# OTOMATİK ÜRETİLDİ — ELLE DÜZENLEMEYİN (SECURE-CODING v1.5 §0.12.3a).",
        "# Kaynak: security/tools/self-scan.sh · Üreteç: security/tools/sync_agent_guardrail.py",
        "# Yeni desen: önce standart tablosu → sonra self-scan.sh → sonra bu üreteç.",
        "# Drift kontrolü CI'da: sync_agent_guardrail.py --check",
        "# NOT: reminder'daki 'Güvenli biçim', standardın tablo hücresinin birebir",
        "# alıntısı değil, bu repo'nun API adlarına çevrilmiş hâlidir (daraltıcı yön).",
        "patterns:",
    ]
    for r in rules:
        safe_form, section = META[r["label"]]
        out.append(f"  - rule_name: {yaml_quote(r['label'])}")
        out.append(f"    reminder: {yaml_quote(build_reminder(r['label'], r['klass'], safe_form, section))}")
        out.append(f"    regex: {yaml_quote(r['regex'])}")
        out.append("    paths: [" + ", ".join(yaml_quote(p) for p in PATHS[r["lang"]]) + "]")
        out.append("    exclude_paths: [" + ", ".join(yaml_quote(p) for p in EXCLUDES) + "]")
    return "\n".join(out) + "\n"


def generate():
    rules = apply_budget(parse_self_scan(SELF_SCAN))
    errors = []

    missing = sorted({r["label"] for r in rules} - set(META))
    for lb in missing:
        errors.append(f"META tablosunda güvenli biçim/bölüm yok: {lb!r}")

    for r in rules:
        try:
            re.compile(r["regex"])
        except re.error as e:
            errors.append(f"Python re ile derlenmiyor ({r['label']!r}): {e}")
        if has_redos_structure(r["regex"]):
            errors.append(f"ReDoS sezgiseline takılıyor, plugin ELEYECEK ({r['label']!r})")

    # BLOK kuralları önce: 50 sınırına dayanırsak İNCELEME'ler kırpılsın.
    rules.sort(key=lambda r: (r["klass"] != "BLOK", r["lang"], r["label"]))
    if len(rules) > PATTERN_MAX_RULES:
        errors.append(
            f"{len(rules)} kural > plugin sınırı {PATTERN_MAX_RULES}; "
            f"desenleri alternation ile katlayın (§0.12.3a kural bütçesi)"
        )
    if errors:
        for e in errors:
            print(f"HATA: {e}", file=sys.stderr)
        sys.exit(2)
    return render(rules), len(rules)


def generate_guidance():
    """security/policies/guidance-*.md → .claude/claude-security-guidance.md.

    Kaynak ayrı tutulur ki `.claude/` altındaki dosya "elle düzenlenmiş" olmasın
    (§0.12.3b) ve drift kontrolü anlamlı kalsın.
    """
    parts, errors = [], []
    for path in GUIDANCE_SRC:
        try:
            with open(path, encoding="utf-8") as f:
                parts.append(f.read().strip())
        except OSError as e:
            errors.append(f"guidance kaynağı okunamadı: {path} ({e})")
    body = (
        "<!-- OTOMATİK ÜRETİLDİ — ELLE DÜZENLEMEYİN (SECURE-CODING v1.5 §0.12.3b).\n"
        "     Kaynak: security/policies/guidance-org.md + guidance-project.md\n"
        "     Üreteç: security/tools/sync_agent_guardrail.py -->\n\n"
        + "\n\n".join(parts)
        + "\n"
    )

    low = body.lower()
    for word in SUPPRESSION_LINT:
        if word in low:
            errors.append(
                f"bastırma dili tespit edildi: {word!r} — bu dosya yalnız kontrol "
                f"EKLEYEBİLİR veya severity YÜKSELTEBİLİR (§0.12.3b)"
            )

    size = len(body.encode("utf-8"))
    if size > GUIDANCE_MAX_BYTES:
        errors.append(
            f"guidance {size} bayt > plugin sınırı {GUIDANCE_MAX_BYTES}; "
            f"plugin kuyruğu SESSİZCE keser — kaynağı kısaltın"
        )
    if errors:
        for e in errors:
            print(f"HATA: {e}", file=sys.stderr)
        sys.exit(2)
    return body, size


def main():
    ap = argparse.ArgumentParser(description="§0.12.3 guardrail üreteci")
    ap.add_argument("--check", action="store_true", help="drift kontrolü; fark varsa exit 1")
    args = ap.parse_args()

    content, n = generate()
    guidance, gsize = generate_guidance()
    targets = [(OUT_PATTERNS, content), (OUT_GUIDANCE, guidance)]

    if args.check:
        for path, expected in targets:
            try:
                with open(path, encoding="utf-8") as f:
                    current = f.read()
            except OSError:
                print(f"DRIFT: {path} yok — üreteci çalıştırın", file=sys.stderr)
                sys.exit(1)
            if current != expected:
                print(
                    f"DRIFT: {os.path.relpath(path, REPO)} kaynağıyla uyumsuz.\n"
                    "Düzeltme: security/tools/sync_agent_guardrail.py (elle düzenlemeyin).",
                    file=sys.stderr,
                )
                sys.exit(1)
        print(f"guardrail senkron: {n} kural · guidance {gsize}/{GUIDANCE_MAX_BYTES} bayt")
        return

    os.makedirs(os.path.dirname(OUT_PATTERNS), exist_ok=True)
    for path, data in targets:
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(data)
    print(f"üretildi: .claude/security-patterns.yaml ({n} kural)")
    print(f"üretildi: .claude/claude-security-guidance.md ({gsize}/{GUIDANCE_MAX_BYTES} bayt)")


if __name__ == "__main__":
    main()
