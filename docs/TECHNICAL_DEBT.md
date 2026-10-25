# Teknik borç envanteri

26 Ekim uygulama kanıtı: ilk grup yerelde doğrulandı. Güncel sonuçlar ve kalan kabul sınırları [görev izleme tablosunda](REFACTORING_TASKS.md) ve [manifestli raporda](../implementation/verification/refactoring-implementation-2026-10-26.json) izlenir. Bu belge tüm görevlerin tamamlandığını göstermez.

> 26 Ekim uygulaması: encoding engeli güncel kaynakta giderilmişti ve yeniden doğrulandı. Kaynak/CI coverage, PG fixture, auth cleanup, output routing, picker/subscription ve publish manifest işleri uygulanıyor. İlk bulgu tabloları 25 Ekim tarihsel durumudur; güncel kapanış yalnız REFACTORING_TASKS.md uygulama tablosu ve manifestli kanıtlarla belirlenir.

Tarih: 25 Ekim 2026. Bu envanter, `313acf8e` HEAD'i üzerinde bulunan **değişen yerel çalışma ağacını** inceler. İnceleme sırasında uygulama dosyalarında başka çalışmaların değişiklikleri vardı; sonuçlar tek, değişmez bir commit'in sertifikası değildir. Bu çalışma uygulama kodunu düzeltmez. Görevlerin bağımlılıkları, eforu ve tam kabul ölçütleri [REFACTORING_TASKS.md](REFACTORING_TASKS.md) içinde `RF01`–`RF30` kimlikleriyle tutulur.

## Kanıt ve öncelik politikası

- **Statik doğrulandı:** belirtilen kod veya yapılandırma davranışı kaynakta görüldü. Üretimde etkisinin gerçekleştiği anlamına gelmez.
- **Yerel doğrulandı:** bu çalışma sırasında test/derleme çalıştırıldı. Donanım, üretim, uzaktaki veritabanı veya yayın kabulü yerine geçmez.
- **Doğrulanmadı:** ilgili ortam, ölçüm veya senaryo çalıştırılmadı. Testin varlığı testin geçtiği anlamına gelmez.
- **P0:** yeniden üretilebilen kritik güvenlik açığı, veri kaybı veya kritik hizmet hatası. Bu inceleme kapsamında yeni bir P0 doğrulanmadı. Büyük dosya veya eksik test tek başına P0 değildir.
- **P1:** mevcut derleme engeli, kritik davranışın doğrulama boşluğu veya yüksek etkili bakım riski. **P2:** kontrollü refactoring ve sürdürülebilirlik işi. **P3:** davranış değiştirmeyen düşük etkili temizlik.

Kaynak referanslarındaki satırlar inceleme anını gösterir; paralel değişikliklerden sonra yeniden kontrol edilmelidir. Bir dosyanın `sqlite_` adını taşıması yalnızca SQLite üzerinde çalıştığı anlamına gelmez; PostgreSQL uyarlaması aynı repository yollarını da çalıştırır.

## Başlangıç durumu

| Alan | Bu çalışmada görülen durum | Sınır / gerekli takip |
|---|---|---|
| Go | `go test ./... -count=1 -timeout=5m -p=2` geçti | Yerel çalıştırmada `-race` yoktu; PostgreSQL ortam değişkenleri tanımlı değildi |
| Electron | 217 test geçti, 1 test atlandı | Gerçek pencere, güncelleme kurulumu, oyun/DPI/donanım kabulü değil |
| E2E | Çalıştırılan 5 test geçti | Projenin bütün kullanıcı akışlarının kapsandığını göstermez |
| Client lint | `lint -- --quiet` geçti | Uyarıları bastıran çalışma; kaynak kodun derlenebilir olduğunu göstermez |
| Client production build | Başarısız: iki TSX dosyasında geçersiz UTF-8 kaynak baytları | `RF01` tamamlanmadan refactoring için yeşil başlangıç yok |
| Client toplu testleri | 23:27–23:32 çalışması: 4.106 geçti, 8 başarısız; 421 dosya geçti, 2 başarısız | İki UserBar mock'unda eksik `useTracks`. Eşzamanlı `da506e3b` commit'i bunu düzeltti; 23:33 hedefli tekrarında 2 dosya/9 test geçti. Son commit üzerinde tam suite yeniden çalıştırılmadı. |
| Coverage | CI'da bazı Go komutlarında `-cover` var; birleşik coverage profili ve risk temelli eşikler yok | Test sayısı, statement/branch coverage yüzdesi veya kabul kapsamı değildir |
| Kabul defteri | 248 açık kayıt: 198 `implemented_unverified`, 15 `missing`, 35 `existing`; ayrıca 2 accepted, 11 excluded | `implementation/coverage.json` ürün kabul defteridir; kaynak kod coverage ölçümü değildir |
| Fiziksel / uzak ortam | PostgreSQL, gerçek cihaz, uzun ses görüşmesi, mobil yaşam döngüsü ve canlı yayın kabulü çalıştırılmadı | Açık kabul kapıları olarak korunur |

Kapanış backend envanteri (23:33, Europe/Istanbul): 594 üretim Go dosyası, 452 `_test.go`, 144 SQLite ve 45 PostgreSQL migration dosyası. Başlangıç HEAD'i `313acf8e`, kapanışta gözlenen HEAD `da506e3b` idi. Sayımlar mevcut izlenmeyen diagnostics migration'larını da içerir. Dosya sayıları satır satır eksiksiz güvenlik denetimi iddiası değildir; bütün ana yüzeyler envantere alınmış, riskli yollar ayrıntılı örneklenmiştir.

## Derleme, kanıt ve teslimat borçları

| Borç / görev | Öncelik | Kanıt | Etki ve ele alınacak iş | Kapanış kanıtı |
|---|---|---|---|---|
| TD01 / RF01 | P1 | `client/src/components/voice/VoiceProvider.tsx:262`, `client/src/components/dm/GroupDMCall.tsx:60`; 2.653 metin dosyalık UTF-8 taramasında bu iki dosya başarısız, build de başarısız | Kaynağın kodlaması derlemeyi engelliyor. Yalnızca bozuk baytları hedefleyen onarım ve kodlama kontrolü; genel formatlama yapılmaz | UTF-8 taraması, ilgili testler, TypeScript ve production build geçer; içerik/davranış farkı incelenir |
| TD02 / RF02 | P1 | `implementation/coverage.json`; yerel çalışma ağacında eşzamanlı logging ve ses ayarı değişiklikleri | Kanıt farklı çalışma ağacı durumlarına ait olabilir. Commit, dosya manifesti/hash, komut, ortam, süre, sonuç ve skip nedeni birlikte kaydedilmeli | Yeniden üretilebilir baseline; mevcut başarısızlıklar yeni PR'a mal edilmez; kabul kayıtları gerçek kanıta bağlanır |
| TD03 / RF03 | P1 | `client/vitest.config.ts:5`; `.github/workflows/server-ci.yml:59`, `:116` | Go yarış testleri ve shard altyapısı mevcut, ancak ortak coverage hedefi/artifact birleşimi yok. Var olan CI korunarak risk temelli rapor eklenmeli | Go shard profilleri birleştirilir; client/Electron coverage artifact'ları yayımlanır; kritik değişen kod için açık eşikler ve istisna gerekçesi vardır |
| TD04 / RF23 | P1 | `scripts/publish-hf-space.py:48–58`, `:63` | İçerik hash'leri remote farkını hesaplıyor; fakat incelenen planın hash'i eklenen dosyaların **yollarını**, içeriklerini değil içeriyor. Aynı yollar altında değişen bytes aynı plan kimliğine sahip olabilir | İnceleme manifesti her dosyanın içerik hash'ine ve remote parent'a bağlanır; uygulamadan önce yeniden doğrulanır; arada içerik değişimi reddedilir |
| TD05 / RF30 | P1 | Go, Electron ve E2E yerel sonuçları ile fiziksel/üretim kabul boşlukları | Yerel test/build ile yayın tamamlanması karışabilir. Değişiklik kapsamına göre runtime kanıtı ayrı tutulmalı | Belge, test, CI ve gerekiyorsa runtime kanıtı tamamlanmadan accepted işaretlenmez; geri alma adımı denenir |

`RF23` için risk, doğrulanmış kötü niyetli dağıtım veya yetki atlatma iddiası değildir. Kaynakta görülen inceleme–uygulama bütünlüğü boşluğudur. Script'in mevcut remote içerik karşılaştırması korunmalıdır.

## Backend ve veri katmanı

| Borç / görev | Öncelik | Kanıt | Etki ve ele alınacak iş | Kapanış kanıtı |
|---|---|---|---|---|
| TD06 / RF04 | P1 | `server/repository/testdb_test.go:52`; `postgres_contract_test.go:11`; `sqlite_group_admission_test.go:123`; `sqlite_stream_start_notification_test.go:257`; `.github/workflows/server-ci.yml:59–70` | PostgreSQL fixture ve eşzamanlılık testleri var; gerekli DSN yoksa atlanıyorlar. İncelenen workflow'larda zorunlu PostgreSQL servis/lane tanımlı değil | SQLite yanında izole PostgreSQL repository/migration lane zorunlu; PostgreSQL'e özgü testlerin bu lane'de atlanması hata |
| TD07 / RF05 | P1 | `server/database/postgres_dialect.go:264–306`; `postgres_dialect_test.go:5`, `:15` | SQL semantic dönüşümleri regex/string replacement ve tabloya özgü upsert haritasında birleşiyor. İki doğrudan test bu geniş etki alanını açıklamıyor | Placeholder, literal/comment, bool/time, upsert, prepared query ve transaction davranış matrisi; iki veritabanında sonuç eşitliği |
| TD08 / RF06 | P1 | `server/database/database.go:244–265` | Migration ledger boş ve `users` tablosu varsa bütün migration'lar uygulanmış sayılıyor; gerçek şema sürümü kanıtlanmıyor | Bilinen legacy checkpoint'leri açıkça tanıyan adoption; bilinmeyen/eksik şema için anlaşılır durma; yarım migration, tekrar çalıştırma ve restore fixture'ları |
| TD09 / RF07 | P1 | `server/services/auth_password.go:138`; `auth_password_test.go:102`; `server/handlers/auth_cookie_test.go:108`; `server/testutil/mocks_auth.go:19`, `:64` | Kullanıcı adı/e-posta recovery sözleşmesi ve handler uçları için kapsama tamamlanmalı. Bazı mock'lar ayarlanmamış çağrıda başarılı veya `(nil,nil)` dönüyor | Bilinmeyen kullanıcı, eski e-postasız hesap, cooldown, mail hatası, tek kullanımlık token ve session revoke senaryoları; dokunulan testlerde beklenmeyen çağrıyı reddeden fake |
| TD10 / RF08 | P1 | `server/services/auth_service.go:326–345`; `server/database/database.go:183–191` | Auth constructor iptal edilemeyen sweep goroutine'i başlatıyor. SQLite/libSQL açılışında ping/migration hatası `conn.Close` olmadan dönüyor | Explicit start/stop/context; idempotent cleanup; tekrarlanan kurulum/kapatma ve DB hata enjeksiyonunda kaynaklar serbest kalır |
| TD11 / RF09 | P2 | `server/services/member_service.go:135–136`; `group_dm_service.go:135–146`, `:222–239`, `:466–468` | Üye listesi bütün platform kullanıcılarını çekip filtreliyor. Grup/member/read-state/mesaj yazarı hydration'ında tekrarlı sorgular var | Server-scoped ve bulk sorgular; query sayısı dönen kişi/mesaj sayısıyla tek tek büyümez; sıralama, yetki ve hata davranışı korunur |
| TD12 / RF10 | P1 | `server/services/music_bot_service.go:103`, `:195`, `:267`; `music_bot_pipeline.go` | Durable kuyruk, lifecycle, yayın, subprocess, timer ve test seam'leri aynı nesnede yoğunlaşıyor. Dosya büyüklüğü tek başına hata değil; sahiplik değişikliği yarış riski yaratıyor | Küçük PR'larla kuyruk geçişleri, persistence ve playback adaptörleri ayrılır; mevcut lock sırası, privacy fence ve paused restore regresyonları geçer |
| TD13 / RF11 | P2 | `server/init_services.go:179`, `:215`, `:329–341`, `:384–406` | Runtime interface assertion ile bazı yetenekler sessizce opsiyonel bağlanıyor; wiring doğruluğu çok sayıda setter'a bağlı | Zorunlu yeteneklere dar named interface/constructor bağımlılığı; gerçek döngüler için açık ikinci wiring fazı; runtime bootstrap testleri |
| TD14 / RF24 | P2 | `server/pkg/logx/`, `server/middleware/request_logger.go`, `server/services/app_log_service.go`, `server/database/migrations/142_app_log_diagnostics.sql`, `server/database/postgres_migrations/044_app_log_diagnostics.sql` | Logging/diagnostics alanında kapsamlı mevcut, kısmen izlenmeyen değişiklikler var. Bunları ikinci kez tasarlamak veya doğrulanmış teslimat saymak yanlış olur | Önce mevcut diff'in sahipliği ve kanıtı; sonra tek olay/sorumlu kayıt noktası, redaction, queue saturation, flush ve iki migration hattı regresyonları |

`RF09` fan-out'u statik olarak doğrulandı; üretim p95 gecikmesine katkısı henüz ölçülmedi. Mevcut bulk role, nickname ve timeout sorguları korunacak, eski N+1 çözümü geri alınmayacaktır. `RF05` SQL injection bulgusu değildir. `RF06` şema bütünlüğü riski olup gerçek müşteri veri kaybı gösterilmemiştir.

Auth için tarihsel notları güncel gerçek gibi taşımamak gerekir: `server/models/user_test.go:5` artık e-postayı zorunlu test eder; `server/handlers/auth.go:754–765` cooldown bilgisini genel HTTP cevabından ayırır; `server/init_services.go:219–223` durable auth session bağımlılıklarını bağlar. Eski yorum veya eski test raporu bugünün açık güvenlik bulgusu olarak yazılmamalıdır.

## Web istemcisi, ses ve şifreleme

| Borç / görev | Öncelik | Kanıt | Etki ve ele alınacak iş | Kapanış kanıtı |
|---|---|---|---|---|
| TD15 / RF12 | P1 | `client/src/hooks/useScreenShareToggle.ts:286` ve yaklaşık 780 satırlık hook; `:249` typed adapter dışındaki cast örneği | Yakalama, publish, native/system audio, hata/cleanup ve ayarlar yoğunlaşmış; doğrudan hook test dosyası bulunmadı. Bu, hiçbir dolaylı test olmadığı anlamına gelmez | Session controller ve platform adaptörleri; deny/cancel/unmount/reconnect/track-ended matrisi; mic test–gerçek çağrı ayar eşitliği |
| TD16 / RF13 | P2 | `client/src/stores/preferencesStore.ts:84–100`, `:296–300`; `stores/slices/voiceSettingsSlice.ts:10`; `components/settings/SettingsModal.tsx` | Preference orchestrator başka store'ları dinamik import ediyor; voice settings tekrar preferences store'a bağlı. Senkronizasyon, validation, cihaz ayarı ve UI uygulama sahipliği karışıyor | Saf codec/merge kuralları, hesap kapsamlı sync coordinator ve explicit apply adapter; account epoch, pending edits, cihaz alanı ayrımı korunur |
| TD17 / RF14 | P2 | `client/src/webrtc/`, `client/src/hooks/ws/`, `server/ws/client.go:58–64` | P2P/WS/media bağlantılarında farklı lifecycle sahipleri var; ortak cleanup kuralları bütün yollar için belge ve senaryo seviyesinde doğrulanmalı | Bağlantı sahibi tek; cancel/close idempotent; geç promise sonucu başka hesaba/çağrıya uygulanmaz; restart/reconnect ve bounded queue testleri |
| TD18 / RF15 | P2 | `client/src/stores/dmStore.ts:296`, `:366`, `:403`, `:480`; `groupDMStore.ts:141–152`, `:241–312`; `messageStore.ts` | Mesaj history merge, dedup, older/newer/around ve canlı olay uzlaştırma mantıkları tekrarlanıyor; davranış farkları birleştirmede kaybolabilir | Yalnızca saf ortak history operasyonlarını çıkar; kanal/DM/grup adapters ayrı kalsın; stale fetch, edit/delete, jump/live yarışları aynı sonucu versin |
| TD19 / RF16 | P2 | `client/src/crypto/keyBackup.ts:325`, `:472–492`, `:552`; `crypto/keyStorage.ts` | JSON decode ile TypeScript tipi runtime doğrulamanın yerini alamaz; backup/restore çok sayıda persistence ve rollback adımı yürütüyor | Unknown girişten dar doğrulama tipine geçiş, hesap generation guard ve hata/rollback sözleşmesi. Algoritma/KDF/wire version değişmez |
| TD20 / RF17 | P2 | `client/src/crypto/keyStorage.ts:905–907`; `keyBackup.ts:373`, `:472` | Bütün cache'i okuyan yollar veri büyüdükçe bellek/I/O yükü yaratabilir; mevcut channel cursor/index yolları da var (`keyStorage.ts:889`, `:924`) | Önce büyüklük ve kullanım ölç; normal sorgularda indeksli bounded okuma, tam yedek için gerekiyorsa batch traversal; no-data-loss testleri |
| TD21 / RF25 | P2 | `client/src/i18n/locales/`, `client/src/components/settings/`, UI/voice/group-call test yüzeyleri | Yerelleştirme ve erişilebilirlik bütünlüğü çoklu yüzey değişikliklerinde ayrıca korunmalı; tüm ekranların erişilebilirlik kabulü yapılmadı | Key parity, eksik çeviri, klavye/focus/modal, reduced-motion ve erişilebilir ad senaryoları; gerçek ekran kontrolü gerekenler ayrı |

E2EE için “JSON.parse kullanılıyor” tek başına bir güvenlik açığı kanıtı değildir. Mevcut doğrulayıcılar, account scope kontrolleri, replay-window normalizasyonu ve recovery davranışı yeni tasarımın başlangıcıdır. `RF16` bunları görünür, tipli ve fault-injection ile doğrulanabilir sınırlara taşır; kriptografi yeniden tasarlanmaz.

## Masaüstü, native ve mobil

| Borç / görev | Öncelik | Kanıt | Etki ve ele alınacak iş | Kapanış kanıtı |
|---|---|---|---|---|
| TD22 / RF18 | P1 | `electron/screen-picker.ts:180` | Global `ipcMain.once("screen-picker-result")` üzerinde bekleyen seçimde açık timeout/cancel/destroy sahibi yok; refresh listener `finally` ile ancak bekleme çözülürse temizleniyor | Tek aktif capture isteği, doğru sender bağlama, cancel/destroy/timeout sonunda tek callback ve bütün listener temizliği; eşzamanlı istek testi |
| TD23 / RF19 | P1 | `electron/preload.ts:458` ve update event abonelikleri; `auto-updater.ts:65`, `:116–117` | Update abonelikleri disposer döndürmüyor; updater timer/event lifecycle doğrudan testlerle korunmuyor. Dosya başındaki “no-op” açıklaması mevcut implementasyonla uyuşmuyor | Sahibi belli subscriber/dispose sözleşmesi; çift setup, destroy/quit, timeout/error/download/install testleri; açıklama güncellenir |
| TD24 / RF20 | P2 | `electron/ipc-handlers.ts:107–543`; `electron/voice-overlay.ts:12`, `:77`, `:176`, `:530` | Büyük registrar farklı yetki, lifecycle ve UI sahipliklerini bir araya getiriyor. Overlay çoklu window/timer/pending intent taşıyor | Alan bazlı registrar ve explicit dispose; sender/frame/session guards korunur; overlay pencere/navigation/account reset testleri |
| TD25 / RF21 | P1 | `native/audio-capture.cpp:90`, `:224`, `:352`, `:392`; `native/game-window.cpp:86`, `:160` | WASAPI/COM/event/process handle davranışı JS mock testlerinden doğrulanamaz; gerçek Windows kabulü açık | Saf parse/protocol testleri + Windows executable smoke; izin reddi, process exit, pipe close, stop/restart, kaynak temizliği ve doğru uygulama sesi |
| TD26 / RF22 | P1 | `client/android/app/src/androidTest/java/com/getcapacitor/myapp/ExampleInstrumentedTest.java`; `client/android/app/src/main/java/net/mqvi/app/ScreenSharePlugin.kt`, `VoiceCallService.java`; `client/ios/` | Android örnek testleri uygulama davranışının güvencesi değil; mobil lifecycle/permission/audio acceptance tamamlanmış sayılmaz | Uygulamaya özgü Android/iOS build/smoke planı; background/foreground, izin iptali, interruption, route switch, ekran paylaşımı durdurma; cihaz kanıtı |

Masaüstü ve native görevlerde IPC kanal adları/payload'ları, executable pipe protokolü ve renderer erişim sınırları korunur. Mevcut Electron unit testlerinin geçmesi fiziksel oyun/ekran/donanım uyumluluğunu kanıtlamaz. Güncelleyicinin gerçek paket indirme/kurulum kabulü yerel mock testinden ayrı kapıdır.

## Ortak kalite ve henüz ölçülmeyen alanlar

| Borç / görev | Öncelik | Kanıt | Yapılacak iş | Kapanış kanıtı |
|---|---|---|---|---|
| TD27 / RF26 | P2 / P3 | `client/eslint.config.js`, `client/vitest.config.ts`, `.golangci.yml`, root/client manifest'leri; uzun ve yoğun satırlı store/composition alanları | Mevcut lint/format araçlarını standartlaştır; yalnız dokunulan modüllerde okunabilirlik ve narrow type; kullanılmayan bağımlılığı import/build/OS yollarıyla doğrula | Yeni lint hatası yok; hedefli format diff'i; kaldırılan dependency için consumer/platform kanıtı; otomatik toplu upgrade yok |
| TD28 / RF27 | P2 | `bots/welcome-bot/main.go:48–75`, ayrı `go.mod` | Bot örneği ana server modülü dışında; URL/config/event/HTTP hata davranışı ve reconnect sahibi ayrı test gerektiriyor | Hatalı config, event filtering/server scope, malformed payload, HTTP failure ve reconnect/stop senaryoları; ayrı modül CI kontrolü |
| TD29 / RF28 | P1 | `e2e/`; bu çalışmada 5 E2E geçti | Geçen dar E2E seti auth/preferences/chat/voice/desktop bütünlüğünün tamamını ispatlamaz | Öncelikli kullanıcı yolculukları ve çapraz hesap/permission regresyonları; sahte medya ile otomasyon, fiziksel medya için ayrı kabul |
| TD30 / RF29 | P2 | `loadtest/`, `server/runtime_telemetry.go`, query fan-out kaynakları | Üretim benzeri yük, sorgu planı, p95/p99, CPU/heap/GC, bağlantı havuzu ve uzun çağrı ölçümleri bu çalışmada yapılmadı | Sabit veri/yük profiliyle önce/sonra karşılaştırması; query count, goroutine, process, AudioContext/Worker kaynak sayısı; ölçümsüz cache/index değişikliği yok |

## Korunacak kazanımlar ve kapanış kuralı

Repository fixture'ları gerçek migration'ları çalıştırıyor; PostgreSQL fixture yalnız loopback kabul ediyor. Route golden ve permission-declaration testleri, setter wiring testleri, bounded WebSocket send queue, music extraction/queue limitleri ve libSQL prepare-only retry sınırı korunacak. Başarılı mevcut kodun sırf biçim için yeniden yazılması teknik borç azaltımı sayılmaz.

Her borç kapanırken ilgili RF görevi, commit/diff, test komutu, sonuç ve kalan ortam gereksinimi birbirine bağlanır. Test atlama, altyapı yokluğu veya başarısız baseline açıkça yazılır. Performans iddiası ölçümle; güvenlik iddiası ulaşılabilir yol ve negatif testle desteklenir. İstisna kabulü kapsam, gerekçe ve yeniden değerlendirme koşulu içerir; `excluded` bir görevin implementasyonu tamamlandı anlamına gelmez.

Bu envanterin tam görev matrisi [REFACTORING_TASKS.md](REFACTORING_TASKS.md), mimari kararları [ARCHITECTURE_IMPROVEMENTS.md](ARCHITECTURE_IMPROVEMENTS.md), test ayrıntıları [TEST_STRATEGY.md](TEST_STRATEGY.md) içindedir.
