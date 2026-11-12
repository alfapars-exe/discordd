# Refactoring görevleri ve kabul ölçütleri

Tarih: 25 Ekim 2026. İlk inceleme revizyonu `313acf8e`; çalışma sırasında başka bir iş akışı HEAD'i `da506e3b` revizyonuna ilerletti. Buna ek olarak inceleme anındaki değiştirilmiş ve izlenmeyen çalışma ağacı dosyaları değerlendirilmiştir. Depo kökü: `C:\Users\PARS\Desktop\PROJELER\HiChat\discordd`. Kod referansları bu köke göredir; satırlar bu incelemenin anlık görüntüsüne aittir. Farklı revizyonların test sonuçları birbirine eklenerek global başarı çıkarılmaz.

Bu belge uygulama önerisidir. Görev kartının varlığı, kodun değiştirildiği veya kabul edildiği anlamına gelmez. İlk teslimat 25 Ekim’de plan belgeleriydi. 26 Ekim’de kullanıcı uygulamayı başlattı; güncel ilerleme aşağıdaki tabloda izlenir. Görev kartlarındaki Problem alanları ilk incelemenin tarihsel kanıtıdır. Mevcut değişiklikler korunur; uygulama aşamasında her PR yalnız seçilen görevin dosyalarını kapsar.

## PostgreSQL parametre bağlama ve CI günlükleri · 12 Kasım 2026

| Revizyon | Doğrulanan davranış | Kanıt |
|---|---|---|
| `e8cdc669` | PostgreSQL 18 üzerinde Go sürücüsü, kaçışlı metindeki ve dolar işaretleriyle sınırlanmış metindeki soru işaretlerini korudu. Aynı sorgulardaki bağlı değerler doğru sütunlara döndü. | Yerel PostgreSQL bağlantısıyla `go test -count=1 -v ./database -run 'DollarStrings\|EscapeString'` koşusunda iki dönüştürücü testi ve iki gerçek sorgu geçti. [PR #221](https://github.com/alfapars-exe/discordd/pull/221) |
| `60d93449` | Sentetik kullanıcı bilgileri içeren alternatif bir PostgreSQL bağlantı adresi hem paket hem servis testi çıktısında maskelendi. | PR dalında `python -m unittest discover -s scripts -p test_run_postgres_tests.py` ile yedi test geçti. [PR #247](https://github.com/alfapars-exe/discordd/pull/247) |

## Birleşik istemci doğrulaması — 12 Kasım 2026

`23fc80b8` revizyonunda tam Vitest kapsam koşusunda 461 dosyada 4.634 test geçti, 1 test atlandı. Satır kapsamı genel olarak %66,38, dal kapsamı %63,27 oldu.

| Modül | Satır | Dal |
|---|---:|---:|
| Kanal arama paneli | %89,84 | %80,00 |
| DM arama paneli | %64,35 | %41,81 |
| `messageStore.ts` | %88,00 | %68,71 |
| `channelMessageHistory.ts` | %100,00 | %90,27 |

Sonraki `b9d0a8da` revizyonunda kanal ve DM panelleri, gezinme isteği sürerken WebSocket üzerinden silinen sonucu sayaçtan bir kez düşürüyor. İki panelin PR dalında toplam 14 testi geçti. Birleşik revizyonda `npm run build` ile TypeScript ve Vite derlemesi geçti. Vite, `AppLayout` parçası için 976,08 kB (gzip ile 272,25 kB) ve 500 kB sınır uyarısı bildirdi.

Klavye kısayolu yardımı ve lo-fi oynatıcı isteğe bağlı yüklendiğinde (`725c7811`) aynı üretim derlemesindeki `AppLayout` parçası 964,98 kB (gzip ile 268,70 kB) oldu. İlgili üç test dosyasında 49 test geçti. Bu ölçüm dosya boyutunu kapsar.

| Birleşik revizyon | Yerel kabul koşusu | Sonuç |
|---|---|---|
| `25abb127` | Chromium, gerçek Go API, mTLS PostgreSQL 18.6 ve Vite geliştirme sunucusu | Kurulum dahil 11/11 test 1,5 dakikada geçti. İki oturumla üst kanal izni kaldırılınca alt konuşmanın HTTP geçmişi ve WebSocket teslimi engellendi. |
| `67f02e5f` | WebKit, üretim istemci paketi, gerçek Go API ve mTLS PostgreSQL 18.6 | Giriş ve parola kurtarma formlarının açılması ve sayfada JavaScript hatası oluşmaması doğrulandı. Derleme dahil 40,8 saniye. |

Bu tarayıcı koşularında fiziksel ses veya kamera aygıtı kullanılmadı.

Sonraki tam istemci koşusu `303165c4` revizyonunda 461 dosyada 4.636 geçen ve 1 atlanan test verdi. İfade kapsamı %65,59, dal kapsamı %63,31, fonksiyon kapsamı %59,94 ve satır kapsamı %66,42 oldu. Kanal arama panelinde satır/dal kapsamı %89,84/%81,11, DM arama panelinde %82,17/%72,72 olarak ölçüldü. Bu revizyon arama sayacı yarış testlerini içerir. Sonraki DM zaman sıralaması değişikliği ayrı dalda 235 hedefli testle sınandı.

Üretim WebKit smoke testi ve Chromium uygulama paketi, PR #238'in `2cf916e4` revizyonunda Linux CI üzerinde de geçti. [Playwright E2E koşusu](https://github.com/alfapars-exe/discordd/actions/runs/43276168619/job/131385259090)

`728c38ab` istemci kaynaklarıyla tam Vitest koşusunda 461 dosyada 4.651 test geçti, 1 test atlandı. Kapsam satırlarda %66,48, dallarda %63,35, fonksiyonlarda %59,95 ve ifadelerde %65,63 oldu.

| Modül | Satır | Dal |
|---|---:|---:|
| `VoiceSettings.tsx` | %87,59 | %84,26 |
| `useEncryptedRoomAdmission.ts` | %92,81 | %86,36 |
| `messageStore.ts` | %88,00 | %68,71 |
| `channelMessageHistory.ts` | %100,00 | %91,93 |

## Kararlı sürümde rol yetkileri ve mesaj geçmişi — 12 Kasım 2026

Başlangıç revizyonu `bb32bbba`. Bu tur Go/PostgreSQL sunucusunu ve React istemcisini kapsar. İzin denetimlerinin sahibi sunucudur. İstemci görünür listeyi sunucunun yetkili REST sayfası ve istek sırasında alınan WebSocket olaylarıyla günceller.

| Bileşen | Başlangıçta gözlenen sorun | Değişiklik ve kabul senaryosu |
|---|---|---|
| Kanal izinleri ve mesaj dağıtımı | Üst kanal izni kaldırıldıktan sonra alt konuşmayı önceden açmış üye okumaya ve dağıtım alıcıları arasına girmeye devam edebiliyordu. | İzin önbelleği kararın alındığı kanalı saklar. İlgili üst kanal değiştiğinde tekli ve toplu girişler temizlenir. İki oturumla üyenin HTTP 403 alması, özel WebSocket mesajının yalnız yetkili oturuma ulaşması ve üyenin açık kanaldaki sonraki mesajı alması sınanır. |
| Rol PATCH | Eşzamanlı ad ve izin düzenlemesinde son yazan istek diğer alanı eski değerine döndürebiliyordu. | Sunucu yetki kilidi altında güncel aktör ve hiyerarşi denetlenir. Sorgu yalnız iletilen alanları değiştirir. PostgreSQL testleri iki yazım sırasındaki son satırı, servis yanıtını ve olay içeriğini denetler. |
| Üyenin rollerini değiştirme | Üye olmayan hesaba atama, geçersiz kısmi yazma ve yinelenen audit kaydı gerçek PostgreSQL üzerinde tekrarlandı. | Üyelik, hiyerarşi, rol farkı ve yanıt aynı transaction içinde okunur. Atama ve kaldırma birlikte tamamlanır. Önbellek, audit ve WebSocket yan etkileri commit sonrasında gerçekleşir. |
| Kanal geçmişi | Yeniden bağlantıda sunucu 54–103. mesajları döndürdüğünde eski pencere sona ekleniyor ve 50. mesaj okundu işaretleniyordu. Eski mesajlar görüntülenirken gelen düzenleme ve tepkiler de kaybolabiliyordu. | Sayfalar sunucunun `(created_at, id)` sırasını izler. Mesaj kimliğine göre tutulan değişiklikler geç REST yanıtlarıyla birleştirilir. Testler okundu imlecini, sayfalama sınırlarını, silmeyi, reaksiyonu ve oturum/izin kaybını denetler. |
| PostgreSQL yükseltme testi | 049 öncesi şemayı hazırlayan test, başka bir paketin kurulumu sırasında eklenti oluştururken `23505` verdi. | Yükseltme testi eski migration listesini başlangıçla aynı kilitli transaction içinde uygular. Dolu şemayı yükseltme ve ikinci kez çalıştırma kontrolleri korunur. |

**Eşzamanlılık.** Rol işlemi, ACL kilidini bekledikten sonra yetkiyi PostgreSQL `READ COMMITTED` ile yeniden okur. Sıralama veya silme işlemi gereken satırı zaten kilitlediyse transaction geri alınır. Çakışan satır serbest kalınca yetki yeniden denetlenir. Testlerde iki yazarın da tamamlanması, iptal edilen isteğin kilidi bırakması ve commit hatasında audit/olay üretilmemesi doğrulandı. Değişiklik yapmayan üye rolü isteğinde iki düzenleyici de PATCH yanıtındaki rolleri kullanır. Daha yeni WebSocket veya oturum bilgisi bu yanıtla ezilmez.

**İstemci ölçümü.** Node 26.13.0 üzerinde aynı Vitest senaryosu, tek kanal, geçmiş penceresi açık, bir ısınma ve dokuz tekrar kullanıldı. Aşağıdaki medyanlar `handleMessageCreate` döngüsünü ölçer. Birleştirilen listenin bütün kimlikleri süre ölçümü bittikten sonra her tekrarda doğrulandı. Genişletilmiş kabul koşusunda üç yükte toplam 30 kez sıra, son içerik, düzenleme, tepki ve silme denetlendi. İleri sayfalamada okundu isteği gönderilmediği, yeniden bağlantıda ise gerçek son mesaj kimliğiyle tek istek gönderildiği görüldü. Ters sırada yinelenen düzenleme için ayrı iki store testi, hem geçmişte hem de son sayfa yüklenirken en yeni `edited_at` değerinin korunduğunu doğrular.

| Benzersiz olay | Önce | Sonra |
|---:|---:|---:|
| 1.000 | 4,46 ms | 0,15 ms |
| 5.000 | 104,91 ms | 0,73 ms |
| 10.000 | 367,99 ms | 1,63 ms |

Ölçümü yinelemek için `client` dizininde `HICHAT_BENCH_CHANNEL_HISTORY=1` ortam değişkeniyle `npx vitest run src/stores/messageStore.test.ts -t "measures detached create processing and checks the complete merged window"` çalıştırılır. İlk keşif ölçümü farklı bir çalıştırıcı kullanıyordu. Tablodaki her iki sütun aynı testten alındı. Süreler ağ, React çizimi ve medya gecikmesini kapsamaz. Geçmiş penceresi açık kaldığı sürece tampon değişen her benzersiz kimlik için bir kayıt tutar. Son sayfaya ulaşıldığında, pencere bırakıldığında, yetki kaldırıldığında veya oturum değiştiğinde ilgili kayıtlar bırakılır. Uzun süre açık pencerelerde bellek için sabit bir üst sınır yoktur.

### Birleşik doğrulama

| Kontrol | Yerel sonuç |
|---|---|
| Go yarış denetimi ve kapsamı | Linux, Go 1.26.10 ve GCC ile CI’daki 17 parçanın tümü geçti. Alt testler dahil 3.964 geçti, 49 koşullu test atlandı. Aynı sunucu kaynağına bağlı profiller `scripts/merge-go-coverage.py --expected-profiles 17` ile birleştirildi. Genel ifade kapsamı önce ve sonra %58,7. Tekli kanal izni çözümü %95,2, toplu izin kararını hesaplayan `resolveBulkAttempt` %96,6. |
| Gerçek PostgreSQL | PostgreSQL 18.6 üzerinde `python scripts/run-postgres-tests.py` ile 922 ana paket, veritabanı ve repository test/alt testi, ayrıca 44 teslimat ve rol test/alt testi geçti. Bu koşuda atlama yok. Repository paketi 271,38 saniyede tamamlandı. Ayrı ve temiz bir veritabanında CI’ın seçtiği 106 yarış testi/alt testi de geçti. Bu profilde `Patch` %100, `WithServerRoles` %93,3 ve servis `ModifyRoles` %91,8 ifade kapsamına ulaştı. |
| Go derleme ve statik denetim | `go build`, `go vet ./...`, `go mod tidy -diff`, welcome-bot testleri ve vet geçti. `golangci-lint` sıfır bulgu verdi. Değişen Go dosyalarında yalnız `handlers/member_test.go` içindeki önceden var olan biçim farkı kaldı. |
| React ve store kapsamı | `npm run test:coverage` ile 458 dosyada 4.603 test geçti, biri atlandı. Genel satır kapsamı %65,59 → %65,88, dal kapsamı %62,87 → %63,07. `messageStore.ts` satır %82,25 → %88,00, dal %63,43 → %68,71. Yeni `channelMessageHistory.ts` satır %100, dal %90,27. `channelHistoryAccess.ts` her ikisinde %100. |
| İstemci derleme ve paket | `npm run build` ile TypeScript ve Vite geçti. `npm run lint` sıfır hata ve başlangıçta da bulunan yedi uyarı verdi. `npm run electron:test` ile 269 test geçti, biri atlandı. |
| Tarayıcı ve ağ | `e2e` dizininde `npm test` ile Chromium ve WebKit toplam 12/12 geçti. İki oturumlu rol testi gerçek Go sunucusu ve mTLS PostgreSQL kullandı. Yetkisi kaldırılan üyenin önceden açtığı alt konuşmadan HTTP 403 alması, özel WebSocket mesajının yetkili oturuma teslimi ve üyenin açık kanal oturumunun işlemeye devam etmesi doğrulandı. |
| Ortak sözleşme ve depo kontrolleri | `cargo test --manifest-path migration/Cargo.toml --locked -p hichat-protocol` ile dört Rust protokol testi geçti. Go yanıt ve olay alanları korundu. Kalite çalıştırıcısının sekiz, kabul defteri aracının 32 ve Python yardımcılarının 31 testi geçti. Güvenlik öz-taramasında engelleyici eşleşme kalmadı. Birleşik rol kilidi sorgusunun dört çağrısında da SQL sabit, kimlikler bağlı parametre. |

İlk Windows PostgreSQL koşusunda repository paketi 15 dakikada tamamlanmadı. Ayrıca ara revizyonda Linux üzerinde parçalanmamış `go test -race` çalıştırıldığında hem repository hem services 15 dakikalık paket sınırına ulaştı. Yukarıdaki genel yarış koşusu CI’ın paket bölme düzenini kullanır. PostgreSQL’deki 271,38 saniye ayrı sözleşme koşusunun süresidir.

Yetki ve hiyerarşi denetimleri servis katmanında, transaction ve satır kilidi tekrarları repository katmanında kalır. İstemcide `channelMessageHistory.ts` sıralama ve olay birleştirmesini üstlenir. Zustand store REST isteğini, hesap ve erişim durumunu, ardından okundu imlecini yönetir. HTTP gövdesi, WebSocket olay şeması ve veritabanı şeması için geçiş gerekmiyor.

**Gönüllü ayrılma ve yeniden katılma.** Üyelik işlemi kaydedildiğinde sunucu ve kanal izin önbellekleri kullanıcı için temizlenir. Servis testinde özel kanala okuma yetkisiyle giren üye ayrıldıktan sonra izinleri sıfırlandı ve yeniden katıldığında yalnız varsayılan rolün yetkilerini aldı. Ayrılma sırasında süren ses katılımının eski yetkiyle tamamlanamadığı ve başka sunucuya katılımın sürdüğü Go yarış algılayıcısıyla on tekrarda doğrulandı. LiveKit 1.9.12 odasında üç ayrı koşuda hem ana katılımcı hem ekran paylaşımı katılımcısı sunucu tarafından çıkarıldı. İki tarayıcı oturumuyla HTTP geçmişi ve WebSocket teslimi kabulü [PR #253](https://github.com/alfapars-exe/discordd/pull/253) üzerinden izleniyor.

**Takip.** Rol ve üye WebSocket olayları transaction sürüm numarası taşımaz. İki eşzamanlı commit için istemcide küresel teslim sırası garanti edilmez. Fiziksel cihazda ses ve video kabulü açıktır. Ürün kabul defterindeki 261 davranışın yapısal denetimi geçti. `npm run check:acceptance` başlangıçtaki 248 açık davranışı raporlamaya devam ediyor.

Arşiv E2E senaryosunda PostgreSQL, silinen sunucunun hâlâ referans verdiği self-hosted LiveKit kaydını `23503` ile reddetmişti. Düzeltmede, sunucuyu silen transaction son atamayı döndürür. Aynı transaction, yönetilen örneğin sayacını düşürür veya son referansı kaldırılan özel örneği siler. SQLite ve PostgreSQL 18.6 testlerinde medya temizleme hatasının sunucu silmeyi geri alması ve eşzamanlı iki silmenin son özel örneği kaldırması doğrulandı. Sahip ve platform yöneticisi yollarında `server_delete` olayının yalnız commit sonrasında gönderildiği servis testiyle doğrulandı.

## Uygulama izleme — 26 Ekim 2026

İlk uygulama grubu, kapsamlı modül ayırmalarından önce test ve kaynak sahipliği sınırlarını kurar. **Planın 30 görevinin tamamı bitmedi.** Bu tablo yerel uygulamayı, CI yürütmesini ve gerçek cihaz kabulünü birbirine karıştırmaz. Aktif kaynak ağacında başka çalışmalar bulunduğundan bütün doğrulamalar kaynak manifestiyle kaydedilir.

| Görev | Uygulanan bölüm | Kalan kabul / iş |
|---|---|---|
| RF01 | Güncel kaynakta iki encoding düzeltmesi zaten vardı; strict UTF-8 taraması ve production build geçti. Genel source encoding kontrolü CI’a eklendi. | Tamamlandı; yeniden kozmetik kaynak dönüşümü yapılmadı. |
| RF02 | `npm run quality:baseline` komut, exit code, log, test özeti, HEAD ve kaynak SHA-256 manifestini JSON’a kaydediyor. Koşu sırasında kaynak değişirse global PASS üretmiyor. | Dondurulmuş kaynak kopyasında tam koşu başarılı ve source_stable=true; kaynak değişen önceki koşular baseline olarak reddedildi. |
| RF03 | CI, aynı kaynağa ait 17 Go profilini birleştirir. Genel Go ifade kapsamı alt sınırı %58,7. Vitest genel alt sınırları ifadelerde %65,1, dallarda %63,0, fonksiyonlarda %59,4 ve satırlarda %65,8. Output routing için dosya bazlı eşikler ayrıca uygulanır. | [CI ölçümü](https://github.com/alfapars-exe/discordd/actions/runs/43245920853) Go ifadelerinde %58,8, istemcide sırasıyla %65,16, %63,08, %59,48 ve %65,88 verdi. |
| RF04 | İzole PostgreSQL 18.6 job’ı, required-skip reddi, gerçek PG fixture’ları ve ayrı mTLS reconnect lane. SQLite’a özgü tarih/FTS migration fixture’ları açıkça SQLite’ta çalışıyor; ortak CRUD/rollback/yarış testleri PG’de çalışıyor. | Yerel PostgreSQL koşusu zorunlu test atlamadan geçti. PR #221’in `2c283224` revizyonunda [PostgreSQL sözleşmeleri](https://github.com/alfapars-exe/discordd/actions/runs/43292855051/job/131443573646) ve [mTLS yeniden bağlantı testi](https://github.com/alfapars-exe/discordd/actions/runs/43292855051/job/131443573688) CI’da geçti. İlk işin günlüğünde dolar sınırlayıcılı sorgu ve eşzamanlı rol güncellemesi için ayrı PASS kayıtları var. |
| RF07 | Username/email recovery, eski e-postasız hesap, generic HTTP/cooldown matrisi; repository hatasını username fallback’iyle gizlememe düzeltmesi; nil token guard. | MFA durum sorgusu, beş yönetim işlemi ve giriş alanları `8aa71878` OpenAPI sözleşmesinde tanımlandı. Yerel Go API ve mTLS PostgreSQL 18.6 ile sahip uyuşmazlığı, kurulumu iptal, TOTP onayı, kurtarma kodunun tek kullanımı ve deneme sınırı doğrulandı. İkinci hesapta kod yenileme eski kodları geçersiz kıldı, yeni kodla MFA kapatılınca parola ile giriş geçti. İstemci ve eşzamanlı parola sıfırlama kabul matrisi ayrıca izleniyor. |
| RF08 | Auth constructor artık worker başlatmıyor; legacy sweep explicit, iptal edilebilir ve tekrar güvenli start/stop sahibi. Durable session yolu gereksiz worker çalıştırmıyor. Başarısız SQLite/libSQL initialization pool’u kapatıyor. | b8a5e04d üzerinde WSL Linux yarış algılayıcısıyla üç test onar kez geçti. Testler iki kez başlatmayı, iptali, tekrar durdurmayı, yeniden başlatmayı, kalıcı oturumlarda gereksiz worker açılmamasını ve süresi dolmamış yenileme belirteci kayıtlarının korunmasını kapsıyor. |
| RF12 | Mikrofon testi, LiveKit ve P2P ortak kayıp-output fallback politikasını kullanıyor; mic test output değişiklikleri sıralı/revision kontrollü. | Büyük screen-share hook’unun tüm platform characterization/controller ayrımı ve gerçek cihaz kabulü bekliyor. |
| RF18 | Tek picker isteği; main-frame/sender kontrolü; owner kapanması/çökmesi/navigation/120 saniye timeout’unda tek finish ve cleanup; kaynak query timer temizliği. | Son Electron koşusu: 256 başarılı, 1 symlink yetenek atlaması. Paketli Windows/gerçek capture kabulü RF21’de bekliyor. |
| RF19 | Preload update/maximize abonelikleri scoped disposer döndürüyor; güncellenen React consumer’ları kendi aboneliklerini ve snooze timer’ını temizliyor. Sandboxed preload’a yeni runtime require eklenmedi. | Updater’ın splash/runtime state machine ve indirme/kurulum kabulü bekliyor. Eski removeMaximizedListener API uyumluluk için duruyor; güncel consumer kullanmıyor. |
| RF23 | Review hash tam source file hash/size manifestini içeriyor; upload aynı immutable byte’ları taşıyor; aynı yol/içerik değişimi, mutation sonrası upload ve LFS/no-op regresyonları. | 12 yardımcı test geçti; gerçek yayın yapılmadı. Eski preview hash’leri yeni manifest v2 için yeniden üretilmeli. |
| RF25 | Bütün 21 namespace için otomatik key ve interpolation parity; mevcut recovery/music dynamic-key sözleşmeleri korunuyor. | 60 locale testi geçti; görsel/klavye/screen reader E2E kabulü bekliyor. |
| RF26 | `.editorconfig`, genel UTF-8 kaynak kapısı; coverage artifacts lint dışında; sadece hedef dosyalarda format. | [PR #249](https://github.com/alfapars-exe/discordd/pull/249) dört kullanılmayan doğrudan `@dnd-kit` bağımlılığını kaldırdı. `378b0c79` üzerinde TypeScript ve Vite üretim derlemesi geçti, Vitest’te 4.603 test geçti ve 1 test atlandı. Kök manifestteki `rcedit` Windows paketleme işinde, `uiohook-napi` bas-konuşta, `concurrently` Electron geliştirme komutunda kullanılıyor. Kalan statik analiz ve okunabilirlik işleri açık. |
| RF27 | Bot katılım olayını yalnız yapılandırılmış sunucu kimliğiyle eşleştiğinde işler. HTTP ve WebSocket el sıkışmasının süre sınırı vardır. Ağ geçidinden 90 saniye boyunca veri veya ping gelmezse okuma sonlanır ve yeniden bağlantı döngüsü devreye girer. | `e3b9fd57` üzerinde yerel HTTP ve WebSocket sunucularıyla modülün yarış testleri beş tekrarda geçti. Testler yanıtsız HTTP isteğini, sessiz ağ geçidini, boşta bağlantıyı sürdüren pingleri ve görünen ad eksikken kullanıcı adına dönüşü kapsar. İfade kapsamı modülde %64,5, `welcomeText` içinde %100. Ayrı süreç testinde Windows botu ilk bağlantı kapatılınca ikinci bağlantıyı kurup karşılama mesajını gönderdi. WSL Ubuntu üzerinde Linux/amd64 botu hem açık bağlantıda hem de yeniden deneme beklerken SIGTERM alınca çıkış kodu 0 ile sonlandı. |
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

**Sorgu envanteri.** `server/repository` altındaki test dışı Go kaynaklarında numarasız soru işareti 110 dosyada, numaralı parametre dört dosyada, virgülle ayrılan dinamik parametre listesi on dosyada geçiyor. Aynı taramada `ON CONFLICT` 56, `SELECT EXISTS` 19, JSON işlemleri dört, `(created_at,id)` ikilisi dört ve satır kilidi ifadeleri yedi dosyada bulundu. Bunlar metin eşleşmesi olan dosya sayılarıdır. Bir dosya birden çok aileye girebilir. Dinamik sorgular için üretilen tüm metinleri saymaz. Örnekler `sqlite_account_asset_cleanup.go` (numaralı parametre), `application_game_grants.go` (upsert ve EXISTS), `postgres_search.go` (dinamik liste) ve `dm_message_tx.go` (satır kilidi).

Parametre sınır testi, sürücünün PostgreSQL protokolünde bağlanamayacak 65.536. pozisyonu ürettiğini gösterdi. Dönüştürücü artık sınırı hem açık numaralarda hem de son numarayı izleyen örtük parametrede denetler. Ayrı bir regresyonda nil `*sql.NullString` argümanı sürücüde paniğe yol açtı. Standart Go dönüştürücüsüyle bu değer SQL NULL olarak iletilir. Ortak sorgu testi her iki veritabanında da sonucu denetler.

**12 Kasım doğrulaması.** Güncel PostgreSQL adaptörü repository sorgularındaki `?` ve `?N` parametrelerini sürücü sınırında çeviriyor. Aşağıdaki regex/upsert bulgusu ilk inceleme revizyonuna ait. Yerel düzeltme, iç içe SQL yorumlarındaki soru işaretlerini koruyor ve gömülü PostgreSQL migration dosyalarını bağlama dönüşümü dışında çalıştırıyor. Bir migration içindeki JSON anahtar operatörü ve aynı transaction içindeki sonraki parametreli sorgu PostgreSQL üzerinde doğrulandı.

`server/database/postgres_dialect_test.go` içindeki `TestRepositoryDialectContracts` aynı veriyle SQLite ve PostgreSQL üzerinde çalışır. Birleşik anahtarlı upsert, çakışmada yazmayı atlama, NULL, tekrarlanan ve sırasız numaralı parametreler, tırnak ve yorum içindeki soru işaretleri, mikrosaniye farkıyla zaman süzme, hazırlanmış EXISTS sorgusunun 0/1 sonucu, eksik argüman reddi ve rollback sonrası satır sayısı denetlenir. PostgreSQL 18.6 ile yerel `go test ./database -skip '^TestOpenPostgresInlinePEMReconnect$' -count=1` geçti. Sertifikayla yeniden bağlantı ayrı test hattına ait. Bu senaryolar repository genelindeki sorgu ailelerinin tam envanterini kapsamıyor.

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

**SQLite içe aktarma.** Boş migration defterinde 144–150 sürümlerinin her biri gerçek migration dosyalarından üretilmiş şema ve dosya dizisi SHA-256 özetleriyle tanınır. Yalnız eşleşen sürüme kadar olan kayıtlar aynı transaction içinde eklenir. Sonraki migration dosyaları olağan sırada çalışır. Testler yedi sürümü, eksik şemayı, sonradan eklenmiş indeksi, değiştirilmiş migration dosyasını, kayıt yazılırken geri almayı ve veri içeren 144 kopyasının güncel sürüme iki kez açılmasını denetler. Operatör adımları `deploy/infra/README.md` içindedir. Gerçek kullanıcı yedeğiyle geri yükleme kabulü açıktır.

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

**Grup konuşmaları.** Mesaj geçmişi ve tek grup görünümü istek başına tek toplu profil okuması kullanır. Kullanıcının grup listesi ise görünür grupları, sıralı üye profillerini ve okuyucuya özel durumu tek SQL sorgusunda alır. İlk okunmamış mesaj her grup için bir kez hesaplanır. SQLite ve PostgreSQL 18.6 testleri üç grup ve iki okuyucuyla görünürlüğü, üye sırasını, özel sessize alma ayarını, ilk okunmamış mesajı ve eksik okundu kaydının reddedilmesini doğruladı. Eksik mesaj yazarı önceki gibi `ErrNotFound` üretir.

**RF29 ölçümü.** `HICHAT_MEASURE_GROUP_PROFILES=1` ile `go test ./repository -run '^TestGroupPublicProfileParity$' -count=1 -v` iki yazardan gelen 100 mesajın profil okumasını karşılaştırır. Bir ısınma ve 30 örnekte yerel PostgreSQL 18.6 p95 süresi 100 tekil okumada 10,874 ms, toplu okumada 0,521 ms oldu. Her iki yolda bağlantı havuzu beklemesi 0 s ölçüldü. SQLite tekil okumada 3,284 ms verdi. Toplu SQLite ölçümünde p95 zamanlayıcının çözünürlüğünün altında kaldı. Bu süreler HTTP isteğinin tamamını ve eşzamanlı kullanıcı yükünü kapsamaz.

**Sunucu üye listesi.** `memberService.GetAll` tüm platform kullanıcılarını okuyor, ayrı bir sorguyla üyelikleri çekiyor ve sonucu bellekte süzüyordu. Artık `ListServerMemberProfiles` üyelik tablosunu kullanıcı tablosuna sunucu kimliğiyle bağlar. Kullanıcı adı sıralaması korunur. Üye yanıtının kullandığı profil ve görünürlük alanları seçilir. Parola özeti ve e-posta sorgudan çıkarıldı. Rol, takma ad ve zaman aşımı okumaları toplu kalır. SQLite ve PostgreSQL 18.6 kabul testinde iki üye, bir dış kullanıcı, boş sonuç, sıra ve profil alanları denetlendi. Grup konuşması projeksiyonları ve p95 ölçümü ayrıca izleniyor.

**Toplu rol okuması, 12 Kasım.** Kanal erişim denetimi, audit yayını ve üye listesinin kullandığı `GetRolesForUsers`, büyük bir alıcı listesinde her kimlik için bir SQL parametresi oluşturuyordu. 65.542 girdilik test SQLite üzerinde parametre sınırı hatasını yeniden üretti. 999 ve üzeri girdide sorgu artık kimlik kümesini bağlı bir JSON parametresinden okur. Sorgu tek bir veritabanı görünümünde çalışır. SQLite ve PostgreSQL 18.6 üzerinde rol sırası, yinelenen kullanıcı, başka sunucudaki rol, rolü olmayan kullanıcı ve listenin sonundaki üye doğrulandı. Bu kontrol gönderim gecikmesini veya bağlantı kapasitesini ölçmez.

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

12 Kasım 2026 tarihinde kapanan oturuma yöneltilen dört kuyruk komutunun başarı döndürdüğü regresyon testiyle tekrarlandı. Kuyruk ve oynatma komutları artık oturum kilidini aldıktan sonra kanalın güncel botunu doğruluyor. Dinleyicinin yetkisi denetlenirken bot değişirse eski oynatma hatası, durum bildirimi veya kapanış bildirimi alıcının WebSocket kuyruğuna girmiyor. Yerine bot gelmediğinde kapanış bildirimi teslim edilebiliyor.

Birleşik dalda komut düzeltmesini kapsayan müzik servisi yarış koşusu 483,6 saniyede geçti. Sonraki `3d82a34b` revizyonunda yayıncı değişimi, dinleyici yetkilendirmesi, bot durdurma, istek sahibi ve geri yüklenen kuyruk için seçili testler `-race -count=2` ile 130,2 saniyede geçti. Aynı revizyonda sunucu modülünde `go vet ./...` ve `go build ./...` geçti. Gerçek sağlayıcıdan ses oynatma kabulü açık. [PR #239](https://github.com/alfapars-exe/discordd/pull/239)

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

**12 Kasım.** DM servisinin constructor’ı sunucu DM politikasını açıkça alır. Hesap anonimleştirme yapılandırması, kalıcı repository ile birlikte etkin müzik isteklerindeki kullanıcı bilgisini temizleyen gözlemciyi alır. P2P cevapsız çağrı e-postası, servis oluşturulurken bağlanır. Bu üç bağlantı için başlangıçtaki çalışma zamanı tür denetimleri kaldırıldı. Testler sunucu gizlilik ayarıyla ilk DM gönderimini, kanal kilidinden sonra politikanın yeniden denetlenmesini, başarısız anonimleştirme sonrasında kimlik bilgilerinin korunmasını ve cevapsız çağrı e-postasının tetiklendiği durumları kapsar. Diğer servislerin başlangıç ve kapanış sözleşmeleri açık.

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

Bire bir DM ve kanal geçmişi, zaman damgalarını UTC ofseti ve milisaniye altı kesirleri hesaba katarak karşılaştırıyor. Sunucu sıra numarası bulunan DM'lerde bu numara öncelikli. Eski DM sayfası, zaten yüklü bir mesajla çakıştığında ekrandaki düzenlenmiş kopya korunuyor. Tekrarlanan kimlikler hem eski hem yeni sayfalarda eleniyor.

Grup geçmişi yenilemesi, grup gönderim onayı ve WebSocket düzenlemeleri, gelen kayıtta sıra numarası eksikse bilinen sıra numarasını koruyor. Bire bir DM için görünür liste, bekleyen geçmiş olayları ve geçmiş penceresinin dışında tutulan canlı mesajlar aynı kuralı kullanıyor. Birleşik `2a46beda` revizyonunda ilgili dört Vitest dosyasında 184 test ve TypeScript derlemesi geçti. [PR #240](https://github.com/alfapars-exe/discordd/pull/240)

Tam istemci koşusu aynı `2a46beda` revizyonunda 461 dosyada 4.640 geçen ve 1 atlanan test verdi. Satır kapsamı %66,43, dal kapsamı %63,32 oldu.

`a70a4f49` sıralama değişikliğinde sunucu sıra numarası her mesaj için bir kez ayrıştırılıyor. Node 26.13.0 ile 5.000 mesajın 1.000 tanesi sıra numarasız, zaman damgaları eşit ve kalan sıra numaraları karışık olacak şekilde ölçüldü. Üç ısınmadan sonraki dokuz tekrarın medyanı 7,31 ms'den 1,35 ms'ye indi. Kimlik dizisinin SHA-256 özeti her iki sürümde aynıydı. Ayrı bir karşılaştırmada 1.000 sabit tohumlu veri kümesi için varsayılan sıra, API konumu ve grup kimliği eşitlik kurallarının üçünde de önceki sürümle aynı çıktı alındı. Ölçüm yalnız sıralama işlevini kapsıyor.

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

12 Kasım 2026 ölçümünde `3fb26986` üzerindeki kanal araması Chromium 156.0.8078.4 ve gerçek IndexedDB ile sınandı. `client` ve `e2e` bağımlılıkları kurulduktan sonra depo kökünde `node e2e/scripts/benchmark-encrypted-search.mjs` çalıştırılır. Her veri kümesinin %80’i hedef kanaldadır. Bir ısınma ve üç ölçümde aksanlı sorgunun sonuç sayısı, mesaj kimliklerinin sırası ve içerikleri doğrulandı. Süre, depolama çağrısından eşleşmelerin dönüşüne kadar ölçüldü.

| Kayıt | Eşleşme | Medyan | En kısa–en uzun |
|---:|---:|---:|---:|
| 1.000 | 267 | 22,5 ms | 22,1–23,0 ms |
| 10.000 | 2.667 | 206,5 ms | 201,3–208,5 ms |
| 50.000 | 13.333 | 993,0 ms | 946,8–1.049,8 ms |

İkinci sayfa için aynı betik, her boyutta yeniden tarama ve sıralama süresini ilk sorguda saklanan kimliklerle 25 kaydı okuma süresiyle karşılaştırır. Aynı çalıştırmada medyanlar 1.000 kayıtta 22,3 ve 2,6 ms, 10.000 kayıtta 192,9 ve 2,5 ms, 50.000 kayıtta 899,2 ve 3,5 ms oldu. Her iki yolda 25 mesajın kimlikleri, içeriği ve sırası eşleşti. Ölçüm depolama ve sayfa seçim süresini kapsar. İlk sorgu tüm kanal indeksini tarar ve panel her eşleşmenin kimliğini bellekte tutar.

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

**Windows doğrulaması (12 Kasım 2026).** [PR #242](https://github.com/alfapars-exe/discordd/pull/242) için `974fa6ad` kaynaklarından MSVC ile derlenen ses yardımcısı gerçek WASAPI üzerinde çalıştırıldı. Bir ısınma çevriminden sonra 50 ayrı süreç başlatıldı. Her süreçte test 12 baytlık format başlığını doğruladı, stdin kanalını kapattı ve yardımcının başarı koduyla çıkmasını bekledi. Testi yöneten Python sürecinin Windows tanıtıcı sayısı ısınmadan sonra ve her çevrim sonunda 166 idi. Başlatmadan kapanışa medyan süre 63 ms idi. Ölçüm tek Windows makinesinde yapıldı. Uzun süre açık tutulan tek yakalama oturumu, Electron ana sürecinin tanıtıcıları, fiziksel duyulurluk, aygıt değişimi ve uygulama sesinin dışlanması için ayrı kabul kanıtı gerekiyor.

**Paketli Windows kabulü (12 Kasım 2026).** `9879e9d9` için [Windows paketleme işi](https://github.com/alfapars-exe/discordd/actions/runs/43285338113/job/131417284733) geçti. İş, Electron paketindeki iki yardımcıyı çalıştırdı. Pencere yardımcısında geçersiz PID ve beş üst süreç kapanışını, ses yardımcısında geçersiz dışlama PID’lerinin reddini sınadı. Aynı işte MSVC ile derlenen ayrı test, WASAPI tampon hatalarını, biçim kararlarını, etkinleştirme zaman aşımını ve kısmi PCM yazımını doğruladı. Paketli yardımcının fiziksel ses çıkışı bu koşunun kapsamı dışında.

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

**iOS simülatör kabulü (12 Kasım 2026).** [macOS CI işinde](https://github.com/alfapars-exe/discordd/actions/runs/43286356543/job/131420689290) `df6bab38` uygulama hedefi derlendi. iPhone simülatöründe uygulamanın kullandığı Swift kesinti kararını çağıran `testOnlyEndedWithResumeHintReactivates` geçti. Tek XCTest, eksik veri, eksik seçenek, kesinti başlangıcı ve kesinti sonundaki iki devam seçeneğini doğruladı. Telefon araması, Siri kesintisi ve hoparlör veya Bluetooth üzerinden fiziksel sesin geri gelmesi açık.

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
