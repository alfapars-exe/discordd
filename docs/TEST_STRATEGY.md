# HiChat test ve doğrulama stratejisi

26 Ekim uygulama kanıtı: ilk grup yerelde doğrulandı. Güncel sonuçlar ve kalan kabul sınırları [görev izleme tablosunda](REFACTORING_TASKS.md) ve [manifestli raporda](../implementation/verification/refactoring-implementation-2026-10-26.json) izlenir. Bu belge tüm görevlerin tamamlandığını göstermez.

> 26 Ekim uygulaması: quality:baseline / quality:postgres profilleri, V8 coverage, Go coverage merge ve PostgreSQL CI kapıları eklendi. Aşağıdaki 25 Ekim başlangıç sonuçları tarihsel kayıttır. Yeni sonuçlar REFACTORING_TASKS.md uygulama bölümünde ve implementation/verification/refactoring-*-2026-10-26.json raporlarında izlenir; son CI/cihaz kabulü ayrı kalır.

Tarih: 25 Ekim 2026. Bu belge, mevcut davranışı koruyan refactoring için uygulanacak test planıdır. Görev kimlikleri [REFACTORING_TASKS.md](REFACTORING_TASKS.md), fazlar [REFACTORING_PLAN.md](REFACTORING_PLAN.md) içindedir. Burada önerilen yeni testler, CI değişiklikleri ve coverage eşikleri henüz uygulanmış sayılmaz.

## 1. Başlangıç durumu ve kanıt sınırı

İnceleme `313acf8e` HEAD'i üzerinde, çok sayıda önceden var olan değişiklik içeren çalışma ağacında başladı; kapanışta başka çalışmanın `da506e3b` commit'i gözlendi. Testler sırasında kaynak/test dosyaları da değişti; bu nedenle aşağıdaki sonuçlar tek bir değişmez commit'in sürüm onayı değildir. RF02 tamamlanırken temiz bir inceleme commit'i veya dosya özetleriyle sabitlenmiş kapsam üzerinde yeniden üretileceklerdir.

| Kontrol | Gözlenen sonuç | Ne kanıtlamaz? |
|---|---|---|
| Go `go test ./... -count=1 -timeout=5m -p=2` | Geçti | Yerel koşuda race detector açılmadı; PostgreSQL DSN verilmedi; canlı libSQL/üretim doğrulanmadı. |
| Electron test komutu | 217 geçti, symlink yeteneğine bağlı 1 test atlandı | Paketlenmiş uygulama, işletim sistemi izinleri, yükleyici, otomatik güncelleme ve gerçek cihaz kabulü. |
| Playwright | 5 geçti; raporlanan süre 46,1 saniye | Yapılandırma gerçek Go + geçici SQLite + Vite geliştirme sunucusudur; üretim bundle'ı veya bütün özelliklerin E2E kapsamı değildir. |
| Client lint `--quiet` | Geçti | Uyarıların sıfır olduğunu veya TypeScript/build'in geçtiğini göstermez. |
| Client production build | Başarısız | `VoiceProvider.tsx:262` ve `GroupDMCall.tsx:60` geçersiz UTF-8 içeriyor; aynı kusur HEAD içeriğinde de doğrulandı. RF01 giriş engelidir. |
| Client tam Vitest koşusu | **Önceki anlık görüntüde başarısız:** 423 dosyanın 421'i geçti, 2'si başarısız; 4.114 testin 4.106'sı geçti, 8'i başarısız. Süre 310,77 saniye. | 25 Ekim 2026 23:27 başlangıçlı İstanbul koşusu, `--maxWorkers=4`; test dosyası sayısı iç içe `describe`/suite sayısıyla karıştırılmaz. İki suite'in o sıradaki LiveKit mock'u `useTracks` sağlamıyordu. |
| Sonraki hedefli client koşusu | **Geçti:** ilgili 2 dosya, 9 test; 12,71 saniye | 25 Ekim 2026 23:33:35 İstanbul; dış çalışmanın `da506e3b` fixture düzeltmesinden sonra. Tam suite bu son sürümde yeniden çalıştırılmadı. |
| Acceptance ledger validator | Yapısal kontrol ve validator'ın 32 testi geçti | Özelliklerin kabul edildiği veya kod coverage oranı. |
| Python shard/publish yardımcı testleri | 9 geçti | Gerçek yayın, kimlik bilgileri, uzak depolama veya HF runtime sağlığı. |
| Strict acceptance | 248 bekleyen: 198 `implemented_unverified`, 15 `missing`, 35 `existing`; ayrıca 2 `accepted`, 11 `excluded` | Bu sayılar statement/branch coverage yüzdeleri değildir; strict kabul tamamlanmış değildir. |

Client envanterinde 423 test dosyası bulunması test altyapısının genişliğini gösterir; başarı oranı ya da ölçülmüş kod kapsamı vermez. `client/vitest.config.ts:5` jsdom ortamını tanımlar, coverage sağlayıcısı/eşiği tanımlamaz. Mevcut `.github/workflows/server-ci.yml` Go race/coverage shard'ları, lint, güvenlik kontrolleri, client test/build, E2E ve Electron kontrolleri içerir. Plan bunları genişletir; sıfırdan alternatif CI kurmaz.

Tam koşuda başarısız client dosyaları `UserBar.groupAudio.test.tsx` (5 test) ve `UserBar.p2pRinging.test.tsx` (3 test) idi: `GroupRemoteVideos.tsx:4` tarafından çağrılan `useTracks`, o anki `@livekit/components-react` mock'unda yoktu. Bu koşu devam ederken bağımsız çalışma `da506e3b` ile fixture'ları güncelledi; sonraki hedefli 2 dosya/9 test geçti. Bu nedenle mock eksikliği güncel kaynakta açık hata olarak listelenmez; RF02 son revision ve dosya içeriklerini sabitleyip tam suite/build durumunu yeniden üretmelidir. Bu doküman çalışması uygulama/test kodunu değiştirmedi. İlk tam koşunun sonucu kesinti sonrasında alınamadı; tablodaki tam sonuç rapor dosyasına yazılan tekrar koşusudur. JSON kanıtı yerel geçici dizinde `C:\Users\PARS\AppData\Local\Temp\hichat-refactoring-baseline-20261025\client-vitest.json` konumundadır; kalıcı teslimatta RF02 kanıt kaydına taşınmalıdır.

## 2. Test katmanları ve bağımlılık politikası

| Katman | Gerçek çalışacak bölüm | Taklit edilebilecek sınır | Kural |
|---|---|---|---|
| Go unit | Model doğrulama, saf politika, izin/limit hesapları, servis kararları | Saat, dış servis portu, gerekli dar repository arayüzü | Tablo testleri; başarı yanında sınır ve hata dalı. HTTP veya SQL ayrıntısını servis testine yayma. |
| Repository integration | Gerçek SQL, migration ve transaction; SQLite + yerel PostgreSQL | E-posta/LiveKit gibi veritabanı dışı servisler | SQL'i mock ederek dialect, FK, kilit veya rollback doğrulandı deme. Her test kendi DB/schema verisini sahiplenir. |
| HTTP/API integration | Gerçek router, middleware, model, handler ve gerekli servis/repository | Dış sağlayıcı HTTP uçları | Status, hata kodu, JSON, cookie/header, authorization ve yan etki birlikte doğrulanır. Route golden tek başına sözleşme testi değildir. |
| WebSocket integration | Gerçek hub ve yerel socket bağlantıları | Saat ve kontrollü ağ kesintisi | Kimlik/oturum bağı, mesaj sırası, yavaş tüketici, iptal ve shutdown davranışı gözlenir. |
| TS unit | Saf dönüştürücü, store geçişi, hook sözleşmesi, codec | Fetch, SDK, medya aygıtı, IPC adaptörü, saat | UI testleri davranış/erişilebilir isim üzerinden; iç hook çağrı sayısını sözleşme yerine kullanma. |
| Crypto integration | Gerçek kripto işlemleri ve sabit test vektörleri; gerçek storage kodu için `fake-indexeddb` | Uzak E2EE API, ayrı kontrollü testlerde pahalı KDF sınırı | Mock kriptoyla şifreleme doğruluğu iddia edilmez. Codec, eski yedek ve geri alma senaryoları gerçek veriyle doğrulanır. |
| Tarayıcı E2E | Gerçek Go, izole DB, gerçek istemci ve iki kullanıcı/context | E-posta teslimatı ve üçüncü taraf müzik/LiveKit servisleri varsayılan olarak kontrollü stub | Kritik kullanıcı akışları ve taşıma entegrasyonu; her kombinasyon E2E'ye taşınmaz. |
| Desktop/native | Electron sözleşmeleri + gerektiğinde paketlenmiş uygulama; native helper süreçleri | Hızlı testlerde OS adaptörü; kabulde gerçek OS/cihaz | Node testi işletim sistemi izinlerini veya sürücü davranışını kanıtlamaz. |
| Performans | Gerçek hedef kod, tanımlı veri büyüklüğü ve kaynak limiti | Kontrol edilmeyen harici servis gecikmesi | Önce baseline, sonra aynı ortamda karşılaştırma; ölçülmeyen darboğaz bulgu olarak etiketlenmez. |

Fixture'lar geçerli üretim sözleşmelerinden türetilir; kimlik, zaman, sıra ve rastgelelik test içinde belirlenir. Geçersiz girdiler ayrı ve açık isimlendirilir. Ortak fixture builder yalnız tekrar eden alanları kurar; testin anlamını gizleyen büyük bir fixture DSL eklenmez. Canlı üretim verisi veya gerçek kullanıcı kimlik bilgileri kullanılmaz.

## 3. Risk ve kabul matrisi

Aşağıdaki senaryolar, ilgili refactoring PR'ının asgari kontrol kümesidir. Mevcut testlerle karşılanan senaryolar yeniden yazılmak yerine yeniden kullanılacak; eksik kombinasyonlar eklenecektir.

| Alan / görev | Öncelikli senaryolar | Katman ve kabul |
|---|---|---|
| Auth, session, recovery / RF07 | Yeni kayıt e-posta zorunluluğu; eski e-postasız hesabın girişinin korunması; e-posta kaldırmanın reddi; kullanıcı adı/e-posta ile recovery; var/yok hesapta dışarıya verilen mesaj eşitliği; süresi dolmuş/tekrar kullanılan token; eşzamanlı refresh; logout/hesap değişimi sırasında geç yanıt | Model + servis + gerçek HTTP/cookie testleri. Yanlış hesapta veri/oturum yazımı yok; reset sonrası beklenen session iptali; OpenAPI ve istemci fixture'ları aynı sözleşmeyi izler. |
| Yetki, rol, moderasyon, davet / RF07, RF11 | Üye olmayan/çıkarılan kullanıcı; rol sınırı; DM block/friend değişimi; timeout/ban başlangıç-bitiş sınırı; davetin limit/expiry eşzamanlı tüketimi; disabled server creation policy | Unit + gerçek API/repository + iki kullanıcılı E2E. İzin reddinde hiçbir kalıcı/WS yan etki yok; yetkili olumlu yol korunur. |
| Repository, dialect, migration / RF04–RF06 | NULL/tarih/JSON/placeholder semantiği; aynı migration'ın tekrar çalıştırılması; önceki desteklenen sürümden yükseltme; temiz kurulum; transaction ortasında hata; concurrent revoke/write; cascade/anonymization | SQLite ve PostgreSQL 18 lane'lerinde aynı davranış testleri. Satır sayısı/ilişki bütünlüğü; hata sonrası önceki verinin korunması; migration ve rollback/restore provası. |
| Mesaj, kanal, DM, group, thread / RF15 | WS önce/POST sonra ve tersi; duplicate echo; 207 kısmi upload; eski/yeni/around paging; aynı tarih sınırı; fetch sırasında delete; geciken decrypt; hesap/kanal değişimi; idempotent group send | Store unit + gerçek API + iki context E2E. Tek mesaj bir kez görünür, yanlış oturum yazmaz, detached history kaybolmaz, retry içerik çoğaltmaz. |
| Upload, attachment, media metadata / RF09, RF15 | Boyut sınırının altı/eşiti/üstü; bozuk içerik; MIME/suffix uyuşmazlığı; unauthorized download; silinen kaynak; iptal edilen upload; geç media-label sonucu | Handler/repository ve client sözleşme testleri. Reddedilen dosyada artık kayıt/nesne yok; erişim kaynağa bağlı; gizli içerik loglanmaz. |
| Preferences / RF13 | Debounce; hydrate sırasında yerel edit; başarısız PATCH + yeni edit; offline cache; storage quota; backend/hesap değişimi; geç ACK; cihaz alanlarının sync dışı kalması; legacy import | Mevcut `preferencesStore.test.ts` ve API/repository testlerini koru. En yeni kullanıcı değişikliği üstün; A hesabının bekleyen verisi B'ye gönderilmez. |
| WebSocket/P2P kontrol / RF14 | Reconnect backoff; offline/online/resume; heartbeat kaybı; session revoke; eski socket'in yeni hesabı etkilemesi; sıra dışı SDP/ICE; yavaş istemci; send/shutdown yarışı | Kontrollü socket + fake clock + Go race. İptalden sonra yayın/yazım yok; kuyruk sınırları ve kapanış tamamlanır. Beklenen backpressure logu test hatası sayılmaz. |
| Mikrofon ve ses çıkışı / RF12, RF14 | Mikrofon testi/LiveKit/P2P aynı engine/gain/gate/profile; model yüklerken mute/deafen; USB çıkarma; kayıp output fallback; permission denial; cihaz değişimlerinin ters sırada tamamlanması; partial init; processor/gate timeout; explicit retry | Mevcut audio suites + gerçek browser worklet probes. Raw mikrofon hazırlık sırasında yayınlanmaz; stale kaynak kapanır; seçilen ayar sessizce değiştirilmez; en son output seçimi üstün gelir. |
| Screen share, kamera, video / RF12, RF14, RF18 | Browser/Electron/Capacitor dalları; picker cancel; native token gelirken kanal değişimi; publish/unpublish hatası; quality restart sırasında unmount/yeni ayar; kamera↔ekran; OS dış durdurma; görünür/yetkili video kaynağı; `UserBar` group/P2P alt ağacının gerçek hook sözleşmesi | RF02 sabit baseline'ından sonra `useScreenShareToggle` characterization; ardından controller testleri. Track, listener, timer, worker ve native capture sahibi belirli; cleanup tekrarında güvenli; yanlış oda/hesaba yayın yok. |
| E2EE ve backup / RF16 | Yeni cihaz, rotation, eski/yeni anahtar, replay/out-of-order, yanlış hesap; ciphertext bozulması; eski backup formatı; malformed nested DTO; her yazım adımında failure; rollback; hesap değişirken IndexedDB işlemi; sealed pending send korunması | Gerçek crypto fixture + fake-indexeddb integration + iki client kabulü. Şifreli format değişmez; başarısız restore öncesi veri geri gelir; sonuç yalnız mock çağrısına göre kabul edilmez. |
| Cache/search / RF17 | 1k/10k/50k mesaj; Unicode/case; boş sorgu; sonucu olmayan arama; iptal; hesap değişimi; backup completeness; quota | Saf eşleşme + IndexedDB integration + benchmark. Sonuç kümesi/sırası korunur; heap ve süre ölçülür; limit uygulanacaksa kullanıcı davranışı ayrıca kararlaştırılır. |
| Müzik, bildirim, jobs / RF08, RF10 | Yetki kaybı; retry/dedup; lease expiry; worker cancel; aynı olayın iki teslimi; provider timeout; queue full; opt-out/privacy değişimi | Fake provider HTTP + gerçek queue/repository + race. Aynı işi iki worker tamamlamaz; shutdown'da kaynak kalmaz; gizlilik kararı geç tamamlanan işte tekrar kontrol edilir. |
| Log/diagnostic / RF24 | Request error + middleware error duplication; panic; secrets/PII içeren metadata; log sink timeout; queue full; shutdown flush; trace/request ilişkisi | Mevcut `logx` pipeline testleri ve HTTP integration. Hata bir sahip tarafından kaydedilir; redaction kalıcı sink'ten önce; log arızası ana isteği sınırsız bekletmez. |
| Electron IPC/overlay/updater / RF18–RF20 | Sender/origin ve payload doğrulama; stale overlay action; pencere kapanması; capture helper exit/hang; update metadata bozuk/eksik; indirme kesintisi; kurulu eski sürümden update | Node contract testleri + paketlenmiş uygulama kabulü. Yetkisiz IPC işlem yapamaz; kaynak sahibi kapanınca lease iptal olur; update başarısı installer çalıştırılarak doğrulanır. |
| Windows native / RF21 | WASAPI başlangıç/stop; aygıt kaybı; child process sonlandırma; DPI/çoklu monitör; oyun penceresi kaybı; PTT focus/blur; izin reddi | Native unit/harness + gerçek Windows cihazı. Bekleyen capture sonlanır; oyun ve masaüstü overlay davranışı ayrı kanıtlanır. |
| Mobil/Capacitor / RF22 | Android permission revoke, foreground service, back/resume; iOS interruption, background/lock, ReplayKit stop; ağ değişimi; native token/oda kapanışı | Plugin contract + Android emulator/cihaz + iOS cihaz/macOS runner. Template testler başarı kanıtı sayılmaz; Android package assertion gerçek `net.mqvi.app` ile eşleşir. |
| Yayın ve restore / RF23 | Dosya manifesti, artifact adları, OS metadata, eksik dosya, kısmi upload, yanlış revision, retry, readiness başarısızlığı, restore | Publish helper unit + fixture manifest + ayrı staging/release kabulü. Build/upload/Running/readiness ve çalışan release kimliği ayrı sonuçlar olarak kaydedilir. |
| i18n/erişilebilirlik / RF25 | 21 EN/TR namespace; plural istisnaları; interpolation anahtarları; dinamik hata anahtarı; klavye focus/escape/geri dönüş; 200% zoom; reduced motion/high contrast; sanal mesaj listesi | Locale/style/store unit + browser E2E + kısa screen reader kabulü. Ham çeviri anahtarı görünmez; kritik diyaloglar klavyeyle tamamlanır. |
| Bot ve operasyon araçları / RF27 | Bot/human gateway ayrımı; izin/token retire; reconnect/rate limit; bozuk payload; SIGTERM/shutdown; standalone module build | Ayrı Go modül testi + gateway integration; dış servise mesaj göndermeden yerel fixture. Yardımcı modül root server suite içinde test edilmiş varsayılmaz. |

RF12 için mevcut somut boşluk: `client/src/hooks/useScreenShareToggle.ts:286` üç platformun yaşam döngüsünü birleştirir; inceleme sırasında `client/src/**/*.test.*` içinde bu hook'u kullanan doğrudan test bulunmadı. Alt seviye P2P/screen testlerinin varlığı bu sınırı kapatmaz. `useMicTest.ts:57/83` ile çağrı çıkış adaptörlerinin kayıp aygıt fallback davranışı da ayrı characterization konusudur.

RF25 için mevcut parity testi 21 namespace'in 12'sini kontrol eder (`client/src/i18n/localeParity.test.ts:73`); auth, channels, dm, errors, landing, privacy, servers, soundboard, terms envantere eklenecektir. Bu tespit eksik çevirilerin tamamının doğrulandığı anlamına gelmez.

## 4. İzolasyon, zaman ve eşzamanlılık

- Her test oluşturduğu stream, track, AudioContext, Worker, socket, timer, listener, dosya, DB/schema ve child process'i kapatır. `t.Cleanup`/`afterEach` ve idempotent `dispose` kullanılır; bir test diğerinin reset sırasına bağımlı olmaz.
- Fake timer yalnız timer sözleşmesini test eden katmanda kullanılır. Gerçek socket/SQL/AudioWorklet kabulünde gerçek saat korunur. `sleep(500)` ile doğruluk beklemek yerine event, deferred promise, channel veya condition beklenir; her bekleme üst sınır taşır.
- Race senaryolarında sıra test tarafından kontrol edilir: işlem başlat → owner/permission değiştir → eski sonucu tamamla → yan etki olmadığını doğrula. Stale sonuç yalnız store yazımı için değil yayın, notification ve cleanup sahipliği için de kontrol edilir.
- SQLite dosyası `t.TempDir` içindedir. PostgreSQL helper zaten yalnız localhost/127.0.0.1 DSN kabul eder ve `hichat_test_*` schema oluşturur (`server/repository/postgres_testdb_test.go:17`). CI'da yalnız bu izole servis kullanılır; üretim DSN'i taşınmaz.
- PostgreSQL CI servisi `deploy/infra/compose.yaml:5` ile aynı 18.6 image/digest ailesine bağlanır. Zaman, JSON, `RETURNING`, kilit, concurrency ve transaction hataları SQLite başarısından türetilemez. LibSQL uyumluluğu ayrı CGO-enabled kontrollü lane'de kanıtlanır.
- E2E mevcut durumda tek account/backend ve tek worker kullanır. RF28'de veri ve port sahipliği worker bazında ayrılmadan `fullyParallel` açılmaz. Başka geliştiricinin Vite/backend süreçleri kabul koşusunda yeniden kullanılmaz; bundle testi ayrıca eklenir.
- Kripto test verisi sentetiktir. Üretimdeki güvenli rastgelelik deterministik yapılmaz; yalnız test factory'si sabit vektör alır. Yanlış-password ve legacy KDF uyumluluğu en az bir gerçek crypto integration testinde korunur.

## 5. Coverage hedefleri ve kalite kapıları

Bu eşikler yeni veya yeniden ayrıştırılan mantık çekirdekleri için hedeftir. Bir satır değişti diye mevcut geniş dosya/paketin tamamına veya ölçülmemiş tüm projeye aynı gün yeni global eşik uygulanmaz. RF02 önce kaynak kapsamı, hariç tutmalar, yürütülen testler ve commit'i kaydeder; RF03 mevcut modül/global baseline'ını bundan sonra geriye düşmeyecek şekilde sabitler.

| Kod sınıfı | Hedef | Sayısal hedefe ek zorunluluk |
|---|---|---|
| Yeni/ayrıştırılan kritik TS çekirdeği: session/permission, preferences, E2EE codec, medya sahipliği, IPC | En az %90 statement, %85 branch | İzin reddi, iptal, late result, retry ve cleanup senaryolarının her biri; mevcut açık branch'in nedeni yazılı. |
| Diğer yeni/ayrıştırılan TS çekirdeği | En az %80 statement, %75 branch | Başarı, geçersiz girdi ve bağımlılık hatası; yalnız render/snapshot testi yeterli değil. |
| Yeni/ayrıştırılan kritik Go çekirdeği | En az %90 statement | Go'nun standart ölçümü branch coverage değildir; hata, izin ve concurrency dalları senaryo matrisiyle ayrıca izlenir. |
| Diğer yeni/ayrıştırılan Go çekirdeği | En az %80 statement | Sınır değerleri ve hata sonucu. Saf forwarding/generated kod için gerekçeli dar istisna. |
| Native ve cihaz adaptörleri | İlk aşamada sayı dayatılmaz; ölçüm baseline'ı çıkarılır | Kaynak sahipliği, process/permission failure ve gerçek cihaz matrisi; kapsam eksikliği görünür kalır. |

Client için mevcut Vitest sürümüyle **tam eşleşen** `@vitest/coverage-v8` geliştirme bağımlılığı RF03 kapsamında eklenebilir; bu, ölçüm boşluğunu kapatan tek amaçlı araçtır. Runtime bağımlılığı değildir. `all` kaynak envanteri yalnız import edilmiş dosyaları saymamalı; test, generated/vendored dosyalar ve deklarasyon istisnaları açık olmalıdır.

Go shard coverage yüzdeleri ortalanmaz. Her shard benzersiz `coverprofile` üretir; aynı kaynak bloklarının hit bilgisi commit ve coverage modu eşleşerek birleştirilir. Birleştirme aracı zero-hit blokları atamaz, çakışan kaynak özetlerini reddeder; testleri RF03'ün parçasıdır. Mümkünse ayrı tam coverage lane'i birleştirilmiş sonucu doğrular. Şu anki `-cover` konsol çıktısı global eşik için yeterli değildir.

`implementation/coverage.json` gereksinim/kabul izleyicisidir. `npm run check:coverage` yapısal tutarlılığı, `npm run check:acceptance` strict kabulü denetler. Birim test veya build geçmesi acceptance satırını otomatik `accepted` yapmaz. Hedef modül testi geçmediyse oran ne olursa olsun PR tamamlanmış değildir.

## 6. CI çalışma sırası

| Lane | Ne zaman | Zorunlu iş |
|---|---|---|
| Hızlı PR | Her PR | UTF-8/diff kontrolü; etkilenen dilin lint/typecheck'i; değişen davranış ve regression testleri; API/IPC sözleşme kontrolü; belge-only PR'da link/ID tutarlılığı. Mevcut gerekli full kontroller kaldırılmaz. |
| Tam merge | Merge öncesi | Mevcut Go race shard'ları + eksiksiz test keşfi; client/Electron tüm testler; build; route/locale contract; yerel PostgreSQL lane; ilgili E2E; coverage raporu. Başarısız veya çalışmayan required job merge'i engeller. |
| Nightly | Ayrı zamanlanmış CI işi olarak uygulandığında | Daha uzun race/concurrency tekrarları, migration rehearsal, seçili fuzz seed+bounded fuzz, gerçek browser audio engines, performans karşılaştırmaları, bağımlılık taraması. Bu belge tek başına zamanlayıcı oluşturmaz. |
| Sürüm/istek üzerine | İlgili medya/native/deploy değişikliği ve release | Paketlenmiş desktop, temiz/eski sürüm update, Android/iOS, USB/Bluetooth, uzun çağrı, çoklu monitör/game overlay, staging readiness ve restore provası. |

Test retry, ilk hatayı gizlemez. Tekrarla geçen test `flaky` olarak raporlanır; sahibi, takip görevi, son tarih ve geçici kısıtı kaydedilir. `skip` yalnız platform yeteneği veya açık dış bağımlılık nedeniyle, gerekçe ve karşılayan alternatif lane ile kullanılabilir. PostgreSQL DSN eksikliğinden atlanan testlerin bir lane'de PASS görünmesi PostgreSQL kabulü değildir. Mevcut Electron symlink skip'i Windows yetenekli runner'da tamamlanmalıdır.

## 7. Tekrarlanabilir komutlar

Aşağıdakiler mevcut script'lerin komutlarıdır; geliştirici bağımlılıklarının kurulu olduğu varsayılır. İlk kurulumda ilgili lockfile için `npm ci` kullanılır. Komutlar ayrı çalıştırılır; uygulama çalıştırma/production yayın komutları bu listeye dahil değildir.

Repository kökü: `C:\Users\PARS\Desktop\PROJELER\HiChat\discordd`

```powershell
npm run electron:test
npm run check:coverage
npm run test:coverage
npm run check:acceptance
py -3.12 -m unittest discover -s scripts -p 'test_go_test_shard.py'
py -3.12 -m unittest discover -s scripts -p 'test_publish_hf_space.py'
git diff --check
```

Client: `C:\Users\PARS\Desktop\PROJELER\HiChat\discordd\client`

```powershell
npm test
npm run lint
npm run build
npm run test:audio
npm run test:audio:gate
npm run test:audio:wasm
node --test scripts/audio-build-csp.test.mjs
```

Coverage bağımlılığı/config'i RF03'te eklendikten sonra: `npm test -- --coverage`. `test:audio` geniş audio güvenlik ağının tamamının yerine geçmez; bu script'in kapsamı değişen medya modülleriyle birlikte güncellenir. Build başarılı olmadan `audio-build-csp` çıktısı yeni bundle kanıtı sayılamaz.

Server: `C:\Users\PARS\Desktop\PROJELER\HiChat\discordd\server`

```powershell
go test ./... -count=1 -timeout=5m -p=2
go vet ./...
go test -race ./... -count=1 -timeout=15m
go test ./... -coverprofile=coverage.out -covermode=atomic -count=1 -timeout=15m
go tool cover -func=coverage.out
```

Race ve libSQL koşuları desteklenen CGO/toolchain ortamında çalışır; Windows toolchain eksikliği test geçişi olarak raporlanmaz. PostgreSQL lane'inde güvenli yerel test yapılandırması `HICHAT_TEST_POSTGRES_DSN` ortam değişkenini sağlar; aynı repository testleri bu ortamla çalıştırılır. Değişken değeri loga veya PR açıklamasına yazılmaz. Coverage dosyası artifact'tır, kaynak commit'ine eklenmez.

E2E: `C:\Users\PARS\Desktop\PROJELER\HiChat\discordd\e2e`

```powershell
npm test
```

İlk kurulumda mevcut Playwright sürümünün Chromium bileşeni kurulur. 3030/9090 portları kontrol edilir; başka sürecin kapatılması veya geliştirici veritabanının kullanılması test kurulumunun parçası değildir. `bots/welcome-bot` bağımsız Go modülünde ayrıca `go test ./...` çalıştırılır. Native/mobile build komutları RF21/RF22'de runner ve cihaz envanteriyle doğrulanıp belgelenir; denenmemiş komutlar hazır kabul edilmez.

## 8. Performans, güvenlik ve release kabulü

RF29 ölçümleri aynı commit, CPU/RAM limiti, veri seti, warm-up ve yük profiliyle yapılır. API için p50/p95/p99, hata oranı, query sayısı, DB wait/pool; WS için mesaj kuyruğu/drop ve reconnect süresi; client için bundle transferi, long task, render sayısı ve heap; medya için capture-to-publish, kesinti, context/worker/track sayısı raporlanır. İlk kontrollü profiller 10/50/100 eşzamanlı sentetik kullanıcı ve artan veri boyutudur; bunlar üretim kapasitesi taahhüdü değildir. Üç tekrarlı karşılaştırmada %10'dan büyük p95 veya kaynak gerilemesi incelenir; gürültülü ölçüm tek başına bloklayıcı karar olmaz. Optimizasyon PR'ı öncesinde hedeflenen metrik ve kabul eşiği o görevde dondurulur.

Medya release kabulünde en az 20 katıl/ayrıl ve aygıt değişimi döngüsü ile 60 dakikalık çağrı profili kullanılır; mute/deafen, reconnect, output kaybı ve izin iptali uygulanır. Her döngü sonunda sahipli track/context/worker/listener sayısı başlangıca dönmelidir. Fiziksel cihaz ve mobil sonuçlar yoksa durum `doğrulanmadı` kalır.

Güvenlik odaklı testler auth/IDOR, role/permission boundary, path/MIME, SSRF/redirect policy, webhook signature/replay, session/IPC origin, secrets redaction ve crypto replay/owner sınırlarına odaklanır. Bu çalışma tam güvenlik taraması veya sızma testi değildir. Mevcut `SECURE-CODING.md`, `SECURITY-SCOPE.yml`, `SECURITY-EXCEPTIONS.yml` ve CI kontrolleri esas alınır; bulguların ciddiyeti ancak somut kaynak→işlem→yan etki kanıtıyla yükseltilir.

RF30 kapanış kaydı her test için komut, cwd, commit/diff özeti, toolchain, tarih, exit code, passed/failed/skipped sayısı ve artifact konumunu taşır. Her skip/blocked kabulün sahibi ve takip görevi vardır. Yerel test, production build, CI, paketlenmiş runtime, dağıtım readiness ve kullanıcı/cihaz kabulü ayrı sütunlardır. Refactoring görevinin kapanışı, değişen kapsamın kabul maddeleriyle belirlenir; küresel 248 maddenin tamamını sıfırlamak refactoring'in örtük ön koşulu değildir. Küresel bekleyen maddeler kanıt olmadan kapatılmaz; kapsam dışı bırakma gerekçesi açıkça kaydedilir.
