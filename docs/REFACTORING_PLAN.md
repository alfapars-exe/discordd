# HiChat: kapsamlı refactoring ve kalite planı

Tarih: **25–26 Ekim 2026**. Durum: **26 Ekim kullanıcı talebiyle uygulama başladı; ilk güvenlik ağı ve kaynak sahipliği grubu yerelde doğrulandı**.

Bu planın amacı çalışan davranışları koruyarak bakım maliyetini, kaynak yaşam döngüsü hatalarını ve değişiklik riskini azaltmaktır. İlk teslimat altı dokümandı. 26 Ekim’de uygulama yetkilendirildi; kod ve test değişiklikleri küçük sorumluluk gruplarıyla ilerliyor. Üretim yayını bu yerel uygulamanın tamamlanma iddiasına dahil değildir.

26 Ekim uygulama sonucu: dondurulmuş kaynakta client lint/test/build, Go, Electron, bot ve E2E kontrolleri geçti; gerçek PostgreSQL ve mTLS ayrıca doğrulandı. Coverage artık ölçülüyor ve CI kapıları eklendi. Ayrıntılı uygulama/kalan iş ayrımı [görev izleme tablosunda](REFACTORING_TASKS.md), kaynak manifestleri ve doğrulama sınırları [kanıt raporunda](../implementation/verification/refactoring-implementation-2026-10-26.json). Otuz görevin tamamı bitmedi; aşağıdaki 25 Ekim ölçümleri tarihsel başlangıçtır.

## 1. Kararlar ve kapsam

- Kullanıcının seçimi: yeni özellik geliştirmeleri devam ederken **küçük, bağımsız ve doğrulanabilir PR'lar**.
- Kullanıcının seçimi: yalnız istenen **altı doküman sürüm kontrolüne alınır**; diğer `docs/` içeriği özel kalır.
- Mevcut modüler monolit korunur: Go HTTP/WebSocket sunucusu, React istemcisi, Electron/Capacitor kabukları ve mevcut servis/repository sınırları geliştirilir. Yeni framework, ORM, DI konteyneri veya mikroservis dönüşümü önerilmez.
- HTTP yolları, yanıt zarfları, WebSocket olayları, IPC kanal/payload'ları, E2EE wire/backup biçimleri, kalıcı tercih anahtarları ve mevcut hesapların davranışı uyumluluk sözleşmesidir.
- Yeni kayıt için e-posta zorunluluğu mevcut kodda vardır. Eski e-postasız hesaplar korunur; önceki incelemedeki eski test hataları güncel hata olarak taşınmaz.
- Feature eksikleri refactoring işi gibi kapatılmaz. Kabul takipçisindeki bekleyen davranışlar; eksik özellik, doğrulanmamış uygulama ve mevcut davranış olarak ayrı değerlendirilir.
- Kimlik doğrulama, yetkilendirme, E2EE, ses ve migration değişiklikleri önce davranış testleri, sonra küçük uygulama PR'ları ile ilerler.
- Üretime yük testi, deploy, dış sisteme mesaj, PR açma veya merge bu doküman teslimatının parçası değildir.

## 2. Mevcut mimari ve başlangıç ölçümü

İncelenen depo: `C:\Users\PARS\Desktop\PROJELER\HiChat\discordd`. Başlangıç HEAD: `313acf8e`. Çalışma ağacında önceden mevcut logging, PostgreSQL, servis ve istemci değişiklikleri vardı. İnceleme sırasında ses ayarları dosyalarında başka değişiklikler de gözlendi. Bu sonuçlar **tek, değişmez bir commit'in kabul raporu değildir**; uygulama öncesinde RF02 ile sabit sürüm üzerinde tekrarlanır.

| Katman | Mevcut yapı | Korunacak güçlü taraf |
|---|---|---|
| Sunucu | Go; handler → service → repository; `database/sql`; SQLite/libSQL ve PostgreSQL adaptörü | Gerçek migration'lı repository fixture'ları, route/permission sözleşmeleri, WS race senaryoları |
| İstemci | React 19, strict TypeScript, Zustand, Vite, Vitest/Testing Library | Alan bazlı testler, hesap sahipliği kontrolleri, ayrılmış API ve domain event handler'ları |
| Medya | LiveKit/P2P; ortak AudioWorklet/WASM mikrofon pipeline'ı; ekran/kamera/native audio | Mevcut session/lease/generation ve eski async sonuçları reddetme kontrolleri |
| Kriptografi | Gerçek kriptografik işlemler ve IndexedDB'de hesap/backend kapsamlı depolama | Uyumluluk fixture'ları, hesap ayrımı ve restore rollback testleri |
| Masaüstü/mobil | Electron main/preload/IPC; Windows C++ helper'ları; Capacitor Android/iOS | Main-frame kontrolü, native kaynak sahipliği, overlay/IPC davranış testleri |
| Operasyon | GitHub Actions, HF kaynak yayını, masaüstü installer/updater, Docker, backup/readiness | Go test shard'ları, lint/security kontrolleri, E2E ve üretim image build kontrolü |

Kapanış envanteri (23:33, Europe/Istanbul): `server/` altında 594 uygulama ve 452 test Go dosyası; 144 SQLite ve 45 PostgreSQL migration dosyası. `client/src/` altında 1.229 dosya ve bunların içinde 423 test/spec dosyası. Sayılar çalışma ağacını içerir; satır/dal kapsam yüzdesi değildir. Eşzamanlı çalışmalardan dolayı başlangıç envanterinden farklıdır. Envanter tüm katmanları kapsar; ayrıntılı inceleme riskli giriş noktaları, veri ve kaynak sahipliği sınırlarında yoğunlaşmıştır. Bu çalışma tam bir penetrasyon testi veya her satırın bağımsız güvenlik doğrulaması değildir.

### Çalıştırılan kontroller

| Kontrol | Gözlenen sonuç | Kanıtın sınırı |
|---|---|---|
| `server/`: `go test ./... -count=1 -timeout=5m -p 2` | Başarılı | Yerel Go 1.27.0; `-race` kullanılmadı. PostgreSQL test DSN'i yok; koşullu PG testleri kabul kanıtı sayılmaz. |
| Kök: `npm run electron:test` | 217 geçti, 1 atlandı | Symlink oluşturma bu Windows ortamında kullanılamadı. Paketli uygulama/installer testi değildir. |
| `e2e/`: `npm test -- --reporter=line` | 5 geçti, 46,1 saniye | Chromium + gerçek yerel Go + geçici SQLite + Vite dev server; üretim bundle ve fiziksel ses kapsam dışı. |
| `client/`: `npm run lint -- --quiet` | Başarılı | ESLint hata kapısı; uyarısız olduğu veya Electron/native kodunu kapsadığı anlamına gelmez. |
| `client/`: `npm run build` | **Başarısız** | TypeScript aşamasından sonra Vite iki dosyayı geçersiz UTF-8 nedeniyle yükleyemedi. |
| `client/`: tam Vitest, 23:27–23:32 | **4.106 geçti, 8 başarısız; 421 dosya geçti, 2 başarısız; 310,77 saniye** | İki UserBar test mock'unda eksik `useTracks`; çalışma sırasında başka değişiklikler vardı. Bu, son HEAD'in tam test sonucu değildir. |
| İki UserBar dosyası, hedefli tekrar, 23:33 | **2 dosya / 9 test geçti**, 12,71 saniye | Başka çalışma akışı `da506e3b` commit'iyle mock'ları düzeltti. Bu görev uygulama/test kodunu değiştirmedi; tam suite bu commit'ten sonra yeniden çalıştırılmadı. |
| Kök: `npm run test:coverage` | 32 geçti | Buradaki isim kabul takipçisi testidir, kod coverage ölçümü değildir. |
| Python shard/publish yardımcıları | 9 geçti | Mevcut publisher testi içerik hash eksikliğini yakalayan bir test değildir. |
| `npm run check:coverage` | Yapı geçerli | 261 davranış: 35 mevcut, 15 eksik, 198 uygulanmış/doğrulanmamış, 2 kabul edilmiş, 11 hariç. |
| `npm run check:acceptance` | **Başarısız: 248 bekleyen davranış** | Global ürün kabulü tamamlanmamış; 248 doğrulanmış yazılım hatası olduğu anlamına gelmez. |
| UTF-8 taraması | 2.653 izlenen metin dosyasında 2 hatalı dosya | Binary, public asset ve belirli üretilmiş kanıt alanları hariç. İki hatanın HEAD içeriklerinde de bulunduğu doğrulandı. |

Yerel Node sürümü 24.22.1; CI Node 22 ve Go 1.26.10 kullanıyor. RF02 aynı toolchain ile tekrarlanabilir başlangıç sonucu üretir; sürüm yükseltmesi refactoring ile birleştirilmez.

İnceleme sonunda HEAD `da506e3b` olmuştu. RF02 mevcut mock düzeltmesini koruyup sabit revizyonda tam suite'i doğrular; artık kaynakta bulunmayan mock eksikliğini tekrar düzeltmeye çalışmaz. UTF-8 hataları bu son kontrol sırasında da devam ediyordu.

### İlk önceliği belirleyen somut bulgular

1. **P1 derleme engeli:** [VoiceProvider.tsx:262](../client/src/components/voice/VoiceProvider.tsx#L262) ve [GroupDMCall.tsx:60](../client/src/components/dm/GroupDMCall.tsx#L60) geçersiz UTF-8 içeriyor. RF01 yalnız metin kodlamasını, anlamı koruyarak düzeltir; görünür karakterler ve build tekrar doğrulanır.
2. **P1 veri tabanı doğrulama açığı:** [testdb_test.go:52](../server/repository/testdb_test.go#L52) PG testlerini ortam değişkenine bağlarken [server-ci.yml](../.github/workflows/server-ci.yml) bu lane'i kurmuyor. Mevcut race/coverage CI'si PG eşdeğerliğini kanıtlamıyor.
3. **P1 migration riski:** [database.go:244](../server/database/database.go#L244) boş migration defterini yalnız `users` tablosu varlığıyla benimseyip paketli dosyaları uygulanmış sayıyor. Bilinen eski şema fixture'ları ve fail-closed benimseme gerekir; mevcut veri kaybı iddiası yoktur.
4. **P1 medya yaşam döngüsü:** [useScreenShareToggle.ts:286](../client/src/hooks/useScreenShareToggle.ts#L286) çoklu platform/async kaynak sahipliğini birleştiriyor; doğrudan hook testi bulunmadı. Alt katman testleri mevcut. Mikrofon testi ile çağrıların kayıp çıkış cihazı fallback'i de eşit değil.
5. **P1 yayın izlenebilirliği:** [publish-hf-space.py:57](../scripts/publish-hf-space.py#L57) inceleme hash'ine dosya içeriklerini katmıyor. Aynı yolun içeriği değiştiğinde onaylı hash aynı kalabilir; yayının değişmez byte manifestine bağlanması gerekir.

P0 için doğrulanmış, erişilebilir kritik güvenlik/veri kaybı olayı saptanmadı. Yeni kanıt çıkarsa P0 iş normal faz sırasının önüne alınır; test açığı tek başına P0 sayılmaz.

## 3. Altı faz ve çıkış koşulları

| Faz | İşler / görevler | Çıkış koşulu |
|---|---|---|
| **1 — Discovery & Baseline** | RF01–RF02; kaynak/test/migration/bağımlılık envanteri; mevcut değişiklik sahipliğini ayırma; sabit sürüm ve toolchain kaydı | Derleme engeli giderilmiş, başarısız/atlanan/çalıştırılmayan kontroller ayrı yazılmış, sayısal ölçümlerin üretim yöntemi kayıtlı. RF01 uygulaması bu doküman teslimatından sonra yapılır. |
| **2 — Test Safety Net** | RF03–RF04, RF07, RF28; RF05/06/12/18/19/21/22'nin karakterizasyon testleri | İlgili refactoring için kırmızıdan yeşile doğrulanmış davranış testleri, gerçek DB sözleşmeleri, deterministic fixture'lar ve PR kapıları mevcut. |
| **3 — Core Refactoring** | RF05–RF06, RF08, RF10–RF16, RF18–RF22; RF11 composition iyileştirmesi | Her alt PR aynı API/durum/olay sonuçlarını koruyor; kaynak sahibi ve cleanup tek yerde; yarış/hesap değişimi/iptal senaryoları geçiyor. |
| **4 — Clean Code & Standardization** | RF24–RF27; RF13/20'nin okunabilirlik adımları | Yeni/değişen kod ortak kurallara uyuyor; toplu kozmetik diff yok; locale/erişilebilirlik ve örnek bot davranışları kanıtlı. |
| **5 — Performance & Security** | RF09, RF17, RF23, RF29; tüm hassas değişikliklerde hedefli güvenlik regresyonları | Aynı fixture/toolchain üzerinde önce/sonra ölçümler; query fan-out azalmış; içerik bazlı yayın doğrulanmış; doğrulanmamış güvenlik iddiaları ayrı. Kritik RF23 düzeltmesi bu fazı beklemek zorunda değildir. |
| **6 — Verification & Documentation** | RF30 ve her PR'ın kendi kanıt güncellemesi | İlgili unit/integration/API/E2E/build kapıları yeşil; platform/lifecycle kanıtları mevcut veya açıkça bekliyor; doküman/task/kanıt eşleşmesi tutarlı. |

Fazlar bir aylık büyük değişiklik paketine dönüştürülmez. Bir modül kendi güvenlik ağı hazır olduğunda refactor edilebilir; başka modülün donanım testini beklemesi gerekmez. RF01 → RF02 → RF03/RF04 başlangıç zinciridir. Sonra backend, frontend ve desktop dalları paralel ilerler; dosya sahipliği çakışan PR'lar sıraya alınır. Görev düzeyinde kesin ön koşullar [REFACTORING_TASKS.md](REFACTORING_TASKS.md) içindedir.

### PR ve geri alma politikası

- Bir PR tek davranış/sorumluluk sınırını iyileştirir; karakterizasyon, taşıma, davranış düzeltmesi ve bağımlılık güncellemesi mümkün olduğunca ayrı PR'lardır.
- Her PR problem, korunacak sözleşme, ölçülebilir fayda, hedefli test komutları, kalan runtime kabulü ve geri alma adımını içerir.
- Değişen dosyalardaki önceden mevcut çalışmalar önce sahipleriyle/ilgili commit'lerle ayrıştırılır. Toplu stage/reset/clean yapılmaz.
- Kaynak refactoring'inde rollback önceki commit/artifact'e dönüştür. Veri biçimi değişikliği gerekiyorsa ayrıca migration görevi, tutarlı backup, eski/yeni sürüm uyumluluğu, restore provası ve ileri/geri kurtarma adımı yazılır. Tarihî migration dosyaları değiştirilmez.
- Başarılı build, yayımlanmış runtime kabulü değildir. Daha sonra yayın yapıldığında exact revision + readiness + ilgili kullanıcı senaryosu + hata/latency gözlemi gerekir.

## 4. Başarı ölçütleri ve test yaklaşımı

Kapsam yüzdesi önce ölçülür; mevcut yüzde uydurulmaz. Yeni veya yeniden ayrıştırılan kritik çekirdeklerde TypeScript için %90 statement / %85 branch, diğer yeni çekirdeklerde %80 / %75 hedeflenir. Go'da kritik yeni çekirdeklerde %90, diğerlerinde %80 statement hedeflenir; dal güvenliği açık senaryo tablosuyla sağlanır. Eski geniş modüllere ilk PR'da toplu eşik uygulanmaz; genel ölçüm başlangıç değerinden düşmeme yaklaşımıyla ilerler. Bu hedefler tek başına kabul değildir.

| Boyut | Ölçülebilir kabul |
|---|---|
| Uyumluluk | HTTP golden/schema, WS olay ve IPC contract, eski preference/backup fixture'ları değişmeden geçer. |
| Kaynak yaşam döngüsü | İptal/yeniden bağlanma/hesap değişimi/unmount sonrası görevin sahip olduğu track, timer, listener, worker, process ve goroutine'ler bırakılır; eski async sonuç state değiştiremez. |
| Veri | SQLite ve PostgreSQL sözleşmeleri geçer; migration/adoption fixture'larında kayıt ve şema korunur; belirsiz yazmalar kör retry edilmez. |
| Performans | Önce query sayısı, p50/p95, pool wait, heap/CPU/long task ölçülür. Aynı kontrollü senaryonun en az üç tekrarının medyanı kıyaslanır. %10 üzeri regresyon inceleme gerektirir; bu eşik üretim SLA'sı değildir. |
| Test kalitesi | Başarısız yol ve sınır değerleri kapsanır; kodun aynısını mock içinde tekrar eden testler yazılmaz; kritik test en az bir ilgili kusuru yakaladığını gösterir. |
| Ürün kabulü | Birim test sonucu yalnız kapsadığı davranışa kanıttır. Fiziksel cihaz, uzun çağrı, installer/upgrade, çoklu ekran/DPI ve mobil izinler ayrı kanıt ister. |
| Teknik borç | Her RF görevinde başlangıç kanıtı, çözüm, risk, test, efor ve kapanış ölçütü vardır; yalnız satır sayısı azalması başarı değildir. |

Test katmanları, fixture/mock politikası, tüm kritik modül senaryoları, CI kademeleri ve çalıştırma komutları [TEST_STRATEGY.md](TEST_STRATEGY.md) içindedir. Kritik her değişiklik kendi güvenlik testini taşır; güvenlik kontrolü yalnız beşinci faza ertelenmez.

## 5. Doküman seti ve kullanım

| Doküman | Tekil sorumluluk |
|---|---|
| [REFACTORING_PLAN.md](REFACTORING_PLAN.md) | Kararlar, baseline, fazlar, sıralama, başarı ve rollback yaklaşımı |
| [TECHNICAL_DEBT.md](TECHNICAL_DEBT.md) | Gerçek kaynak referanslı borçlar; gözlem/çıkarım/bilinmeyen ayrımı |
| [TEST_STRATEGY.md](TEST_STRATEGY.md) | Test matrisi, coverage, mock/fixture, CI, platform ve performans kabulü |
| [CODE_QUALITY_STANDARDS.md](CODE_QUALITY_STANDARDS.md) | Uygulanabilir okunabilirlik, tip, hata/log, async ve kaynak sahipliği kuralları |
| [ARCHITECTURE_IMPROVEMENTS.md](ARCHITECTURE_IMPROVEMENTS.md) | Mevcut/hedef bağımlılıklar, küçük sınır değişiklikleri ve korunacak sözleşmeler |
| [REFACTORING_TASKS.md](REFACTORING_TASKS.md) | RF01–RF30 işleri; tüm gerekli görev alanları, efor ve bağımlılıklar |

Eforlar mühendis-günüdür ve görev bazında test/review payını içerir; donanım temini, CI kuyruğu ve dış servis bekleyişi takvim tahminine dahil değildir. Paralellik nedeniyle görev eforlarının toplamı doğrudan takvim süresi değildir. Önce P1 güvenlik ağı ve derleme/veri/yaşam döngüsü işleri; ardından ölçülmüş faydası olan P2 işler; en son P3 yorum/adlandırma temizliği alınır.

Bu teslimatın tamamlanması, RF görevlerinin uygulanmış veya HiChat'in tüm platformlarda production-ready kabul edilmiş olduğu anlamına gelmez. Dokümanlar uygulama sırasında kanıtla güncellenir; global kabul takipçisi yapay olarak yeşile çevrilmez.
