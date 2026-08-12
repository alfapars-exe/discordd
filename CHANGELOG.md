# CHANGELOG — SECURE-CODING.md

Bu dosya, İnfina Ar-Ge Evrensel Güvenli Yazılım Geliştirme Standardı'nın sürümleri arasındaki
değişiklikleri kaydeder. Biçim [Keep a Changelog](https://keepachangelog.com/tr/1.1.0/) yaklaşımına,
sürümleme [Semantic Versioning](https://semver.org/lang/tr/) mantığına dayanır:

- **MAJOR** — geriye dönük uyumsuz politika değişikliği (mevcut repo'ların yeniden sertifikasyonu gerekir).
- **MINOR** — yeni zorunlu bölüm/kural eklenmesi; mevcut kurallar korunur.
- **PATCH** — yazım, referans veya örnek düzeltmesi; normatif etki yok.

> **Sürüm numaralandırma notu (v1.1 yayını için):** v1.1 yayımlandığında kurumsal olarak
> yayımlanmış tek sürüm **v1.0** idi. Genişletme çalışması sırasında üretilen
> `SECURE-CODING-v2_0.md` taslağı **yayımlanmış bir sürüm değil, bir öneri girdisidir**; içeriği bu sürümde değerlendirilerek v1.1'e alınmıştır. Kurallar
> korunup üzerine eklendiği (kaldırma/uyumsuzluk olmadığı) için sürüm **v1.1** olarak numaralanmıştır.
> Repo'lardaki `AGENTS.md` / `CLAUDE.md` bootstrap dosyalarında sürüm etiketi ve hash bu numaraya göre
> güncellenmelidir.

---

## [1.5] — 2026-08-06

### Girdi kaynağı ve gerekçe

- Kullanıcı isteği: bağımlılık yönetiminde, **sürüm pinlenmiş olsa dahi** yeni açıklanan CVE'lerin uyarılması — "şu bağımlılığın şu anki sürümünde şu açık tespit edilmiş, bir sonraki patch sürümünde düzeltilmiş" biçiminde.
- Bağlam: v1.4, "Sıfır Açık Bulgu Hedefine Taşıma Raporu"nu tam olarak entegre etmişti (bkz. `[1.4]`). §15/§32 SCA, cooldown, VEX ve "CVE watch" içeriyordu; ancak **pinlenmiş bağımlılıkların sürekli yeniden taranması, `first_fixed_version` raporlaması ve otomatik patch akışı** normatif değildi. Bu additive normatif yetenek olduğundan sürüm **v1.5**'e yükseltildi (changelog yol haritasındaki v1.5 hedefinin bir parçası öne çekildi).

### Eklendi

| Yeni içerik | Neden |
|---|---|
| **§15.1 — Pinlenmiş Bağımlılıklarda Sürekli CVE İzleme ve Otomatik Patch Önerisi** (`SC-DEP-CVE-001`) | "Sürüm pinlemek kodu dondurur, riski dondurmaz" ilkesi; pinli lockfile ≥ günlük + advisory-tetikli yeniden taranır |
| §15.1.1 **sürekli tarama kadansı** | zamanlanmış tam SCA + advisory-tetikli + runtime/registry yeniden tarama; "yalnız build-anı raporuna güvenme" |
| §15.1.2 **`dependency_finding` şeması** — `current_version` + **`first_fixed_version`** + `fix_type` + severity(CVSS+EPSS+KEV) + `affected_range` + reachability | kullanıcının istediği "şu sürümde açık, şu patch'te düzeltilmiş" bilgisini makine-okunur taşır |
| §15.1.3 **çok dilli, on-prem/KVKK öncelikli araç seti** | OSV-Scanner (air-gapped/yerel ayna) + dil-yerel denetçiler (`pip-audit`, `npm/pnpm audit`, `dotnet list package --vulnerable`, **`govulncheck`** reachability, `bundler-audit`, `cargo audit`) + Trivy/Dependency-Check; **auto-PR** Renovate self-hosted / Dependabot |
| §15.1.4 **otomatik patch akışı + SLA + dürüst "pinned-but-vulnerable" ele alışı** | yeni CVE agent regresyonu değildir → secret-rotation gibi SLA'lı yükümlülük; patch/minor→agent auto-PR, major→insan, fix yok→telafi+VEX; VEX ≠ risk kabulü, AppSec yetkisi |
| §15.1.5 **gate/release/§0.3 bağlanışı** + `SC-DEP-CVE-001` normatif hükmü | `open_sca_findings == 0` = "eşik üstü, SLA-dışı, VEX'siz açık CVE yok" olarak okunur |
| §36 test matrisine **"Pinned-dep sürekli CVE + fixed-version"** satırı | PR (yeni direct dep) / nightly (≥ günlük) / release (eşik üstü açık = 0) / production (advisory-tetikli rescan + auto-PR) |
| D3'e **3 metrik** (pinned-dep CVE yaşı, mean time to dependency-patch, fixed-version availability) | yeni yeteneğin gözlemlenebilirliği |
| D4'e **pinned-dep CVE müdahale maddesi**; §15/§32'ye sürekli-izleme maddeleri; E1'e `dep_cve_scan.py` | mekanizmanın olay-müdahale, kural ve dosya-yapısı ayakları |

### Değiştirildi

- Başlık, §0.9 bootstrap ve footer **v1.5**'e güncellendi.
- Bölüm D "Düzeltme SLA'sı" satırı §0.11 ile hizalandı: **Low ≤ 180 gün**; aynı SLA'nın pinlenmiş bağımlılık CVE'lerine de uygulandığı belirtildi.
- §0.3 sıfır tanımı, SCA'yı da kapsayacak biçimde netleştirildi: sürekli açıklanan CVE'ler **yönetişimli düzeltme/VEX** ile ele alınır, sessizce değil.

### Kaldırılan / gevşetilen kural

- **Yoktur.** Tüm v1.4 hükümleri korunmuştur; değişikliklerin tamamı ekleme veya (SLA hizalaması) sertleştirmedir.

### Sürüm numarası notu

- Yüklenen dosya zaten tam bir **v1.4** idi (rapor `[1.4]`'te entegre). Bu mesajdaki bağımlılık-CVE isteği additive normatif bir yetenek olduğundan **v1.5** olarak numaralandı — bu, changelog'un kendi yol haritasındaki v1.5 hedefiyle tutarlıdır. Yayımlanmış v1.4'ün anlamını/hash'ini bozmamak için üzerine yazılmadı. Ekibin tercihi v1.4 etiketinde kalmaksa tek adımda geri alınabilir.

### v1.5'e geçiş adımları (repo başına)

1. `security/tools/dep_cve_scan.py` eklenir; **OSV-Scanner** (yerel OSV ayna) + en az bir dil-yerel denetçi CI'a bağlanır; çıktı §15.1.2 şemasına normalize edilir.
2. **Zamanlanmış (≥ günlük) SCA job'ı** tüm aktif branch lockfile'larına kurulur; advisory beslemesi (OSV/GHSA ayna) webhook'u ile tetikleme eklenir.
3. **Renovate self-hosted** (KVKK öncelikli) veya Dependabot vulnerability alerts açılır; `vulnerabilityAlerts` + minimum-fix yükseltme + gruplama yapılandırılır; auto-PR §15.1.4 kapısına (lockfile + testler + yeni-bulgu-yok) bağlanır.
4. İç registry (Nexus/Artifactory) proxy'si advisory + paket çekimini iç ağda tutar (kod-gizliliği, §23).
5. Release gate'e "eşik üstü açık pinned-dep CVE = 0 (SLA-içi/VEX hariç)" kriteri; D3 metrikleri baseline'a alınır.

---

## [1.4] — 2026-08-06

### Girdi kaynağı

- **İlk kez bir Checkmarx taraması DEĞİL:** Anthropic **`security-guidance` Claude Code eklentisi v2.0.6** (25 regex deseni + tek-atış LLM inceleme prompt'undaki ~40 zafiyet kategorisi + agentic investigate→refute prompt'ları), doğrulanmış bir savunma-aracı kural kümesi olarak hasat edildi — bulgu-tepkisel değil **proaktif** genişletme. Eklenti bir *öneri girdisidir*; normatif metin standarttır. Bölüm G kaynak anlatısı buna göre genişledi (G4 önsözü).
- **Sürüm tespiti:** `anthropics/claude-code` altındaki eklenti kopyası **bayat mirror'dır** (v2.0.0 gösterir); gerçek upstream `anthropics/claude-plugins-official`'dır ve yerel kurulum (2.0.6) günceldir. Sürüm doğrulaması yalnız gerçek upstream'den yapılır.

### Kök neden analizi ("neden bu ekleme gerekiyor?")

1. **Kapsam denetimi:** Eklentinin kategorilerinden önemli bir bölümü v1.3'te kuralsızdı (argv flag smuggling, subprocess env injection, boolean coercion, entropi tabanı, credential dosya izinleri, fail-open kapı, parser differansiyeli, registry fanout, OAuth state bağlama, spoofable header, orchestrator template injection, Node `child_process`, `createCipher`, `torch.load`/pickle ailesi…); bir bölümü ise kurallıydı ama **desensizdi** (DOM XSS sink'leri, Python SQL f-string, XXE, path traversal, GH Actions `${{ }}`) — insafe olayındaki mekanizma açığıyla aynı sınıf.
2. **v1.3'ün ✅ örneğinde düzeltme gerektiren kusur:** §11 path traversal örneği leksikal `resolve + startsWith` kullanıyordu — symlink ile atlatılabilir; realpath-first olarak düzeltildi.
3. **self-scan.sh'de 3 kusur:** (a) `yaml.load` deseninde POSIX ERE'de çalışmayan PCRE lookahead; (b) `incele()` yalnız Python ekinde tanımlıydı — B4'ün istediği İNCELEME çıktısı taban script'ten hiç üretilemiyordu; (c) `venv/.venv/site-packages/__pycache__` exclude'ları eksikti.

### Eklendi

| Yeni içerik | Neden |
|---|---|
| **G4.1–G4.17 + G4.0 çatışma notu** (argv smuggling, env injection, Node child_process, OAuth state/token-minting, spoofable header, fail-open kapı, kapı/eylem uyumu, viewer-yetkisi serileştirme, parser differansiyeli, allowlist bypass, bool coercion, registry fanout, entropi tabanı, credential dosya izni, createCipher, agent izin bypass'ı, orchestrator injection) + §1/§2/§3/§4/§5/§6/§7/§9/§10/§11/§16/§19/§21/§31/§33 ev sahibi bölüm ekleri | Eklenti kategorilerinin kuralsız kalanları; her kural CWE etiketli + ❌/✅ örnekli |
| **§0.10'a 13, §0.10.1'e 21 yeni desen satırı** + **yeni §0.10.2 CI/Workflow (YAML) desen seti** (`INC_CI`; GHA untrusted context, pwn request, SHA pin, orchestrator template, OIDC trust, agent izin bypass'ı BLOK) | Kurallı-ama-desensiz ailelerin icrası (insafe dersinin genelleştirilmesi); workflow YAML'ları ilk kez kapsama girdi |
| **Yeni §0.12 "Gerçek-Zamanlı Agent Guardrail Katmanı"** — eklenti kurulumu ZORUNLU (AI-destekli her repo); KVKK/§23 çerçevesi (endpoint kurumsal gateway'e pin); kill-switch YASAK tablosu; `.claude/security-patterns.yaml` (§0.10'dan üretilir, elle düzenlenemez) + `.claude/claude-security-guidance.md` (≤8 KB, yalnız ekler/yükseltir) + `sync_agent_guardrail.py --check` CI drift kontrolü; diff-baseline disiplini + **gate için "yeni bulgu" tanımı** (in-diff / off-diff-enabled); self-certify yasağı ("plugin sessizliği kanıt değildir"); suppression çelişkisinin katı okuması | Eklentinin kendisi kalıcı guardrail katmanı olarak normatifleşti; "guardrail ≠ gate; gate CI'dadır" |
| **§0.2 iki geçişli RCI** (yüksek riskte incele → çürüt) + **§0.6 R1–R11 çürütme taksonomisi** (R4 NEVER-listesi; **R8 throwaway-code İnfina'da bilinçli olarak GEÇERSİZ** — §0.5 kazanır) + §0.7 akışına saldırgan/kurban adımı | Eklentinin investigate→refute mimarisinin ve refutation taksonomisinin normatifleştirilmesi |
| **C8 eşleme tablosu** (~55 satır: plugin kuralı ↔ v1.3 durumu ↔ v1.4 karşılığı ↔ §0.10 deseni; ⚠ = standart daha katı) | Tam izlenebilirlik — insafe tablosunun eklenti karşılığı |
| **B2-ek 41–50** + B önsözüne "yorumlar kanıt değildir" hükmü + B3'e registry-fanout alanı + **B4'e 9. madde (guardrail bölümü)** ve 50-madde/G4/§0.10.2 güncellemeleri; şablon `security-delivery-report.template.html` buna göre güncellendi | Yeni kuralların teslim kanıtına bağlanması |
| **§39 #14** (agent'ın guardrail'i devre dışı bırakması) + **D3'e 3 metrik** (guardrail finding density, refute-survival rate, guardrail tamper attempt rate) + **D2'ye guardrail onay satırı** + **E1'e `.claude/` üçlüsü ve `sync_agent_guardrail.py`** + §0.2 manifest şablonuna `guardrail:` bloğu + E2'ye guardrail durumu satırı + §0.9 bootstrap 9. madde | Mekanizmanın gözlemlenebilirlik, onay ve dosya-yapısı ayakları |

### Değiştirildi

- **§11 path traversal ✅ örneği DÜZELTİLDİ:** leksikal `path.resolve + startsWith` → **realpath-first** (symlink bypass kapatıldı); "`join` traversal'ı önlemez" hükmü eklendi. (Sertleştirme.)
- **§12 SSRF:** allowlist bypass taksonomisi (userinfo `@`, base-resolution, suffix, normalizasyon, aynı-parser, redirect) + HTTP-dışı taint kaynakları (`.mcp.json`, `package.json`, repo YAML'ı…).
- **§2 OAuth:** `state` oturum bağlama sözleşmesi (forgeable base64-JSON state = no-op) + kimliksiz token üretimi yasağı.
- **§7:** JS event-handler attribute decode inceliği (`html.escape` yetmez → `JSON.stringify`), eksik escaper, yanlış-tehdit sanitizer'ı, template autoescape sözleşmesi (jinja2 `Environment()` default KAPALI, Go `text/template`, EJS `<%- %>`, `mark_safe`).
- **§14:** pickle ailesi genişletmesi (cPickle/cloudpickle/dill/marshal/shelve/joblib/read_pickle/allow_pickle/torch.load + `_load` sarmalayıcıları).
- **§3:** TLS yasak listesi genişletmesi (`_create_unverified_context`, `check_hostname=False`, `sslmode=disable`, `grpc.insecure_channel`, `curl -k`, `--insecure-skip-tls-verify`) + §0.10 TLS BLOK regex'i buna göre güncellendi; YASAK listesine `createCipher` eklendi.
- **§6:** shell wrapper = aynı sink; `basename` metakarakter notu; dolaylı taint kaynakları.
- **§31:** untrusted context tam listesi (18 madde) + `actions/checkout` ref injection kuralı.
- **§36:** gate politikasında "yeni bulgu" tanımı §0.12.4'e bağlandı; guardrail'in gate-öncesi danışma statüsü; kontrol matrisine guardrail satırı.
- **self-scan.sh onarımı:** PCRE lookahead → iki aşamalı `grep -v`; `incele()` taban script'e taşındı (düz boru + `tee "$OUT"`; sed ayracı `|` — `/` içeren etiketler s komutunu kırıp eşleşmeyi sessizce yutuyordu); merkezî `EXC` değişkeni (venv/site-packages/build/.next/vendor/coverage dâhil); Python desenleri `INC_PY`/`blok_py`/`incele_py` ile yalnız `*.py`'ye kapatıldı (çapraz-dil yanlış tetiklemesi: `jwt.decode` Python'da meşru API).
- **Tablo↔script eşliği denetimi (bağımsız doğrulama bulguları):** tabloda ilan edilip script'te uygulanmayan desenler eklendi — Secret Leak response (2 aşama, `grep -v toPublic`), ham `err` değişkeni yanıtta, `HTMLResponse/PlainTextResponse`, `getrandbits` (düşmüştü, geri kondu), orchestrator template PY satırı (Airflow DAG'leri `.py`'dir), 0.0.0.0 bind (İNCELEME) ve 777 izinlerinin JS/sh karşılığı; PY hardcoded-secret BLOK'una `TOKEN_ENDPOINT` tipi FP'ler için 2 aşamalı eliminatör; "Unchecked Loop Condition" satırı açıkça "yalnız manuel" işaretlendi; §2 `jwt.decode` istisnası §0.10 BLOK'uyla çelişmeyecek biçimde netleştirildi.
- Başlık bloğu, §0.9 bootstrap örneği ve footer **v1.4**'e güncellendi.
- CHANGELOG yapısal temizliği (PATCH niteliğinde): "Planlanan" bölümündeki bayat `[1.2]` etiketi `[1.5]` yapıldı; v1.3'ten miras **başlıksız kalmış `[1.2]` ve `[1.1]` sürüm girdilerine** başlık eklendi (içerik değişmedi).

### Kaldırılan / gevşetilen kural

- **Yoktur.** §0.3 Sıfır Açık Bulgu Protokolü aynen geçerlidir; tüm değişiklikler ekleme veya sertleştirmedir. Tek bilinçli sapma, eklentinin "throwaway-code" çürütmesinin **reddidir** (§0.6 R8): §0.5 "çevre kod kanoniktir" hükmü üstündür — bu bir gevşetme değil, gevşetmenin engellenmesidir.

### Eklenti ↔ standart çatışmaları (standart üstündür — G4.0)

1. Dev-fallback secret'lar: eklenti bulgulamaz → **G3.2/§4 yasaklar**. 2. DoS/rate-limit: eklenti kapsam dışı → **§13 zorunlu**. 3. Env var/CLI argümanı: eklenti güvenilir sayar → **§0.2/§5 güvensiz sayar**. 4. Low severity: eklenti düşürür → **§0.3 Low dahil**. 5. `scripts/`/test = "throwaway": eklenti çürütür → **§0.5 kanonik**. 6. Satır-içi yorumla susturma: README ima eder → **tek yol §0.6** (eklentinin kendi prompt'ları da yorumlara güvenmez). 7. İstemci-tarafı telemetri anahtarları otomatik muaf değildir (§4).

### Eklenti kuralı → v1.4 izlenebilirliği

Tam eşleme standardın **C8** tablosundadır (plugin kuralı ↔ v1.3 durumu ↔ v1.4 karşılığı ↔ §0.10 deseni ↔ katılık işaretleri).

### v1.4'e geçiş adımları (repo başına)

1. Kurumsal marketplace'ten `security-guidance@≥2.0.6` kurulur; managed settings'e `ANTHROPIC_BASE_URL` + `SECURITY_REVIEW_MODEL` + `SG_AGENTIC_MODEL` pin'leri işlenir (BT yönetimi, workspace dışı).
2. `security/tools/sync_agent_guardrail.py` eklenir; `.claude/security-patterns.yaml` (§0.10+§0.10.1+§0.10.2'den) ve `.claude/claude-security-guidance.md` (G/G2/G3/G4 tek-cümlelikleri + ADDENDUM invaryantları, ≤8 KB) üretilip commit edilir.
3. `.claude/settings.json` pin kopyası commit edilir; `agent-tools.yml`'e `guardrail:` bloğu + write-deny yolları; CODEOWNERS'a `.claude/` AppSec sahipliği.
4. CI'ya `sync_agent_guardrail.py --check` drift adımı eklenir (fark = build fail); `self-scan.sh` v1.4 sürümüyle değiştirilir (onarımlar + yeni desenler + §0.10.2).
5. `AGENTS.md`/`CLAUDE.md` bootstrap'ına 9. madde işlenir; sürüm + hash v1.4'e güncellenir (§0.9).
6. B2-ek 41–50 ve §0.6 R1–R11 ekiplerle paylaşılır; ilk `yüksek` risk PR'da iki geçişli RCI pilotu koşulur.
7. §39 #14 senaryosu red-team kataloğuna işlenir ve ilk tur çalıştırılır; D3'ün 3 yeni metriği için baseline ölçümü alınır.
8. `SECURITY-ADDENDUM.md`'ye guardrail durumu bölümü, §23 işleme faaliyeti kaydına eklenti incelemesi işlenir.

---

## [1.3] — 2026-08-06

### Girdi kaynağı

- Checkmarx tarama raporu: **`arge insafe`** (scanid=1000880, projectid=102) — farklı bir ürünün (Python backend + TS/TSX frontend, 45.923 LOC) **ilk tam taraması**, branch: `Insafe-sql-injection-and-bug-fixed`. Sonuç: **480 bulgu (0 Critical, 46 High, 140 Medium, 294 Low)**, tamamı `New / To Verify`. Öne çıkanlar: Reflected XSS 44 (High), SSRF 2 (High), Privacy Violation 68, Use of Hardcoded Password 38, Object Access Violation 21, Hardcoded Password in Connection String 9, Log Forging 162, Information Exposure via Error 59, Filtering Sensitive Logs 35.

### Kök neden analizi ("neden hâlâ bulgu geliyor?")

1. **Kapsama sorunu, kural sorunu değil:** Bulgu ailelerinin büyük kısmı v1.2'de zaten yasaktı — `config.py`'deki `environ.get("SMTP_PASSWORD", <default>)` deseni §4'ün birebir ❌ örneği; `scripts/e2e_reset.py`'deki `E2E_PASSWORD = "..."` §0.5 çevre-kod kuralının birebir ihlali; XSS §7, log hijyeni §20, session boundary §5/§14'te vardı. Standart insafe repo'sunda **hiç icra edilmedi**; ilk tam tarama birikmiş borcu envanterledi.
2. **v1.2'nin gerçek mekanizma açığı:** §0.10 öz-tarama desenleri **yalnız JS/TS** idi — Python dosyalarında hiçbir BLOK deseni çalışamazdı. Sıfırı üreten mekanizma bu üründe kör kaldı.
3. **Üçüncü kez aynı süreç hatası:** Yine tarama başına yeni Checkmarx projesi (101 → 102) — baseline yok, `Fixed` takibi imkânsız; ve yine `"-fixed"` adlı dar kapsamlı görev çerçevesi (SQLi gerçekten 0 Critical, ama 44 High XSS ve 47 hardcoded secret açık kaldı).

### Eklendi

| Yeni içerik | Neden |
|---|---|
| **§0.10.1 Python Desen Seti** — 15 satırlık BLOK/İNCELEME tablo + `self-scan.sh` Python ekleri (`incele()` fonksiyonu dâhil) + "desen seti repo'nun TÜM dillerini kapsamak zorundadır" hükmü | insafe'deki körlüğün doğrudan kapatılması; her ailenin grep karşılığı tanımlandı |
| **§0.11 Kurumsal Yaygınlaştırma, Repo Onboarding ve Kalıcı Tarama Kaydı** | Sorunun yapısal cevabı: org varsayılanı (template repo + merkezî `secure-coding-compliance` CI check'i) · **ürün başına tek kalıcı Checkmarx projesi** (tarama başına proje açmak yasak) · 8 adımlık repo onboarding checklist'i · **legacy borç protokolü** (ilk tarama = envanter; ≤5 iş günü triage sprinti; SLA burn-down, Low ≤ 180g) · **görev çerçevesi kuralı** ("bulgu sınıfı düzelt" görevi bile B4 tam teslimle kapanır; "-fixed" branch adı kanıt değildir) · adoption metrikleri |
| **G3 — insafe bulgularından türetilen 8 zorunlu kural** | G3.1 yanıt yankısı yasağı / merkezî encode helper (44 XSS tek sink'ten) · G3.2 hardcoded credential icrası — çevre kod dâhil, config default'u yasak · G3.3 `setattr`/`__dict__.update` yasağı + Pydantic `extra="forbid"` (Object Access Violation) · G3.4 merkezî sanitize logger (162 Log Forging + 35 Sensitive Logs) · G3.5 session'a yalnız doğrulanmış DTO · G3.6 cookie değeri yalnız sunucu üretimi token · G3.7 `safe_fetch` zorunluluğu (SSRF) · G3.8 `HTTPException(detail=str(e))` yasağı |
| B4 şablonuna **8 G3 satırı** (başlık: G + G2 + G3) | Rapor checklist'i yeni ailelerle hizalandı |

### Değiştirildi

- Başlık bloğu, §0.9 bootstrap örneği ve footer **v1.3**'e güncellendi.
- §0.10 giriş hükmü: desen setinin repo'daki her dili kapsaması zorunlu kılındı; kapsamayan repo'da §0.11 onboarding'i tamamlanmamış sayılır.

### Kaldırılan / gevşetilen kural

- **Yoktur.** §0.3 Sıfır Açık Bulgu Protokolü aynen geçerlidir; tüm değişiklikler ekleme veya sertleştirmedir.

### insafe bulgusu → v1.3 kuralı izlenebilirliği

| Bulgu (arge_insafe) | Adet/Sev. | v1.3 karşılığı | v1.2'de zaten var mıydı? |
|---|---|---|---|
| Reflected XSS (`helpers.no_cache_json` sink'i) | 44 High | G3.1 + §0.10.1 | Kural vardı (§7); Python deseni yoktu |
| SSRF (`requests.*` doğrudan) | 2 High | G3.7 + §0.10.1 | Kural vardı (§12); wrapper zorunluluğu yeni |
| Use of Hardcoded Password (`e2e_reset.py` dâhil) | 38 Medium | G3.2 + §0.10.1 BLOK | Kural vardı (§4, §0.5); icra deseni yoktu |
| Hardcoded Password in Connection String (`config.py` default) | 9 Medium | G3.2 | §4 fallback yasağının birebir vakası |
| Object Access Violation (`setattr` / `upsert_rows`) | 21 Medium | **G3.3 (yeni kural)** | Kısmen (§1/§5); Python karşılığı yoktu |
| Privacy Violation | 68 Medium | §20/§23 + G3.4 | Vardı |
| Unchecked Loop | 3 Medium | §13 / G2.8 | Vardı |
| HttpOnly | 1 Medium | G3.6 / G2.3 | Vardı |
| Log Forging | 162 Low | **G3.4 + §0.10.1 (yeni icra)** | Kural vardı (§20 CWE-117); desen yoktu |
| Filtering Sensitive Logs | 35 Low | G3.4 + §20 matrisi | Vardı |
| Info Exposure / Privacy / Secret in Error | 69 Low | G3.8 (G2.7'nin Python eşleniği) | Vardı |
| Trust Boundary in Session | 11 Low | **G3.5 (yeni kural)** | Kısmen (§5/§14) |
| Cookie Poisoning (`_set_refresh_cookie`) | 9 Low | G3.6 | Kısmen (G2.3) |
| Random / iframe / CSP / clickjacking | 8 Low | §3, §7, §16 | Vardı |

### v1.3'e geçiş adımları (insafe için onboarding)

1. §0.11 madde 3 checklist'i insafe repo'suna uygulanır (bootstrap + SCOPE + EXCEPTIONS + agent-tools + self-scan **Python desenleriyle** + helper iskeleti + B4 şablonu).
2. Checkmarx'ta insafe için **tek kalıcı proje** belirlenir; `projectid=102` bu kayıt olur, bundan sonra tüm taramalar buraya yapılır — yeni proje açılmaz.
3. **≤5 iş günü triage sprinti:** 480 bulgu sınıflandırılır (0 `To Verify` hedefi); Confirmed'ler SLA'ya bağlanır.
4. Kod düzeltme sırası (en yüksek kaldıraç): G3.1 merkezî response helper (44 High) → G3.2 secret temizliği + rotasyon (47) → G3.4 merkezî logger (197 Low'un ~%85'i) → G3.8 merkezî exception handler (69 Low) → G3.3/G3.5/G3.6/G3.7.
5. Her düzeltme turu: §0.10+§0.10.1 öz-tarama → aynı projeye tarama → B4 raporu; hedef §0.3 sıfır durumu.

---


## [1.2]

> *(v1.4 düzeltmesi: bu sürüm girdisi CHANGELOG'da başlıksız kalmıştı; içerik değiştirilmeden başlık eklendi. Orijinal yayın tarihi girdide kayıtlı değildi.)*

### Girdi kaynağı

- Checkmarx tarama raporu: **`mihenk 360 fixed second`** (scanid=1000879) — fix branch'inin (`feature/fixed-sql-injection-and-bugs`) ilk düzeltme turu sonrası durumu: **58 bulgu (1 Critical, 0 High, 21 Medium, 36 Low)**, tamamı `To Verify`. Önceki taramaya göre delta: 87 → 58; 9 Critical → 1, 12 High → 0. İlk tur gerçek ilerleme sağladı ancak (a) her taramanın **yeni Checkmarx projesi** olarak açılması baseline'ı yok etti, (b) kalan bulgu aileleri (auth yanıtında password akışı, JWT'de PII claim, cookie helper'sız `Set-Cookie`, localStorage session, test dosyasında `document.cookie`, generic query-builder, `err.message` yanıtları) kural olarak yeterince bağlayıcı değildi, (c) Low severity gate dışındaydı.

### Sürüm hedefi değişikliği (en önemli karar)

**"Sıfır kontrolsüz risk" hedefi, "Sıfır Açık Bulgu Protokolü"ne yükseltildi (§0.3).** Artık **Critical, High, Medium ve Low dahil hiçbir severity'de açık bulgu bırakılamaz**; Information bulgular dahi triage edilmeden kalamaz. Sıfır, üç şeridin birlikte işletilmesiyle sağlanır: (1) kodda önleme, (2) scanner-clean kod biçimi — bulgu **hiç doğmaz**, (3) kayıtlı triage. "Görev tamamlandı" tanımı buna bağlandı: aynı Checkmarx projesine yapılmış son taramada 0 açık bulgu + 0 `To Verify` + 0 onaysız istisna + FAIL'siz B4 raporu.

### Eklendi

| Yeni içerik | Neden |
|---|---|
| **§0.10 Teslim Öncesi Deterministik Öz-Tarama** — Checkmarx sorgularına birebir eşlenmiş BLOK/İNCELEME desen tablosu + repo'ya eklenecek `security/tools/self-scan.sh` referans script'i | Bulgular scanner'a gitmeden kod tarafında sıfırlanır; ikinci taramadaki her aile için desen tanımlandı |
| **B4 — Teslim Sonrası Doğrulama ve Zorunlu HTML Raporu** | Agent her görev sonunda `security-delivery-report.html` üretir: meta, tarama karşılaştırması, **40 maddelik B checklist'i (PASS/FAIL/N-A + kanıt)**, G/G2 aile kontrolleri, çalıştırılan komutlar (sürüm + exit code), öz-tarama çıktısı, insan triage kuyruğu, kalan risk + rollback, kanıt dürüstlüğü beyanı. FAIL içeren rapor teslim değildir |
| **`security/templates/security-delivery-report.template.html`** | B4'ün tek dosyalık, bağımsız (CDN'siz), otomatik PASS/FAIL sayaçlı şablonu — 40 checklist maddesi ve G2 tablosu gömülü |
| **G2 — İkinci tarama bulgularından türetilen 9 ek zorunlu kural** | G2.1 auth yanıt DTO zorunluluğu (Secret Leak, iç severity **High**) · G2.2 JWT claim minimizasyonu — signed download token dâhil · G2.3 merkezî cookie helper, `httpOnly` varsayılan, ham `Set-Cookie` yasağı · G2.4 istemci session depolama yasağı (`stripTokens` yetersizdir) · G2.5 testlerde `document.cookie` yasağı → Playwright `context.addCookies/clearCookies` · G2.6 generic query-builder sözleşmesi (bind + identifier allowlist + IN-chunk MAX cap) · G2.7 merkezî hata cevabı (36 Low'un 31'inin kökü) · G2.8 sınırlı döngü kanıtı · G2.9 JS-readable UI cookie kuralları |
| §36 test matrisine **"Agent B4 HTML teslim raporu"** satırı | Rapor, PR ve release kanıt setinin parçası oldu |

### Değiştirildi

- **§0.3** tamamen yeniden yazıldı (yukarıdaki hedef değişikliği); "aynı Checkmarx projesine tarama" zorunluluğu ve "yeni proje açmak YASAK" hükmü eklendi — baseline süreksizliği ikinci taramada bulgu takibini imkânsız kılmıştı.
- **§0.2 teslim akışı:** §0.10 öz-taraması, aynı projeye **düzelt → yeniden tara** döngüsü, scanner erişimi yoksa "taramaya hazır" statüsü ve B4 raporu zorunlu adım olarak eklendi; "tamamlandı" engeli Critical/High'dan **herhangi bir severity'ye** genişletildi.
- **§36 Gate politikası:** PR gate'i "yeni Critical/High/Medium" → **"herhangi bir severity'de yeni bulgu (Low dahil)"**; Release gate'i **"herhangi bir severity'de açık bulgu + triage edilmemiş Information + eksik/FAIL'li B4 raporu"** olarak sertleştirildi.
- Başlık bloğu ve §0.9 bootstrap örneği v1.2'ye güncellendi; bootstrap'a 8. madde (B4 raporu) eklendi; E1 repo yapısına `templates/` ve `self-scan.sh` girdi.

### Kaldırılan / gevşetilen kural

- **Yoktur.** Tüm v1.1 hükümleri korunmuştur; değişikliklerin tamamı ekleme veya sertleştirmedir. (Low severity'nin gate'e alınması ve hedefin sıfıra çekilmesi sertleştirmedir.)

### İkinci tarama bulgusu → v1.2 kuralı izlenebilirliği

| Bulgu (fixed-second) | Adet/Sev. | v1.2 karşılığı |
|---|---|---|
| SQL Injection — `executor.ts runInsert` | 1 Critical | G2.6 + §0.10 BLOK deseni |
| Secret Leak — `auth.ts` sign-in/sign-up yanıtı | 3 Medium | G2.1 (iç severity High) + §0.10 |
| Privacy Violation in JWT — `auth.service.ts` / `storage.service.ts` | 3 Medium | G2.2 + §0.10 İNCELEME |
| HttpOnly Cookie Flag Not Set — `cookies.ts` middleware + `sidebar.tsx` + `csrf.test.ts` | 10 Medium | G2.3 + G2.9 + G2.5 |
| Client DOM Cookie Poisoning — `csrf.test.ts` | 1 Medium | G2.5 |
| Client HTML5 (Insecure / Sensitive) Storage — `client.ts writeSession` | 2 Medium | G2.4 + §0.10 BLOK |
| Unchecked Loop — `relation.ts enrichRows` / `format.ts formatBytes` | 2 Medium | G2.6 / G2.8 |
| Error Messages + Logs ailesi (Privacy/Secret/Info) | 31 Low | G2.7 + §0.10 BLOK |
| Diğer Low'lar (iframe sandbox, headers, clickjacking, target=_blank, random) | 5 Low | Mevcut §3/§7/§16 + gate artık Low'u da kapsıyor |

### v1.2'ye geçiş adımları (v1.1 adımlarına ek)

1. Checkmarx'ta **tek kalıcı proje** belirlenir (ör. `mihenk-360`); bundan sonra tüm taramalar (branch parametresiyle) bu projeye yapılır — "fixed second" gibi yeni projeler açılmaz; mevcut dağınık projeler arşivlenir.
2. `security/tools/self-scan.sh` repo'ya eklenir; pre-commit + CI'da koşar; BLOK eşleşmesi build'i kırar.
3. `security/templates/security-delivery-report.template.html` repo'ya eklenir; agent bootstrap'ına 8. madde işlenir.
4. G2.1–G2.7 kod değişiklikleri uygulanır (DTO, JWT claim, cookie helper, writeSession kaldırma, test cookie API, query-builder, merkezî error middleware).
5. Kalan yapısal bulgular (sidebar cookie, formatBytes) §0.6 kayıtlarıyla portalde kapatılır; hedef durum: **0 açık / 0 To Verify — tüm severity'lerde**.

---


## [1.1]

> *(v1.4 düzeltmesi: bu sürüm girdisi CHANGELOG'da başlıksız kalmıştı; içerik değiştirilmeden başlık eklendi. Orijinal yayın tarihi girdide kayıtlı değildi.)*

### Girdi kaynakları

- Checkmarx tarama raporları: `mihenk-360` (87 sonuç: 9 Critical, 12 High, 19 Medium, 47 Low) ve
  `arge_prompt_management` (30 sonuç: 1 High, 11 Medium, 18 Low) — tamamı `To Verify` durumunda.
- "Agentic ve Vibe Coding Uyumlu Evrensel Güvenli Yazılım Geliştirme Standardı İçin Araştırma Raporu".
- "İnfina SECURE-CODING.md v1.1 için Kapsamlı Araştırma Raporu" (SAST kural evreni ve boşluk analizi).
- `SECURE-CODING-v2_0.md` taslağı ve `SECURITY-SCOPE.template.yml`.

### Eklendi (yeni normatif bölümler)

| Yeni bölüm | Neden eklendi |
|---|---|
| **§0.0 Normatif dil, öncelik ve çelişki çözümü** | v1.0'da ZORUNLU/YASAK/ÖNERİLİR tanımı ve doküman öncelik sırası yoktu; kurallar yorum açığı bırakıyordu. |
| **§0.2 AI/Agent Güvenlik Sözleşmesi** (talimat hiyerarşisi, yasak listesi, zorunlu akış, durma koşulları, **`agent-tools.yml` yetki manifesti**) | v1.0'da LLM *entegrasyonu* vardı; kod üreten **agent'ın kendisi** için operasyonel guardrail yoktu. |
| **§0.3 Güvenlik hedefi tanımı** | "Sıfır bulgu" hedefi ölçülemez ve yanıltıcıydı; ölçülebilir hedef seti (0 açık Critical/High, 0 `To Verify`, 0 onaysız suppression…) tanımlandı. Ayrıca `Not Exploitable` ≠ `Accepted Risk` ayrımı eklendi. |
| **§0.4 Tarama kapsamı ve artifact sınıflandırması** + `SECURITY-SCOPE.yml` şablonu | Raporlarda aynı kusurun hem `src/` hem `backend/dist/` kopyasında görünmesi; wireframe HTML'in "tasarım dosyası" sanılması. |
| **§0.5 Çevre Kod Güvenliği** (scripts/tests/mocks/fixtures/migrations/IaC/CI) | `arge_prompt_management` bulgularının büyük kısmı test, script ve wireframe dosyalarından geldi. v1.0'ın en büyük kör noktası. |
| **§0.6 Triage, exclusion ve suppression yönetişimi** (20 alanlı `SECURITY-EXCEPTIONS.yml` + CI red kuralları) | Tüm bulguların `To Verify` kalması; gerekçesiz/süresiz istisna riski. |
| **§0.7 Scanner modeli, FP/FN nedenleri, araç bazlı tuning tablosu, bulgu doğrulama akışı** | "Scanner temiz = kod güvenli" varsayımını kırmak; Checkmarx/Sonar/Semgrep/CodeQL/Veracode/Fortify/Snyk/Trivy için zorunlu tuning yaklaşımı. |
| **§0.8 Merkezî güvenlik wrapper kütüphanesi + scanner-dostu kod biçimi** | Güvenli kontrolün hem insan hem taint-analiz aracı tarafından tanınabilmesi; her wrapper için 5 zorunlu kanıt. |
| **§0.9 Agent talimat dosyalarına dağıtım, policy-as-code ve kural yazım biçimi** | 100+ KB'lık dosyanın her agent tarafından okunacağı garanti değil; bootstrap + hash drift kontrolü. Ayrıca **persona kalıbının yasaklanması** ve **RCI öz-eleştiri adımının zorunlu kılınması**. |
| **§39 Agentic red-team senaryo kataloğu** (13 saldırı + ölçülecek metrikler) | Agent güvenliğinin test edilebilir hâle getirilmesi. |
| **§40 Çok dilli güvenli örüntü matrisi** (JS/TS · Python · Java) | AI'a ve geliştiriciye doğrudan kopyalanabilir düzeltme kalıbı vermek. |
| **Bölüm A3** (§36–§40 doğrulama başlığı altında toplandı) | Test/gate/kanıt konularının tek çatı altında toplanması. |
| **C5 — Agentic Top 10 2026 (ASI01–ASI10) eşlemesi** | v1.0'da agentic taksonomi yoktu. |
| **C6 — Doğrulama standartları eşlemesi** (ASVS 5.0 / WSTG / MASVS / TCASVS / SSDF / 800-218A / 800-63B-4 / SLSA 1.2 / LLMSVS 2.0 / AISVS 1.0 / CycloneDX) | Her standardın hangi bölümle ve hangi kanıtla karşılandığının izlenebilmesi. |
| **D1 — Makine tarafından okunabilir requirement izlenebilirliği** (`SECURITY-REQUIREMENTS.yml`) | "OWASP uyumlu" gibi ölçülemez ifadeleri ortadan kaldırmak. |
| **D3 — Genişletilmiş metrik tablosu** (15 metrik + kötüye kullanım notu) | Metriklerin toplu `Not Exploitable` ile manipüle edilmesini engellemek. |
| **E1 — Önerilen repo dosya yapısı** (`security/` ağacı: policies, semgrep, fixtures, tests, tools) | Politikanın koda dönüşmesi (policy-as-code). |
| **Bölüm G — Checkmarx bulgularından türetilen zorunlu kurallar** (22 satırlık kural+kanıt tablosu) | Her rapor bulgusunun bir kurala ve bir teste bağlanması. |

### Eklendi (mevcut bölümlere yeni kurallar)

| Bölüm | v1.1 ile eklenen |
|---|---|
| §1 Erişim kontrolü | **Parameter tampering** maddesi (rol/tenant/fiyat/indirim/sahiplik/durum istemciden alınamaz) |
| §2 Kimlik doğrulama | **SAML XSW** koruması; OAuth **RFC 9207 `iss` doğrulaması** (mix-up); genişletilmiş **JWT sözleşmesi** (`kid`/`jku`/`x5u` güvensiz, alg confusion, `jti` iptal, clock skew, refresh reuse detection, payload minimizasyonu); cookie flag'lerinin `Set-Cookie` üzerinden test edilmesi zorunluluğu |
| §3 Kriptografi | **CWE-208 timing/padding-oracle** maddesi; TLS doğrulama yasağının **test ve script kodunu da kapsadığının** açıkça yazılması |
| §4 Secrets | Secret taramanın pre-commit + full history + build artifact + container layer katmanlarında zorunlu olması |
| §5 Girdi doğrulama | **Unicode / Trojan Source (CWE-1007)** yasağı; prototype pollution'ın **merge/postMessage/webhook/LLM çıktısı** kaynaklarını kapsayacak şekilde sertleştirilmesi + ❌/✅ örnek |
| §6 Injection | **Expression/EL injection (CWE-917)**; güvenli dinamik `ORDER BY` referans örneği; `setTimeout(string)` yasağının açık yazılması |
| §7 Çıktı kodlama | Bölüm **"Response/Output güvenliği"** olarak yeniden çerçevelendi: **DOM clobbering**, **Trusted Types**, JSON content-type kuralı, **dosya indirme başlıkları**, iframe `sandbox`, `rel=noopener noreferrer`, `frame-ancestors` clickjacking kuralı, dinamik istemci kodu yürütme yasağının ayrıntılandırılması |
| §9 API | **Unsafe pass-through yasağı** (method/headers/authorization/body/query downstream'e ham yansıtılamaz) |
| §10 Hata yönetimi | **Observability ayrımı** (kullanıcı hatası ≠ iç tanı kaydı, ikisinde de redaction); retry üst sınırı ve "sonsuz dene" yasağı |
| §11 Dosya | SVG sanitizasyonu, polyglot reddi, quarantine → taşıma akışı, `Content-Type` başlığının güvenilmez sayılması |
| §12 SSRF | URL parse + credential bölümü reddi + port allowlist; **IMDSv2 benzeri tokenlı metadata**; "regex/hostname karşılaştırması SSRF koruması değildir" hükmü |
| §13 Kaynak tüketimi | **Bounded execution tablosu** (iterasyon, byte, decompressed byte, chunk, DB satırı, derinlik, retry, wall-clock, eşzamanlılık, agent step/token) + `MAX` clamp'in tek başına yetersiz olduğu, cancellation/timeout zorunluluğu |
| §15 Tedarik zinciri | **Slopsquatting / paket halüsinasyonu** kuralı; install script exfiltration; **lockfile poisoning**, protestware, yeni sürüm cooldown; SCA kararında EPSS/KEV/reachability/exposure; **VEX'in risk kabulü olmadığı**; imza doğrulamasının fail-closed olması |
| §16 Konfigürasyon | **HTTP request smuggling (CWE-444)**, **Host header (CWE-644)**, **cache poisoning/deception**; CSP'de `unsafe-inline`/`unsafe-eval` yasağı + **`require-trusted-types-for 'script'`**; **COOP/COEP/CORP** |
| §17 Frontend | `postMessage`'da origin **+ tip + şema + alan allowlist'i**; istemci tarafı auth cookie yazımı yasağı |
| §18 Mobil | MASVS gereksinimlerinin **MASTG testleriyle eşlenmesi** zorunluluğu |
| §19/§31 CI/CD | **GitHub Actions script injection** kuralı (untrusted context → `env:` → `"$VAR"`, ❌/✅ örnekli); **pwn request yasağı** (`pull_request_target` + untrusted checkout); `GITHUB_TOKEN` varsayılan `contents: read`; build job'ın kaynak koddan yüksek yetki alamaması |
| §20 Loglama | **Redaction matrisi tablosu** (kategori × alan × politika); "varsayılan loglama yok, istisna izinli alan" politikası; ❌/✅ log örnekleri; agent tool çağrılarının audit kapsamına alınması |
| §22 AI/LLM | Prompt'a kaynak kodun yalnız gerekli bölümünün gönderilmesi; RAG yetkisinin **filtre seviyesinde** uygulanması; agent step budget |
| §25 Multi-tenant | (v2.0 taslağından korundu) DB Row Level Security ikinci katmanı |
| §30 Kubernetes | PSA `restricted`; "base64 kodlama şifreleme değildir" hükmü; admission policy fail-closed |
| §33 MCP/Agent | **Tool poisoning**, **rug pull** (tool tanımı pinleme + diff), **tool shadowing**, **confused deputy / token passthrough yasağı**, audience-bound token, sandbox + default-deny egress |
| §35 Embedded | **Cross-language sınırların** (JS↔native, Java↔JNI, Go↔C) ayrıca test edilmesi |
| §36 Gate | Gate matrisine **"üretilen kanıt"** sütunu ve build/artifact/SBOM/signing/provenance/staging/agentic/deployment/production aşamaları |
| §37 Test | **Test metodolojisi matrisi** (seeded vulnerability, property-based, IAST, differential scanner, production validation…) |
| §38 Çoklu araç | Precision/seeded-recall/escape-rate ölçüm kuralı; scanner kıyaslama disiplini |
| Bölüm B | Öz-denetim listesi 20 → **40 madde**; B1 (kod) / B2 (süreç-agent) / B3 (teslim kanıtı) olarak ayrıldı; listenin **RCI biçiminde** uygulanması zorunlu kılındı |

### Değiştirildi

- **Metadata tablosu:** sürüm, sahip, statü alanları eklendi; taksonomi listesi ASVS 5.0.0, TCASVS, LLMSVS 2.0, AISVS 1.0, Agentic Top 10 2026, MCP Security, NIST SP 800-218A, NIST SP 800-63B-4, CISA Secure by Design, SLSA 1.2 ve CycloneDX ile genişletildi.
- **Gözden geçirme sıklığı:** 6 ay → **3 ay**; ayrıca scanner engine/query paketi, framework major sürümü ve ciddi olay sonrası tetikleyicileri eklendi.
- **Kapsam tanımı:** "uygulama kodu" → uygulama kodu **+ test, script, fixture, wireframe, IaC ve CI kodu**.
- **Altın kurallar:** 12 → 13 madde; **"Kanıt olmadan güvenli sayılmaz"** ilkesi eklendi; 1. madde tool çıktısını da kapsayacak şekilde genişletildi.
- **Bölüm F:** düz bağlantı listesi → **kaynak / kullanım amacı / bağlantı** tablosu + zorunlu sürüm doğrulama notu.
- **Bölüm E:** yalnız `SECURITY-ADDENDUM.md` şablonuydu → **repo dosya yapısı (E1) + addendum şablonu (E2)** olarak ikiye ayrıldı.
- Kural yazım biçimi: uzun anlatı yerine **kısa + ❌/✅ örnek çifti + CWE etiketi** biçimi normatif hâle getirildi.

### Düzeltildi

- **Çelişki giderildi:** v1.0/D bölümündeki *"`dist/ build/ node_modules/ vendor/ coverage/` tarama dışıdır"* hükmü, §0.4 artifact sınıflandırmasıyla çelişiyordu. Yeni metinde bu dizinler **yalnızca sınıflandırılmış, gerekçeli ve telafi kontrollü** biçimde source SAST dışında tutulabilir; final artifact taraması **zorunludur**.
- **Parola politikası:** genel 8 karakter minimumu, NIST SP 800-63B-4 ile hizalandı — **tek faktörlü parolada 15**, MFA'nın parçası olan parolada 8; composition rule ve zorunlu periyodik değişim kaldırıldı.
- **`Not Exploitable` kullanımı:** yalnızca "validation eklendi" gerekçesinin yeterli olmadığı; ortama bağlı gerekçelerin (`henüz prod değil`) severity düşürme + not ile yönetileceği açıkça yazıldı.
- **SSRF kategorisi:** OWASP 2025 eşlemesinde SSRF'in A10'dan **A01 Broken Access Control** içine taşındığı yansıtıldı (C2).
- **Test klasörü dışlaması:** Playwright `context.cookies()` gibi framework semantiği kaynaklı yanlış yorumların tüm `tests/` klasörünü dışlama gerekçesi olamayacağı; çözümün ayrı profil + query tuning + kayıtlı istisna olduğu netleştirildi.

### Kaldırılan / gevşetilen kural

- **Yoktur.** v1.1, v1.0'ın hiçbir zorunluluğunu kaldırmaz veya gevşetmez; yalnızca ekler ve sertleştirir.
  (Tek istisna: yukarıdaki *parola minimumu* değişikliği bir **sertleştirmedir**, gevşetme değildir.)

---

## Rapor bulgusu → yeni kural izlenebilirliği

| Rapor / bulgu | v1.0'daki durum | v1.1'de karşılığı |
|---|---|---|
| Privacy Violation in Logs (14 adet) | §20'de genel yasak vardı | §20 **redaction matrisi** + §0.5 çevre kod loglama hijyeni + Bölüm G kanıt zorunluluğu |
| HttpOnly Cookie Flag Not Set (6 adet) | §2'de kural vardı | §2 cookie matrisi + **`Set-Cookie` header testi** zorunluluğu + §0.6 test-kodu istisna kaydı |
| Client Potential Code Injection (4 adet) | §7'de kısmi | §7 **dinamik istemci kodu yürütme yasağı** (attribute clone, `script.src`, `fetch().text()`, dinamik `import()`) |
| Prototype Pollution (wireframe HTML, High) | §5'te vardı | §5 sertleştirildi (merge/postMessage/webhook/LLM kaynakları) + §0.4 **executable-nonprod** sınıfı |
| Unchecked Input for Loop Condition | §13'te kısmi | §13 **bounded execution tablosu** + cancellation/timeout zorunluluğu |
| SQL Injection (9 adet, mihenk-360) | §6'da vardı | §6 **dinamik identifier allowlist'i** + güvenli `ORDER BY` referans örneği |
| Reflected XSS (9 adet) | §7'de vardı | §7 response/output güvenliği bölümü + §9 unsafe pass-through yasağı |
| JWT No Signature Verification (2 adet) | §2'de vardı | §2 genişletilmiş JWT sözleşmesi + Bölüm G negatif test zorunluluğu |
| Secret Leak (6 adet) / Privacy Violation (4 adet) | §4/§20'de vardı | §20 matrisi + §0.8 "secret nesnesi loglanabilir metadata ile aynı object graph'ta olamaz" |
| Sensitive data in Web Storage | §17'de vardı | §17 + §2 (token yalnız HttpOnly cookie) + E2E storage assertion |
| Parameter Tampering | Dolaylı (§8) | §1'de **açık kural** |
| Iframe sandbox / Clickjacking | §16'da kısmi | §7 + §16 (CSP `frame-ancestors` + legacy XFO) |
| `backend/dist/**` çift bulgu | Politika yoktu | §0.4 `build-output` sınıfı + final artifact tarama zorunluluğu |
| Wireframe HTML bulguları | Politika yoktu | §0.4 wireframe kuralı + production artifact absence testi |
| Test kodu false positive'leri | Politika yoktu | §0.5 + §0.6 istisna şablonu (örnek kayıt `SEC-EX-2026-0042`) |
| Tüm bulguların `To Verify` kalması | Kısmen (Bölüm D) | §0.3 hedefi + §0.6 triage zorunluluğu + D3 `To-Verify age` metriği |

---

## v1.1'e geçiş adımları (repo başına)

1. `SECURE-CODING.md` v1.1 repo köküne konur; `AGENTS.md` / `CLAUDE.md` / `.cursor/rules/` bootstrap dosyaları **sürüm + hash** ile güncellenir (§0.9).
2. `SECURITY-SCOPE.yml` oluşturulur; her dizin §0.4 sınıflarından birine atanır (varsayılan: `production-source`).
3. Mevcut scanner exclusion'ları `SECURITY-EXCEPTIONS.yml`'ye taşınır; owner, gerekçe, kanıt ve expiry olmayanlar **kaldırılır**.
4. Mevcut `To Verify` bulguları triage edilir; her biri `Confirmed / Fixed / Not Exploitable / Accepted Risk` durumuna alınır (§0.6).
5. Logger redaction konfigürasyonu §20 matrisine göre güncellenir ve **log çıktısı üzerinde assertion testi** yazılır.
6. Cookie flag'leri, JWT doğrulaması, prototype pollution ve bounded execution için negatif testler eklenir (§37).
7. `security/policies/agent-tools.yml` oluşturulur; agent yetkileri prompt'tan **policy'ye** taşınır (§0.2).
8. CI'ya `validate_scope.py` ve `validate_exceptions.py` kontrolleri eklenir; süresi geçmiş istisna build'i kırar.
9. `security/fixtures/secure` ve `security/fixtures/vulnerable` altına ilk fixture seti konur; seeded detection rate ölçülmeye başlanır (D3).
10. Wireframe/prototip dizinleri için "production artifact içinde yok" testi eklenir (§0.4).

---

## [1.0] — İlk yayımlanan sürüm

### Eklendi

- Metadata tablosu, "bu dosya nedir" çerçevesi ve `// SECURITY-REVIEW:` işaretleme kuralı.
- **§0 Altın kurallar** (12 madde): tüm dış girdi güvensizdir, deny by default, least privilege, complete mediation, parametrize et, secrets, kanıtlanmış kripto, fail securely, defense in depth, secure defaults, her IO'ya sınır, emin değilsen güvenli olanı uygula.
- **Bölüm A — §1–§23:** erişim kontrolü, kimlik doğrulama/oturum, kriptografi, secrets, girdi doğrulama, injection ailesi, çıktı kodlama/XSS, güvenli tasarım, API güvenliği, hata yönetimi, dosya işleme, SSRF, kaynak tüketimi, serileştirme/bütünlük, tedarik zinciri, güvenli konfigürasyon/HTTP başlıkları, frontend, mobil, konteyner/IaC/CI-CD, loglama, eşzamanlılık/bellek, AI-LLM entegrasyonları, gizlilik/veri koruma.
- **Bölüm B:** 20 maddelik AI öz-denetim listesi.
- **Bölüm C:** OWASP Top 10 2021 & 2025, API Top 10 2023, LLM Top 10 2025, Mobile Top 10 2024 ve seçilmiş CWE eşleme tabloları.
- **Bölüm D:** SSDLC süreç kuralları (tehdit modelleme, DoD, otomasyon zinciri, SLA, insan incelemesi, sızıntı müdahalesi, sızma testi, eğitim).
- **Bölüm E:** proje eki (`SECURITY-ADDENDUM.md`) şablonu ve istisna yönetimi ilkesi.

---

## Planlanan

> Not: v1.5, bağımlılık-CVE sürekli izleme yeteneğiyle yayımlandı (yukarı bkz.). Aşağıdaki kalan hedefler [1.6]'ya taşındı.

### [1.6] — hedef: 2026 Q4

- Stack profillerinin ayrı dosyalara bölünmesi (`security/profiles/{js,python,java,go}.md`) ve ana dosyanın import mekanizmasıyla modülerleştirilmesi (agent bağlam maliyeti).
- Go ve C# için §40 örnek matrisinin tamamlanması.
- `security/semgrep/` altında İnfina kural setinin ilk sürümü ve fixture tabanlı rule unit testleri.
- Checkmarx custom query / model paketleriyle §0.8 wrapper'larının scanner'a tanıtılması.
- Seeded vulnerability pipeline'ının kurulması ve D3 metriklerinin ilk baseline'ı.

### [2.0] — hedef: standart sürümleri güncellendiğinde

- ASVS/LLMSVS/AISVS requirement ID'lerinin bölüm bazında **birebir** eşlenmesi (`SECURITY-REQUIREMENTS.yml` tam doldurulmuş hâli).
- SLSA Build L3 hedefine geçiş ve deployment'ta zorunlu attestation doğrulaması.
- Geriye dönük uyumsuz sertleştirmeler (ör. tüm yeni servislerde varsayılan ASVS L3) bu sürümde toplanacaktır.
