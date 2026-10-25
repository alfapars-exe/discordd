# Refactoring görevleri ve kabul ölçütleri

Tarih: 25 Ekim 2026. İlk inceleme revizyonu `313acf8e`; çalışma sırasında başka bir iş akışı HEAD'i `da506e3b` revizyonuna ilerletti. Buna ek olarak inceleme anındaki değiştirilmiş ve izlenmeyen çalışma ağacı dosyaları değerlendirilmiştir. Depo kökü: `C:\Users\PARS\Desktop\PROJELER\HiChat\discordd`. Kod referansları bu köke göredir; satırlar bu incelemenin anlık görüntüsüne aittir. Farklı revizyonların test sonuçları birbirine eklenerek global başarı çıkarılmaz.

Bu belge uygulama önerisidir. Görev kartının varlığı, kodun değiştirildiği veya kabul edildiği anlamına gelmez. İlk teslimat 25 Ekim’de plan belgeleriydi. 26 Ekim’de kullanıcı uygulamayı başlattı; güncel ilerleme aşağıdaki tabloda izlenir. Görev kartlarındaki Problem alanları ilk incelemenin tarihsel kanıtıdır. Mevcut değişiklikler korunur; uygulama aşamasında her PR yalnız seçilen görevin dosyalarını kapsar.

## Uygulama izleme — 26 Ekim 2026

İlk uygulama grubu, kapsamlı modül ayırmalarından önce test ve kaynak sahipliği sınırlarını kurar. **Planın 30 görevinin tamamı bitmedi.** Bu tablo yerel uygulamayı, CI yürütmesini ve gerçek cihaz kabulünü birbirine karıştırmaz. Aktif kaynak ağacında başka çalışmalar bulunduğundan bütün doğrulamalar kaynak manifestiyle kaydedilir.

| Görev | Uygulanan bölüm | Kalan kabul / iş |
|---|---|---|
| RF01 | Güncel kaynakta iki encoding düzeltmesi zaten vardı; strict UTF-8 taraması ve production build geçti. Genel source encoding kontrolü CI’a eklendi. | Tamamlandı; yeniden kozmetik kaynak dönüşümü yapılmadı. |
| RF02 | `npm run quality:baseline` komut, exit code, log, test özeti, HEAD ve kaynak SHA-256 manifestini JSON’a kaydediyor. Koşu sırasında kaynak değişirse global PASS üretmiyor. | Dondurulmuş kaynak kopyasında tam koşu başarılı ve source_stable=true; kaynak değişen önceki koşular baseline olarak reddedildi. |
| RF03 | Vitest V8 coverage, yeni output-routing çekirdeğinde %90/%85 hedefi; Go source-bound shard profilleri ve birleştirme; Python/Node yardımcı testleri; CI artifact/job kapıları. | Birleşik coverage’ın gerçek GitHub CI koşusu ve ölçülen genel baseline’dan ratchet belirleme bekliyor. |
| RF04 | İzole PostgreSQL 18.6 job’ı, required-skip reddi, gerçek PG fixture’ları ve ayrı mTLS reconnect lane. SQLite’a özgü tarih/FTS migration fixture’ları açıkça SQLite’ta çalışıyor; ortak CRUD/rollback/yarış testleri PG’de çalışıyor. | Tam yerel PG koşusu sıfır zorunlu atlamayla geçti; sertifikalı reconnect de gerçek PG’de geçti. Uzak CI yürütmesi bekliyor. |
| RF07 | Username/email recovery, eski e-postasız hesap, generic HTTP/cooldown matrisi; repository hatasını username fallback’iyle gizlememe düzeltmesi; nil token guard. | Daha geniş MFA/reset concurrency/OpenAPI/client matrix’i mevcut testlerle tek tek uzlaştırılacak. |
| RF08 | Auth constructor artık worker başlatmıyor; legacy sweep explicit, iptal edilebilir ve tekrar güvenli start/stop sahibi. Durable session yolu gereksiz worker çalıştırmıyor. Başarısız SQLite/libSQL initialization pool’u kapatıyor. | Hedefli testler ve tam Go koşusu geçti. Yerel CGO/gcc bulunmadığından race çalıştırılmadı; Linux CI race kapısı bekliyor. |
| RF12 | Mikrofon testi, LiveKit ve P2P ortak kayıp-output fallback politikasını kullanıyor; mic test output değişiklikleri sıralı/revision kontrollü. | Büyük screen-share hook’unun tüm platform characterization/controller ayrımı ve gerçek cihaz kabulü bekliyor. |
| RF18 | Tek picker isteği; main-frame/sender kontrolü; owner kapanması/çökmesi/navigation/120 saniye timeout’unda tek finish ve cleanup; kaynak query timer temizliği. | Son Electron koşusu: 256 başarılı, 1 symlink yetenek atlaması. Paketli Windows/gerçek capture kabulü RF21’de bekliyor. |
| RF19 | Preload update/maximize abonelikleri scoped disposer döndürüyor; güncellenen React consumer’ları kendi aboneliklerini ve snooze timer’ını temizliyor. Sandboxed preload’a yeni runtime require eklenmedi. | Updater’ın splash/runtime state machine ve indirme/kurulum kabulü bekliyor. Eski removeMaximizedListener API uyumluluk için duruyor; güncel consumer kullanmıyor. |
| RF23 | Review hash tam source file hash/size manifestini içeriyor; upload aynı immutable byte’ları taşıyor; aynı yol/içerik değişimi, mutation sonrası upload ve LFS/no-op regresyonları. | 12 yardımcı test geçti; gerçek yayın yapılmadı. Eski preview hash’leri yeni manifest v2 için yeniden üretilmeli. |
| RF25 | Bütün 21 namespace için otomatik key ve interpolation parity; mevcut recovery/music dynamic-key sözleşmeleri korunuyor. | 60 locale testi geçti; görsel/klavye/screen reader E2E kabulü bekliyor. |
| RF26 | `.editorconfig`, genel UTF-8 kaynak kapısı; coverage artifacts lint dışında; sadece hedef dosyalarda format. | Kullanılmayan bağımlılık envanteri ve kalan static/readability işleri bekliyor. |
| RF27 | Bot URL/config validation, bounded HTTP ve handshake, non-2xx hata, signal/context cleanup, capped reconnect; bağımsız modül testi/vet CI’a eklendi. | Yerel bot test/vet geçti; dış servise mesaj gönderilmedi. |
| Diğer RF görevleri | Henüz uygulanmadı. | RF05/06 veri dönüşümü/migration güvenliği; RF09–11 ve RF13–17 core ayrımları; RF20–22 platform; RF24 log uzlaştırma; RF28–30 kapsamlı E2E/performance/runtime kapanışı. |

Kanıt özeti: [uygulama raporu](../implementation/verification/refactoring-implementation-2026-10-26.json). Dondurulmuş [tam baseline](../implementation/verification/refactoring-frozen-baseline-2026-10-26.json) ve [PostgreSQL koşusu](../implementation/verification/refactoring-frozen-postgres-2026-10-26.json) aynı kaynak manifestinde başarılıdır. Son picker tanılama sözleşmesi ayrıca [Electron raporunda](../implementation/verification/refactoring-frozen-electron-2026-10-26.json) farklı manifestle doğrulandı; sonuçlar tek revizyonmuş gibi birleştirilmez.

Ölçüm: client 4.219 başarılı test; E2E 5 başarılı senaryo; Go 3.534 başarılı test olayı (üst test/alt test olayları dahil), 15 koşullu fixture atlaması. Gerçek PG ve mTLS ayrı koşularda doğrulandı. Client coverage: statements %62,60, branches %60,82, functions %56,53, lines %62,91; Go statements %58,3. Yeni output-routing çekirdeğinde dört metrik de %100. Uzak GitHub CI henüz yürütülmedi. Kaynak değişen ilk baseline/PG raporları tarihsel kayıt olarak korunur ve sabit baseline sayılmaz. Global ürün acceptance defterindeki 248 bekleyen madde otomatik kapatılmadı.

## Görev dizini

Efor birimi **mühendis-gün**dür; geliştirme, ilgili test ve inceleme düzeltmelerini kapsar. İnsan kabulü, cihaz temini ve CI bekleme süreleri takvim hesabına ayrıca eklenir. Aralıklar taahhüt değil, kaynak incelemesine dayalı ilk tahmindir. P0 için doğrulanmış kritik olay/açık bulunmadığından yapay P0 atanmadı; yeniden üretilebilir güvenlik veya veri kaybı bulgusu çıkarsa ilgili görev ayrı incident akışına alınır.

| ID | Öncelik | İş | Efor | Ön koşullar |
|---|---|---|---|---|
| RF01 | P1 | Geçersiz UTF-8 kaynakların build engelini kaldırma | 0,5–1 | Yok |
| RF02 | P1 | Sabit kalite baseline ve kabul envanteri | 1–2 | Yok |
| RF03 | P1 | Test profilleri, coverage ve CI görünürlüğü | 2–3 | RF02 |
| RF04 | P1 | Gerçek PostgreSQL test hattı | 2–3 | RF02 |
| RF05 | P1 | SQL dialect dönüşümünün davranış güvenliği | 3–5 | RF04 |
| RF06 | P1 | Eski veritabanı migration kabulünü doğrulama | 2–4 | RF04 |
| RF07 | P1 | Auth/recovery sözleşme regresyon matrisi | 2–3 | RF02 |
| RF08 | P1 | Backend kaynak yaşam döngüsü ve hata temizliği | 1–2 | RF07 |
| RF09 | P2 | Üye/grup verisi için sınırlı ve toplu sorgular | 2–3 | RF04 |
| RF10 | P1 | Music bot eşzamanlılık ve kaynak sahipliği | 3–5 | RF08, RF04 |
| RF11 | P2 | Zorunlu servis bağımlılıklarını görünür kılma | 2–3 | RF08 |
| RF12 | P1 | Ekran paylaşımı ve mikrofon testinin davranış güvenliği | 3–5 | RF01, RF03 |
| RF13 | P2 | Preferences/store bağımlılıkları ve alan eşlemesi | 2–4 | RF03, RF07 |
| RF14 | P2 | P2P/WebSocket transport yaşam döngüsü | 2–4 | RF12 |
| RF15 | P2 | Mesaj geçmişi için saf ortak işlemler | 2–3 | RF07, RF03 |
| RF16 | P2 | Crypto storage/backup sınırları ve tip güvenliği | 3–5 | RF07, RF03 |
| RF17 | P2 | Decrypted cache sorgularını ölçme ve sınırlama | 1–2 | RF16 |
| RF18 | P1 | Electron ekran seçicisinin istek sahipliği | 2–3 | RF03 |
| RF19 | P1 | Updater ve preload abonelik yaşam döngüsü | 2–4 | RF18 |
| RF20 | P2 | Electron IPC ve overlay sorumluluklarını ayırma | 3–5 | RF18, RF19 |
| RF21 | P1 kabul kapısı | Windows helper protokolü ve kaynak güvenliği | 3–5 | RF18, RF12 |
| RF22 | P1 kabul kapısı | Android/iOS native sınır testleri | 3–5 | RF12 |
| RF23 | P1 | HF yayın planını içerik hash'lerine bağlama | 1–2 | RF02 |
| RF24 | P2 | Mevcut log altyapısında hata standardı | 2–3 | RF02 |
| RF25 | P2 | Locale kapsamı ve erişilebilirlik regresyonları | 2–3 | RF03 |
| RF26 | P2 / P3 alt işler | UTF-8, format, statik analiz ve bağımlılık standardı | 2–3 | RF02 |
| RF27 | P2 | Welcome bot hata/timeout sınırları | 1–2 | RF02 |
| RF28 | P1 | Üretim bundle'ı ile çok kullanıcılı E2E matrisi | 3–5 | RF01, RF07, RF03 |
| RF29 | P2 | Tekrarlanabilir performans ve kaynak baseline'ı | 2–4 | RF09, RF17 |
| RF30 | P1 kabul kapısı | Platform/runtime doğrulaması ve belge kapanışı | 2–4 + cihaz beklemesi | Kapsama alınan RF01–RF29 işleri |

P1 kabul kapısı, doğrulanmış ürün hatası anlamına gelmez; cihaz/platform kanıtı olmadan tamamlandı denmesini önleyen zorunlu doğrulamadır. P2 işler, bağımlılıkları sağlandığında P1 işleri engellemeden ayrı PR'larda yürütülebilir.

## Fazlar ve çıkış koşulları

1. **Discovery & Baseline:** RF01 ve RF02 ile başlar. Çıkış: sabit kaynak revizyonu/dirty dosya özeti, UTF-8 engelinin ayrı küçük düzeltmesi, başka iş akışınca düzeltilen client mock sözleşmesinin baseline'a uzlaştırılması ve başarılı/başarısız/atlanan/çalıştırılmayan komutların kaydı. `implementation/coverage.json` gereksinim kabul defteridir; kod coverage yüzdesi değildir.
2. **Test Safety Net:** RF03, RF04, RF07 ve RF28. RF18/19 ile kritik native adapter karakterizasyonları bu fazda yazılabilir. Çıkış: refactor öncesi davranış testleri, gerçek DB testleri için çalışır ortam, kritik hata yolları ve kararlı CI çıktıları. Kırmızı baseline gizlenmez.
3. **Core Refactoring:** RF05–RF06, RF08–RF17 ve RF20; her kartın bağımlılığı geçerlidir. Çıkış: küçük PR'ların ayrı test kanıtı, API/WS/IPC/storage uyumu ve önce/sonra ölçülebilir kazanımı. Bütün 30 görevin tek PR'da tamamlanması gerekmez.
4. **Clean Code & Standardization:** RF24–RF27; RF26'nın biçimsel P3 alt işleri en sona alınabilir. Çıkış: dokunulan kodda format/tip/hata/locale kuralları, kaynak ve test okunabilirliği. Depo çapında biçimsel diff oluşturulmaz.
5. **Performance & Security:** RF09/RF17 ölçümleri üzerinden RF29; RF21–RF23 kabul ve yayın güvenliğinin son doğrulaması. RF23 gibi P1 düzeltmeler bağımlılıkları tamamlanınca erken yapılır, bu fazı beklemez. Çıkış: ölçülmüş sorgu/kaynak bütçeleri, içerik bağlı yayın doğrulaması, platform sınırlarının negatif testleri. Güvenlik şüphesi ile doğrulanmış açık ayrı tutulur.
6. **Verification & Documentation:** RF30. Çıkış: kapsamındaki tüm kartların test kanıtı, kalan blokajların açık listesi ve altı plan belgesinin tutarlılığı. Build, unit test veya HTTP 200 tek başına gerçek cihaz/canlı servis kabulü sayılmaz.

Paralel çalışma hatları: backend veri/lifecycle (RF04–RF11), client state/crypto (RF13–RF17), voice/native (RF12/RF18–RF22), kalite/yayın (RF03/RF23–RF29). Aynı dosyaya dokunan işler sıralanır; branch/PR sahipliği tek kişide olur. RF30 geri besleme için yeni doğrulama turu açabilir, önceki görevlerin anlamını veya kabul ölçütünü gevşetmez.

## RF01 — Geçersiz UTF-8 build engeli

| Alan | Tanım |
|---|---|
| Task ID | RF01 |
| Priority | P1 — geliştirme/yayın build engeli |
| Module | `client/src/components/voice/VoiceProvider.tsx`; `client/src/components/dm/GroupDMCall.tsx` |
| Problem | `VoiceProvider.tsx:262` ve `GroupDMCall.tsx:60` çevresindeki geçersiz UTF-8 byte'ları mevcut build'i bozuyor. İncelenen 2.653 metin kaynağında iki geçersiz dosya bulundu; sorun temel `313acf8e` revizyonunda da mevcut. Başarılı TypeScript veya ayrı unit testler bu bundle hatasını ortadan kaldırmıyor. |
| Solution | Etkilenen yorum/metin byte'larını doğru UTF-8'e sınırlı diff ile düzelt; tüm dosyayı başka encoding'e dönüştürme. Sonraki CI korumasını RF26'da yerleştir. |
| Risk | Düşük; toplu encoding/line-ending dönüşümü yanlış diff oluşturabilir. Davranış değişikliği bu karta dahil değildir. |
| Dependencies | Yok. RF02 kanıt kaydı paralel yapılabilir. |
| Tests | UTF-8 strict decode taraması; client typecheck ve production build. Düşük etkili metin düzeltmesi için implementation'ı tekrar eden unit test yazılmaz. |
| Acceptance Criteria | İki dosya geçerli UTF-8; taranan kaynak kümesinde geçersiz byte kalmıyor; build bir sonraki gerçek hataya kadar ilerlerse o hata ayrı kaydediliyor. Build ancak komut sıfır exit code ile biterse başarılı işaretlenir. |
| Effort | 0,5–1 mühendis-gün |

## RF02 — Sabit baseline ve kabul envanteri

| Alan | Tanım |
|---|---|
| Task ID | RF02 |
| Priority | P1 |
| Module | Depo genelinde test/build komutları; `implementation/coverage.json:11`; `scripts/check-implementation-coverage.mjs` |
| Problem | Kabul defteri mevcut kaynak temellerini tamamlanmış kabulden ayırıyor; strict kontrolde 248 kabul maddesi bekliyor. İlk tam client suite 423 dosyada 421 başarılı/2 başarısız; 4.114 testte 4.106 başarılı/8 başarısız, süre 310,77 saniye. `client/src/components/layout/UserBar.groupAudio.test.tsx` (5) ve `UserBar.p2pRinging.test.tsx` (3) mock'larında `@livekit/components-react` useTracks eksikti; hata `client/src/video/GroupRemoteVideos.tsx:4` kullanımına ulaştı. Başka iş akışının `da506e3b` düzeltmesinden sonra hedefli 2 dosya/9 test 12,71 saniyede geçti; bu revizyonda tam suite yeniden çalıştırılmadı. |
| Solution | Commit, dirty dosya listesi, platform/runtime sürümleri, komut, exit code, süre, test/skip sayısı ve artifact konumunu her doğrulama grubuyla kaydet. Mevcut `da506e3b` mock düzeltmesini yeniden yazmadan doğrula ve sabit kaynak anlık görüntüsünde tam baseline'ı yenile; gerçek sahiplik/cleanup assertion'larını koru. Ana komutları tek baseline tablosunda tut; kod coverage ile gereksinim kabulünü ayrı metrik olarak kullan. |
| Risk | Düşük; artifact içine token, gerçek kullanıcı içeriği veya yerel secret yolu eklenmemeli. Mevcut dirty işlerin sahipliği değişmez. |
| Dependencies | Yok. |
| Tests | Go, Electron, client, lint, typecheck, production build, E2E, acceptance checker; önce iki UserBar suite'i ve aynı mock'u paylaşan tüketiciler, ardından tam client suite. Ortam gerektiren PostgreSQL/native/live servis testleri ayrı profile ayrılır. |
| Acceptance Criteria | Her kontrol passed/failed/skipped/not-run/blocked durumlarından biriyle ve gerekçesiyle kayıtlı; ilk tam suite başarısızlığı ile yeni revizyonun hedefli başarısı ayrılmış; yeni tam suite sonucu olmadan global yeşil iddiası yok. Mevcut düzeltme tekrar uygulanmamış, suite skip veya assertion silerek hata gizlenmemiş. 248 bekleyen madde sırf kod/test bulunduğu için accepted yapılmamış; bu ilgisiz ürün maddelerini uygulamak seçili refactoring PR'larının ön koşulu değil. |
| Effort | 1–2 mühendis-gün |

## RF03 — Test profilleri, coverage ve CI görünürlüğü

| Alan | Tanım |
|---|---|
| Task ID | RF03 |
| Priority | P1 |
| Module | `client/vitest.config.ts`; `client/package.json`; `package.json`; `.github/workflows/server-ci.yml`; `.github/workflows/build-desktop.yml` |
| Problem | Test komutları frontend, Go, Electron, Python/Node scriptleri ve browser/audio kabul araçları arasında dağınık. `package.json:8–15` coverage adıyla acceptance ledger kontrollerini de barındırıyor; bu kod coverage raporu değildir. Baseline raporu ve hangi suite'in CI'da gerçekten çalıştığı ayrı görünür olmalı. |
| Solution | Mevcut araçlarla fast-unit, integration, production-E2E, desktop/native ve audio-device profilleri tanımla. Tek aggregate kontrol her alt sürecin exit code'unu korusun; coverage raporlarına kaynak include/exclude ve kritik modül hedefleri ekle. [TEST_STRATEGY.md](TEST_STRATEGY.md) yüzdesel tabanları yeni/refactor edilen kritik yollara uygula; mevcut global kapsamın düşmeme eşiğini yalnız RF02 sonrası gerçek ölçümden kur. |
| Risk | Orta; kapsam dışlama veya skip ile yapay yeşil sonuç üretilmemeli. İlk iş ölçüm, sonra kontrollü eşik; bütün depoya temelsiz yüzde dayatılmaz. |
| Dependencies | RF02 |
| Tests | Aggregate script için child failure/timeout/skip/boş rapor fixture'ları; tüm mevcut script testleri; audio entegrasyon profilinin gerekli artifact/süreç ön koşullarını doğrulama. |
| Acceptance Criteria | Kritik suite başarısızlığı aggregate sonucu başarısız yapıyor; raporda file/line/branch coverage ile acceptance ledger ayrı; exclude yalnız generated/vendor/platform tanımıyla gerekçeli; zorunlu test atlaması gerekli job'ı yeşile çevirmiyor. |
| Effort | 2–3 mühendis-gün |

## RF04 — Gerçek PostgreSQL test hattı

| Alan | Tanım |
|---|---|
| Task ID | RF04 |
| Priority | P1 |
| Module | `server/database/postgres_test.go`; `server/database/postgres_tls_integration_test.go`; `.github/workflows/server-ci.yml` |
| Problem | PostgreSQL entegrasyonları test DSN'i gerektiriyor; mevcut yerel Go başarısı gerçek PostgreSQL davranışını kanıtlamıyor. CI'ın PostgreSQL hizmeti/DSN sağlamayan yolu bu alanı atlayabiliyor. SQLite testlerinden dialect, PostgreSQL transaction ve TLS uyumu çıkarılamaz. |
| Solution | İzole geçici PostgreSQL hizmetli job ekle; repo testlerinin beklediği DSN'i yalnız bu job'da kur. Şema/migration ve repository ortak sözleşmelerini SQLite ve PostgreSQL üzerinde aynı fixture niyetiyle çalıştır; TLS testini ayrı açık profile bağla. |
| Risk | Orta; test bağlantısı gerçek üretim DB'sine yönelmemeli. Fixture verileri test başına namespace/DB ile izole edilir. |
| Dependencies | RF02 |
| Tests | Temiz DB migration, tekrar açma, repository CRUD/transaction rollback, bulk sorgu, timestamp/JSON/boolean davranışı; TLS positive/negative fixture'ları. |
| Acceptance Criteria | CI çıktısında PostgreSQL testleri gerçekten executed; DSN yokluğu zorunlu job'da fail; bağlantı/fixture cleanup kanıtlı; desteklenen DB yollarının biri diğerinin sonucu gibi raporlanmıyor. |
| Effort | 2–3 mühendis-gün |

## RF05 — SQL dialect dönüşüm güvenliği

| Alan | Tanım |
|---|---|
| Task ID | RF05 |
| Priority | P1 |
| Module | `server/database/postgres_dialect.go:230–298`; `server/database/postgres_dialect_test.go` |
| Problem | `postgres_dialect.go:264` ve devamı SQLite sözdizimini regex/string replacement ile PostgreSQL'e çeviriyor; tabloya özgü upsert kuralları aynı akışta. Mevcut iki üst seviye dialect testi, bütün kullanılan sorguların semantiği için yeterli kanıt değildir. |
| Solution | Üretimde kullanılan sorgu biçimlerini fixture corpus olarak envanterle. Placeholder/literal/comment ayrımını koruyan mevcut dönüşüm sınırını testlerle daralt; desteklenmeyen yeni SQL biçimlerini açık hata ile reddet. Karmaşık sorgular için repository sınırında açık dialect varyantı kullan; ORM veya genel SQL parser ekleme varsayılan değildir. |
| Risk | Yüksek; INSERT/upsert, tarih, JSON, NULL ve satır sırası farkları veri sonucunu değiştirebilir. Yeni SQL biçimi test olmadan ortak çeviriciye eklenmez. |
| Dependencies | RF04 |
| Tests | Gerçek SQLite/PostgreSQL sonuç eşdeğerliği; tırnaklı `?`, yorum/string içinde anahtar kelimeler, çok satırlı SQL, NULL, conflict target, parametre sayısı, timestamp sınırları ve rollback. |
| Acceptance Criteria | Kullanılan dönüşüm ailelerinin her biri pozitif/negatif fixture ile kapsanmış; aynı mantıksal veriyle sonuçlar eşdeğer; SQL injection açığı bulunduğu iddia edilmeden semantik risk açık belgelenmiş. |
| Effort | 3–5 mühendis-gün |

## RF06 — Eski şema migration kabulü

| Alan | Tanım |
|---|---|
| Task ID | RF06 |
| Priority | P1 |
| Module | `server/database/database.go:244–264`; SQLite/PostgreSQL migration dizinleri |
| Problem | Migration defteri boşken yalnız `users` tablosunun varlığı kontrol ediliyor; `:255–261` tüm migration dosyalarını uygulanmış işaretliyor. Kısmi/eski şemada gerçekte bulunmayan kolon veya indeksler böylece uygulanmış görünebilir. Mevcut production şemasının bozuk olduğu doğrulanmış değildir. |
| Solution | Bilinen legacy şema fingerprint'i doğrulanmadan toplu adoption yapma. Desteklenen snapshot'lara explicit baseline eşlemesi, bilinmeyen/kısmi şemaya anlaşılır hata ve operatör runbook'u ekle. Herhangi bir şema değişikliği için ileri migration, backup/restore ve geri dönüş planı ayrı hazırlanır. |
| Risk | Yüksek; veri kaybı ve upgrade kesintisi riski. Gerçek DB'ye otomatik onarım uygulanmaz; dry-run snapshot fixture'ları önce gelir. |
| Dependencies | RF04 |
| Tests | Boş DB; doğru legacy DB; yalnız users tablosu; eksik kolon/indeks; boş/yarım migration ledger; yarıda hata/transaction rollback; aynı upgrade'i ikinci kez çalıştırma; backup restore provası. |
| Acceptance Criteria | Doğrulanmamış şema bütün migration'ları applied yapamıyor; desteklenen legacy fixture kayıpsız açılıyor; bilinmeyen şema fail-closed; recovery adımları test artifact'iyle belgeli. |
| Effort | 2–4 mühendis-gün |

## RF07 — Auth ve recovery sözleşmeleri

| Alan | Tanım |
|---|---|
| Task ID | RF07 |
| Priority | P1 |
| Module | `server/services/auth_password.go`; `server/services/auth_service.go:297`; `server/models/password_reset.go`; auth handler/model testleri |
| Problem | Yeni kayıt e-postası, username/email recovery identifier, legacy e-postasız hesap ve e-posta kaldıramama davranışları katmanlar arası ortak sözleşme gerektiriyor. Mevcut test başarıları bütün kombinasyonların handler/API/frontend seviyesinde doğrulandığı anlamına gelmiyor. Legacy login'in bozuk olduğu varsayılmıyor. |
| Solution | Kaynakta mevcut davranışı açık contract matrisiyle sabitle: yalnız yeni kayıt için e-posta zorunlu, legacy hesabı koru, mevcut e-postayı silme; recovery yanıtı hesap varlığını ifşa etmesin. Model/service/handler/client/OpenAPI aynı kabul maddesine bağlansın. |
| Risk | Yüksek; hesap erişimi, enumeration, token tekrar kullanımı ve session revocation etkilenir. Public response/route değişikliği bu kartın varsayılanı değildir. |
| Dependencies | RF02 |
| Tests | Username/email identifier, trim/case sınırları, bilinmeyen kullanıcı, e-postasız legacy kullanıcı, tek kullanımlık/expired token, eşzamanlı reset, provider hata/timeout, session invalidation, e-posta removal reddi, yeni kayıt validasyonu. Mail sağlayıcısını fake et; gerçek gönderim ayrı kabul. |
| Acceptance Criteria | Matrisin her satırı ilgili katmanda test veya açık runtime kapısı taşır; mevcut HTTP/status/error sözleşmesi korunur; gizli token/şifre test loglarına çıkmaz; legacy erişim korunur. |
| Effort | 2–3 mühendis-gün |

## RF08 — Backend kaynak yaşam döngüsü

| Alan | Tanım |
|---|---|
| Task ID | RF08 |
| Priority | P1 |
| Module | `server/services/auth_service.go:326–335`; `server/database/database.go:183–190` |
| Problem | Auth constructor sweep goroutine başlatıyor; loop yalnız ticker kanalını okuyor ve dışarıdan stop yolu yok. DB constructor'ında Ping/migration hatasından sonra açılan connection kapanmadan hata dönüyor. Testlerin tekrar kurulumları ve startup failures kaynak sahipliğini belirsiz bırakıyor. |
| Solution | Auth sweep için context/stop ve idempotent close sahipliği ekle; zamanı fake edilebilir kıl. DB initialization tamamlanana kadar deferred cleanup kullan, başarıda sahipliği döndür. Shutdown orchestration bu kaynakları kapatsın. |
| Risk | Orta; refresh replay koruması ve shutdown sırası korunmalı; cleanup çağrıları çalışır servisi erken kapatmamalı. |
| Dependencies | RF07 |
| Tests | Tekrarlı create/close, çift close, iptal sırasında sweep, expired/live refresh kayıtları, Ping ve migration hata enjeksiyonu, constructor failure sonrası açık connection/goroutine bırakmama. |
| Acceptance Criteria | Her background worker'ın tek stop sahibi var; kapanış beklenebilir ve idempotent; startup hata dalları connection sızdırmıyor; refresh davranış testleri değişmeden geçiyor. |
| Effort | 1–2 mühendis-gün |

## RF09 — Üye/grup sorgularının veri kapsamı

| Alan | Tanım |
|---|---|
| Task ID | RF09 |
| Priority | P2 |
| Module | `server/services/member_service.go:135–188`; `server/services/group_dm_service.go:135`, `:222`, `:466` |
| Problem | Member GetAll önce bütün kullanıcıları yüklüyor (`:136`), sonra üyeliğe göre filtreliyor (`:182`). Grup member/mesaj projeksiyonlarında kişi başına lookup örüntüleri var. Üye rollerinde mevcut bulk iyileştirmesi korunmalı; bütün endpoint'in N+1 olduğu genellenmemeli. |
| Solution | Gerekli üye ID'lerine göre bounded bulk projection/repository okuması ekle; kullanıcı/rol/nickname/timeout verilerini toplu birleştir. Grup projeksiyonunda aynı request boyunca kullanıcıları ID setiyle çöz. API alanları ve sıralama aynı kalsın. |
| Risk | Orta; görünürlük, silinmiş kullanıcı, pagination/sıralama ve permission filtreleri korunmalı. |
| Dependencies | RF04 |
| Tests | 0/1/çok üye, başka sunucudaki çok kullanıcı, silinmiş kişi, rol/nickname/timeout, hata propagation; sorgu sayacı ile N büyürken sabit sayıda bulk query; gerçek iki DB. |
| Acceptance Criteria | İlgisiz bütün kullanıcılar yüklenmiyor; üye sayısına bağlı query fan-out kaldırılıyor; response contract eşdeğer; p95/DB wait etkisi RF29 ölçümüne ekleniyor. |
| Effort | 2–3 mühendis-gün |

## RF10 — Music bot concurrency ve cleanup

| Alan | Tanım |
|---|---|
| Task ID | RF10 |
| Priority | P1 |
| Module | `server/services/music_bot_service.go:103`, `:195`, `:267` ve ilişkili handler/provider yolları |
| Problem | Music service provider erişimi, oturum/oynatma durumu, background iş ve yayın yan etkilerini aynı yaşam döngüsünde yönetiyor. Yakın tarihli dirty logging değişiklikleri de bu dosyada; refactor onların davranışını yanlışlıkla değiştirebilir. Kaynak incelemesi concurrency riskini gösterir, doğrulanmış race/p95 sonucu değildir. |
| Solution | Önce oturum başlat/durdur/değiştir hata matrisi; ardından provider adapter, session owner ve state transition işlevlerini ayır. Bir session generation'ına ait geç sonuç yenisini etkileyemesin; context cancellation bütün provider/stream işlerine taşınsın. |
| Risk | Yüksek; kullanıcıya çalma durumunun yanlış yayınlanması, çift oturum ve kaynak bırakma riski. Aynı anda feature davranışı değiştirilmez. |
| Dependencies | RF08, RF04 |
| Tests | Eşzamanlı play/stop/skip, provider timeout/hata, stale completion, bağlantı kopması, shutdown, çift stop; deterministic fake provider/saat; Linux Go race job'ı ve gerçek provider ayrı smoke. |
| Acceptance Criteria | Her session kaynakları tek owner tarafından kapatılıyor; stale iş yeni session'a event yazmıyor; başarısız playback başarılı gösterilmiyor; race/cleanup testleri ve mevcut API regresyonları geçiyor. |
| Effort | 3–5 mühendis-gün |

## RF11 — Zorunlu servis wiring sözleşmeleri

| Alan | Tanım |
|---|---|
| Task ID | RF11 |
| Priority | P2 |
| Module | `server/init_services.go:179` ve `server/wiring_test.go` |
| Problem | initServices geniş constructor zinciri ve order-sensitive bağlama içeriyor. Bazı sorumluluklar setter/capability assertion ile daha sonra bağlanabiliyor; gerekli davranışın atlanması runtime'da ortaya çıkabilir. Mevcut audit constructor enjeksiyonu (`:185–192`) korunacak olumlu örnek. |
| Solution | Gerçek zorunlu bağımlılıkları constructor parametresi veya küçük dependency struct'ında açıklaştır. Opsiyonel integration'lara açık no-op/disabled state ver. Wiring'i domain gruplarına ayır; DI framework ekleme. |
| Risk | Orta; startup sırası, callback closure'ları ve test fixture'ları etkilenir. |
| Dependencies | RF08 |
| Tests | Missing-required-dependency, disabled optional provider, bütün callback wiring, startup/shutdown ve route manifest regresyonları; mevcut wiring testleri genişletilir. |
| Acceptance Criteria | Zorunlu bağlantı eksikliği constructor/build/başlangıç doğrulamasında bulunuyor; opsiyonel özelliğin kapalı olması deterministik; initServices iş mantığı içermiyor. |
| Effort | 2–3 mühendis-gün |

## RF12 — Ekran paylaşımı ve mikrofon testi

| Alan | Tanım |
|---|---|
| Task ID | RF12 |
| Priority | P1 |
| Module | `client/src/hooks/useScreenShareToggle.ts:286–736`; `client/src/hooks/useMicTest.ts:57–58`, `:84`; ses pipeline ve sink adapter'ları |
| Problem | Screen-share hook'u start/stop/restart, track publish, audio ve UI koşullarını uzun bir akışta taşıyor; hook için doğrudan davranış testi bulunmadı. Mic test sink seçimi kayıp cihaz hatasında varsayılan çıkışa retry sözleşmesi taşımıyor; gerçek çağrı yolu ile parite korunmalı. |
| Solution | Önce hook davranışını fake LiveKit/track/capture adapter'larıyla testle; sonra start/stop/restart controller ile UI state'i ayır. Var olan ortak mikrofon pipeline'ını kullan; mic test ve çağrıda aynı engine/gain/gate/capture settings uygulanmalı. Kayıp output device için bir kez default sink'e dön, ikinci hatayı gözlemlenebilir tut. |
| Risk | Yüksek; ekran/sistem sesi ve mikrofon sahipliği birbirini kesebilir. Native/WASM/AudioWorklet işleme tercihi değişmez. |
| Dependencies | RF01, RF03 |
| Tests | İzin reddi, kullanıcının picker cancel'i, publish failure, track ended, hızlı toggle/restart, route değişimi, missing sink/default fallback, engine fallback, unmount ve kaynak cleanup. Unit ve gerçek iki cihaz ses kabulü ayrı. |
| Acceptance Criteria | Doğrudan hook/controller testleri deterministik; stale start publish yapamıyor; track/context/worker/IPC lease sahipliği ve cleanup assertion'ları korunmuş; mic test ile gerçek çağrı ayar matrisi aynı; gerçek ses duyulurluğu ayrıca kaydediliyor. RF02'de izlenen suite'ler bu işi yeşil göstermek için atlanmıyor. |
| Effort | 3–5 mühendis-gün |

## RF13 — Preferences bağımlılıkları ve ortak alan eşlemesi

| Alan | Tanım |
|---|---|
| Task ID | RF13 |
| Priority | P2 |
| Module | `client/src/stores/preferencesStore.ts:294–310`; settings/sidebar/voice/accessibility/timeFormat store'ları; `client/vite.config.ts:148–150` |
| Problem | Preferences store diğer store'ları dynamic import ile topluyor; store'ların preferences erişimi iki yönlü bağımlılık oluşturuyor. Vite uyarı filtresi de bu import örüntüsünü özel olarak ele alıyor. Çok sayıda ayarın type/default/projection/apply eşlemesi ayrı yerlerde tutuluyor. |
| Solution | Hesap kapsamlı sync owner'ını koru; saf preferences codec/default/type tanımlarını store dışına çıkar. Uygulama bootstrap'ında açık adapter bağlama ile döngüyü kır; taşınan alanlara persistence round-trip testi ekle. |
| Risk | Yüksek; A hesabının tercihlerinin B'ye taşınması, pending değişiklik kaybı veya aktif ses oturumunun reset'i. |
| Dependencies | RF03, RF07 |
| Tests | A→B geçişi, stale response, offline merge/retry, expected_user_id mismatch, bozuk/eksik/eski değerler, yeni alan default'u, reload ve voice-session preservation. |
| Acceptance Criteria | Hesap izolasyonu/pending state korunuyor; yeni alan tek sözleşmeden türetiliyor; döngü kaldırılan yol için özel bundle warning suppression gerekmiyor; wire/storage alan adları değişmiyor. |
| Effort | 2–4 mühendis-gün |

## RF14 — P2P ve WebSocket transport lifecycle

| Alan | Tanım |
|---|---|
| Task ID | RF14 |
| Priority | P2 |
| Module | `client/src/stores/p2pCallStore.ts:136–209`; `client/src/hooks/useWebSocket.ts`; `client/src/webrtc/` |
| Problem | Call/transport side effect'leri store, module state ve hook'lar arasında paylaşılıyor. Peer connection, listener, timer ve capture sahipliğinin hesap/oturum değişimiyle beraber kapanması açık contract gerektiriyor; mevcut testler varken tüm transport katmanını yeniden yazmak gereksiz. |
| Solution | Mevcut p2pPeerConnection/media controller ayrımlarını kullanarak oturum owner'ına start/dispose sınırı koy; store UI durumunu taşısın. Reconnect/signal handler geç olayları generation/account kontrolünden geçsin. |
| Risk | Yüksek; signaling sırası ve WebRTC negotiation uyumluluğu. WS event/payload sözleşmesi korunur. |
| Dependencies | RF12 |
| Tests | Reconnect backoff, offline/online, logout/relogin, stale signal, negotiation çakışması, ended track, hangup sırasında pending start, tekrarlı dispose; mevcut P2P ses/camera/screen regresyonları. |
| Acceptance Criteria | Hesap/çağrı değişince eski listener/peer/timer kalmıyor; sonraki oturum öncekinin event'ini uygulamıyor; mevcut signaling ve medya davranışı aynı. |
| Effort | 2–4 mühendis-gün |

## RF15 — Mesaj geçmişinde saf ortak işlemler

| Alan | Tanım |
|---|---|
| Task ID | RF15 |
| Priority | P2 |
| Module | `client/src/stores/messageStore.ts:285`; `client/src/stores/dmStore.ts:296` ve history/update yolları |
| Problem | Channel ve DM store'larında history merge, duplicate engelleme, sıralama, optimistic update ve pagination benzeri işlemler tekrar ediyor. Yetki/E2EE bağlamları farklı olduğu için iki store'u tek genel store'a birleştirmek yüksek coupling yaratır. |
| Solution | Yalnız saf collection dönüşümlerini isimli yardımcı işlevlere ayır; transport/auth/crypto seçimleri domain store'larında kalsın. Hangi davranışın gerçekten ortak olduğunu karakterizasyon fixture'larıyla sabitle. |
| Risk | Orta; cursor, read/unread anchor, edit/delete ve encrypted içerik sırası etkilenebilir. |
| Dependencies | RF07, RF03 |
| Tests | Duplicate/out-of-order event, pagination overlap, edit/delete sırasında history fetch, aynı timestamp, optimistic failure/retry, account/channel değişiminde stale response. |
| Acceptance Criteria | İki store aynı ortak fixture'ları kullanıyor; domain özel yetki/şifreleme branch'leri birleştirilmiyor; kullanıcı mesaj kaybı/çift render görmüyor; API formatları değişmiyor. |
| Effort | 2–3 mühendis-gün |

## RF16 — Crypto storage/backup sınırları

| Alan | Tanım |
|---|---|
| Task ID | RF16 |
| Priority | P2 — güvenlik açısından yüksek değişiklik riski |
| Module | `client/src/crypto/keyStorage.ts` (1.125 satır); `client/src/crypto/keyBackup.ts:325`, `:754` |
| Problem | keyStorage persistence, account scope, key/session erişimi ve cache sorumluluklarını birleştiriyor. keyBackup parse edilmiş veriyi cast/any ile işliyor; bozuk veya eski backup biçiminde alan doğrulaması ayrı contract olmalı. Bu, kanıtlanmış şifreleme açığı iddiası değildir. |
| Solution | Önce mevcut backup/key/session fixture'larını sabitle; account-bound IndexedDB adapter, saf codec/validator ve backup orchestration sınırları çıkar. `unknown` girdiyi doğrulayarak domain type'a dönüştür. Algoritma, key derivation, blob formatı veya sürüm değiştirme. |
| Risk | Yüksek; geçmiş mesajların çözülememesi, hesabın anahtarına yanlış erişim veya recovery kaybı. Önce round-trip/golden fixture'lar gerekir. |
| Dependencies | RF07, RF03 |
| Tests | Legacy/current backup round-trip, yanlış passphrase, bozuk/truncated/veri tipi yanlış payload, unknown version, account mismatch, storage hata/transaction rollback, import sırasında cancel ve yeniden deneme. |
| Acceptance Criteria | Mevcut saklanmış örnekler byte/semantik uyumlu okunuyor; bozuk veri anlaşılır typed error ile reddediliyor; anahtarlar loglanmıyor; hesap sınırı testleri geçiyor; herhangi bir format migration'ı ayrı plana bırakılmış. |
| Effort | 3–5 mühendis-gün |

## RF17 — Decrypted cache arama maliyeti

| Alan | Tanım |
|---|---|
| Task ID | RF17 |
| Priority | P2 |
| Module | `client/src/crypto/keyStorage.ts:878`, `:913` |
| Problem | Arama/cache yollarında bütün kayıtları çekip filtreleme örüntüsü veri büyüdükçe CPU/heap/I/O maliyeti doğurabilir. Bu incelemede büyük veri gecikmesi ölçülmedi; yavaşlık kesinleşmiş gibi raporlanmaz. |
| Solution | 1k/10k/50k yerel fixture ile süre, okunan kayıt ve heap baseline al. Önce mevcut indeks/cursor ve bounded batch kullanımıyla iyileştir; yeni IndexedDB indeks/schema sürümü gerekiyorsa ayrı migration/geri dönüş uyumluluğu planla. |
| Risk | Orta-yüksek; account filter, arama sonucu doğruluğu ve browser storage upgrade etkilenir. |
| Dependencies | RF16 |
| Tests | Hesap izolasyonu, empty/çok sonuç, unicode arama, cancellation, pagination ve aynı sonuç sırası; ölçüm koşulları sabit performans fixture'ı. |
| Acceptance Criteria | Önce/sonra veri kümesi ve ölçüm aynı; sonuç eşdeğer; büyük cache işlemi bounded ve iptal edilebilir; ölçüm kazancı yoksa gereksiz indeks/abstraction eklenmiyor. |
| Effort | 1–2 mühendis-gün; schema migration gerekirse ayrı tahmin |

## RF18 — Electron ekran seçicisi sahipliği

| Alan | Tanım |
|---|---|
| Task ID | RF18 |
| Priority | P1 |
| Module | `electron/screen-picker.ts:180–202` |
| Problem | Global `screen-picker-result` için `once` bekleniyor; request/sender eşlemesi veya renderer kapanması iptali yok. Sonuç gelmeyince refresh cleanup `finally` bloğuna ulaşılamıyor. Eşzamanlı isteklerin aynı sonucu tüketmesi statik akış riskidir; gerçek cihazda reproducer çalıştırılmadı. |
| Solution | Tek aktif owner'lı picker controller; ikinci eşzamanlı isteği `{}` ile tamamla. Mevcut string sonuç sözleşmesini koru, sender/main-frame doğrula; owner destroy/navigation/crash olayında tam bir kez cancel ve listener cleanup yap. |
| Risk | Orta; picker kaynak yenileme ve callback sırası bozulabilir. |
| Dependencies | RF03 |
| Tests | İki paralel istek, cancel, destroy, navigation, stale result, geç refresh, kaynak kalmaması, query failure; fake Electron event emitter. |
| Acceptance Criteria | Bir sonuç iki isteği tamamlamıyor; her istek bir callback ile sonlanıyor; owner kaybında listener'lar temiz; güvenilmeyen sender seçimi tamamlayamıyor; mevcut UI payload'ı aynı. |
| Effort | 2–3 mühendis-gün |

## RF19 — Updater ve preload abonelik lifecycle

| Alan | Tanım |
|---|---|
| Task ID | RF19 |
| Priority | P1 |
| Module | `electron/preload.ts:431–474`; `electron/auto-updater.ts:65–119`, `:223–266`; `client/src/hooks/useUpdateChecker.ts:47–88` |
| Problem | Update abonelikleri disposer döndürmüyor; maximize cleanup tüm listener'ları kaldırıyor. Hook cleanup yapmıyor; titlebar kendi update listener'ını bırakıyor. Prelaunch hata sonrası updater event'leri runtime setup'a taşınabiliyor; ayrı updater state-machine testi bulunmadı. |
| Solution | Abonelikler kendi listener'ını kaldıran idempotent disposer döndürsün; preload type'ları ve tüketiciler birlikte güncellensin. Updater için tek subscription/timer owner ve fake edilebilir adapter çıkar; splash/runtime geçişini karakterizasyonla koru. Eski public IPC kanal/payload adları korunur. |
| Risk | Orta-yüksek; otomatik kurulum/restart ve tray davranışı. Disposer dönüşü eklemek uyumlu internal interface genişlemesidir; eski cleanup geçiş sırasında korunur. |
| Dependencies | RF18 |
| Tests | Çok abone/bir unmount, StrictMode remount, çift dispose, offline/no-update/download failure/retry, downloaded sonrası tekrar hata, tray/kapalı pencere, tekrar setup ve tek install çağrısı. |
| Acceptance Criteria | Remount listener sayısını büyütmüyor; kardeş abone kaldırılmıyor; prelaunch→runtime geçişinde eski handler kalmıyor; aynı indirme yalnız bir install başlatıyor; cihaz upgrade smoke ayrı RF30 kanıtı. |
| Effort | 2–4 mühendis-gün |

## RF20 — IPC ve overlay sorumlulukları

| Alan | Tanım |
|---|---|
| Task ID | RF20 |
| Priority | P2 |
| Module | `electron/ipc-handlers.ts:107–543`; `electron/voice-overlay.ts:16–87`, `:188`, `:248`, `:308`, `:364` |
| Problem | 552 satırlık IPC registrar overlay, game, diagnostic, update, audio, settings ve credentials sorumluluklarını birleştiriyor. Overlay 842 satır; birden fazla window/session/timer ortak module state'i ve tekrarlı child-window kurulumu taşıyor. |
| Solution | Mevcut PTT/system-audio registrar örneğiyle domain registrar'ları çıkar. Overlay'de composer/action windows, snapshot ve lifecycle sahipliğini küçük factory'lere ayır. Genel window framework'ü ekleme; security predicate'leri açık isimli tut. |
| Risk | Yüksek; plaintext overlay içeriği, child-window teardown ve session authorization korunmalı. |
| Dependencies | RF18, RF19 |
| Tests | IPC kanal/tip/payload/allowed sender envanteri; reload/crash, stale load, pending chat timeout, account switch, multiple displays/geometry; mevcut overlay-window/contract testleri. |
| Acceptance Criteria | Registrar wiring yapıyor, domain logic kendi modülünde; her kaynak tek cleanup sahibi; IPC sözleşmesi aynı; kapanan overlay'de önceki oturum verisi yeniden gösterilemiyor. |
| Effort | 3–5 mühendis-gün |

## RF21 — Windows helper protokolü ve kaynak sahipliği

| Alan | Tanım |
|---|---|
| Task ID | RF21 |
| Priority | P1 gerçek cihaz kabul kapısı; iç RAII refactor P2 |
| Module | `native/audio-capture.cpp:208–459`, `:345–399`; `native/game-window.cpp:148–181`; `electron/audio-capture.test.ts:39–213` |
| Problem | C++ capture wmain aktivasyon/format/protokol/loop/cleanup'ı birlikte taşıyor; hata dallarında manuel Release/CloseHandle tekrarları var. TS wrapper için güçlü fake-process testleri mevcut, fakat gerçek C++ helper test hedefi bulunmadı. `:165` sınırsız COM bekleyişi parent startup timeout'uyla dışarıdan sınırlanıyor. |
| Solution | Önce gerçek Windows helper stdout/stderr protokol smoke'u ve parent-exit testleri; sonra RAII ownership ve küçük format/protocol/capture işlevleri. Mevcut binary header/PCM biçimi ve MSVC hardening flag doğrulaması korunur. |
| Risk | Yüksek; PCM bozulması, self-audio exclusion, COM threading ve handle ömrü. |
| Dependencies | RF18, RF12 |
| Tests | Header/PCM split, stdout pipe closure, stdin EOF, parent exit, startup timeout, format fallback, tekrarlı start/stop, missing helper, device hotplug; gerçek loopback ile mikrofon/sistem sesi ayrımı. |
| Acceptance Criteria | Orphan helper yok; test döngülerinde handle/child sayısı kalıcı artmıyor; protokol byte uyumu geçiyor; fiziksel duyulurluk ve kendi uygulama sesinin dışlanması artifact'li cihaz testinde doğrulanıyor. |
| Effort | 3–5 mühendis-gün + Windows cihaz erişimi |

## RF22 — Android/iOS native kabul sınırları

| Alan | Tanım |
|---|---|
| Task ID | RF22 |
| Priority | P1 platform kabul kapısı |
| Module | `client/android/app/src/androidTest/java/com/getcapacitor/myapp/ExampleInstrumentedTest.java:24`; `client/android/app/build.gradle:5–8`; `client/ios/App/App/` native voice/screenshare plugin'leri |
| Problem | Android starter test `com.getcapacitor.app` bekliyor, gerçek applicationId `net.mqvi.app`. Bu test ürün davranışını doğrulamıyor; iOS için otomatik test hedefi bulunmadı. Web unit testleri native permission/background/audio routing kabulünü karşılamıyor. |
| Solution | Android starter assert'i gerçek paket sözleşmesiyle değiştir ve plugin lifecycle instrumented testleri ekle. iOS XCTest/native adapter test hedefini kur; simulator ile cihaz testlerini ayrı etiketle. Mevcut Capacitor/native plugin API'leri korunur. |
| Risk | Yüksek; işletim sistemi izinleri ve background/audio session davranışı platforma bağlı. |
| Dependencies | RF12 |
| Tests | Permission allow/deny/revoke, background/foreground, interruption, Bluetooth/wired route, ekran paylaşımı başlat/durdur, process restart, native callback sırası; iOS broadcast extension lifecycle. |
| Acceptance Criteria | Paket kimliği testi gerçek app ile uyumlu; Android/iOS test hedefleri çalışıyor veya açık ortam blokajı kayıtlı; fiziksel cihaz gerektiren kabul simulator başarısıyla kapatılmıyor. |
| Effort | 3–5 mühendis-gün + macOS/Android/iOS ortamı ve cihaz beklemesi |

## RF23 — İçeriğe bağlı yayın manifesti

| Alan | Tanım |
|---|---|
| Task ID | RF23 |
| Priority | P1 |
| Module | `scripts/publish-hf-space.py:40–58`, `:63–70`; `scripts/test_publish_hf_space.py` |
| Problem | Script HEAD'i kaydediyor fakat çalışma ağacındaki byte'ları okuyor. Review hash source commit/yol/deletion listesini kapsıyor, içerik hash'ini kapsamıyor. Aynı yol farklı byte içerse onay hash'i değişmeyebilir; upload operation path sakladığından sonraki dosya değişimi de bağlanmamış. Temiz CI checkout riski azaltır, içerik bağını sağlamaz. |
| Solution | Manifestte her dosyanın SHA-256/size ve kaynak provenance bilgisi olsun. Publish doğrulanmış immutable byte snapshot'ını kullansın; temiz committed source varsayılanı ve dirty source reddi açık olsun. Mevcut remote parent kontrolünü/managed deletion sınırını koru. |
| Risk | Orta; LFS materialization ve büyük dosyalarda bellek/disk tüketimi. Gerçek publish bu plan aşamasının dışındadır. |
| Dependencies | RF02 |
| Tests | Aynı yol farklı içerik, preview sonrası değişiklik, hash sonrası değişiklik, dirty source, eksik LFS, değişmiş remote HEAD, unmanaged user data ve idempotent no-op. Tamamen fake API ile. |
| Acceptance Criteria | İçerik değişirse reviewed digest geçersiz; uyuşmazlıkta create_commit hiç çağrılmıyor; yayınlanan byte'lar manifest hash'iyle aynı; exact deployed commit sonraki readiness doğrulamasına aktarılıyor. |
| Effort | 1–2 mühendis-gün |

## RF24 — Mevcut log altyapısında standart hata akışı

| Alan | Tanım |
|---|---|
| Task ID | RF24 |
| Priority | P2 |
| Module | `server/pkg/logx/`; `server/middleware/request_logger.go`; `server/pkg/response.go`; `server/services/app_log_service.go`; `ERROR_MANAGEMENT.md` |
| Problem | İnceleme sırasında bu alanlarda kapsamlı dirty logging çalışması ve yeni pipeline testleri bulunuyor. Handler/service/request log/Sentry/DB akışının ikinci bir logger ile tekrar kurulması duplicate event, sensitive context ve yüksek I/O riski yaratır. |
| Solution | Mevcut `pkg/logx` çalışmasını kaynak kabul et; error ownership, stable code, severity, request correlation, redaction ve sample/drop politikalarını ortak kurala bağla. Handler HTTP cevabını, service domain hatasını, worker operational failure'ı açıkça ayırsın. |
| Risk | Orta-yüksek; mevcut eşzamanlı çalışmanın üstüne yazma, log tekrarları veya gözlem kaybı. Önce ilgili dirty iş stabilize edilir. |
| Dependencies | RF02; mevcut logging değişikliğinin sahibiyle dosya kapsamı eşlemesi |
| Tests | Aynı olayın tek emit'i, wrapped error/status mapping, panic redaction, client log input limits, queue saturation/drop, provider failure, log sink yavaşlığı; mevcut pipeline regresyonları. |
| Acceptance Criteria | Yeni rakip logger yok; loglar secret/PCM/mesaj içeriği taşımıyor; hata kimliği response/log boyunca korele; backpressure request'i sınırsız bekletmiyor; mevcut dirty testler kaybolmuyor. |
| Effort | 2–3 mühendis-gün |

## RF25 — Locale ve erişilebilirlik kapsamı

| Alan | Tanım |
|---|---|
| Task ID | RF25 |
| Priority | P2 |
| Module | `client/src/i18n/localeParity.test.ts:14–37`, `:73–86`; `client/src/i18n/locales/`; kritik dialog/settings/voice UI'ları |
| Problem | Locale parity testi 12 namespace'i elle import ediyor; mevcut 21 namespace'in tamamı otomatik kapsanmıyor. Key parity, missing dynamic key veya klavye/focus/screen-reader davranışını tek başına doğrulamaz. |
| Solution | Mevcut namespace envanterinden locale fixture'larını keşfet; dilin plural farklarına açık allowlist uygula. Auth/recovery, ayarlar, picker ve voice controls için davranışsal erişilebilirlik acceptance matrisi ekle. |
| Risk | Düşük-orta; Türkçe/İngilizce plural istisnaları ve bilinçli eksikler yanlış pozitif üretebilir. |
| Dependencies | RF03 |
| Tests | Tüm namespace key parity, dinamik hata kodu karşılıkları, missing key render, keyboard-only dialog aç/kapat, focus restore/trap, accessible name, zoom/reduced-motion; gerçek ekran okuyucu smoke ayrı. |
| Acceptance Criteria | Yeni namespace otomatik teste giriyor; gerekçesiz locale allowlist yok; kritik eylemler klavye ile çalışıyor ve adı okunuyor; otomatik kontrol gerçek ekran okuyucu kabulü diye sunulmuyor. |
| Effort | 2–3 mühendis-gün |

## RF26 — Kod kalite standardını kontrollü uygulama

| Alan | Tanım |
|---|---|
| Task ID | RF26 |
| Priority | P2; ölü/tarihsel yorum temizliği ve kozmetik işler P3 |
| Module | `client/eslint.config.js`; TS config'leri; `.golangci.yml`; `electron/system-audio-ipc.ts:3`; `electron/auto-updater.ts:8–12`, `:26–42`; kaynak encoding ve lockfile'lar |
| Problem | Uzun tek satırlı IPC/test kodu okunabilirliği azaltıyor; Electron'a client lint kapsamı otomatik uygulanmıyor. Updater yorumu no-op/GitHub feed anlatırken gerçek kod aktif HF feed kullanıyor. RF01 encoding hatası source hygiene boşluğunu gösteriyor. Kullanılmayan dependency varsayımla silinemez. |
| Solution | [CODE_QUALITY_STANDARDS.md](CODE_QUALITY_STANDARDS.md) kurallarını dokunulan dosyalara uygula: strict UTF-8, formatter/lint/typecheck, adlandırılmış koşullar, `unknown` input validation, anlamlı hata bağlamı. Dependency kullanımını import/build/native/runtime manifestleriyle doğrula; gerekçesiz yükseltme/framework ekleme. |
| Risk | Düşük-orta; toplu format diff'i veya false-positive dead code silimi gerçek davranışı saklayabilir. |
| Dependencies | RF02 |
| Tests | UTF-8 checker fixture'ları; lint/typecheck/Go static checks; dokunulan domain testleri; dependency silinirse package/install/build ve platform smoke. |
| Acceptance Criteria | Yalnız ilgili PR dosyaları formatlanmış; magic value yalnız anlamlı domain kuralıysa isimli sabit; yanıltıcı yorumlar kaldırılmış/güncellenmiş; kullanılmayan kod iddiasının import/runtime kanıtı var; lockfile değişikliği ayrı gerekçeli. |
| Effort | 2–3 mühendis-gün; isteğe bağlı P3 temizliği ayrı küçük PR'lar |

## RF27 — Welcome bot hata sınırları

| Alan | Tanım |
|---|---|
| Task ID | RF27 |
| Priority | P2 |
| Module | `bots/welcome-bot/main.go:58`, `:101–111`; bağımsız `bots/welcome-bot/go.mod` |
| Problem | URL slice ile üretiliyor, kısa/geçersiz base panic oluşturabilir. NewRequest hatası yok sayılıyor; DefaultClient timeout'suz. Non-2xx yanıt da posted diye loglanıyor. Bot örnek programı için test dosyası bulunmadı. |
| Solution | Config parser/url.Parse, timeout/context içeren HTTP adapter ve saf event handler ayır; non-2xx'i hata olarak döndür. Başarısız POST'u otomatik sınırsız tekrar etme; duplicate welcome riski nedeniyle retry politikası açık/bounded olsun. |
| Risk | Düşük-orta; bot gateway ve message API sözleşmesi korunmalı. Kalıcı queue/framework bu örnek uygulamanın kapsamına eklenmez. |
| Dependencies | RF02 |
| Tests | Kısa/geçersiz URL, malformed payload, başka server, 401/403/429/500, HTTP timeout, gateway disconnect, display-name fallback; httptest ve fake gateway. |
| Acceptance Criteria | Config hatası panic yerine anlaşılır hata; ağ işlemleri bounded; başarısız status başarı logu üretmiyor; bağımsız Go modülü test profiline dahil. |
| Effort | 1–2 mühendis-gün |

## RF28 — Çok kullanıcılı üretim E2E matrisi

| Alan | Tanım |
|---|---|
| Task ID | RF28 |
| Priority | P1 |
| Module | `e2e/playwright.config.ts:49–86`; `e2e/tests/golden-path.spec.ts:27`; `e2e/tests/regressions.spec.ts:33`, `:74`, `:120` |
| Problem | Mevcut küçük E2E seti golden message/upload ve birkaç hata akışını kapsıyor; 5 başarılı test bütün hesap, permission, E2EE, reconnect veya gerçek native davranışın kanıtı değildir. Dev-server başarısı production bundle encoding/asset sorunlarını da gizleyebilir. |
| Solution | Production build servis eden ayrı E2E profile ekle; iki bağımsız browser context ve benzersiz fixture hesaplarıyla auth/session, permission değişimi, messaging/history, preferences izolasyonu ve crypto recovery akışlarını kur. API ile hazırlık yap, test edilen davranışı UI üzerinden doğrula. |
| Risk | Orta; testler rate limit'i gevşeterek ürün davranışını değiştirmemeli; fixture state paylaşımı flake üretebilir. |
| Dependencies | RF01, RF07, RF03 |
| Tests | A/B account switch, logout/revocation, role change ve erişim kaybı, concurrent message/edit/delete, offline retry, upload failure draft preservation, E2EE backup/recovery, production asset load. Audio gerçek cihaz testleri RF21/RF30'da kalır. |
| Acceptance Criteria | Her test kendi sunucu/channel/veri bağlamını oluşturuyor; ortak fixture yalnız kimlik setup amacıyla; assertion sonuç davranışını ölçüyor; sabit sleep yerine observable wait; production profile gerçekten build artifact'i kullanıyor. |
| Effort | 3–5 mühendis-gün |

## RF29 — Ölçümlü performans ve kaynak bütçeleri

| Alan | Tanım |
|---|---|
| Task ID | RF29 |
| Priority | P2 |
| Module | `loadtest/`; `server/services/member_service.go:135`; `server/services/group_dm_service.go:466`; `client/src/crypto/keyStorage.ts:878`; WS/voice/native lifecycle yolları |
| Problem | Kaynak şekli fan-out veya full-scan maliyetini düşündürüyor; mevcut inceleme bütün endpoint/platform için p95/CPU/heap ölçümü üretmedi. Log örneği veya build sonucu ölçeklenebilirlik kanıtı değildir. |
| Solution | Sabit seed/veri/süre/eşzamanlılık ile yerel baseline: member/group/history/search, WS reconnect/broadcast ve voice start/stop soak. DB query count/wait, request p50/p95, CPU/heap, goroutine/worker/context/child sayısını ölç. Yeni cache/indeks yalnız ölçülen darboğaz için. |
| Risk | Orta; üretime izinsiz load uygulanmaz; local ölçüm üretim SLA'sı diye sunulmaz. |
| Dependencies | RF09, RF17 |
| Tests | Aynı makine ve veriyle önce/sonra tekrarlar; boş/normal/büyük veri; yavaş consumer/provider; connection churn; bounded soak sonrasında kaynak taban seviyeye dönüş. |
| Acceptance Criteria | Ölçüm koşulları/artifact'leri yeniden üretilebilir; kritik query count üye sayısıyla artmıyor; p95/CPU/heap kötüleşmesi gerekçesiz kabul edilmiyor; ölçüm varyansı raporlanıyor; kazanımı olmayan optimizasyon uygulanmıyor. |
| Effort | 2–4 mühendis-gün |

## RF30 — Runtime kabulü ve kapanış

| Alan | Tanım |
|---|---|
| Task ID | RF30 |
| Priority | P1 kabul kapısı |
| Module | `implementation/coverage.json:11`; `scripts/verify-windows-upgrade.ps1:90–108`; altı refactoring belgesi; platform/deployment smoke yolları |
| Problem | Windows upgrade script'i paket/feed/helper varlığını doğrular; gerçek uygulama açılışı, iki yönlü ses, çoklu ekran/DPI ve anti-cheat uyumluluğunu kanıtlamaz. Yerel Go/Electron/E2E başarıları PostgreSQL/LibSQL/gerçek cihaz/canlı runtime kapsamını kapatmaz. |
| Solution | Seçilen teslimat kapsamının kabul matrisini uygula: web, kurulu Windows, desteklenen Linux/macOS, Android/iOS ve desteklenen DB/provider'lar. İlgili build sonrası readiness/startup error/5xx/latency doğrulaması planla. Altı belge ve görev↔borç↔test↔kanıt çapraz referanslarını güncelle. |
| Risk | Orta-yüksek; gerçek dış servis/cihaz yoksa açık blocked sonucu verilir. Yayın bu belgeyle kendiliğinden yetkilendirilmez; bu aşama plan dokümanı üretimidir. |
| Dependencies | Teslimat kapsamına alınan RF01–RF29 görevlerinin kabulü. Kapsam dışı işler isim ve gerekçeyle kalır; bütün backlog'un tek release'te tamamlanması şart değildir. |
| Tests | Önceki installer→yenisi/profile preservation, login/logout/remember me, update/restart, overlay/DPI/çoklu ekran, bağımsız iki cihaz ses/camera/share, hotplug/uzun çağrı, gerçek DB migration/restore, readiness ve hata/latency gözlemi. |
| Acceptance Criteria | Her kapsamdaki iş için test artifact'i ve sahibi var; build/runtime/ürün kabulü ayrı durumlar; çözülmemiş riskler ve platform blokajları açık; API/WS/IPC/storage biçimleri korunmuş veya ayrı onaylı migration planına bağlı; 248 kabul maddesi otomatik topluca kapatılmamış. |
| Effort | 2–4 mühendis-gün + cihaz/servis/insan kabul beklemeleri |

## Her PR için ortak tamamlanma tanımı

- Problem ve ölçülebilir fayda görev ID'siyle açıklanır; yalnız farklı görünmesi için kod taşınmaz.
- Public HTTP/API, WS event, Electron IPC ve kalıcı veri biçimi aynı kalır. Internal type/constructor sınırı değişirse bütün tüketiciler aynı PR'da güncellenir. DB/schema veya backup biçimi değişikliği ayrıca ileri/geri uyumluluk planı gerektirir.
- Kritik davranış refactor'dan önce testle sabitlenir. Unit testte dış ağ/gerçek saat yerine fake adapter/saat, repository integration testinde gerçek izole DB kullanılır; uygulamanın kendisini tamamen mock'layan test kabul kanıtı olmaz.
- Hedefli doğrulama ve gerekli ortak CI kontrolleri geçer; atlanan/başarısız/not-run durumları saklanmaz. Coverage tek başına kabul değildir. Global strict acceptance sonucu görünür kalır; 248 ilgisiz açık ürün maddesi her refactoring PR'ı için yeni bir tamamlanma şartı yapılmaz.
- İlgisiz dirty dosyalar staged edilmez; commit/PR/release artifact'i ile kanıt kaydı aynı kaynak anlık görüntüsünü gösterir.
- Rollback küçük PR'ın revert'iyle mümkün tutulur. Veri migration'ı varsa backup/restore provası olmadan release kapısı kapanmaz.
- [REFACTORING_PLAN.md](REFACTORING_PLAN.md), [TECHNICAL_DEBT.md](TECHNICAL_DEBT.md), [TEST_STRATEGY.md](TEST_STRATEGY.md), [CODE_QUALITY_STANDARDS.md](CODE_QUALITY_STANDARDS.md) ve [ARCHITECTURE_IMPROVEMENTS.md](ARCHITECTURE_IMPROVEMENTS.md) ilgili kararlarla eşleşir.
