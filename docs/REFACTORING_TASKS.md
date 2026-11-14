# Refactoring görevleri ve kabul ölçütleri

Tarih: 25 Ekim 2026. İlk inceleme revizyonu `313acf8e`; çalışma sırasında başka bir iş akışı HEAD'i `da506e3b` revizyonuna ilerletti. Buna ek olarak inceleme anındaki değiştirilmiş ve izlenmeyen çalışma ağacı dosyaları değerlendirilmiştir. Depo kökü: `C:\Users\PARS\Desktop\PROJELER\HiChat\discordd`. Kod referansları bu köke göredir; satırlar bu incelemenin anlık görüntüsüne aittir. Farklı revizyonların test sonuçları birbirine eklenerek global başarı çıkarılmaz.

Bu belge uygulama önerisidir. Görev kartının varlığı, kodun değiştirildiği veya kabul edildiği anlamına gelmez. İlk teslimat 25 Ekim’de plan belgeleriydi. 26 Ekim’de kullanıcı uygulamayı başlattı; güncel ilerleme aşağıdaki tabloda izlenir. Görev kartlarındaki Problem alanları ilk incelemenin tarihsel kanıtıdır. Mevcut değişiklikler korunur; uygulama aşamasında her PR yalnız seçilen görevin dosyalarını kapsar.

Birleşik dalın `a0d23642` revizyonunda 462 dosyada 4.667 Vitest testi geçti ve 1 test atlandı. Satır kapsamı %66,56, dal kapsamı %63,44, fonksiyon kapsamı %60,02 ve ifade kapsamı %65,70 ölçüldü. `bd069157` üzerinde varsayılan 13 Playwright testi gerçek Go sunucusu ve mTLS PostgreSQL ile geçti. Eşzamanlı yenileme isteklerinden biri 200, diğeri 409 aldı ve kazanan çerezle aynı hesap yeniden doğrulandı.

Birleşik istemcinin `9aaecadb` revizyonunda tam Vitest koşusu 124,37 saniyede tamamlandı. 464 dosyada 4.671 test geçti ve 1 test atlandı. V8 kapsamı satırlarda %66,73, dallarda %63,52, fonksiyonlarda %60,21 ve ifadelerde %65,84 oldu. `messageStore.ts` için satır ve dal kapsamı sırasıyla %88,00 ve %68,71, `ScreenPicker.tsx` için %86,88 ve %77,50 ölçüldü.

## Ekran paylaşımı seçicisi · 13 Kasım 2026

`d5fb4f1b` üzerinde Electron TypeScript derlemesi geçti. 276 Electron testi geçti ve 1 test atlandı. Windows'ta gerçek Electron ana süreci ile gizli bir test penceresi üzerinden `getDisplayMedia` çağrıldı. Üretim seçici işleyicisi küçük resimleri kapalı tutarak masaüstü kaynaklarını listeledi, yenileme isteğinde tekrar listeledi ve iptal edildiğinde tarayıcıya `AbortError` döndü. Test pencereyi ana pencere olarak atadı. Ardından sentetik pencere seçildi ve iki yerel WebRTC ucu arasında aktarılan görüntü alıcıda doğrulandı (RF18). İki fiziksel cihaz arasındaki çağrı açık. [PR #257](https://github.com/alfapars-exe/discordd/pull/257)

Kaynak seçicisinin `52881530` ve paketlenmiş ses motoru testlerinin `fb3f904c` revizyonlarında 36 CI kontrolünün tamamı geçti. İkinci koşuda Vite üretim çıktısı üzerinde ses motorlarının bütünlük ve çıkarım testleri çalıştı. [Seçici PR #257](https://github.com/alfapars-exe/discordd/pull/257) · [Ses motoru CI işi](https://github.com/alfapars-exe/discordd/actions/runs/43325386759/job/131556431027)

## Masaüstü başlangıcı ve paketleme · 13 Kasım 2026

Temiz profille çevrimdışı açılan Windows paketinde ilk üç saniyede kanal arayüzü modülü işlenmedi. Önceki pakette aynı koşullarda Chromium bu modülü işledi. Yeni pakete geçerli sentetik önbellek kaydı verilip yeniden yüklendiğinde kanal modülü işlendi, kullanıcı ve sunucu adı salt okunur önizlemede göründü ve oturum geri yükleme durumu sürdü. Oturum zamanlaması için PR dalında 30 test geçti. [PR #256](https://github.com/alfapars-exe/discordd/pull/256)

Paketlenmiş Windows uygulamasında eski biçimdeki kayıtla iki çevrimdışı açılış yapıldı. Özel kanal kimliği ve adı ilk okumada yerel depodan temizlendi. Kullanıcı, sunucu ve özgün zaman damgası iki açılışta da korundu. Ayrı bir geçici profilde yenileme isteğine test ağı üzerinden HTTP 401 döndürüldüğünde giriş formu açıldı ve başlangıç kaydı silindi. Uygulama çevrimdışı yeniden başlatıldığında eski hesap önizlemesi görünmedi. Bu senaryo üretim istemcisini ve benzetilmiş HTTP yanıtını kullandı.

Aynı girdilerle üretilen iki yerel Windows x64 paketinde filtre 38 derlenmiş testi ve bir test yardımcısını çıkardı. ASAR 336.201 bayt, imzasız NSIS yükleyicisi 44.003 bayt küçüldü. Paket denetimi eski arşivi reddetti ve yeni arşivi kabul etti. PR dalındaki 36 CI kontrolü geçti. [PR #255](https://github.com/alfapars-exe/discordd/pull/255)

## Masaüstü parola deposu ve CI · 13 Kasım 2026

Electron ana süreci, elle girişte parolayla birlikte kaydedilen sunucu adresini denetliyor. Başka bir HTTPS sunucusuna veya yönlendirme hedefine kayıtlı parola gönderilmiyor. Sunucu adresi içermeyen eski kayıtla bir kez elle giriş gerekiyor. Linux'ta parola depolamak ve okumak için işletim sisteminin parola yöneticisi gerekiyor. Entegrasyon dalında 275 Electron testi geçti ve 1 test atlandı. Giriş formu testlerinde kaydetme ve silme hatalarında kullanıcı uyarıldı ve kanallara geçiş tamamlandı. Debian Bookworm konteynerinde Electron 45.1.0, D-Bus ve GNOME Keyring ile gerçek `gnome_libsecret` deposunda sentetik parola kaydedildi, şifreli dosya kontrol edildi, kayıt geri okundu ve silindi. Ayrı Electron sürecinde `basic_text` seçildiğinde parola dosyası oluşmadı. [PR #254](https://github.com/alfapars-exe/discordd/pull/254)

Windows üzerinde Electron 45.1.0 ve geçici profille iki gerçek BrowserWindow açıldı. Test ana pencereyi seçip üretim IPC işleyicilerini kaydetti. Ana pencere sentetik parolayı kaydetti, kullanıcı adını okudu ve kaydı sildi. İkinci pencereden kaydetme, okuma, kayıtlı parolayla giriş ve silme çağrılarının dördü de gönderici denetiminde reddedildi. Sonrasında ana pencere aynı kullanıcı adını okuyabildi. Deneme paketlenmiş uygulamanın pencere oluşturma akışını kapsamıyor.

Capacitor güncellemesinin `b1664dae` ve günlük maskelemesinin `e08470d9` revizyonlarında GitHub'daki 36 kontrolün tamamı geçti. [PR #217](https://github.com/alfapars-exe/discordd/pull/217) · [PR #247](https://github.com/alfapars-exe/discordd/pull/247)

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

Birleşik dalın `7cfbcb9e` revizyonunda 461 dosyada 4.654 istemci testi geçti ve 1 test atlandı. Satır kapsamı %66,49, dal kapsamı %63,39, fonksiyon kapsamı %59,97 ve ifade kapsamı %65,64 oldu. Aynı revizyonda Go vet ve build, TypeScript ve Vite üretim derlemesi geçti. WebKit üretim paketi testinde giriş ve parola kurtarma ekranları açıldı ve tarayıcıda JavaScript hatası gözlenmedi.

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

Birleşik dalda 60505fb2 üzerinde Node 26.13.0 ile tekrar ölçülen medyanlar sırasıyla 0,21 / 0,88 / 2,79 ms oldu. Aynı koşuda birleştirilmiş pencere ve okundu imleci kontrolleri geçti. Ölçümü yinelemek için `client` dizininde `HICHAT_BENCH_CHANNEL_HISTORY=1` ortam değişkeniyle `npx vitest run --silent=false src/stores/messageStore.test.ts -t "measures detached create processing and checks the complete merged window"` çalıştırılır. İlk keşif ölçümü farklı bir çalıştırıcı kullanıyordu. Tablodaki her iki sütun aynı testten alındı. Süreler ağ, React çizimi ve medya gecikmesini kapsamaz. Geçmiş penceresi açık kaldığı sürece tampon değişen her benzersiz kimlik için bir kayıt tutar. Son sayfaya ulaşıldığında, pencere bırakıldığında, yetki kaldırıldığında veya oturum değiştiğinde ilgili kayıtlar bırakılır. Uzun süre açık pencerelerde bellek için sabit bir üst sınır yoktur.

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

Birleşik dalın `9631d5c1` revizyonunda gerçek Go sunucusu ve mTLS PostgreSQL ile varsayılan Chromium koşusu 12/12 geçti (kurulum dahil, 1,6 dakika). Ayrı masaüstü WebKit koşusunda giriş ve parola kurtarma arasında klavyeyle geçiş 18,9 saniyede doğrulandı. Kurtarma PR’ının `54b0d251` revizyonunda yerel posta kutusuna teslim edilen bağlantı ilk parola değişikliğini tamamladı. Aynı bağlantının ikinci kullanımı reddedildi ve ilk belirlenen parolayla oturum açıldı. Kurulum ve senaryo 39,8 saniyede geçti. [PR #225](https://github.com/alfapars-exe/discordd/pull/225)

Windows üzerinde `ee21edc5` revizyonunda sunucunun `go build ./...` ve `go vet ./...` kontrolleri geçti. Önbelleksiz `go test -count=1 -json ./...` koşusu çıkış kodu 0 ile tamamlandı. Alt testler dahil 4.013 test geçti ve 57 test atlandı.

Birleşik dalda `f8b79322` revizyonunun Windows mTLS PostgreSQL koşusu tamamlandı. Repository paketi 316,80 saniyede geçti. Sahiplik devri ve ayrılma yarışında önce ayrılan üyeye sahiplik verilemedi. Önce devir tamamlandığında yeni sahibin üyeliği ve rol ataması korundu. İkinci sıra `3fe8a08d` üzerinde beş tekrarda doğrulandı. [PR #253](https://github.com/alfapars-exe/discordd/pull/253)

Yetki ve hiyerarşi denetimleri servis katmanında, transaction ve satır kilidi tekrarları repository katmanında kalır. İstemcide `channelMessageHistory.ts` sıralama ve olay birleştirmesini üstlenir. Zustand store REST isteğini, hesap ve erişim durumunu, ardından okundu imlecini yönetir. HTTP gövdesi, WebSocket olay şeması ve veritabanı şeması için geçiş gerekmiyor.

**Gönüllü ayrılma ve yeniden katılma.** Üyelik işlemi kaydedildiğinde sunucu ve kanal izin önbellekleri kullanıcı için temizlenir. Servis testinde özel kanala okuma yetkisiyle giren üye ayrıldıktan sonra izinleri sıfırlandı ve yeniden katıldığında yalnız varsayılan rolün yetkilerini aldı. Ayrılma sırasında süren ses katılımının eski yetkiyle tamamlanamadığı ve başka sunucuya katılımın sürdüğü Go yarış algılayıcısıyla on tekrarda doğrulandı. LiveKit 1.9.12 odasında üç ayrı koşuda hem ana katılımcı hem ekran paylaşımı katılımcısı sunucu tarafından çıkarıldı. 356b5565 üzerinde gerçek Go sunucusu ve mTLS PostgreSQL ile yerel Chromium koşusu 41,4 saniyede geçti (kurulum ve iki senaryo). Ayrılıp yeniden katılan üye özel kanal geçmişinden HTTP 403 aldı. Sahibe ulaşan özel mesaj üyeye teslim edilmedi ve üye sonraki genel kanal mesajını aynı tarayıcı oturumunda aldı. 31268757 üzerinde iki oturumlu senaryo dahil 12 Playwright testi [CI koşusunda](https://github.com/alfapars-exe/discordd/actions/runs/43306168397/job/131490138551) geçti.

**Takip.** Rol ve üye WebSocket olayları transaction sürüm numarası taşımaz. İki eşzamanlı commit için istemcide küresel teslim sırası garanti edilmez. Fiziksel cihazda ses ve video kabulü açıktır. Ürün kabul defterindeki 261 davranışın yapısal denetimi geçti. `npm run check:acceptance` başlangıçtaki 248 açık davranışı raporlamaya devam ediyor.

Arşiv E2E senaryosunda PostgreSQL, silinen sunucunun hâlâ referans verdiği self-hosted LiveKit kaydını `23503` ile reddetmişti. Düzeltmede, sunucuyu silen transaction son atamayı döndürür. Aynı transaction, yönetilen örneğin sayacını düşürür veya son referansı kaldırılan özel örneği siler. SQLite ve PostgreSQL 18.6 testlerinde medya temizleme hatasının sunucu silmeyi geri alması ve eşzamanlı iki silmenin son özel örneği kaldırması doğrulandı. Sahip ve platform yöneticisi yollarında `server_delete` olayının yalnız commit sonrasında gönderildiği servis testiyle doğrulandı.

## Uygulama izleme — 26 Ekim 2026

Bu bölüm 26 Ekim anlık görüntüsüdür. Sonraki uygulamalar ve açık kabul kapıları için [güncel RF01–RF30 matrisini](REFACTORING_STATUS.md) ve bu belgedeki tarihli kanıt kayıtlarını kullanın. Aşağıdaki tarihsel “henüz uygulanmadı” ifadeleri güncel kaynak durumu değildir.

İlk uygulama grubu, kapsamlı modül ayırmalarından önce test ve kaynak sahipliği sınırlarını kurar. **Planın 30 görevinin tamamı bitmedi.** Bu tablo yerel uygulamayı, CI yürütmesini ve gerçek cihaz kabulünü birbirine karıştırmaz. Aktif kaynak ağacında başka çalışmalar bulunduğundan bütün doğrulamalar kaynak manifestiyle kaydedilir.

| Görev | Uygulanan bölüm | Kalan kabul / iş |
|---|---|---|
| RF01 | Güncel kaynakta iki encoding düzeltmesi zaten vardı; strict UTF-8 taraması ve production build geçti. Genel source encoding kontrolü CI’a eklendi. | Tamamlandı; yeniden kozmetik kaynak dönüşümü yapılmadı. |
| RF02 | `npm run quality:baseline` komut, exit code, log, test özeti, HEAD ve kaynak SHA-256 manifestini JSON’a kaydediyor. Koşu sırasında kaynak değişirse global PASS üretmiyor. | Dondurulmuş kaynak kopyasında tam koşu başarılı ve source_stable=true; kaynak değişen önceki koşular baseline olarak reddedildi. |
| RF03 | CI, aynı kaynağa ait 17 Go profilini birleştirir. Genel Go ifade kapsamı alt sınırı %58,7. Vitest genel alt sınırları ifadelerde %65,1, dallarda %63,0, fonksiyonlarda %59,4 ve satırlarda %65,8. Output routing için dosya bazlı eşikler ayrıca uygulanır. | [CI ölçümü](https://github.com/alfapars-exe/discordd/actions/runs/43245920853) Go ifadelerinde %58,8, istemcide sırasıyla %65,16, %63,08, %59,48 ve %65,88 verdi. |
| RF04 | İzole PostgreSQL 18.6 job’ı, required-skip reddi, gerçek PG fixture’ları ve ayrı mTLS reconnect lane. SQLite’a özgü tarih/FTS migration fixture’ları açıkça SQLite’ta çalışıyor; ortak CRUD/rollback/yarış testleri PG’de çalışıyor. | Yerel PostgreSQL koşusu zorunlu test atlamadan geçti. PR #221’in `2c283224` revizyonunda [PostgreSQL sözleşmeleri](https://github.com/alfapars-exe/discordd/actions/runs/43292855051/job/131443573646) ve [mTLS yeniden bağlantı testi](https://github.com/alfapars-exe/discordd/actions/runs/43292855051/job/131443573688) CI’da geçti. İlk işin günlüğünde dolar sınırlayıcılı sorgu ve eşzamanlı rol güncellemesi için ayrı PASS kayıtları var. |
| RF07 | Username/email recovery, eski e-postasız hesap, generic HTTP/cooldown matrisi; repository hatasını username fallback’iyle gizlememe düzeltmesi; nil token guard. | MFA durum sorgusu, beş yönetim işlemi ve giriş alanları `8aa71878` OpenAPI sözleşmesinde tanımlandı. Yerel Go API ve mTLS PostgreSQL 18.6 ile sahip uyuşmazlığı, kurulumu iptal, TOTP onayı, kurtarma kodunun tek kullanımı ve deneme sınırı doğrulandı. İkinci hesapta kod yenileme eski kodları geçersiz kıldı, yeni kodla MFA kapatılınca parola ile giriş geçti. SQLite ve PostgreSQL’de üçer tekrarda aynı kodla yarışan iki sıfırlamadan biri başarılı oldu ve kalıcı parola özeti kazanan isteğe aitti. İstemci bileşen testinde yeni kurtarma bağlantısına geçildikten sonra eski isteğin sonucu yeni formu değiştirmedi. Yerel Resend uyumlu HTTP sağlayıcısına gönderilen e-postadaki bağlantıyla Chromium üzerinden parola değiştirildi ve yeni parolayla oturum açıldı. Kurulum ve senaryo mTLS PostgreSQL ile 56,7 saniyede geçti. |
| RF08 | Auth constructor artık worker başlatmıyor; legacy sweep explicit, iptal edilebilir ve tekrar güvenli start/stop sahibi. Durable session yolu gereksiz worker çalıştırmıyor. Başarısız SQLite/libSQL initialization pool’u kapatıyor. | b8a5e04d üzerinde WSL Linux yarış algılayıcısıyla üç test onar kez geçti. Testler iki kez başlatmayı, iptali, tekrar durdurmayı, yeniden başlatmayı, kalıcı oturumlarda gereksiz worker açılmamasını ve süresi dolmamış yenileme belirteci kayıtlarının korunmasını kapsıyor. |
| RF12 | Mikrofon testi, LiveKit ve P2P ortak kayıp-output fallback politikasını kullanıyor; mic test output değişiklikleri sıralı/revision kontrollü. | Büyük screen-share hook’unun tüm platform characterization/controller ayrımı ve gerçek cihaz kabulü bekliyor. |
| RF18 | Tek picker isteği; main-frame/sender kontrolü; owner kapanması/çökmesi/navigation/120 saniye timeout’unda tek finish ve cleanup; kaynak query timer temizliği. | Son Electron koşusu: 256 başarılı, 1 symlink yetenek atlaması. Paketli Windows/gerçek capture kabulü RF21’de bekliyor. |
| RF19 | Preload update/maximize abonelikleri scoped disposer döndürüyor; güncellenen React consumer’ları kendi aboneliklerini ve snooze timer’ını temizliyor. Sandboxed preload’a yeni runtime require eklenmedi. | Updater’ın splash/runtime state machine ve indirme/kurulum kabulü bekliyor. Eski removeMaximizedListener API uyumluluk için duruyor; güncel consumer kullanmıyor. |
| RF22 | Android uygulama kimliği, ses servisinin görünürlüğü ve servis türleri kurulu uygulamada denetlendi. Mikrofon izni verilmemişken oynatma servisi başlatılıp durduruldu. iOS ses kesintisinden dönüş davranışı simülatörde sınandı. | Android 15 emülatöründe [iki test](https://github.com/alfapars-exe/discordd/actions/runs/43290996037/job/131436880949), iOS simülatöründe [bir test](https://github.com/alfapars-exe/discordd/actions/runs/43286356543/job/131420689290) geçti. Bluetooth ve kablolu ses yönlendirme ile fiziksel cihaz kabulü açık. |
| RF23 | Review hash tam source file hash/size manifestini içeriyor; upload aynı immutable byte’ları taşıyor; aynı yol/içerik değişimi, mutation sonrası upload ve LFS/no-op regresyonları. | 12 yardımcı test geçti; gerçek yayın yapılmadı. Eski preview hash’leri yeni manifest v2 için yeniden üretilmeli. |
| RF24 | İstemci API hata günlüklerinden özel istek hedefleri, sunucuda davet yollarından kodlar ve HTTP ile goroutine panik kayıtlarından ham panik içeriği kaldırıldı. | Linux yarış algılayıcısıyla beş tekrarda istek kimliğiyle tek hata kaydı, Sentry’ye tek olay iletimi, kuyruk taşmasında kayıp sayacı ve panik gizliliği testleri geçti. WSL üzerinde üç kez 2.000 bellek içi HTTP isteği ölçüldü. Yazıcı veritabanı çağrısında bloke olduktan sonra p95 1,15–2,68 µs, bırakılan hata kaydı her tekrarda 1.488 oldu. Sağlıklı yazıcıyla p95 1,54–3,67 µs, günlükleme kapalıyken 0,10–0,15 µs ölçüldü. Ölçüm ağ ve disk gecikmesini kapsamıyor. [PR #247](https://github.com/alfapars-exe/discordd/pull/247) |
| RF25 | Bütün 21 namespace için otomatik key ve interpolation parity; mevcut recovery/music dynamic-key sözleşmeleri korunuyor. | 60 locale testi geçti. Üretim derlemesinde Chromium ve WebKit giriş ile parola kurtarma bağlantılarını Enter ile açtı, Tab ile gönderme düğmesine ulaştı. Kurtarma hatasının erişilebilir uyarı rolü bileşen testinde doğrulandı. Ayarlar, picker, ses kontrolleri ve gerçek ekran okuyucu kabulü açık. |
| RF26 | `.editorconfig`, genel UTF-8 kaynak kapısı; coverage artifacts lint dışında; sadece hedef dosyalarda format. | [PR #249](https://github.com/alfapars-exe/discordd/pull/249) dört kullanılmayan doğrudan `@dnd-kit` bağımlılığını kaldırdı. `378b0c79` üzerinde TypeScript ve Vite üretim derlemesi geçti, Vitest’te 4.603 test geçti ve 1 test atlandı. Kök manifestteki `rcedit` Windows paketleme işinde, `uiohook-napi` bas-konuşta, `concurrently` Electron geliştirme komutunda kullanılıyor. Kalan statik analiz ve okunabilirlik işleri açık. |
| RF27 | Bot katılım olayını yalnız yapılandırılmış sunucu kimliğiyle eşleştiğinde işler. HTTP ve WebSocket el sıkışmasının süre sınırı vardır. Ağ geçidinden 90 saniye boyunca veri veya ping gelmezse okuma sonlanır ve yeniden bağlantı döngüsü devreye girer. | `e3b9fd57` üzerinde yerel HTTP ve WebSocket sunucularıyla modülün yarış testleri beş tekrarda geçti. Testler yanıtsız HTTP isteğini, sessiz ağ geçidini, boşta bağlantıyı sürdüren pingleri ve görünen ad eksikken kullanıcı adına dönüşü kapsar. İfade kapsamı modülde %64,5, `welcomeText` içinde %100. Ayrı süreç testinde Windows botu ilk bağlantı kapatılınca ikinci bağlantıyı kurup karşılama mesajını gönderdi. WSL Ubuntu üzerinde Linux/amd64 botu hem açık bağlantıda hem de yeniden deneme beklerken SIGTERM alınca çıkış kodu 0 ile sonlandı. Farklı bir porta HTTP 307 yönlendirmesinde bot belirtecinin ikinci sunucuya ulaştığı regresyon testiyle üretildi. Düzeltmeden sonra ikinci sunucu hiç istek almadı. PR dalında `3c4d9cc9` üzerinde Go 1.26.11 ile Debian Bookworm konteynerinde `go test -race -count=5 ./...` geçti. |
| Diğer RF görevleri | Henüz uygulanmadı. | RF05/06 veri dönüşümü/migration güvenliği; RF09–11 ve RF13–17 core ayrımları; RF20–21 platform; RF28–30 kapsamlı E2E/performance/runtime kapanışı. |

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

**13 Kasım ek doğrulama.** DM iletişim e-postası, DM tepki tercihleri ve grup DM tepki bildiriminin notification/tercih/engelleme bağımlılıkları constructor parametrelerine taşındı. Üretim başlangıcındaki bu üç koşullu setter bağlantısı kaldırıldı. İletişim ve özel tepki testleri constructor yolunu kullanıyor. `0c37fdd0` üzerinde `go vet ./...`, `go build ./...`, wiring, ilgili mesaj/tepki ve grup handler testleri geçti. E-posta constructor değişikliğinden sonra 17 gerçek PostgreSQL DM teslim/outbox/okundu testi yarış algılayıcısıyla geçti. Grup constructor değişikliği sonrasında `452ee398` üzerinde gerçek PostgreSQL 18.6 ile `go test -race -v ./services ./handlers -run '^Test.*Group|^Test.*Reaction' -count=1 -timeout=5m` 61 üst seviye test çalıştırdı. İki paket geçti, skip/fail veya veri yarışı bildirimi yoktu. Süreler services 180,663 s, handlers 44,631 s oldu. Tüm sunucu yarış paketinin birleşik tekrarı açık.

Kalan koşullu bağlantılar `server/init_services.go` içinde kalıcı kanal gönderimi hub yeteneği, sunucu işlemleri ve P2P politika değişimi gözlemcilerini içeriyor. Bunların constructor'a taşınması için sahip servislerin callback döngüleri ve disabled/no-op davranışları ayrı ayrı doğrulanmalı. RF11 tamamlandı olarak işaretlenmedi.

Preferences servisinin profil görünürlüğü geçersizleştiricisi ve oyun etkinliği eşitlemesi de constructor'a taşındı. Oyun etkinliği servisi önce oluşturuluyor. Başarılı tercih kaydı sonrasında gözlemcinin çağrıldığı, başarısız kayıtta çağrılmadığı ve tercih verisinin görünürlük olayına taşınmadığı test edildi. `cec39b39` üzerinde `go test -race ./services ./handlers . -run '^TestPreferences|^Test.*ProfileAudience|^TestWiring' -count=1` üç pakette geçti. Bu koşu gerçek PostgreSQL ortamı içermiyordu.

**13 Kasım yaşam döngüsü bağlantıları.** Engelleme, arkadaşlık, üyelik ve sunucu servislerinin oyun etkinliği gizliliği gözlemcileri constructor parametreleri oldu. Üyelik profil görünürlüğü ve sunucu katılımı tercih repository'si de aynı yolla bağlanıyor. Oyun etkinliği servisi bu tüketicilerden önce oluşturuluyor. Engelleme/engeli kaldırma, arkadaşlık kabulü/kaldırma, üye atma, sunucuya katılma, ayrılma ve silme testleri constructor bağlantısını kullanıyor. Ayrılma ve silme yazısı başarısızsa gözlemci çağrılmıyor.

`f4b5bb25` üzerinde PostgreSQL 18.6 ile 17 yaşam döngüsü testi `-race` altında geçti, skip/fail yoktu. Son tercih constructor değişikliği dahil `d0408a97` üzerinde gerçek Go başlangıcı, üretim Chromium ve mTLS PostgreSQL ile iki oturumlu rol/kanal erişim paketi hazırlık dahil 3/3 geçti. Koşu 59,1 saniye sürdü. Kalan koşullu bağlantılar kanal/ses silme temizliği, hub'ın kalıcı kanal gönderimi yeteneği ve oyun katılım teklifi callback'idir. RF11'in tüm başlangıç/kapanış kabulü ve tam sunucu yarış tekrarı açık.

**RF11 hub ve kanal/ses sözleşmesi.** Kanal silme sonrası ses temizliği channel constructor'ına taşındı. Voice constructor'ının dönüş arayüzü bu yeteneği garanti ediyor, başlangıçtaki tür dönüşümü kaldırıldı. `initServices` hub arayüzü artık kalıcı kanal gönderimi, oyun katılım teklifi ve görünür çevrimiçi kullanıcı sorgusunu açıkça gerektiriyor. Bu yetenekler koşullu bağlanmıyor. `b069ad9e` üzerinde altı silme/wiring testi yarış algılayıcısıyla geçti; altı PostgreSQL kanal teslim testi de ayrı izole PostgreSQL 18.6 koşusunda yarış algılayıcısıyla geçti.

`9fe902a0` üzerinde son constructor ve hub değişikliklerini içeren üretim Chromium paketi gerçek Go ve mTLS PostgreSQL ile 14/14 geçti (2,3 dakika). Yenileme hız sınırının 15 saniyelik beklemesinden sonra oturum toparlandı. Tam sunucu yarış paketi ve bütün RF11 kapanış kabulü açık.

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

39e66ca4 revizyonunda gerçek Go sunucusu ve mTLS PostgreSQL ile Playwright Chromium projesi kurulum dahil 13/13 geçti (1,8 dakika). İki oturumda üst kanal izni kaldırılınca önceden açılan alt konuşmanın HTTP geçmişi ve WebSocket teslimi engellendi. Yüklü kanal sayfasının dışındaki yanıt hedefine geçiş de geçti. Bu koşuda grup dışı DM yanıt hedefine tarayıcıdan geçiş sınanmadı.

006e3b7c üzerinde Linux/amd64 ve Go 1.26.11 ile DM okundu imleci, oturumlar arası teslim ve yanıt referanslarının kanal sınırı testleri üç kez yarış algılayıcısıyla çalıştırıldı. WebSocket, servis ve repository paketlerindeki seçili testler geçti. Repository testlerinde SQLite kullanıldı.

Birleşik 426fa853 revizyonunda Go vet ve build geçti. Windows Go koşusunda alt testler dahil 4.020 test geçti ve 57 test atlandı. İstemci üretim derlemesi geçti. Vite küçültülmüş bazı parçalar için 500 kB uyarısı verdi. ESLint iki TanStack Virtual uyarısı ve sıfır hata bildirdi. Electron ana süreç testlerinin 276’sı Windows’ta geçti. Sembolik bağlantı testi aynı derlenmiş dosyalarla Linux konteynerinde geçti.

13 Kasım 2026 tarihli birleşik istemci doğrulamasında `ac20226f` revizyonunun TypeScript derlemesi geçti. Vitest 4.693 testten 4.692’sini geçirdi. Varsayılan koşuda atlanan uzun grup geçmişi testi aynı istemci kaynaklarında HICHAT_GROUP_BENCHMARK=1 ile ayrıca geçti. JSDOM ortamında 2.000 mesajın üç çiziminde süreler 73,67 / 23,49 / 18,43 ms oldu. Her örnekte 17 mesaj satırı ve 276 DOM düğümü ölçüldü. DM okundu imlecinin işlemsel kapsamı SQLite ve PostgreSQL’de, iki okuyucu oturumuna teslim ve karşı tarafın bağlantısına gönderilmemesi ise SQLite ile gerçek WebSocket bağlantılarında sınandı.

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

13 Kasım 2026'da Chromium üzerinde 3f253b11 revizyonundaki ortak mesaj listesi DM bağlamında 2.000 sentetik mesajla sınandı. Kaydırma isteğinden önce DOM dışında olan qa-1000 hedefi istekten sonra tamamen görünür ve vurguluydu. O anda 29 satır DOM'a bağlıydı. İlk deney hedef kimliğini listeye verdi. Ardından son mesajdaki gerçek yanıt önizlemesine tıklama ve önizleme düğmesine odaklanıp Enter tuşuna basma denemelerinde aynı hedef görünür ve vurgulu hale geldi. Rozet ve kozmetik API'leri çevrimdışıydı.

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

Windows doğrulaması: Electron kaynak seçicisinde test penceresi kendi medya kimliğiyle seçildi. getDisplayMedia akışında 304 × 180 video karesinin merkezinde pencereye verilen yeşil renk doğrulandı. İkinci koşuda yakalanan video izi iki yerel RTCPeerConnection arasında aktarıldı. Alıcının çözdüğü 304 × 180 karenin merkezinde aynı renk doğrulandı. Fiziksel cihazlar arası HiChat çağrısı ayrıca sınanmalı.

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

### WebSocket yayın ölçümü, 13 Kasım 2026

`4b8bb88c` üzerinde Windows/amd64, Go 1.27.3 ve Ryzen 9 7950X3D ile sunucunun `server` dizininde çalıştırıldı.

```sh
go test ./ws -run '^$' -bench 'Benchmark(BroadcastToServer|Deliver)' -benchmem -benchtime=1000x -count=9
```

Her örnek 1.000 işlemin ortalamasıdır. Aralık dokuz koşudaki en düşük ve en yüksek ortalamayı gösterir. Sağlıklı istemcilerde her partinin teslim sayısı doğrulandı. Yavaş istemci senaryosunda kuyruklar dolu başladı. Ölçüm ağ aktarımı ve sokete yazma süresini kapsamıyor.

| Benchmark | Medyan ns/işlem | Aralık ns/işlem | Medyan bayt/işlem | Medyan tahsis/işlem |
|---|---:|---:|---:|---:|
| `BenchmarkBroadcastToServer_FastClients/clients=10-32` | 2232 | 1888–3417 | 373 | 7 |
| `BenchmarkBroadcastToServer_FastClients/clients=100-32` | 12907 | 7928–14869 | 373 | 7 |
| `BenchmarkBroadcastToServer_FastClients/clients=1000-32` | 151084 | 129796–201698 | 373 | 7 |
| `BenchmarkBroadcastToServer_SlowClients/clients=10-32` | 2142 | 2054–3069 | 373 | 7 |
| `BenchmarkBroadcastToServer_SlowClients/clients=100-32` | 10464 | 8079–14769 | 373 | 7 |
| `BenchmarkBroadcastToServer_SlowClients/clients=1000-32` | 98489 | 85360–118858 | 373 | 7 |
| `BenchmarkDeliver-32` | 87.7 | 59.2–409.8 | 0 | 0 |

**RF29 bağlantı döngüsü.** Windows/amd64, Go 1.27.3 üzerinde `HICHAT_MEASURE_WS_CHURN=1` ile `go test ./ws -run '^TestWebSocketConnectionChurnReleasesMembership$' -count=3 -v` geçti. Her tekrarda sekizer gerçek yerel bağlantı 1.024 turda açıldı ve TCP reset ile kapatıldı. Hub her tur sonunda kullanıcı ve sunucu üyelik sorgularında boş liste döndürdü. İlk denemede normal TCP kapanışı yerel geçici portları tüketti. Ölçüm profili ani kopmayı kullanıyor, varsayılan test normal kapatmayı koruyor.

Her tekrarda 16. turdan 1.024. tura kadar çift GC sonrasında ölçülen canlı heap değişimleri sırasıyla +361.728, +64.040 ve −5.848 bayttı. Aynı Go test sürecinde alınan 15 örneğin her birinde 4 goroutine vardı. Üç tekrar toplam 23 saniye sürdü. Bu deney uzun süreli üretim yükünü, işletim sistemi belleğini ve gerçek veritabanı erişimini kapsamıyor.

### Go ve PostgreSQL doğrulaması, 13 Kasım 2026

Kaynak revizyonu `0ee543e9` üzerinde PostgreSQL 18.6 ile `python3 scripts/run-postgres-tests.py` tamamlandı. JSON olaylarında alt testler dahil 950 test geçti, atlanan veya başarısız test yoktu. Sunucu, repository ve database paketleri tamamlandı. Scriptin ikinci aşamasındaki rol ve mesaj transaction testleri de geçti.

Aynı izole PostgreSQL ile CI'ın rol, üye rolü, teslimat, DM idempotency/outbox ve okundu imleci seçimi `-race` altında geçti. E-posta sağlayıcısı paketinde ortak regex hiçbir test seçmediği için `f95e9ee2` bu paketi ayrı çalıştırıyor. `go test -race -v ./pkg/email -count=1` dokuz üst seviye testi çalıştırdı ve geçti.

Genel Go yarış denetiminde Docker kesintisinden önce tamamlanmayan repository ve services paketleri sekizer bölümde yeniden çalıştırıldı. On altı bölüm geçti. İlk koşuda tamamlanan diğer paketlerle birlikte bütün paketler denetlendi. Bu yerel sonuçlar GitHub CI kabulünü ve RF30 fiziksel cihaz kabulünü tamamlamaz.

### RF28 üretim paketi doğrulama açığı, 13 Kasım 2026

`d1fdaf00` üzerinde gerçek Go sunucusu ve mTLS PostgreSQL ile Chromium geliştirme koşusunda 14/14 test geçti. `HICHAT_E2E_PRODUCTION_CLIENT=1` ile aynı paket 3 geçti, 11 başarısız verdi. Bu sonuç RF28 üretim bundle kabulünü karşılamıyor.

Üretim koşusunda bazı yardımcılar `/src/api/client.ts`, `/src/stores/authStore.ts`, `/src/api/dm.ts` ve `/src/stores/uiStore.ts` modüllerini tarayıcıdan yüklemeye çalışıyor. Derlenmiş uygulamada bu kaynak yolları bulunmuyor. İlgili çağrılar `helpers.ts`, `dm-reply-navigation.spec.ts`, `reply-navigation.spec.ts` ve `role-visibility.spec.ts` içinde. Hazırlık verileri HTTP ile kurulmalı, test edilen gezinme ve yetki davranışları kullanıcı arayüzünden sürülmeli. Oturum yenileme eşzamanlılığı korunarak test yardımcılarının token erişimi yeniden düzenlenmeli. Diğer başarısızlıkların User Profile düğmesi bekleme süresinde oluşması ayrıca incelenmeli. Hata anındaki channel-notifications görüntüsünde yalnız HiChat logosu vardı. Bu nedenle düğme seçicisini değiştirmek için kanıt yok. Bu dalda loginAsCredentials zaten expectSignedInShell sonrasında onboarding kontrolünü yapıyor. Derlenmiş modüllerin yüklenmesi ve giriş sonrası yeniden yönlendirme sırasında oluşan tarayıcı hataları bir sonraki koşuda yakalanmalı.

**RF28 üretim DM düzeltmesi.** `159e5b2d` üzerinde üretim paketi, gerçek Go ve mTLS PostgreSQL ile DM yanıt geçmişi testi hazırlık dahil 2/2 geçti. İlk DM listesi isteği sürerken yalnız okundu metadata'sının değişmesi yanıtın tamamını attırıyordu. Store bu durumda listeyi yükleyip değişen okundu sayılarını koruyor. Konuşma listesi değişmişse eski snapshot engeli sürüyor. 102 DM store testi ve ESLint geçti. Sunucu snapshot'ında konuşmanın varlığı ve klavyeyle yanıt önizlemesinden eski mesaja geçiş ayrıca doğrulandı. Tüm üretim Chromium paketinin bu düzeltmeyle birleşik tekrarı bekliyor.

**RF28 birleşik üretim tekrarı.** `0c9a104f` kaynak durumunda Chromium paketi 14/14 geçti. Üretim istemcisi `npm run build -- --base=/` ile derlendi ve Vite preview üzerinden sunuldu. Gerçek Go sunucusu ve mTLS PostgreSQL kullanıldı. Koşu yaklaşık iki dakika sürdü. Yenileme endpoint'i 429 ve 25 saniyelik Retry-After döndürdü; istemci yeni isteği bekletti ve oturum toparlandı. Hazır ekran için 90 saniye, test başına 120 saniye ayrıldı. Bu sonuç fiziksel cihaz ve GitHub CI kabulünü tamamlamıyor.

**RF03 güncel kapsam.** `2b4a13b5` üzerinde `npx vitest run --coverage` 467 dosyada 4.706 test geçti, bir opt-in benchmark atlandı. Genel statement %66,24, branch %63,73, function %60,59, line %67,16 ölçüldü ve yapılandırılmış eşikler geçti. DM store line %84,69 ve branch %74,51, server store line %78,66 ve branch %71,42 oldu. Bu ölçüm kaynak test kapsamıdır.

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

## Ayrı PR doğrulaması — 13 Kasım 2026

- PR #267, `a341faba`: WebSocket profil ömrü düzeltmesi temiz main tabanında doğrulandı. `go test -race ./ws -count=1` geçti. Kapanmış kayıt ilk regresyon koşusunda başarısızdı; kayıt reddi düzeltildikten sonra geçti. Kapanış sırasında profil temizliği, kayıt bekleyicisinin serbest bırakılması ve istemci kapanışı dahil iki regresyon `-count=20` ile geçti. Yerel günlükler `%TEMP%/hichat-ws-profile-review-fixed.log` ve `%TEMP%/hichat-ws-registration-repeat.log`.
- PR #268, `4771c7c8`: Sunucu listesi snapshot sıralaması temiz main tabanına ayrıldı. `npx vitest run src/stores/serverStore.navigation.test.ts` 15/15 geçti; iki değişen dosyanın ESLint denetimi geçti. Aynı testler origin/main sunucu store koduyla çalıştırıldığında 6 başarısız ve 9 başarılı sonuç verdi. Sabit kaynak geri yüklendi ve çalışma ağacı temizliği denetlendi. Negatif koşu günlüğü `%TEMP%/hichat-server-list-before.log`.

Bu kayıt yerel kaynak doğrulamasıdır. PR CI, birleştirme, yayın ve fiziksel cihaz kabulü ayrı kalır.

**RF28 bağımsız üretim paketi.** PR #238 dalında `c5feda38` üzerinde `HICHAT_E2E_PRODUCTION_CLIENT=1 npx playwright test --project=chromium`, gerçek Go ve mTLS PostgreSQL ile 11/11 geçti (2,1 dakika). Sunucu hazırlığı ve rol testi artık `/src` modüllerini yüklemiyor; oturum yanıtındaki token test belleğinde tutularak gerçek HTTP kullanılıyor. `npm run test:isolation` geçti; Windows dosya symlink senaryosu atlandı. Koşu günlüğü `%TEMP%/hichat-production-review-chromium.log`. Sunucu silmede LiveKit foreign-key hataları ve bir app-log batch timeout görüldü; tarayıcı başarısı bu sunucu hatalarının kapandığı anlamına gelmez. Birleşik daldaki `b26ac84c` / `0feb7ec5` silme düzeltmeleri ayrı teslim edilmelidir.

**RF03 uzak kabul.** PR #263 ve #264 için 13 Kasım son denetiminde 36/36 GitHub kontrolü SUCCESS durumundaydı. Diğer PR'ların CI kapıları henüz kapanmadı; birleştirme ve runtime yayını yapılmadı.

**RF17 bağımsız ayarlar yükleme ölçümü.** `f66c7b92` üzerinde ayarlar yalnız açıkken React.lazy ile bağlanıyor. Aynı Node ve `npm run build` komutuyla temiz main tabanında AppLayout JS 974,48 kB / gzip 271,78 kB iken 951,21 kB / gzip 265,46 kB oldu. Ayrılan SettingsModal JS 26,24 kB / gzip 7,65 kB. AppLayout CSS 10,57→6,68 kB. Altı modal testi, iki değişen dosyada ESLint, TypeScript ve Vite geçti. Bu ölçüm başlangıç gecikmesini kanıtlamaz. Günlükler `%TEMP%/hichat-settings-build-before.log` ve `%TEMP%/hichat-settings-build-after.log`.

**RF17 vurgu zamanlayıcısı.** PR #272, `97c6882a`, temiz main tabanında kanalın iki gezinme yolu ve grup DM için ortak satır bazlı zamanlayıcı kullanıyor. Aynı satıra tekrar gidildiğinde ilk timeout'un ikinci vurguyu erken kaldırdığı regresyon önce başarısız oldu; düzeltme sonrasında geçti. Ayrı satırların süreleri bağımsız sınandı. Hedefli koşuda 49 geçti, bir opt-in test atlandı. TypeScript geçti; ESLint sıfır hata ve mevcut iki TanStack Virtual uyumluluk uyarısı verdi. PR #266 son GitHub denetiminde 36/36 SUCCESS; birleştirilmedi.

## PR teslimat uzlaştırması — 13 Kasım 2026

Toplu GitHub kontrolü `implementation/verification/refactor-pr-snapshot-2026-11-13.json` içinde PR numarası, dal, güncel head, taslak durumu ve CI özetiyle saklandı. Bu anlık görüntüde 43 açık refactor PR'ının kontrolleri tamamlandı; devam edenler ayrı gösteriliyor. Başarılı CI, merge veya fiziksel runtime kabulü anlamına gelmez.

LiveKit silme düzeltmesinin mevcut PR #222 ile sonradan açılan PR #270'te aynı olduğu doğrulandı. #270'in tek ilave testi #222'ye taşındı (`a138717c`); iki dalın dosya ağaçları eşit. #270 kapatıldı. Bu belgedeki önceki #270 referansları tarihsel kayıttır; kanonik teslimat #222'dir ve test eklenmesi nedeniyle yeni CI koşusu beklenir. Ana çalışma ağacı değiştirilmedi.

**RF11 mevcut PR #223 genişletmesi.** `04fd775b` üzerinde DM iletişim e-postası ve dar tepki tercih okuyucusu constructor'a taşındı; setter/type assertion yolları kaldırıldı. Mevcut üretim ve test çağrıları aynı dalda güncellendi. PostgreSQL DSN ile `go test ./services -run 'TestSendMessage_|TestPrivateReaction|TestDM' -count=1 -v` 59 üst düzey test geçti, skip yok. Seçim gerçek PostgreSQL outbox/idempotency senaryoları ile mock tabanlı constructor davranışlarını birlikte kapsar; bütün testler PostgreSQL kullanıyor iddiası değildir. Docker race altında SendMessage/private reaction seçimi, `go vet ./services` ve `go build ./...` geçti. İlk dar filtre yalnız bir private-reaction testini seçtiğinden tam DM kanıtı olarak kullanılmadı. Günlükler `%TEMP%/hichat-service-wiring-dm-pg-full.log` ve `%TEMP%/hichat-service-wiring-dm-race.log`. PR #223 güncellendi; yeni CI bekleniyor.

**RF11 grup constructor devamı.** PR #223 `433fb609`, grup DM tepki deposu, dar tercih okuyucusu ve engelleme denetimini constructor'a taşıyor. Değişen servis/handler seçimi 33 üst düzey test geçti. Grup kabul fixture'ı PostgreSQL desteğine geçirildi; gerçek mTLS PostgreSQL üzerinde iki ana ve 18 alt senaryo geçti. Aynı senaryolar CI PostgreSQL race filtresine eklendi. SQLite/mock race seçimi services 155,856 s ve handlers 47,581 s ile geçti; vet ve tam server build geçti. Günlükler `%TEMP%/hichat-group-admission-constructor-pg.log` ve `%TEMP%/hichat-group-constructor-review-race.log`. Güncel PR CI bekleniyor.

**RF11 tercih constructor devamı.** PR #223 `313c2b85` üzerinde profil audience invalidation, game activity sync ve hub constructor parametresi oldu. Optional setter yolları kaldırıldı; üretim kurulumu ve tüm mevcut çağrılar güncellendi. `go test -race ./services ./handlers -run 'TestPreferences' -count=1 -v` 11 ana test geçti. SQLite HTTP integration, hassas veri içermeyen audience olayı ve başarısız yazmada callback olmaması kapsanıyor; PostgreSQL tercih kabulü iddia edilmiyor. Vet ve tam server build geçti. Günlük `%TEMP%/hichat-preferences-constructor-review-race.log`. PR #265 ve #268 son kontrolde 36/36 SUCCESS; merge yapılmadı.

**RF11 üyelik constructor devamı.** PR #223 `ab6e58f2` üzerinde member profil audience ve game activity invalidator bağımlılıkları constructor'a taşındı. Ortak game activity servisi üyelikten önce kurulup tercih servisi tarafından da kullanılıyor. Üyelik/profil seçiminde 28 ana test ve aynı seçimin services/handlers/middleware race koşusu geçti. Gerçek mTLS PostgreSQL rol transaction testinde dokuz alt senaryo geçti; geri alma, revoked manager ve eşzamanlı grant sonrası replacement kapsanıyor. Vet ve tam build geçti. Günlükler `%TEMP%/hichat-member-constructor-review-race.log` ve `%TEMP%/hichat-member-constructor-review-pg.log`. Güncel PR CI bekleniyor.

**RF11 sosyal servis constructor devamı.** PR #223 `ec263a53`, block/friendship oyun etkinliği invalidator bağımlılığını constructor'a alıyor. 26 ana sosyal servis testi race ile geçti. Atomik block testi ayrıca yazma sürerken ve başarısız yazma sonrasında invalidation olmamasını, başarılı yazma sonrasında bir kez yapılmasını doğruladı; bu ek test de race ile geçti. Vet ve tam build geçti. Sonuçlar mock/service düzeyindedir; PostgreSQL sosyal transaction kabulü iddia edilmez. Günlük `%TEMP%/hichat-social-constructor-review-race.log`. PR #267 güncel son kontrolde 36/36 SUCCESS; #269 son kontrolde 33 başarılı ve bir çalışan kontrol vardı.

**RF11 sunucu constructor devamı.** PR #223 `72f2da9e` sunucu activity invalidator ve tercih deposunu constructor'a alıyor. Katılım seçiminde 10 ana test race ile geçti; başarılı yazmadan sonra bildirim, başarısız üyelik yazmasında callback olmaması ve doğru hesaba tercih okuması doğrulandı. Vet ve tam build geçti. Ayrılma/silme davranışları ayrı PR #253/#222 kapsamındadır. Birleşik dalın mevcut kaynaklarında iki lifecycle testi tekrar geçti; owner/admin silme gerçek mTLS PostgreSQL, ayrılma callback sırası mock fixture kullanıyor. Günlükler `%TEMP%/hichat-server-constructor-review-race.log` ve `%TEMP%/hichat-server-lifecycle-integration-current-pg.log`. PR #223 güncel CI bekleniyor.

**RF11 kanal ve hub sözleşmesi.** PR #223 `3d1e6ba6`, kanal silme sonrası voice cleanup constructor bağımlılığı, voice constructor dönüşünde cleanup garantisi ve startup hub için durable/presence/game-join yeteneklerini statik sözleşme yapıyor. Üç ana kanal izin/silme testi race ile geçti; repository hatasında cleanup yapılmaması ve başarılı silme sonrasında doğru server/channel kapsamı doğrulandı. Tüm server için `go vet ./...` ve `go build ./...` geçti. Günlük `%TEMP%/hichat-channel-constructor-review-race.log`. Bu test mock servis sırasını kanıtlar; gerçek medya/cihaz kapanışı değildir. PR #223 güncel CI bekleniyor.

**RF16 yedek sürüm doğrulaması.** PR #228 `fd53cd23`: çözülmüş payload sürümü 0/2/metin 1/null iken eski kod dört regresyonda da içe aktarmayı kabul etti. Sürüm 1 dışındaki değerler artık yerel storage'a erişmeden false döndürüyor. Birleşik ve PR dalında 28 backup testi, lint ve TypeScript geçti. Yeni testler decrypted plaintext'i kontrollü vererek sürüm sınırını izole eder; mevcut round-trip testleri şifrelemeyi sınar. Tam codec/storage ayrımı ve diğer bozuk payload alanları hâlâ RF16 açık kapsamıdır. PR #238 son kontrolde 36/36 SUCCESS; PR #228 yeni CI bekliyor.

**RF16 saf içerik codec'i.** PR #228 `6d67baa4`, BackupContents tipini ve JSON alan/base64 doğrulamasını storage bağımsız `backupContentsCodec.ts` sınırına taşıyor. Üç yeni regresyon önce başarısızdı: string registrationId kabul ediliyor, bozuk anahtar ve sessions ise snapshot/clear sonrası rollback'e ulaşıyordu. Düzeltme sonrası birleşik ve PR dalında 46 codec/backup testi, lint ve TypeScript geçti. Saf fixture'lar iç içe bozuk alanları, kesilmiş/non-object JSON'u, eksik eski preKeys, boş anchor ve additive alanları kapsıyor. Replay alanları mevcut normalizasyon politikasını koruyor. Ratchet alanlarının tam semantik doğrulaması, serializer any kaldırma ve account-bound storage/orchestration ayrımı hâlâ açık; RF16 kapanmadı.

**RF11 CI güvenlik kapısı düzeltmesi.** PR #223 security job'ı, `dm_delivery_test.go` için stale reviewed-source hash nedeniyle başarısız oldu. `8072e489` ile dosya farkı incelendi: tek değişiklik constructor'a iki nil bağımlılık eklenmesi; SQL eşleşmesi ve line hash aynı kaldı. Yalnız o dosyanın manifest hash'i güncellendi (`4060e242`); kural, path, reason ve proof genişletilmedi. Tam `self-scan.sh` exit 0, sıfır BLOK ve 421 non-blocking inceleme satırı verdi; manifest doğrulayıcısının altı testi geçti. Günlük `%TEMP%/hichat-wiring-selfscan-review.log`. Düzeltme gönderildi, yeni CI bekleniyor. PR #271 ve #272 son kontrolde 36/36 SUCCESS.

**RF16 tipli oturum codec'i.** PR #228 `83fa3d2e`, recursive any serileştirmeyi `backupSessionCodec.ts` içine unknown tabanlı dönüşüm ve SessionState doğrulaması olarak ayırıyor. 32-byte ratchet anahtarları, nullable zincirler, tamsayı sayaçlar ve skipped-key kayıtları doğrulanıyor. Golden fixture eski __b64 JSON'u ile aynı bayt gösterimini ve tüm alanların round-trip eşitliğini sınar. Gerçek encrypted create/restore testi oturumun aynı alanlarla saveSession'a ulaşmasını doğruladı. Önceki preflight codec ile bozuk ratchet verisi snapshot'a ulaştı; regresyon başarısız oldu. Son PR dalında 57 test, lint ve TypeScript geçti. Unknown session extension alanları korunur; storage/orchestration ayrımı ve fiziksel çok cihaz kabulü açık. PR #223 güncel Security scan SUCCESS; diğer CI işleri sürüyor. PR #222 36/36 SUCCESS.

**RF16 hesap kapsamlı backup storage ayrımı.** PR #228 `13b6c9e2`, şifreleme girişini storage collect/import/rollback ve ortak hesap/oturum guard modüllerinden ayırıyor. keyBackup artık keyStorage'a doğrudan başvurmuyor. Taşınan üç işlemin gövdeleri önceki kaynakla export bildirimi dışında birebir karşılaştırıldı. Ortak BACKUP_VERSION codec'den kullanılıyor. Birleşik ve PR dalında dört dosyada 64 test geçti; lint ve TypeScript başarılı. Gerçek IndexedDB fixture'ları owner değişiminde açılış/yazma iptali, generation değişiminde geç okuma reddi ve eski global DB'ye erişmeme sınırlarını kapsar. Mevcut backup rollback ve encrypted session round-trip testleri geçti. Daha geniş keyStorage ayrımı, legacy corpus ve fiziksel çok cihaz kabulü açık. Yeni CI bekleniyor.

**RF16 IndexedDB sahipliği ayrımı.** PR #228 `112b6d6a`: hesap/backend adlandırması, şema, connection cache, proxy ve transaction guard `keyDatabase.ts` içine ayrıldı; mevcut keyStorage export yüzeyi re-export ile korundu. Namespace, schema version ve object store değişmedi. Database fonksiyon gövdeleri önceki kaynakla export bildirimleri dışında eşit. Birleşik dalda 95 storage/backup testi; temiz PR dalında beş dosyada 115 test ve ayrı legacy arşiv dosyasında 15 test geçti. Lint ve TypeScript başarılı. Fake-indexeddb gerçek IndexedDB API fixture'ıdır; fiziksel tarayıcı/cihaz kanıtı değildir. Legacy testleri açık onay, owner/key kanıtı, atomik kopyalama, kaynak korunumu ve dolu hedef reddini sınar. Güncel CI ve tarihsel kullanıcı arşivi/cihaz kabulü açık.

**RF03 birleşik storage refactor kapsamı.** `a08d2fb1` üzerinde `npx vitest run --coverage` exit 0: 469 dosyada 4.741 geçti, bir opt-in benchmark atlandı, unhandled error yok; 116,54 s. Statements %66,34, branches %63,84, functions %60,71, lines %67,27; eşikler geçti. Önceki `d9c722b2` koşusunda tüm assertion'lar geçmesine rağmen RegisterPage teardown RPC hatası nedeniyle exit 1 alındı ve başarılı sayılmadı. Kayıt fixture'ı tercih API'sini deterministik kılıyor ve gerçek auth-store yolunun başlattığı hydration'ı bekliyor. Dört test ve lint temiz PR #224 dalında geçti; güncelleme gönderildi. Sonraki `2b7339a3` yalnız bu testin satır sonlarını normalize etti; EOL hariç diff boş. Modül metrikleri ve iki koşunun ayrımı `implementation/verification/refactor-storage-client-coverage-2026-11-13.json` içinde. Yeni #224 CI ve #228 doğrulaması ayrı kalır.

**RF28 storage refactor üretim tekrarı.** Birleşik `8212d816` kaynaklarında gerçek Go API/WebSocket, verified-mTLS PostgreSQL ve root-base üretim istemcisiyle Chromium 14/14 (2,3 dk), WebKit smoke 1/1 (40,0 s) geçti. Kaynak koşular boyunca değişmedi. Yeni database/storage/codec modülleri üretim başlangıç yolunda çalıştı; Chromium iki oturumlu izin, mesaj/yanıt geçmişi, upload/retry ve arşiv erişimini kapsıyor. WebKit sonucu yalnız auth/recovery smoke kapsamındadır. Komut/commit/log ayrımı `implementation/verification/refactor-storage-production-e2e-2026-11-13.json` içinde. Fiziksel medya, çok cihazlı backup restore ve yayın kabulü değildir. RF16 no-key-logging maddesi için backupStorage rollback hata loglarının ayrı olumsuz testi gerekiyor; ham error argümanı mevcut.

**RF16 rollback log gizliliği.** PR #228 `c70c700e`: sentetik private key ve özel metadata kimliği taşıyan error nesnesiyle yeni regresyon eski kodda başarısız oldu. Restore ve rollback console çağrıları artık raw error almıyor; sabit mesaj, statik store adı ve hata sayısı kalıyor. Test hem tüm log argümanlarının string ve içeriksiz olmasını hem private metadata'nın rollback ile geri gelmesini hem de eksik rollback sayacını doğruluyor. Birleşik ve PR dalında 58 backup/codec testi, lint ve TypeScript geçti. Önceki gerçek cihaz/çok kullanıcı kabulleri bu düşük etkili log değişikliği için yeniden iddia edilmedi. Güncel PR CI bekliyor.

**RF16 sabit eski-yazıcı corpus.** PR #228 `9e529cce`, `f33f6d9a` üretim createBackup işleviyle mocked okuyucudan üretilmiş iki sentetik ciphertext fixture'ı içeriyor. Biri değiştirilmemiş 2M yazıcı; diğeri default KDF 1M yapılıp dış algorithm alanı kaldırılarak eski zarfı taklit eder, gerçek pre-audit kullanıcı arşivi değildir. Geçici kaynak değişimi finally ile geri alındı; gerçek key DB okunmadı/yazılmadı. Fixture SHA-256/provenance testte ve README'de sabit. On yeni test bütün kayıt ailelerini boş hedefe geri yükleme, frozen hash, yanlış parola, kesilmiş ciphertext ve farklı owner için bütün yazma çağrılarının yapılmamasını kapsar. Birleşik ve PR dalında mevcut backup dosyasıyla toplam 44 test, lint ve TypeScript geçti. Gerçek tarihsel kullanıcı arşivi ve cihaz kabulü ayrı açık kalır. PR #224 güncel son kontrolde 36/36 SUCCESS; #228 yeni CI bekliyor.

**RF20 credential IPC registrar.** PR #254 `2b5b2e93`, dört credential kanalını domain registrar'a ayırıyor; merkezi kurulum aynı trusted-main-frame predicate, storage ve net.fetch adaptörlerini verir. Ortak string/number validator gövdeleri taşındı; kanal/yanıt biçimleri, alan sınırları ve hata mesajları korunur. Birleşik Electron baseline 276 geçti/1 atlandı; ayrımdan sonra 281 geçti/1 atlandı. Beş yeni test sender/subframe reddi, pencere değişimi/yıkımı, alan sınırları, origin normalizasyonu ve username-only dönüşünü kapsar. PR dalında explicit Electron hazırlığından sonra 280 geçti/1 atlandı. İlk ignore-scripts kurulum koşusu bilinen paralel Electron extraction yarışıyla audio test importunda başarısızdı; ayrı #236 hazırlık düzenini kullanarak giderildi, gizlenmedi. Günlükler `%TEMP%/hichat-ipc-refactor-electron-before.log`, `%TEMP%/hichat-ipc-refactor-electron-after.log`, `%TEMP%/hichat-credential-ipc-pr-electron-prepared.log`. Güncel CI ve paketli fiziksel kabul açık.

**RF20 app settings IPC ayrımı ve own-property düzeltmesi.** PR #273 iki ayrı commit içerir: `75fc0412` kalıtılan Object anahtarlarının IPC ve settings setter tarafından kabulünü engeller; `11529a1f` iki ayar kanalını bağımlılıkları enjekte edilen registrar içine taşır. Kanal adları, boolean değer sınırları ve OS startup durumunu okurken cache ile eşleme korunur. Beş yeni test own-property anahtarları, geçersiz değerler, beş yazılabilir bayrak ve OS senkronizasyonunu kapsar. Birleşik dalda 286 geçti/1 atlandı; güncel main tabanlı bağımsız PR dalında 279 geçti/1 atlandı, TypeScript başarılı. PR dalı günlüğü `%TEMP%/hichat-app-settings-ipc-pr-electron.log`. Çakışma yalnız import satırlarında çözüldü; ayrı credential PR değişiklikleri bu dala alınmadı. CI ilk kontrolde 26 running ve 7 queued; henüz başarı iddiası yok. Fiziksel OS startup kaydı ve RF20'nin diğer registrar/overlay kabulü açık.
**RF20 updater IPC registrar.** PR #274 `e9e1e898` dört updater kanalını ayrı registrar içine taşır; canlı prelaunch state, updateInfo/null, indirme boolean sonucu ve silent/force-restart bayrakları korunur. Dört yeni contract testi; birleşik dalda 290 geçti/1 atlandı, main tabanlı bağımsız dalda yeni output dizininde 273 geçti/1 atlandı ve TypeScript başarılı. İlk PR koşusu önceki daldan kalan compiled testleri çalıştırıp başarısız oldu; yeni dizinde yalnız mevcut kaynak derlenerek doğrulandı. Günlük `%TEMP%/hichat-updater-ipc-pr-electron-clean.log`. Gerçek installer/provider erişilebilirliği ve diğer RF20 kabul kapıları açık; CI bekleniyor.
**RF03 Electron temiz derleme izolasyonu.** PR #236 `86256e96`, Electron binary hazırlığından sonra benzersiz geçici repo-altı dizine derler, yalnız o dizinin testlerini çalıştırır ve finally ile temizler. Önceki dalın dist-electron testleri yeni kaynak paketine karışmaz. Bilerek hata atan stale test dist-electron içine bırakıldığında PR dalında 269 geçti/1 atlandı; geçici dizin kalmadı. Birleşik kaynakta 290 geçti/1 atlandı. Günlük `%TEMP%/hichat-electron-isolated-runner-stale-proof.log`. PR #228 güncel head 36/36 SUCCESS; #236 yeni head için CI yeniden başladı. Açık PR snapshot yenilendi; kartların runtime/cihaz kabulleri yerine geçmez.
**RF12 native stop listener sahipliği.** PR #275 `310f0406`: hook unmount sonrası callback yeni paylaşım state'ini false yapabildi; yeni doğrudan hook regresyonu eski kodda başarısız oldu. Effect retirement callback'in store/WS yazmasını engeller; geç tamamlanan native kayıt hemen kaldırılır. Birleşik ve main tabanlı bağımsız dalda 15 hook testi, ESLint ve TypeScript geçti. Günlükler `%TEMP%/hichat-native-stop-listener-before.log`, `hichat-native-stop-listener-after.log`, `hichat-native-stop-listener-pr.log`. Bu düzeltme controller ayrımından önce yaşam döngüsü davranışını sabitler; fiziksel Android/iOS capture veya RF12'nin tamamlandığı iddia edilmez. CI bekleniyor.
**RF12 native token hata rollback.** PR #275 `7345c1f0`: denied ve success-without-data token yanıtlarında hook isStreaming=true bırakıyordu; iki regresyon eski kodda başarısız oldu. Güncel istek başarısızsa state/WS false olarak geri alınır; cancelled yanıt ayrı erken döner. Üçüncü test eski owner unmount sonrası geç denied yanıtın yeni owner state'ine/WS'ine dokunmadığını doğrular. Birleşik ve PR dalında 18 hook testi geçti; PR dalında ESLint ve TypeScript başarılı. Günlükler `%TEMP%/hichat-native-token-before.log`, `hichat-native-token-after.log`, `hichat-native-token-pr.log`. Controller ayrımı ve fiziksel platform kabulü açık; PR başlığı/gövdesi son kapsam için güncellendi, yeni CI bekleniyor.
**RF12 native controller ayrımı.** PR #275 `fbe528eb`, token/channel/start/stop akışını injected nativeScreenShareController içine ayırır; hook store/plugin/log adaptörlerini sağlar. Mevcut davranış düzeltmeleri ayrı commit olarak kalır. Dört controller testi token/native completion sırası, eksik sahiplik, kanal değişimi, error propagation ve stop delegasyonunu kapsar. Birleşik ve bağımsız PR dalında 22 test geçti; PR dalında ESLint ve TypeScript başarılı. Günlük `%TEMP%/hichat-native-controller-pr.log`. Browser/Electron controller, tüm platform characterization ve fiziksel ses/capture kabulü açık; RF12 kapatılmadı. PR #273 son gözlemde 27 SUCCESS/7 running; son durum olarak kullanılmamalı.
**RF12 native refusal sözleşmesi.** PR #275 `b8156efd`: startNativeScreenShare boolean sonucu dikkate alınmıyor, false yanıt bile started olarak bildiriliyordu. Controller regresyonu eski kodda başarısız oldu. Adaptör sınırı Promise<boolean> olarak daraltıldı; güncel owner false sonucunda mevcut hook hata/rollback/toast yoluna gider. İptal native sonucu önce kontrol edilir, retired owner yeni state'e dokunmaz. Hook testi stopped WS, state=false, toast ve started WS olmamasını doğrular. Birleşik ve PR dalında 25 test, ESLint ve TypeScript geçti. Günlükler `%TEMP%/hichat-native-refusal-before.log`, `hichat-native-refusal-after.log`, `hichat-native-refusal-pr.log`. Fiziksel capture kanıtı değildir; diğer RF12 controller/platform kabulleri açık.
**RF12 sıralı lifecycle controller.** PR #275 `7efe37fc`, start/stop kuyruğunu ScreenShareLifecycleController içine ayırır; hook effect cancellation ve platform/track cleanup adaptörlerini sağlar. Dört yeni deterministik test eski picker drain, iptal edilen explicit stop'un korunması, sıra öncesi iptal edilen start'ın atlanması, hata sonrası kuyruk devamı ve retired owner hata bildirimi olmamasını sınar. Birleşik dalda 29 hook/controller testi; PR dalında LiveKit ve P2P ile beş dosyada 76 test geçti. ESLint ve TypeScript başarılı. Günlük `%TEMP%/hichat-screen-lifecycle-pr.log`. Native controller ve lifecycle ayrımı gerçek kullanımda bağlı; desktop capture/restart ve fiziksel kabul açık. PR gövdesi son kapsam ve güncel test sayısıyla yeniden yazıldı; CI bekleniyor.
**RF12 native restart retirement.** PR #275 `1c724cd3`: kalite restart'ının native stop aşaması beklerken paylaşımı kapatmak ikinci capture başlangıcına yol açtı; yeni hook regresyonu eski kodda 2 start gözleyerek başarısız oldu. Restart iptali generation yanında güncel isStreaming ve kanal sahipliğini doğrular; watcher cleanup generation'ı emekliye ayırır. Parametrik stop/channel/unmount testi üç durumda da yeni başlangıç ve fazla started WS olmadığını doğrular. Birleşik dalda 32 hook/controller; PR dalında beş dosyada 79 test, ESLint ve TypeScript geçti. Günlük `%TEMP%/hichat-native-restart-retirement-pr.log`. PR #273 36/36 SUCCESS doğrulandı. Desktop controller ve gerçek cihaz kabulü hâlâ açık.
**RF12 desktop capture controller.** PR #275 `19e96bd2` Electron/browser capture ve audio publication/stop akışlarını hook'tan injected desktopScreenShareController'a taşır; UI/store/track owner adaptörleri hook'ta kalır. Unique stream retirement, stereo/DSP kapalı capture, picker sonrası audio intent, WASAPI track mute/publish/unmute guard ve cleanup sırası korunur. Dört doğrudan test owned stream cleanup/foreign stream korunumu, ownership failure, unsupported capture ve audio-before-video teardown'u sınar. Birleşik ve main tabanlı PR dalında altı dosyada 83 test, PR dalında ESLint ve TypeScript geçti. Günlük `%TEMP%/hichat-desktop-controller-pr.log`. Ara düzenlemede lint ref-render uyarısı ve eksik brace görüldü; lazy controller factory ile düzeltildi, bu ara koşular başarı sayılmadı. Native restart orchestration ayrımı, daha geniş platform/cihaz kabulü açık; RF12 kapatılmadı.
**RF12 restart controller ayrımı.** PR #275 `978567af`, native restart stop/start orchestration, cancellation ve suppression sahipliğini screenShareRestartController'a taşır. Hook debounce/UI adaptörlerini verir. Sekiz test işlem sırası, eksik owner, stop sırasında generation/streaming/channel değişimi, stop hatası ve newer restart suppression korunmasını kapsar. Birleşik ve bağımsız PR dalında yedi pakette 91 test geçti; PR dalında ESLint ve TypeScript başarılı. Günlük `%TEMP%/hichat-restart-controller-pr.log`. Native/Desktop/Lifecycle/Restart controller sınırları kullanımda; bütün platform characterization, mikrofon ayar paritesi ve fiziksel cihaz kabulü ayrıca uzlaştırılmalı. PR #274 güncel gözlemde 36/36 SUCCESS.
**RF03/RF12 birleşik controller coverage.** Kaynak `1ddcbc7db4c4c56eaa5ed571c9622a8785c61b29` üzerinde tam `npx vitest run --coverage` exit 0: 474 dosya, 4.782 geçti/1 opt-in skip, unhandled error yok, 102,77 s. Statements %66,55, branches %64,00, functions %60,92, lines %67,50; global ve outputRouting eşikleri geçti. Native/lifecycle/restart controller dört metrikte %100; desktop lines %96,29/branches %76,08; hook lines %79,82/branches %51,83. Eksik platform/hata branch'leri tam kabul sayılmadı. Kaynak/test/komut/module ölçümleri `implementation/verification/refactor-screen-controller-coverage-2026-11-13.json`; günlük `%TEMP%/hichat-client-coverage-after-screen-controllers.log`. Koşu sırasında ürün/test kaynağı değişmedi; yalnız kabul matrisi belgesi güncellendi. Fiziksel capture, ses duyulurluğu ve yayın kanıtı değildir.
**RF12 CI tip/kalite düzeltmesi ve kanıt düzeltmesi.** #275 `978567af` CI mobil/paket/imaj build'lerinde TS2322 verdi: desktop log adapter Record<string,unknown> kabul ediyor, gerçek logger yalnız primitive metadata kabul ediyor. `ba91df4c` adapter'ı gerçek sınıra daraltır. Önceki bu controller turundaki `npx tsc --noEmit` sonuçları uygulama tip kontrolü kanıtı değildir: root tsconfig files=[] ve project references taşıyor; bu komut referenced app'i derlememiş. Eski kayıtların TypeScript iddiası bu notla düzeltilir. Gerçek `npx tsc -b --force` eski PR head'de aynı hatayı yeniden üretti. Düzeltme sonrası birleşik ve PR dalında gerçek `npm run build` (tsc -b + Vite) exit 0 geçti. PR `9a8bbe18` Sonar iki floating diagnostic promise'i explicit void yapar, cognitive-complexity 33 fonksiyonu Electron/browser işlevlerine ayırır. `9820fd12` yalnız whitespace düzeltmesi, ignore-all-space diff boş. Son PR head'de yedi dosyada 91 test tekrar geçti. Günlükler `%TEMP%/hichat-screen-controller-typecheck-before.log`, `hichat-screen-controller-build-fixed.log`, `hichat-screen-controller-pr-quality-build.log`, `hichat-screen-controller-pr-quality-tests.log`. Sonar kalite kapısı ve yeni CI terminal sonucu henüz doğrulanmadı; eski başarısız sonuçlar başarı sayılmadı. Mikrofon matrisi işi bu CI hatasını düzeltmek için ertelendi.
**RF12 mikrofon adaptör matrisi ve gecikmeli capture retirement.** PR #275 `7de68a18` 16 ortak senaryoda yedi motorun konuşma/müzik profilini ve iki suppression-off durumunu gerçek useMicTest/gerçek MicrophoneTrackProcessor girişlerinde sınar; pipeline/model ve OS adaptörleri fake olduğundan fiziksel ses/model inference kanıtı değildir. Her iki yolda initial settings, canlı gain/gate/DeepFilter değişimi ve tek capture/dispose doğrulanır. `e7d9644e` gecikmeli unpublish sırasında ikinci owned track'in açık kalması regresyonunu düzeltir; eski kodda enabled=true görüldü. Önce bütün own-stream track'leri susturulur/durdurulur, sonra unpublish beklenir; yabancı stream korunur. Birleşik ve PR dalında on dosyada 123 test, changed-file ESLint ve PR dalında gerçek npm run build (tsc -b+Vite) geçti. Günlükler `%TEMP%/hichat-microphone-adapter-parity.log`, `hichat-desktop-retirement-before.log`, `hichat-capture-parity-retirement-pr-tests.log`, `hichat-capture-parity-retirement-pr-build.log`. Sonar önceki `9820fd12` analizi quality gate OK, yalnız await-in-loop smell kalmıştı; bu commit'te await loop dışına taşındı. Yeni head CI ve fiziksel/parite kapsamının kalanları açık.
**RF12 geniş ses regresyon paketi.** Birleşik kaynak `84bd45978c2423bd8ba21fb740e0b2ed253bac96` üzerinde `npm run test:audio` exit 0, 31 dosyada 336 test, 9,80 s. Ses motor/pipeline fallback, SDK processor, microphone admission, private call audio/camera, mic test, voice settings ve preferences sözleşmeleri birlikte çalıştı. Kanıt `implementation/verification/refactor-rf12-audio-suite-2026-11-13.json`. Fiziksel duyulurluk/capture, model inference ve nihai CI kabulü değildir. RF24 eski timeout kaydı 2026-11-13 12:05:58.501+03:00, count=2 ve insert context deadline exceeded içeriyor; mevcut log SQL lock/pool wait/network ayrımı sağlamadığından kök neden kapanmış sayılmadı. App-log writer bütçesi 2 s, shutdown drain 5 s; mevcut recursion guard service.applog olayını sink'e geri göndermiyor. Son #275 head CI sürüyor.
**RF24 gerçek PostgreSQL wait sözleşmeleri.** Yeni PR #276 `fcb7e9ec`: üretim retry wrapper üzerinden app-log insert için pool exhaustion (tek connection tutulur, DBStats.WaitCount gözlenir) ve DB lock (ACCESS EXCLUSIVE app_logs kilidi, pg_stat_activity/pg_blocking_pids gözlenir) testleri ekler. Her iki durumda deadline kimliği korunur, timeout insert'i sıfır kayıt bırakır; engel kalkınca aynı repo yazabilir. Gerçek verified-mTLS fixture ile birleşik dalda 4,78 s ve main tabanlı PR dalında 4,67 s, iki alt test geçti. Günlükler `%TEMP%/hichat-applog-pg-waits.log`, `hichat-applog-pg-waits-pr.log`. Bu iki farklı bekleme aynı timeout'u üretebildiği için eski E2E olayının kök nedeni hâlâ doğrulanmadı; kör retry ya da bütçe artışı uygulanmadı. Kaynak/test aktarımı ayrı draft PR, CI bekleniyor. #275 son gözlemde 11 SUCCESS/23 pending, failure yok; terminal kabul değildir.
**RF24 kısmi yazım kayıp sayacı.** PR #276 `02da226a`, batch capability olmayan fallback repository'nin önceki grouped Insert'leri başarılı olduktan sonra hata vermesi durumunda bu başarılı occurrence'ları FailedEvents'ten düşer. Önceki kod üç/beş olay yazılmışken altısının tamamını kayıp saydı; iki regresyon başarısız oldu. Dört fail-position senaryosu saved+lost=6 ve write failure sayısını doğrular. Error kaydına yalnız numeric written_rows/failed_events eklendi; otomatik retry politikası değişmedi. Birleşik ve temiz PR dalında 12 ana test/7 alt test geçti; Docker Go 1.26.10 targeted -race ./services -run ^TestAppLog exit 0, 16,414 s. Günlükler `%TEMP%/hichat-applog-partial-before.log`, `hichat-applog-partial-after.log`, `hichat-applog-partial-pr.log`, `hichat-applog-partial-race.log`. Yeni head gönderildi; CI bekleniyor. Bu sayım düzeltmesi eski PostgreSQL timeout'unun kök nedenini çözdüğü anlamına gelmez.
**RF12/RF24/RF28 güncel birleşik üretim E2E.** Kaynak `a4eccf63025868db7ffdb0fe4d8cb23f4690b49f` üzerinde gerçek Go HTTP/WS, isolated verified-mTLS PostgreSQL ve production Vite --base=/ ile Chromium 14/14 (2,1 dakika), ayrı WebKit smoke 1/1 (40,8 s) exit 0. İki koşuda server level=ERROR ve app-log batch failure satırı sıfır. Chromium warm-thread revocation/WS delivery, iki oturumlu rol görünürlüğü, kanal/DM eski reply history, upload/retry ve arşiv erişimini kapsar. Bir refresh 429, Retry-After=25 ile beklenip başarılı oldu; anonim/retired-session 400/401 debug kayıtları mevcut. Fixture'da yt-dlp/ffmpeg yok. Kanıt `implementation/verification/refactor-rf12-rf24-production-e2e-2026-11-13.json`. Bu koşu native controller'ın fiziksel medya yolunu, cihaz sesini, yayımlanmış sürümü veya eski timeout'un kök nedenini kanıtlamaz. Ürün/test kaynağı koşu boyunca değişmedi; sonraki RF19 updater incelemesi henüz düzenleme içermiyordu.
**RF19 runtime updater tekrar kurulum.** PR #277 `e1cec149`, setupAutoUpdater ikinci kez çağrıldığında timer değişse bile event listener'larının ikiye çıkmasını engeller. Gerçek derlenmiş modül fake Electron/updater ile VM'de yüklenir; eski kodda update-available listener sayısı 2 olduğu için regresyon başarısız oldu. Üç test repeated setup tek listener/poller/check/download notification, development no-op ve public event/poll forwarding'i sınar. Birleşik Electron 293 geçti/1 atlandı; main tabanlı PR dalı yeni compile output dizininde 272 geçti/1 atlandı. Günlükler `%TEMP%/hichat-updater-repeat-before.log`, `hichat-updater-repeat-after.log`, `hichat-updater-repeat-pr.log`. Kullanılan worktree'deki önceki untracked generated output korundu ve stage edilmedi. Fiziksel installer, tek install lifecycle ve diğer RF19 runtime kabulü açık; yeni CI bekleniyor.
**RF19 tek kurulum sahibi.** PR #277 `e1bcc7ef` notification/tray/renderer IPC'nin ortak process-lifetime installation gate kullanmasını sağlar. Çift notification click eski kodda iki quitAndInstall çağrısıyla regresyon verdi. Yeni test aynı indirildi olayının tekrarıyla oluşan başka notification click'ini de kapsar; saf gate testleri farklı entry point, synchronous failure/retry ve reentrancy'yi sınar. Silent/force-restart bayrakları korunur. Birleşik Electron 297 geçti/1 atlandı; main tabanlı bağımsız PR dalında yeni output dizininde 276 geçti/1 atlandı. Günlükler `%TEMP%/hichat-update-install-once-before.log`, `hichat-update-install-once-after.log`, `hichat-update-install-once-pr.log`. IPC çakışması main'in mevcut handler'ı korunup yalnız gate bağlanarak çözüldü; #274 extraction bu dala taşınmadı. Asynchronous installer/provider failure, gerçek kurulum, runtime cleanup/refactor ve cihaz smoke açık. #275 güncel head e7d9644e 36/36 SUCCESS olarak doğrulandı.
**RF24 CI gosec düzeltmesi.** #276 eski `02da226a` head'inde golangci-lint G115 signed int64 occurrence→uint64 dönüşümünü reddetti. Yeni `960132b7` dönüşümden önce occurrences>0 guard koyar; suppressed rule veya manifest istisnası eklenmedi. Birleşik dalda kısmi yazım regresyonu geçti. Main tabanlı PR dalında CI ile aynı Docker golangci/golangci-lint:v2.12.2 tam run --timeout=5m exit 0, 0 issues; ardından tüm ^TestAppLog testleri exit 0 (11,611 s). Günlükler `%TEMP%/hichat-pr276-lint.log`, `hichat-pr276-lint-fixed.log`, `hichat-pr276-lint-fixed-tests.log`. Düzeltme gönderildi, yeni CI bekleniyor. RF19 runtime controller çalışması bu CI hatası için kesildi; henüz kaynak düzenlemesi başlamamıştı.
**RF19 runtime controller ve shutdown sahibi.** PR #277 `fdbf92b4`, dört updater aboneliği ve poller'ı runtime-updater modülünde toplar; platform notification/window/tray adaptörleri auto-updater'da kalır. Will-quit disposer idempotent; yalnız kendi listener'larını kaldırır, eski available/progress/downloaded/error ve poll callback'leri çalışmaz. Önceki shutdown testi timer=1 gördüğü için başarısız oldu. Sibling listener korunumu ve offline check sonrası başarılı poll testi eklendi. Birleşik Electron 299 geçti/1 atlandı; main tabanlı PR dalı yeni output dizininde 278 geçti/1 atlandı. Günlükler `%TEMP%/hichat-updater-runtime-cleanup-before.log`, `hichat-updater-runtime-controller-final.log`, `hichat-updater-runtime-controller-pr.log`. Ara mekanik düzenlemedeki parse hatası düzeltilip tam suite tekrarlandı; ara koşu başarı sayılmadı. Legacy splash/runtime eşlemesi, async installer failure ve fiziksel kurulum/notification kabulü hâlâ açık; yeni CI bekleniyor.
**RF19 renderer sürüm sahipliği ve SDK hata uyumluluğu.** PR #277 `701922a8` ready/progress/snooze regresyonlarını düzeltir; test fixture ayrımı `e3a62833` ayrı commit. Son `c55f8d40`, aynı tamamlanmış sürümün duplicate available/progress/downloaded olaylarında ready/snooze'u korur; farklı available sürüm eski ready owner ve snooze'u emekliye ayırıp yeni download'a geçer. Böylece SDK yeni indirme hatasında eski cache'i temizlerse eski installer kullanılabilir varsayılmaz. Eski kodda dört hook regresyonu başarısız oldu; son yedi hook testi PR kaynağında geçti. SDK BaseUpdater kurulum hatasını throw yerine synchronous error event ile bildirebildiği incelendi; `c1dcd6a3` installation gate bu çağrı süresinde geçici error observer kullanır. Önceki gate retry regresyonunda yalnız bir çağrı görüldü; düzeltmeyle iki deneme ve listener cleanup doğrulandı. Daha sonra gelen ilgisiz error başarılı gate'i açmaz. Birleşik Electron 301 geçti/1 atlandı; bağımsız PR Electron 280 geçti/1 atlandı; son client kaynağında ESLint ve gerçek npm run build exit 0 geçti. Client doğrulaması bağımlılık lock'ları eşitliği doğrulanmış mevcut worktree'de exact c55f8d40 detached checkout ile yapıldı; main çalışma ağacı korunur. Günlükler `%TEMP%/hichat-updater-ready-state-before.log`, `hichat-updater-final-pr-hook.log`, `hichat-updater-final-pr-build.log`, `hichat-install-emitted-error-before.log`, `hichat-install-emitted-error-pr.log`. Async installer error ve fiziksel kabul açık; yeni CI bekleniyor.
**RF19 saf updater state machine.** PR #277 `6162a224`, davranış düzeltmelerinden sonra hazır sürüm/progress/error/snooze geçişlerini updateCheckerState reducer'ına ayırır. Hook tek useReducer state'i, IPC abonelikleri ve token-scoped timer effect'ini yönetir; eski resume token'ı yeni sürümü veya sonraki dismiss'i değiştiremez. Sekiz pure state testi + mevcut yedi hook regresyonu birleşik ve exact PR detached kaynağında 15/15 geçti. ESLint ve her iki kaynakta gerçek npm run build (tsc -b+Vite) exit 0 başarılı. Günlükler `%TEMP%/hichat-updater-state-controller-tests.log`, `hichat-updater-state-controller-build.log`, `hichat-updater-state-controller-pr.log`, `hichat-updater-state-controller-pr-build.log`. IPC/hook public alanları korunur. Electron kaynakları önceki 280/1 PR doğrulamasından bu yana değişmedi; bu tur yeniden sayılmadı. PR #276 head 960132b7 36/36 SUCCESS doğrulandı. Yeni #277 CI bekleniyor; fiziksel kurulum ve async installer failure kapsamı açık.
**RF19 renderer install IPC rejection.** PR #277 `5eaec912`, preload installUpdate Promise'i reddedildiğinde hook'un reddi yakalayıp content-free diagnostic üretmesini sağlar; ready sürüm ve retry korunur. Önceki regresyon diagnostic olmamasıyla başarısız oldu; intentional fixture rejection ayrıca test tarafından gözlenerek pre-fix runner'a kontrolsüz hata bırakılmadı. Son bağımsız kaynakta 16 hook/state-machine testi, ESLint ve gerçek npm run build exit 0 geçti. İlk derlemeler fixture'ın Mock fonksiyonunu tam ElectronAPI'ye doğrudan cast etmesi yüzünden TS2352 verdi; typed Promise<void> adapter wrapper ile düzeltildi, unknown cast eklenmedi. Günlükler `%TEMP%/hichat-install-ipc-rejection-before.log`, `hichat-install-ipc-rejection-pr.log`, `hichat-install-ipc-rejection-pr-build.log`. Installer launch sonrası async OS/provider failure veya fiziksel kurulum kabulü değildir. Son birleşik coverage kaynak c68191df üzerinde ayrıca çalışıyor; sonuç henüz bu kayda dahil değil.
**RF03/RF19 güncel birleşik coverage.** Kaynak `c68191dfd4184e8e31c30e442cf48670b2402720`, Node v26.13.1 üzerinde tam npx vitest run --coverage exit 0: 476 dosyada 4.814 geçti/1 opt-in skip, 110,91 s; Unhandled Errors/EnvironmentTeardownError/Unhandled Rejection satırı yok. Statements %66,59, branches %64,03, functions %61,01, lines %67,53; mevcut global/outputRouting eşikleri geçti. Saf updateCheckerState dört metrikte %100; useUpdateChecker lines %100/functions %100, branches %62,5; web/legacy adapter branch eşlemesi açık. Kaynak test sırasında değişmedi (client/server/electron için c68191df..HEAD diff boş); yalnız evidence belgeleri güncellendi. Kanıt implementation/verification/refactor-updater-state-coverage-2026-11-13.json, günlük %TEMP%/hichat-client-coverage-after-updater-state.log. Fiziksel ses/capture/installer, provider yayın kabulü veya tüm proje refactor tamamlanması iddiası değildir.
**RF20 diagnostic IPC registrar.** PR #278 `cf05d808`, sekiz invoke kanalı ve diagnostic-log event validation/export orchestration'ını merkezi registrar'dan ayırır. Saat, dialog, güncel window, fs, logger ve trace adaptörleri injection ile verilir. Source=renderer zorlaması, 2000/64 input sınırları, binary upload ve saved/path/dumpCopied yanıtları korunur; sender policy genişletilmedi/daraltılmadı. Yedi contract testi kanal envanteri/local filename, invalid/boundary input, cancel/empty save, export/copy sırası, optional dump failure ve primary write/build failure ile verbose validation sırasını kapsar. Birleşik Electron 308 geçti/1 atlandı; git fetch sonrası güncel main tabanlı bağımsız dal yeni compile output dizininde 276 geçti/1 atlandı. Günlükler `%TEMP%/hichat-diagnostic-ipc-electron.log`, `hichat-diagnostic-ipc-pr.log`. Merkezi dosya çakışması yalnız diagnostics bölümü taşınarak çözüldü; ayrı credential/settings/updater/installer PR'ları bu dala alınmadı. Native dialog/dosya export ve diğer RF20 overlay/sender/session kabulü açık; yeni CI bekleniyor.
**RF20 overlay action windows.** Yeni PR #279 iki ayrı commit taşır: `dab68396` actions/notification-actions/chat-actions loadURL reddinde boş native child'ı kapatır, pending intent'leri temizler, failed yüzeyi normal snapshot'larda yeniden yaratmaz ve explicit feature retry ile toparlanır. Üç yeni alt test eski kodda destroyed=false ile başarısız oldu. `2139b103` yalnız bu üç non-focusable yüzeyin sabit native setup politikasını küçük overlay-action-window factory'ye ayırır; composer/session owner mantığı taşınmadı. Sandbox/contextIsolation/nodeIntegration=false, parent/focus/show, shape bölgeleri, floating level ve sabit dev/prod URL'leri dört factory testiyle doğrulandı (altı surface/environment kombinasyonu dahil). Mevcut sender/session, stale load, compatibility, crash/reload testleri korunur. Birleşik Electron 315 geçti/1 atlandı; bağımsız main tabanlı dal yeni output dizininde 276 geçti/1 atlandı, TypeScript başarılı. Factory'ye callback assignment taşınınca gereken null guard'lar eklendi; testte ES hedefinin desteklemediği .at kullanımı array index'e çevrildi, hedef/quality gate değiştirilmedi. Günlükler `%TEMP%/hichat-overlay-load-failure-before.log`, `hichat-overlay-load-failure-after.log`, `hichat-overlay-action-factory-final.log`, `hichat-overlay-action-factory-pr.log`. Physical compositor/DPI/multiple-display ve composer/snapshot ayrımı açık; CI bekleniyor.
**RF20 composer crash ve document factory.** PR #279 `83ed6557`: composer renderer crash sonrası native pencere kalıyordu; yeni regresyon destroyed=false ile başarısız oldu. Crash artık owner'ı kapatır, pending request'i unavailable yapar, main-window owner'a kapandığını bildirir ve aynı grant'in yeniden açılmasını engeller. `c332599f` ayrı refactor commit'i composer native kurulum/load/navigation/crash/close sahipliğini küçük factory'ye taşır; session/pending/snapshot domain mantığı core'da kalır. Altı factory testi focusable sandbox policy, sabit dev/prod URL, ilk yükleme vs main-frame reload, sibling listener korunumu, queued callback ve late load failure guard'larını doğrular. Birleşik Electron 322 geçti/1 atlandı; bağımsız main tabanlı PR dalı yeni compile output dizininde 283 geçti/1 atlandı. Mevcut plaintext-history izolasyonu ve sender/session testleri aktif. Günlükler `%TEMP%/hichat-composer-crash-before.log`, `hichat-composer-crash-after.log`, `hichat-composer-factory-final.log`, `hichat-composer-factory-pr.log`. Yeni CI bekleniyor; snapshot/lifecycle ayrımı ve fiziksel compositor/DPI kabulü açık. Pending protocol request'in kapanması sunucuya zaten iletilmiş mesajı geri alma iddiası değildir.
### RF20 — action renderer crash ownership (2026-11-13)

- Regression reproduced for actions, notification-actions and chat-actions: renderer termination retained a native child. The shared factory now reports crash to its exact owner, removes only its own listeners on close and ignores queued crash/late load callbacks after retirement.
- Chat action termination also closes its composer and settles the pending request as unavailable. This cancels the local request ledger; it does not recall an already forwarded server message.
- Before-fix fixture: `%TEMP%/hichat-action-crash-before.log`. Final integrated Electron compile/test: 327 passed, 1 skipped (`hichat-action-crash-final.log`). Canonical PR #279 head d698c7ce: 288 passed, 1 skipped (`hichat-action-crash-pr.log`), pushed; fresh CI pending. PR #278 head cf05d808: 36/36 successful checks verified.
- Physical compositor, DPI and multi-display acceptance remain open. Whole-project refactor is not complete.

### RF20 — retire action documents on reload/navigation (2026-11-13)

- Three before-fix regressions proved loaded action windows retained their owner during main-document reload/navigation. The factory now retires those owners, including associated chat composers. Initial loading, in-place navigation and subframe navigation remain permitted; queued callbacks after close cannot retire a replacement.
- Integrated source 14076896: TypeScript compilation and Electron suite 331 passed, 1 skipped (`%TEMP%/hichat-action-navigation-after.log`). Canonical PR #279 head c0f7fa39: compile and 292 passed, 1 skipped (`hichat-action-navigation-pr.log`), pushed; fresh head CI pending. Before-fix evidence: `hichat-action-navigation-before.log`.
- Physical window/compositor acceptance and remaining RF20 snapshot/lifecycle decomposition are still open.

### RF20 — action snapshot projections (2026-11-13)

- Extracted chat, notification and voice action payload builders from native window ownership. Sender/session revalidation, geometry and delivery remain in the owner; payload fields and existing HTTP/IPC contracts are preserved.
- Direct contract tests exercise compose expansion, selected opaque reply rows, private history/display-data exclusion and shared snapshot immutability. Existing native-owner tests still verify actual child delivery.
- Integrated source 6c191642: compile and 334 passed, 1 skipped (`%TEMP%/hichat-action-payload-integrated.log`). PR #279 head 4d8f4e53: compile and 295 passed, 1 skipped (`hichat-action-payload-pr.log`), pushed; CI pending for this head. No physical/compositor acceptance claimed.

### RF20 — passive HUD projection (2026-11-13)

- Extracted bounded passive HUD payload construction from the native owner. Geometry calculation, lifecycle clocks/tombstones and platform state remain in the caller; the pure builder projects the existing fields without changing renderer contracts.
- Direct tests cover newest-edge chat slicing, first-edge activity/notification slicing, geometry absence, effective participant limits and preference immutability. Existing owner tests retain welcome/go-live expiry, privacy and child delivery coverage.
- Integration 61eaf2dc compile/Electron: 336 passed, 1 skipped (`%TEMP%/hichat-hud-payload-integrated.log`). PR #279 head 8a76806e compile/Electron: 297 passed, 1 skipped (`hichat-hud-payload-pr.log`), pushed; current-head CI pending. Native physical display acceptance and remaining lifecycle/registrar inventory are open.

### RF20 — retired HUD callbacks (2026-11-13)

- Before-fix regression proved an old HUD hide callback could hide a replacement chat action window. Hide, move and will-move handlers now require their original native window to remain the current owner.
- Integration 8c7ca9d2 compile/Electron: 337 passed, 1 skipped (`%TEMP%/hichat-hud-owner-after.log`). PR #279 head 7d460948 compile/Electron: 298 passed, 1 skipped (`hichat-hud-owner-pr.log`), pushed; fresh CI pending. Before-fix evidence: `hichat-hud-owner-before.log`.
- Repaired a mixed-encoding RF20 status row introduced during the previous documentation edit; the entire status document now decodes as UTF-8. Remaining lifecycle ownership and physical display acceptance stay open.

### RF20 — failed HUD load ownership (2026-11-13)

- Before-fix fixture proved a rejected passive HUD load retained the native window. The rejection is now consumed, the current owner and its children are closed, and ordinary snapshots cannot produce a retry loop. Disable/re-enable or explicit close permits recovery. A late failure from a retired owner cannot close its replacement.
- Integration fa9bac98 compile/Electron: 339 passed, 1 skipped (`%TEMP%/hichat-hud-load-after.log`). PR #279 head e4fa9bac compile/Electron: 300 passed, 1 skipped (`hichat-hud-load-pr.log`), pushed; fresh head CI pending. Before-fix evidence: `hichat-hud-load-before.log`.
- Physical compositor and display recovery remain unverified; this is injected native-window contract evidence.

### RF19/RF20 — adapter acceptance and CI quality follow-up (2026-11-13)

- RF19: added web/no bridge, legacy downloaded/no metadata and legacy subscriptions/no cleanup callback acceptance. Integrated source 7b7840d9 and PR #277 head 24365ca4: 19 hook/state tests pass, targeted statements/branches/functions/lines all 100%. Canonical production build (`tsc -b && vite build`) passes; existing ineffective dynamic-import warnings remain. Logs: `%TEMP%/hichat-updater-adapters.log`, `hichat-updater-adapters-pr.log`, `hichat-updater-adapters-build.log`. This is targeted module coverage, not a new global coverage receipt. Physical installer and asynchronous failure acceptance remain open.
- RF20: PR #279 head e4fa9bac Sonar gate failed at 3.3% new duplication (limit 3%); duplicated crash setup was replaced with a parameterized surface matrix. Two S2681 guard readability issues were expanded into explicit multiline handlers. Integration 8c3213ce: compile + 339 passed/1 skipped; PR head 539e7e9e: compile + 300 passed/1 skipped. Logs: `hichat-overlay-quality-integrated.log`, `hichat-overlay-quality-pr.log`. Current-head CI must still verify the quality gate.

### RF20 — overlay action IPC registrar and discovery inventory (2026-11-13)

- Eleven action/confirmation/composer channels moved from central registration to `overlay-action-ipc.ts`. Existing authorization/session owners remain authoritative. Five routing tests cover rejection, missing/destroyed main window and identity-preserving delegation across all eleven channels.
- Integration c458dddc compile/Electron: 344 passed, 1 skipped (`%TEMP%/hichat-overlay-ipc-integrated.log`). Independent PR #280 head e57b103f: compile/Electron 274 passed, 1 skipped (`hichat-overlay-ipc-pr.log`), pushed as draft; CI pending. Main-base import conflict resolved without importing other unmerged registrars.
- Added a source-bound literal IPC registration discovery inventory under `implementation/verification/refactor-ipc-registration-inventory-2026-11-13.json`. It is not sender-policy acceptance: dynamic registrations and per-channel policy reconciliation remain open.

### RF20 — sender/session trace and real pending reload fixture (2026-11-13)

- Added an eleven-channel source-bound policy matrix in `implementation/verification/refactor-overlay-ipc-policy-2026-11-13.md`, distinguishing registrar routing, owner/frame/session policy and renderer/server access revalidation still requiring reconciliation.
- Audit found the old composer reload fixture attempted to send after exhausting its 64-ID cap; its immediate rejection was not evidence of cancellation. The fixture now rotates to a fresh grant and asserts actual forwarding before reload, then verifies cancellation and grant retirement.
- Integration 7e67ff78 compile/Electron: 344 passed, 1 skipped (`%TEMP%/hichat-overlay-reload-pending-integrated.log`). PR #279 head 38993999 compile/Electron: 300 passed, 1 skipped (`hichat-overlay-reload-pending-pr.log`), pushed; fresh CI pending. No physical or project-wide authorization completion claimed.

### RF20/RF15 — renderer policy and caller retirement acceptance (2026-11-13)

- Four renderer policy/access suites on source 289a473b: 56 passed; targeted statements 93%, branches 92.02%, functions 85.5%, lines 97.48%. Source-bound per-module metrics: `implementation/verification/refactor-overlay-renderer-policy-2026-11-13.json`; log `%TEMP%/hichat-overlay-renderer-policy.log`. These are target-module metrics, not global coverage.
- Added five real channel-store action tests separating caller revocation from account/composer reset: initial rejection, metadata wait, encryption wait, late response/cache suppression and retry-delay retirement. HTTP/encryption boundaries remain mocked. Integration cdf827b6 and independent PR #281 head 8ce6720b: 39 store/compose-hook tests pass. Canonical changed-file lint and actual tsc -b/Vite build pass (existing dynamic-import warnings). Logs: `hichat-overlay-store-context.log`, `hichat-overlay-store-context-pr.log`, `hichat-overlay-store-context-build.log`.
- Renderer hook rechecks fresh owner/generation/target/access and passes a live caller guard; store awaits now have explicit caller-only acceptance evidence. Server HTTP authorization, other IPC families and physical packaged overlay behavior remain independent open gates.

### RF20 — desktop source/display IPC boundary (2026-11-13)

- Extracted legacy desktop source enumeration and current-window display metrics into a two-channel registrar. Preserved sender policy, public names and response fields. Tests cover monitor movement, fractional DPI-to-physical-pixel rounding, primary fallback, zero refresh rate and uncached source shape.
- Integration 2d8c8dfb compile/Electron: 347 passed, 1 skipped (`%TEMP%/hichat-desktop-media-ipc-integrated.log`). Independent draft PR #282 head 3c8fc0a9: compile/Electron 272 passed, 1 skipped (`hichat-desktop-media-ipc-pr.log`), pushed. Main-base import conflict resolved without unrelated unmerged modules.
- CI snapshot: #277 head 24365ca4 32 success/2 pending; #279 head 38993999 11/23; #280 head e57b103f 19/15; #281 head 8ce6720b 1/32; no failures observed in these snapshots. This is not terminal CI proof. Injected screen contracts do not prove physical capture, compositor or multi-display acceptance.

### RF20 — window control and badge IPC boundary (2026-11-13)

- Five channels moved into `window-control-ipc.ts`: taskbar badge, attention flash, minimize, maximize toggle and close. Existing validators are injected from central registration; there is no duplicate validation implementation. Sender policy and public channel/response behavior are preserved.
- Four direct tests verify validation ordering and exact bounds, rejection without native mutations, non-image URL refusal, badge clear/null-icon, focused-window behavior, maximize state and absent main window.
- Integration 46b1a816 compile/Electron: 351 passed, 1 skipped (`%TEMP%/hichat-window-ipc-integrated.log`). Independent draft PR #283 head b4c5ad09: compile/Electron 273 passed, 1 skipped (`hichat-window-ipc-pr.log`), pushed. Canonical import conflict resolved without unrelated pending registrars.
- CI snapshots: #277 head 24365ca4 34 success/1 pending; #279 head 38993999 18/16; #280 head e57b103f 26/8; no failure observed. These counts are not terminal CI evidence. Physical Windows taskbar/tray and remaining registrar/lifecycle acceptance stay open.

### RF20 — registered game command registrar (2026-11-13)

- Nine local game commands now live in `registered-games-ipc.ts`, reusing the existing name registrar and injected trust/string validators. Tracker/detection initialization, overlay policy ownership and shutdown remain in central orchestration. Public channel/platform/registry contracts are preserved.
- Seven direct tests cover all-channel untrusted rejection, overlay support states, native selection/cancel/empty/unsupported paths, successful-only layout cleanup, boolean/ID bounds and adapter delegation.
- Integration eeb9af5d compile/Electron: 358 passed, 1 skipped (`%TEMP%/hichat-games-ipc-integrated.log`). Independent draft PR #284 head 989917c6: compile/Electron 276 passed, 1 skipped (`hichat-games-ipc-pr.log`), pushed. Import-only canonical conflict resolved without other pending registrars. CI pending; physical native game/dialog/overlay acceptance remains open.
- CI snapshots: #277 head 24365ca4 35 success/1 pending; #279 head 38993999 21/13; #280 head e57b103f 32/2, no failures observed. Await terminal current-head proof.

### RF19/RF20/RF28 — current source production E2E and terminal CI (2026-11-13)

- Integrated source 4dae7d7f held unchanged through both runs. Real Go server, fresh per-run verified-mTLS PostgreSQL databases, production Vite base=/: Chromium 14/14 passed (2.6m), WebKit smoke 1/1 passed (42.9s), both exit 0. Both logs contain zero server level=ERROR and app-log batch failures. Chromium includes refresh 400/401 diagnostics; assertions passed. ffmpeg/yt-dlp unavailable in this fixture.
- Source-bound evidence: `implementation/verification/refactor-overlay-updater-production-e2e-2026-11-13.json`; logs `%TEMP%/hichat-overlay-updater-production-chromium.log` and `hichat-overlay-updater-production-webkit.log`. Toolchain Node v26.13.1, Go go1.27.4 windows/amd64. This supersedes the older a4eccf63 browser receipt for the changed updater/app-log source.
- PR #277 head 24365ca4 and PR #280 head e57b103f each terminal 36/36 SUCCESS, verified live. No additional PR was merged. Packaged Electron, physical media/display, provider release and historical app-log root cause remain separate open gates.

### RF20 — capture and global shortcut command boundaries (2026-11-13)

- Extracted five legacy capture commands and four global shortcut commands into focused registrars. Worker/lease/keyboard ownership remains unchanged; original per-channel sender policy and return contracts are preserved. Existing validators are supplied by central registration.
- Five tests cover trust-before-owner ordering, exact promise/status/result propagation, UUID-v4 diagnostic tokens, 64-character validation delegation, native refusal and owner cleanup routing. These are adapter contracts, not physical WASAPI/keyboard acceptance.
- Integration 408d1113 compile/Electron: 363 passed, 1 skipped (`%TEMP%/hichat-capture-shortcut-ipc-integrated.log`). Independent draft PR #285 head 0e64ea5b: compile/Electron 274 passed, 1 skipped (`hichat-capture-shortcut-ipc-pr.log`), pushed; CI pending. Canonical import/constant conflict resolved while preserving badge constants still used on main.
- PR #279 head 38993999 now terminal 36/36 SUCCESS, including SonarCloud. Other snapshots: #281 27 success/7 pending; #282 23/11; #283 14/20; #284 12/22, no failures observed. Physical/source/runtime/release gates remain distinct.

### RF20/RF21 — terminal tracker disposal completion (2026-11-13)

- Before-fix regression proved a second dispose call completed while the first still awaited native child close. Terminal disposal now caches child-reap completion; every dispose caller and stop during terminal disposal await it. Immediate invalidation, one kill owner and permanent restart prevention remain intact.
- Regression covers concurrent dispose/dispose/stop, pending-before-close and completion-after-close, repeated terminal disposal and no restart. Integration 8c2a6a61 compile/Electron: 364 passed, 1 skipped (`%TEMP%/hichat-tracker-dispose-after.log`); independent draft PR #286 head 2d31ceec: compile/Electron 270 passed, 1 skipped (`hichat-tracker-dispose-pr.log`), pushed. Before-fix evidence: `hichat-tracker-dispose-before.log`.
- Initial push hit transient GitHub DNS resolution failure; unchanged push retry succeeded. No LFS or repository configuration was modified. This is tracker API completion evidence, not proof that Electron before-quit currently waits for all asynchronous cleanup; that wiring and physical helper shutdown remain open.

### RF20/RF21 — bounded application shutdown ownership (2026-11-13)

- Main previously let a repeated before-quit bypass pending capture cleanup and did not await IPC-owned tracker resources. Added one shutdown coordinator: repeated requests remain prevented, independent owners all start, failure diagnostics contain only fixed resource scopes, and quit resumes once. A 5-second deadline reports still-pending groups as timeout before continuing; timeout is not successful child-reap proof. Cookies remain best effort.
- IPC registration now returns a memoized cleanup promise, attempts every synchronous/asynchronous owner and awaits tracker completion even when a sibling fails. Removed its separate before-quit hooks; main owns the wait.
- Six tests cover actual compiled main/IPC wiring, repeated requests, multiple resource waits, rejected sibling cleanup, timeout/late completion and cookie nonblocking behavior. Old compiled main fails the repeated-quit regression (`%TEMP%/hichat-app-shutdown-before.log`). Integration 10ac8f08 compile/Electron: 370 passed, 1 skipped (`hichat-app-shutdown-integrated.log`); PR #286 head ad934651: compile/Electron 276 passed, 1 skipped (`hichat-app-shutdown-pr.log`), pushed. Current-head CI pending; physical Windows/updater/OS shutdown acceptance remains open.
- PR #281 head 8ce6720b reached terminal 36/36 SUCCESS. PR #283 client job failed in EditorDraftGuards LiveKit successful-save close behavior; log downloaded after a transient network retry. The failure is being investigated separately, not masked by a rerun.

### RF25/RF03 — settings commit-time draft ownership and full client refresh (2026-11-13)

- Investigating PR #283's failed EditorDraftGuards close assertion exposed a deterministic passive-effect timing gap: commit-time navigation could observe stale dirty state in either direction. Two new real-workspace regressions failed before the fix. Layout-phase draft registration now makes dirty/acknowledged state visible before committed navigation; form data remains in its owner. This is evidence of a real timing gap, not proof that it explains every historical CI flake.
- Dedicated draft PR #287 head 34053042: 24 editor/workspace tests and actual production build pass. Applied the same client patch to failed PR #283, new head eabf4065; the client tree matches the tested dedicated source. Fresh CI pending; no assertion removal, timeout increase or retry masking.
- Integrated source 660773c3 held unchanged through full coverage/build/lint: 476 files, 4824 passed/1 opt-in group-history benchmark skipped, 106.83s, exit 0; statements 66.59%, branches 64.04%, functions 61.01%, lines 67.53%. Coverage floors passed; zero unhandled/teardown error lines. Production tsc -b/Vite build passed; full ESLint 0 errors/8 warnings. Source-bound module metrics and logs: `implementation/verification/refactor-draft-guard-full-client-2026-11-13.json`.
- New log files under `%TEMP%`: `hichat-draft-commit-before.log`, `hichat-draft-commit-after.log`, `hichat-draft-commit-pr.log`, `hichat-draft-commit-build.log`, `hichat-draft-guard-full-coverage.log`, `hichat-draft-guard-integrated-build.log`, `hichat-draft-guard-integrated-lint.log`. Earlier 4dae7d7f E2E receipt remains source-bound and predates this draft/shutdown change. PR #282 head 3c8fc0a9 also reached 36/36 SUCCESS.

### RF20/RF21 — relaunch uses the cleanup owner; app command boundary (2026-11-13)

- Source audit found relaunch IPC called app.exit(0), bypassing before-quit/native cleanup. A regression on actual compiled central wiring failed before the fix (`%TEMP%/hichat-relaunch-before.log`); relaunch now schedules app.relaunch then app.quit, entering the bounded shutdown coordinator. Behavior fix f57d1016 and extraction 45c09509 are separate commits.
- Version/relaunch/clipboard adapters now live in `app-command-ipc.ts`, preserving channel names and existing string validator with 10 MiB bound. Three direct tests cover fresh version reads, relaunch/quit ordering and scheduling failure, and validation-before-unmodified clipboard write. The compiled central wiring regression remains active after extraction.
- Integrated source 45c09509 compile/Electron: 374 passed, 1 skipped (`hichat-app-command-integrated.log`). PR #286 head 56b3b64b compile/Electron: 280 passed, 1 skipped (`hichat-app-relaunch-pr.log`), pushed; fresh CI pending. Canonical conflicts resolved without importing other unmerged registrars/settings modules. Physical relaunch/updater/OS-driven quit acceptance remains open.
- PR #284 head 989917c6 reached terminal 36/36 SUCCESS. Other current-head snapshots: #283 eabf4065 11 success/23 pending; #285 0e64ea5b 33/1; #287 34053042 14/20; no failures observed in those snapshots.

### RF20 — renderer observer ownership and shutdown snapshot retirement (2026-11-13)

- Extracted one focused renderer observer owning the app creation listener and exact per-contents listeners. Destroyed contents detach/retire once; disposal preserves siblings and ignores queued/future callbacks. Current main crash/full navigation still revokes policy; subframes and in-place navigation do not.
- Shutdown immediately clears the retained overlay snapshot and rejects later acknowledged snapshots. A compiled old IPC cleanup fixture fails this regression because privateFixture remains retained (`%TEMP%/hichat-overlay-renderer-cleanup-before.log`). Actual IPC cleanup wiring tests now require observer cleanup and verify policy cannot revive after shutdown.
- Integration 3ef262e7 compile/Electron: 378 passed, 1 skipped (`hichat-overlay-renderers-integrated.log`). PR #286 head 9b5efe12 compile/Electron: 284 passed, 1 skipped (`hichat-overlay-renderers-pr.log`), pushed; fresh CI pending. Added failure acceptance ensures prepare/cookies/diagnostics cannot strand remaining cleanup or quit.
- Targeted Node coverage for compiled modules: application-shutdown and overlay-renderer-lifecycle 100% lines/branches/functions; tracker 94.93% lines, 77.55% branches, 90% functions. Source/scope-bound receipt: `implementation/verification/refactor-overlay-shutdown-module-coverage-2026-11-13.json`; log `hichat-overlay-shutdown-module-coverage.log`. These metrics are not whole-Electron or physical acceptance.
- PR #285 head 0e64ea5b reached 36/36 SUCCESS. PR #287 head 34053042 currently 25 success/9 pending; PR #283 head eabf4065 24/10; neither is terminal yet. Remaining startup ownership, full inventory reconciliation and physical quit/relaunch/export acceptance stay open.

### RF20 — ownership before partial IPC startup failure (2026-11-13)

- Before-fix compiled main wiring regression showed a late registration exception left shutdownIPC null (`%TEMP%/hichat-ipc-startup-before.log`). Registration now publishes its disposer before first resource acquisition. Every acquired join/shortcut/media/subscription/registry/tracker/controller/renderer observer is recorded immediately; disposal runs the acquired prefix in reverse order and shares one completion promise.
- Failed app initialization logs a fixed, content-free diagnostic and enters normal app.quit, allowing the already-published native cleanup owner to run under the existing deadline. New tests cover early disposer publication and compiled cleanup of a partial three-resource prefix without touching unacquired owners. Existing sibling-failure, tracker wait and snapshot retirement assertions remain active.
- Integration 38ebb42f compile/Electron: 380 passed, 1 skipped (`hichat-ipc-startup-after.log`). PR #286 head 9d23d91b compile/Electron: 286 passed, 1 skipped (`hichat-ipc-startup-pr.log`), pushed; fresh CI pending. Canonical conflicts resolved while preserving main's unrelated diagnostic/settings/registry adapters.
- PR #287 head 34053042 reached terminal 36/36 SUCCESS. PR #283 head eabf4065 currently 32 success/2 pending, no failures; its earlier failed head remains distinct. Physical startup/quit/relaunch and final whole-project acceptance are not established by these injected wiring tests.

### RF26/RF03 — generated focused coverage reports and lint scope (2026-11-13)

- Six of the integrated checkout's eight lint warnings came from generated lcov HTML JavaScript in root-level coverage-overlay-policy and coverage-updater-adapters reports. Added root-level `coverage-*/**` to the existing generated-output ESLint ignores. Report files were not edited; product source rules and scope remain active.
- Integration 11d9c00d full lint: exit 0, 0 errors/2 remaining source warnings (`%TEMP%/hichat-lint-generated-coverage.log`). ESLint API verification confirms a generated report is ignored, MessageList.tsx is included and react-hooks/incompatible-library remains warning level. Independent draft PR #288 head 76cf200c full lint: exit 0, 0 errors/7 existing source warnings (`hichat-lint-generated-coverage-pr.log`); its main-based tree differs from integrated refactor source. No product behavior changed, so no redundant behavior tests/build were added for this lint-only scope.
- Two integrated warnings remain at the TanStack Virtual ownership boundary. Official rule/design evidence reviewed: https://react.dev/reference/eslint-plugin-react-hooks/lints/incompatible-library and https://react.dev/reference/react-compiler/directives/use-no-memo . The mutable API compatibility debt remains open; no compiler escape hatch or rule suppression was added to claim resolution.
- PR #283 head eabf4065 reached terminal 36/36 SUCCESS after the draft-guard repair; the earlier failed head b4c5ad09 is not reused as a success receipt. Physical acceptance, remaining RF26 source-quality work and the full project goal remain open.

### RF29 — trustworthy WebSocket load profile before resource measurements (2026-11-13)

- Found the k6 script read top-level tokens although the real Go API returns success/data. HTTP success checks passed while no WS opened; repeated executor iterations retried login. A real bounded negative control showed the old script's 1657 HTTP checks passing with zero WS, but its process already exited 99 under the existing duration threshold. Earlier wording about a false green is limited to those HTTP checks, not the whole process. New checks reject the missing credential immediately and retain nonzero exit; no overall before-green claim is made.
- Fixed envelope validation, one measured connection per VU, explicit handshake/completed-hold counters and target counts, error/early-close checks, positive integer configuration and graceful hold completion. Fourteen Node VM contracts evaluate the actual k6 source; added them to the existing CI job without removing Electron preparation. Integration c2bda0c1 and independent draft PR #289 head 0fb62cf8: 14/14 pass; YAML parsed. Product Go/client code did not change.
- Actual k6 v2.4.0 one-VU smoke on c2bda0c1, real isolated Go/verified-mTLS PostgreSQL, ticket path: 5 checks pass/0 fail, handshake 1, completed session 1, heartbeat ACK 1, connection 9.5671 ms, session 35010.0356 ms. This single sample is not capacity or a latency distribution. Node-only negative control with missing token exits 99 and reports the credential check failure.
- Fixture port closed; explicit validated helper database drop succeeded (exit 0), then only this run's private descriptor/owner marker were removed. No production load occurred. Evidence: `implementation/verification/refactor-k6-session-contract-2026-11-13.json`; redacted logs under `%TEMP%` are listed there. Reproducible profile parameters and contract command are in loadtest/README.md. CPU/heap/DB wait, slow-consumer and extended soak remain RF29 work.
- PR #286 head 9d23d91b and #288 head 76cf200c both reached terminal 36/36 SUCCESS, verified live. No additional PR was merged.

### RF29 - retired slow WebSocket resource ownership (2026-11-13)

- Fixed f4157516: removeClient closes the retired transport outside the hub lock before presence callbacks; unregisterClient immediately retires completed clients even when its queue is full. Before-fix regressions both failed at 500 ms; afterward both passed five repeats and the full ws package passed.
- Extended the actual upgraded WebSocket fixture with injected stalled writes to eight default waves or 256 opt-in measurement waves. Every wave waits for both pumps and asserts zero remaining pumps and global/server membership. Three 256-wave runs passed; sampled goroutines stayed at 3, with heap samples recorded without asserting a universal memory threshold.
- Full ws race run passed in Docker golang:1.26.10-bookworm (14.611 s). This proves bounded injected-backpressure cleanup, not production throughput, authentication/database acceptance, or extended soak. Evidence: implementation/verification/refactor-ws-slow-cleanup-2026-11-13.json. Canonical draft publication/CI and broader RF29 measurements remain open.
- Canonical draft PR #290 head d4fdb757 adds the composed stalled-write/full-unregister-queue case: 768 waves passed, 384 saturated, zero pumps/membership retained; full independent ws race passed (7.187 s). golangci-lint v2.12.2 reported 0 issues before the test extension. Fresh-head CI is pending. PR #289 head 0fb62cf8 reached 36/36 SUCCESS. No additional PR merged.

### RF05 - portable cursor/list/join corpus extension (2026-11-13)

- Extended the shared SQLite/PostgreSQL transaction fixture with forward/backward tuple cursors and bound limits, dynamic IN parameters, nullable LEFT JOIN and empty results. Equal timestamp rows explicitly test the target-key tie break in both directions. A SQL-looking list value remains a bound value and must not select extra rows; no vulnerability claim is inferred.
- Five new scenarios passed on both real drivers using the same logical rows, with PostgreSQL over verified mTLS. Final tie-break fixture targeted run: exit 0, 0.291 s, %TEMP%/hichat-dialect-corpus-targeted.log. Earlier full database run before adding the tied row passed (22.174 s), excluding the separately configured TestOpenPostgresInlinePEMReconnect profile; %TEMP%/hichat-dialect-corpus-full.log. These are representative query-family fixtures, not a complete inventory of production SQL or evidence that RF05 is closed. Independent draft publication remains open.
- Published the RF05 corpus extension to existing canonical PR #221, head 89bd008f, preserving its baseline contracts instead of duplicating prerequisites in a main-based PR. Full canonical database package passed (28.591 s) including tied timestamps; golangci-lint v2.12.2 reported 0 issues, exit 0. Inline-PEM reconnect remains a separate CI profile. New-head CI is queued; earlier-head CI is not reused.

### RF05 - explicit error for incomplete quoted tokens (2026-11-13)

- Six regressions demonstrated that bindPostgres returned transformed SQL without error for unterminated single/double/backtick tokens and escaped PostgreSQL E strings. It now returns an empty query and a fixed error unless the token closes. This is lexical error-contract consistency with existing comment/dollar-string rejection, not a SQL parser or a demonstrated injection vulnerability. Backtick coverage describes scanner preservation, not PostgreSQL syntax support.
- Six positive controls preserve complete quoted content and binding, including doubled quotes and backslashes. Targeted before run failed all six negative controls; after run passed. Logs: %TEMP%/hichat-dialect-unclosed-before.log and hichat-dialect-unclosed-after.log.
- Full canonical database package passed with local verified-mTLS PostgreSQL (30.431 s), excluding the separately configured inline-PEM reconnect profile; %TEMP%/hichat-dialect-unclosed-full.log. Complete production SQL inventory and final-source acceptance remain open.
- Quoted-token fix published to canonical PR #221 head 24437845; golangci-lint v2.12.2 finished with 0 issues (exit 0). Integration counterpart 232e71e6 preserves the same product/test patch. New-head CI is pending; no merge performed.

### RF05 - reproducible source call inventory (2026-11-13)

- Added scripts/query-inventory: read-only standard-library Go AST scanner for candidate Exec/Query/QueryRow/Prepare calls, with/without Context. It reports source locations and direct string literals; identifiers and dynamic expressions remain explicitly unresolved. Receiver typing, reachability, build-tag filtering and runtime execution are not inferred.
- On integration e3b32199 source plus the tool: 181 non-test repository files, 957 candidate call sites, 654 literal and 303 unresolved. This replaces ambiguous text-count assumptions with a reproducible navigation artifact; it does not prove semantic corpus completion. Full JSON is local at %TEMP%/hichat-query-inventory.json. Positive/negative family fixture mapping remains RF05 work.
- Tool contracts verify context argument indexing, literal versus unresolved expressions, source locations, test-file exclusion and failure for missing repository source. They pass; added the command to the existing Go base CI job. Instructions and limitations are in scripts/query-inventory/README.md. No database or product behavior changed in this tooling commit.

### RF05 - real search-query tie ordering (2026-11-13)

- Traced unresolved postgres_search.go dynamic count/page queries to the existing real repository Search contracts. Added an equal-rank/equal-timestamp fixture with three visible rows, one excluded-channel row and a SQL-looking bound allow-list value. It checks count, all one-row offset pages and the terminal empty page on both database backends.
- Before-fix SQLite returned search-a on page zero where the explicit descending tie contract requires search-c. SQLite FTS now orders by rank first, then created_at DESC and id DESC; relevance remains primary. PostgreSQL already uses the timestamp/ID order and passed unchanged. This establishes tie behavior, not universal FTS/ILIKE relevance equivalence or snapshot-stable pagination during concurrent writes.
- All three SearchRepo contracts passed on SQLite (1.137 s) and real verified-mTLS PostgreSQL (2.396 s). Logs: %TEMP%/hichat-search-tie-before.log, hichat-search-tie-sqlite.log and hichat-search-tie-postgres.log. The source inventory remains incomplete; these tests map one dynamic query family to actual repository execution.
- Search tie fix: full golangci-lint v2.12.2 passed with 0 issues (exit 0). No broad repository rerun was substituted for the dedicated SQLite/PostgreSQL search contracts; fresh canonical CI follows the push.
- Search tie fix published to canonical PR #221 head f4d1b17d; integration counterpart 991ffac3. PR #290 head d4fdb757 reached terminal 36/36 SUCCESS, verified live. No additional PR merged. Remaining inventory, final integration and runtime acceptance gates stay open.

- Added a SQLite FTS relevance guard for the search tie fix: an older, higher-relevance hit must precede a newer lower-relevance hit. The fixture first verifies distinct actual FTS ranks. All four SearchRepo tests passed (3.002 s); go vet ./repository passed. A temporary timestamp-first mutation was rejected by this new test (exit 1) and the product file was restored byte-for-byte. Logs: %TEMP%/hichat-search-relevance-sqlite.log and hichat-search-relevance-mutant.log. This is a SQLite-specific relevance contract, not equivalence with PostgreSQL ILIKE ranking.

### RF20 - remaining overlay control/media command registration (2026-11-13)

- Moved seven layout/shortcut/media command registrations from ipc-handlers.ts to overlay-control-ipc.ts. Main-window authorization still precedes layout/shortcut effects; null shortcut bindings still lock after the owner decision. Media commands pass the unchanged event and unknown payload to the same broker, which owns sender/session/input validation.
- Three registrar contracts cover rejected main callers, acceptance results and null locking order, exact media event/payload forwarding and all seven channel names. Integration 1f6e5b95: full Electron 383 pass/1 skip. Canonical PR #286 source 71f5b6ed: unique clean compiled output, full Electron 289 pass/1 skip. Logs: %TEMP%/hichat-overlay-control-integrated.log and hichat-overlay-control-canonical.log. The initial canonical cherry-pick conflict was resolved by retaining its existing action handlers; unrelated action extraction was not imported.
- Snapshot acknowledgment and resource ownership remain in the lifecycle composition root. This registration refactor does not establish physical display/capture/quit acceptance or full sender/session inventory completion. Current-head CI must be refreshed after publication.
- Published to existing PR #286 head 4754d7fa; prior 9d23d91b CI success does not certify the new head. No merge performed.

### RF20 - preload/registration and sender-policy source reconciliation (2026-11-13)

- Static TypeScript AST inspection of integration 26ff1a81 finds 76 preload invoke/send call sites and 77 main on/handle registrations, with zero unresolved channel expressions and zero unmatched call/protocol pairs. voice-overlay-snapshot intentionally has both on and handle registrations. The receipt records every location and SHA-256 of every participating file: implementation/verification/refactor-ipc-channel-map-2026-11-13.json.
- Reviewed registration owners separately from channel matching: main sender assertions (credentials/join/registry/notices), owned main leases (PTT/system audio), consent/session delegates (overlay actions/media), picker owner/frame lifecycle, snapshot acknowledgment/stopping guard, and mixed legacy capture/shortcut paths. App commands/settings, desktop source getters, diagnostics, updater and window controls have no explicit sender predicate in their registrar; input bounds alone do not establish caller authorization. These are open capability-review/negative-test obligations, not claimed validated exploits.
- This source map does not prove runtime reachability on every platform, full sender/session authorization, or physical/native acceptance. RF20 remains open. The local parser was client TypeScript 5.9.3; root TypeScript 7 exposes version metadata without the AST API, so the failed initial parser attempt was replaced with the installed client parser rather than adding dependencies.

### RF20 - current-main-frame ownership for application mutations (2026-11-13)

- Source reconciliation found the same preload on main and overlay windows. Relaunch and clipboard mutation registrars did not consult the existing main-window predicate. Two failing-before regressions demonstrated effects were not rejected for foreign window/frame and retired main-window/frame cases. This is a demonstrated handler-boundary gap; no end-to-end exploit or compromised renderer is claimed.
- Both mutation handlers now require the existing current-main sender/frame assertion before validation or effects. Version reads remain available without this mutation capability. Tests cover foreign contents, subframes, missing frames, destroyed/absent windows, old frames after navigation and successful current-frame behavior. Existing clipboard bounds, unmodified text and relaunch-before-graceful-quit semantics remain covered. The real compiled composition test verifies assertion wiring before relaunch/quit.
- Integration d0644555: full Electron 385 pass/1 skip. Canonical source 51542656: unique clean TypeScript build, full Electron 291 pass/1 skip. Logs: %TEMP%/hichat-app-command-sender-before.log, hichat-app-command-sender-after.log and hichat-app-command-sender-canonical.log. Physical native acceptance and the remaining legacy registrar capability review remain open. The earlier 26ff1a81 channel-map receipt is immutable historical evidence, not a current assertion that this app-command gap remains unchanged.
- Published to existing PR #286 head 2802af2c; fresh CI pending. No merge performed.

### RF20 - main-frame ownership for persistent application settings (2026-11-13)

- Two failing-before regressions demonstrated set-app-setting did not reject foreign window/frame or retired main-window/frame callers. It now requires the existing current-main assertion before key/value validation, persistence or login-item writes. get-app-settings retains the existing read/synchronization behavior; known flags, boolean bounds and inherited-key rejection remain covered.
- Negative cases cover foreign contents, subframes, missing frames, destroyed/absent windows, old frames after navigation, malformed input from an unauthorized caller and zero persistence/OS effects. A compiled actual-composition test proves the main assertion is supplied and precedes native writes, followed by a successful authorized write.
- Integration 7cb1e478: full Electron 388 pass/1 skip. Existing canonical PR #273 source 4e708694: fresh unique TypeScript output, full Electron 277 pass/1 skip. Logs: %TEMP%/hichat-settings-sender-before.log, hichat-settings-sender-after.log and hichat-settings-sender-canonical.log. No physical startup registration was exercised; remaining IPC capability and runtime acceptance stay open.
- Published to canonical PR #273 head bb7ee036; fresh CI pending. PR #221 head 6c97592d reached terminal 36/36 SUCCESS, verified live. No additional PR merged.

### RF20 - updater action ownership before network/install effects (2026-11-13)

- Two failing-before regressions demonstrated check/download/install handlers did not reject foreign or retired main senders. All three actions now consult the existing current-main sender/frame assertion before provider or installer effects. Check/download authorization is outside provider try/catch, so denial rejects rather than becoming an absent-update/null or download-failed/false result. The read-only prelaunch status contract remains unchanged.
- Tests cover foreign contents, subframes, missing frames, destroyed/absent windows, old navigation frames and the current frame. Existing provider error normalization, retry and silent/forced restart flags remain tested. A compiled actual-composition test verifies the injected predicate and unchanged event before provider/installer effects.
- Integration 95a9ac4a: full Electron 391 pass/1 skip. Canonical PR #274 source a75fba63: fresh unique TypeScript output, full Electron 276 pass/1 skip. Logs: %TEMP%/hichat-updater-sender-before.log, hichat-updater-sender-after.log and hichat-updater-sender-canonical.log. No real installer was invoked; physical updater/relaunch and final integrated acceptance remain open.
- Published to existing PR #274 head 2fc8190d; fresh CI pending. No merge performed.

### RF20 - diagnostic native-operation ownership (2026-11-13)

- Two failing-before regressions demonstrated diagnostic operation callers were not rejected at the registrar for foreign/retired main frames. Added the existing current-main assertion before consuming crash state, building/exporting archives, opening the log directory, setting verbosity and starting/cancelling a performance trace. Seven privileged commands are gated; bounded renderer diagnostic logging and the read-only verbosity getter retain their existing behavior.
- Tests cover foreign contents, subframes, missing frames, destroyed/absent windows, old navigation frames, zero native/persistence/archive effects after denial, and successful current-frame use. Existing log bounds, upload binary contract, cancellation, optional dump behavior, file failures and verbosity validation remain covered.
- Integration 03678808: full Electron 393 pass/1 skip. Existing canonical PR #278 source 9734d1cf: fresh unique TypeScript output, full Electron 278 pass/1 skip. Logs: %TEMP%/hichat-diagnostic-sender-before.log, hichat-diagnostic-sender-after.log and hichat-diagnostic-sender-canonical.log. No physical export dialog or trace was exercised. Remaining source/media/window/shortcut capability review and final runtime acceptance remain open.
- Published to existing PR #278 head 862395ab; fresh CI pending. No merge performed.

### RF20 - desktop source enumeration ownership (2026-11-13)

- Two failing-before regressions demonstrated get-desktop-sources did not reject foreign/retired main frames. The registrar now requires the existing current-main assertion before source enumeration. Source contents, provider identity and uncached behavior remain unchanged; get-display-info retains its existing monitor/primary fallback contract.
- Tests reject foreign contents, subframes, missing frames, destroyed/absent windows and old navigation frames with zero provider calls, then allow the current main frame. Integration e897e460: full Electron 395 pass/1 skip. Canonical PR #282 source 8ae09b9d: fresh unique TypeScript output, full Electron 274 pass/1 skip. Logs: %TEMP%/hichat-desktop-source-sender-before.log, hichat-desktop-source-sender-after.log and hichat-desktop-source-sender-canonical.log.
- This is a registrar ownership contract, not a physical source-picker/capture permission or multi-display acceptance receipt. Remaining window/shortcut/capture capabilities and final runtime acceptance remain open.
- Published to existing PR #282 head c4cfdaff; fresh CI pending. No merge performed.

### RF20 - diagnostic capture and mute-hook mutation ownership (2026-11-13)

- Two failing-before regressions demonstrated diagnostic capture and mute-hook commands bypassed the already supplied main-window assertion. Both diagnostic start/stop and mute shortcut register/unregister now invoke that same assertion before worker/native effects and before token/key validation. Existing capture/PTT assertions and read-only capture status remain unchanged.
- Tests prove denial cannot start capture, stop with a valid or malformed token, validate an untrusted shortcut input or mutate native hooks. Authorized token validation, worker promise/results, registration refusal, bounds and hook cleanup remain covered; expected calls now include authorization before those operations.
- Integration aa4450ff: full Electron 397 pass/1 skip. Canonical PR #285 source b5aafd32: fresh unique TypeScript output, full Electron 276 pass/1 skip. Logs: %TEMP%/hichat-capture-shortcut-sender-before.log, hichat-capture-shortcut-sender-after.log and hichat-capture-shortcut-sender-canonical.log. No physical microphone or native hook was exercised. Window-command capability review and final runtime acceptance remain open.
- Published to existing PR #285 head 0b663800; fresh CI pending. No merge performed.

### RF20 - main-window native command ownership (2026-11-13)

- Two failing-before regressions demonstrated badge, flash, minimize, maximize and close commands did not reject foreign/retired main frames. All five now require the existing current-main assertion before validation, image creation, tray mutation or native window calls.
- Tests cover foreign contents, subframes, missing frames, destroyed/absent windows and old navigation frames, with zero effects after denial and successful current-frame use. Existing bounds, image URL rejection, focus/maximize behavior and badge clearing remain covered. The former absent-window no-op fixture now explicitly exercises the owner disappearing after successful authorization; a caller whose owner is absent at authorization is rejected.
- Integration 3d7ce640: full Electron 399 pass/1 skip. Canonical PR #283 source 58f2a10e: fresh unique TypeScript output, full Electron 275 pass/1 skip. Logs: %TEMP%/hichat-window-sender-before.log, hichat-window-sender-after.log and hichat-window-sender-canonical.log. No physical badge/taskbar/titlebar behavior was exercised; final inventory/runtime acceptance remains open.
- Published to existing PR #283 head 41e50c71; fresh CI pending. PR #286 head 2802af2c reached terminal 36/36 SUCCESS, verified live. No additional PR merged.

### RF03/RF20 - integrated IPC ownership verification checkpoint (2026-11-13)

- Frozen product source 154d5687: AST verification confirms all 23 newly protected command callbacks begin with the sender assertion and forward their actual event. Receipt includes each channel/location and source SHA-256: implementation/verification/refactor-ipc-entry-guards-2026-11-13.json. Existing low-impact metadata reads and bounded diagnostic-log event remain explicitly listed; this is not proof of every packaged/runtime sender/session path.
- Production client build passed; full lint passed with 0 errors and 2 existing TanStack warnings. Go vet ./... and build ./... passed (host CGO_ENABLED=0). Logs are listed in the receipt. Existing large-chunk build warning remains open rather than being suppressed.
- Fresh compiled Electron coverage run: 399 pass/1 skip, no failures. All eight modified entry-guard IPC modules have 100% line/branch/function coverage in compiled JavaScript. The broader 17-file *-ipc.js filter reports 99.64% lines, 98.89% branches and 100% functions; this is not whole-Electron/main composition coverage or physical acceptance. Log: %TEMP%/hichat-ipc-entry-coverage.log.
- Full Go race ./... is actively running in Docker golang:1.26.10-bookworm against the general/SQLite profile without PostgreSQL DSN. Local execution session 87987 and %TEMP%/hichat-ipc-final-go-race.jsonl must be followed to terminal state; no race success is claimed yet. PostgreSQL verification is separate. Final runtime/platform/device and release gates remain open.

### RF19 - installed NSIS asynchronous handoff constraint (2026-11-13)

- Inspected installed electron-updater 6.8.11 and executed its actual BaseUpdater.install/quitAndInstall and NsisUpdater.doInstall methods in a VM with native spawn/app/OS dependencies mocked. Under a controlled deferred spawn rejection, events were spawn-requested, before-quit-for-update, quit-requested, deferred-install-error; the vendor installation latch remained true. Source hashes and scope are in implementation/verification/refactor-installer-async-contract-2026-11-13.json.
- This demonstrates that the wrapper return is not an observed installer handoff and that simply unlocking our gate on an arbitrary late error would not establish safe recovery. It does not establish physical OS error scheduling, a real installer failure or a complete recovery design. No native installer or app quit was executed. Async failure recovery remains an explicit RF19 acceptance gap; the successful-path duplicate-install gate is not weakened to hide it.
- PR #274 head 2fc8190d reached terminal 36/36 SUCCESS, verified live. Other registrar heads and full integrated Go race remain under follow-up; no merge performed.

### RF03 - settings PR check-state discrepancy (2026-11-13)

- PR #273 head bb7ee036: Server CI run 43447711102 is completed/success. Migration job/check 131961420497 has a successful conclusion, completed_at and all five completed/success steps, yet its status remains in_progress in both job and check-run APIs. Other 35 checks completed successfully. This contradictory last record is not reported as 36 terminal successes. Receipt: implementation/verification/refactor-pr273-check-state-2026-11-13.json.
- No source defect or failed test was observed and no rerun was started solely to replace a contradictory observation. The exact check will be revalidated. Full integrated Go race execution session 87987 remains live and progressing; no terminal race success is claimed.

### RF03/RF08 - full race timeout and exact CI shard follow-up (2026-11-13)

- Frozen Go source from 154d5687: unsharded Docker race ./... ended exit 1. Twenty-two packages passed, seven had no tests; repository and services each reached the unchanged 15-minute package limit. JSON contained 2950 test pass events and 46 skips before termination, no observed DATA RACE report. These partial results are not a successful full run. Log: %TEMP%/hichat-ipc-final-go-race.jsonl.
- Started the existing CI shard runner without changing assertions or timeout: repository/services eight shards each, two concurrent jobs, same race+cover+15m gates. Execution session 45007; actual log directory is in the updated entry-guard receipt. No PostgreSQL DSN is supplied in this general/SQLite profile. The prior full run is terminal; it was not restarted merely because observation timed out.
- Timeout stack inspection found 400 TTL-cache cleanup goroutines whose creating parent had already completed. The permission parity property test constructs two cache-backed resolvers in each of 200 iterations; its shared mock-service helper registers no cleanup. This is a separate concrete test ownership gap, not a demonstrated sole cause of the full-package timeout. Preserve the frozen shard input while addressing it in an isolated follow-up.
- PR #278 head 862395ab reached terminal 36/36 SUCCESS, verified live. No additional PR merged. Sharded results and all remaining acceptance gates still require follow-up.

### RF08 - permission fixture cache worker ownership (2026-11-13)

- Shared permission fixture helpers now accept their testing.TB owner and register the cache Close method with t.Cleanup. Propagated the owner through nested fixture factories and their existing inflight/music/voice callers. Production service/cache code and the 200 randomized parity iterations are unchanged.
- The new regression runs the actual 200-iteration single/bulk parity test as a child owner. Before: 400 cache cleanup workers remained after the child finished (exit 1). After: five repeats returned from zero workers to zero (exit 0). Integration variant 6665fc71 passed all 42 affected top-level tests (6.288 s) and targeted race (17.134 s). Canonical main-based source 295ab67f passed all 40 discovered affected top-level tests (6.054 s), with JSON proving every selected test ran, and targeted race (16.371 s).
- Receipt: implementation/verification/refactor-permission-fixture-lifecycle-2026-11-13.json. This fixes the demonstrated test-helper ownership leak; it does not establish that the full-package 15-minute timeout is resolved, nor clean every other direct cache constructor. Frozen integration shard execution 45007 does not include this change and must retain its separate source identity.
- Published as independent draft PR #291 head c683dbb2. Integration Go source is deliberately unchanged while shard session 45007 runs. PR #282 head c4cfdaff, #283 head 41e50c71 and #285 head 0b663800 reached terminal 36/36 SUCCESS, verified live. No additional PR merged.

### RF08 - direct permission fixture ownership extension (2026-11-13)

- Extended the lifecycle regression to the existing music-access, message-recipient, search, leave/rejoin, stream-notifier and thread-invalidation fixtures. Before extension, all six direct constructors retained one worker each; the already-fixed parity fixture passed. Added t.Cleanup at each constructor without changing its arguments, including literal nil broadcaster semantics. The search fixture factory now receives its testing.TB owner.
- Integration source 2a3f8fd2: all seven fixture groups return to the initial worker count across five repeats; all 54 selected top-level tests ran and passed (5.909 s), targeted race passed (15.869 s). Canonical source 615b5457: all 51 selected top-level tests ran and passed (5.875 s), targeted race passed (15.612 s). Canonical covers six fixture groups: leave/rejoin is not present in main, so its unrelated fixture/implementation dependencies were excluded rather than copied into this PR.
- The updated receipt preserves the initial 400-worker proof, extension failures, latest source hashes and source-specific counts. Known permission constructors in services tests now register ownership in the applicable source tree. This does not close production lifecycle or whole-suite timeout acceptance. Frozen shard session 45007 still excludes this patch.
- Extended existing PR #291 to head 5e50ae98; fresh CI pending. Frozen Go shard source remains unchanged.
- PR #273 head bb7ee036 metadata reconciliation: after repeated contradictory records on the terminal workflow, requested migration-job rerun; attempt 2 completed successfully, new check 131996969735 is completed/success and current PR rollup is terminal 36/36 SUCCESS. Source was unchanged. Historical discrepancy and resolution are both preserved in the check-state receipt. No additional PR merged.

### RF08 - normal shutdown ownership for all four TTL cache owners (2026-11-13)

- Regressions reproduced repeated/concurrent TTLCache.Close panics and missing Stop ownership on channel-permission/ticket services and auth/permission middleware. Close now uses shared idempotent completion, waits for worker exit and ticker disposal, and retains cache access for draining requests. Each of the four production constructor families exposes Stop; main registers cleanup immediately after successful service/route acquisition. Public service interfaces and request/cache invalidation contracts are unchanged.
- Source 82bfd758: targeted tests and race passed five repetitions; complete cache/middleware tests passed; full Go vet/build passed; golangci-lint v2.12.2 reported 0 issues. The isolated cache profile is 44.4% statements, with Close at 100%; these figures are not whole-server coverage. Receipt: implementation/verification/refactor-cache-owner-shutdown-2026-11-13.json.
- Main cleanup registration is source-checked and actual owners are unit-tested. This does not prove a real server-process shutdown, forced-exit cleanup or initialization failure before the owner bundle returns. Those RF08 gates remain open. Existing frozen shard session 45007 uses the earlier source and must not be relabeled as validation of this patch.
- Published independently as draft PR #292 head 52251bad; its CI remains separate. Frozen integration source is unchanged and shard session 45007 remains live, with 15/16 completed successfully at this checkpoint. No additional PR merged.

### RF03 - frozen race shard terminal receipt (2026-11-13)

- Session 45007 finished exit 0: all 16 CI-style race+cover shards passed under the unchanged 15-minute limit. Selection audit verifies each discovered repository/services top-level Test/Example/Fuzz name occurs exactly once across its eight shards. Server source still matches 154d5687. Together with 22 earlier passing non-heavy packages and seven packages without tests, this supplies the general/SQLite race baseline; the original unsharded timeout remains recorded.
- Evidence: implementation/verification/refactor-frozen-go-race-shards-2026-11-13.json. The non-verbose shard output does not provide a complete skip inventory. PostgreSQL/tagged profiles and subsequent PR #291/#292 changes remain separate. Final source/platform acceptance is not claimed.


2026-11-13: PR #292 shutdown-test duplication was removed through a shared testutil assertion, preserving all four owner factories and eight concurrent callers. Source 276a927a (integration 5f38cf12); Sonar new-code duplication fell from 14.4% to 0.0% and the check passed. Five repeated targeted tests and race tests passed on the canonical branch; integrated selected tests, Go vet and build passed. Full PR CI remains pending; this does not establish live-process or physical-device acceptance. Evidence: implementation/verification/refactor-cache-shutdown-dedup-2026-11-13.json.


2026-11-13 RF08: reproduced two leaked middleware cache workers for each initRoutes panic at registration 1 and 100. The initializer now releases workers unless ownership transfers through a successful return, preserving the original panic. Route golden/permission inspection fixtures close returned owners. PR #292 source 35245f2d: five repeated route regressions, full main-package race (193.553s), full Go vet/build and golangci-lint 0 issues passed. Integration 60c2b1bd route scope passed five times. Evidence: implementation/verification/refactor-route-cache-ownership-2026-11-13.json. Rate limiter cleanup loops lack public stop and production ownership; service-construction failure ownership and live-process acceptance remain open. New-head CI pending.


2026-11-13 RF08: PR #293 source 0831edb4 adds a shared waiting, concurrent/idempotent Stop for login/message limiter workers, preserves budgets for draining requests and wires all 17 RateLimiters bundle fields into main shutdown. Before tests failed for both limiter types and bundle ownership. Five-repeat complete limiter race, targeted main race, full vet/build and golangci-lint (0 issues) passed. Package statement coverage 67.6%; new worker construction/Stop 100%. Integration cc2e9edb preserves both cache and limiter cleanup defers after resolving their same-line conflict; selected route/limiter tests and race passed five times, full vet/build passed. Evidence: implementation/verification/refactor-rate-limiter-shutdown-2026-11-13.json. Production inventory found another limiter in GameJoinHandler, outside the 17-field bundle; its owner, partial startup cleanup and actual live-process shutdown remain open. PR #292/#293 current-head CI still running.


2026-11-13 RF08/RF11: PR #293 follow-up 047a9837 eliminates GameJoinHandler-owned worker construction and injects its 60/min limiter from the service bundle, now 18 fields. Admission/session fixtures retained 10 workers before and zero after. Two handlers share one 60/min budget, exhausting it returns 429/Retry-After 60; nil fails closed, constructor adds no worker, shutdown preserves the budget. Removing GameJoin from Stop triggers the ownership regression (1 retained worker), then restored source passes. Canonical full handlers package, five repeated targeted race tests, full vet/build and lint passed. Integration a8ba509d selected tests and race passed five times, full vet/build passed. Evidence: implementation/verification/refactor-gamejoin-limiter-ownership-2026-11-13.json. Latest observed #292 head 35245f2d had 28 successful checks and 6 running; #293 head 047a9837 had 3 successful and 30 running. These are pending snapshots, not terminal CI acceptance. Partial initServices failure cleanup and live-process shutdown remain open.


2026-11-13 RF08: PR #294 source a2a48de6 (stacked on #292) rolls back acquired service cache/context owners in reverse order when initServices fails, preserving the original panic. A throwing real hub callback retained one permission-cache worker before the fix; early config and hub-failure regressions passed five times with race afterward. Canonical full vet/build and lint passed. Integrated real constructor success transfers two live caches plus eighteen live limiter workers and caller cleanup returns both counts to baseline; early/failure/success tests passed five times with race (3.229s), full vet/build passed. This combined handoff test depends on #293 and is integration-only. Late failure after limiter acquisition and actual process shutdown remain open. Evidence: implementation/verification/refactor-service-startup-rollback-2026-11-13.json. PR #292 immutable head 35245f2d reached 36/36 terminal SUCCESS (refactor-pr292-terminal-2026-11-13.json); #293/#294 CI still pending. No additional PR merged.


2026-11-13 RF08/RF11: PR #293 refactor fd07cfe5 moves limiter assembly after service construction, preserving all 18 field/constructor/argument mappings against 047a9837. Fix 3d39a3a3 records each limiter immediately and closes partial bundles on failure. Constructor injection at positions 2-18 retained 1-17 workers before; all 18 failure points preserve the original panic and retain none after. Successful return hands off 18 live workers. Canonical selected tests/race passed five times; full vet/build and lint passed. initRateLimiters coverage is 100%, while the isolated main-package run is only 1.9% and does not represent whole-package acceptance. Integration 12548e22 combined service/limiter/game-join tests and race passed five times; full vet/build passed. Full main race session 5329 is running on that frozen source. Evidence: implementation/verification/refactor-partial-limiter-startup-2026-11-13.json.

CI correction: PR #294 initially targeted #292 branch and only five checks were scheduled because Server CI filters PR targets to main/master. Target changed to main; its diff includes the prerequisite #292 fixes. Full workflow_dispatch run 43468133456 is verified running on exact head a2a48de6, separately from the PR rollup. PR #293 current head is 3d39a3a3 and pending. These are not terminal acceptance receipts. No extra PR merged.


2026-11-13: frozen integrated source 12548e22 full main-package race session 5329 completed exit 0, 202.971s. This covers the main package only, with no PostgreSQL DSN injected into the Docker process; it is not a whole-server or production-profile result. Receipt refactor-partial-limiter-startup-2026-11-13.json updated from running to PASS.


2026-11-13 RF08: PR #293 source 539647b5 adds test-owner cleanup to existing limiter fixtures. New regression executes 12 actual handler fixture groups and one middleware group under child owners: all failed before, retaining 14+1 workers, and restore their baseline afterward. Five-repeat regressions passed; complete handlers race passed (87.821s), middleware race passed (14.794s), full vet/build and lint 0 issues passed. Integration cdaca069 selected groups passed five times, full vet/build passed. Evidence: implementation/verification/refactor-limiter-fixture-ownership-2026-11-13.json. Auth/permission middleware caches still need fixture ownership reconciliation. MetricsCollector Start starts duplicate workers and Stop closes a channel without cancellation/waiting/idempotence; production lifecycle remediation remains open. PR293 current-head CI and PR294 exact-head dispatch 43468133456 remain pending.


2026-11-13 RF08: PR #295 b24d47a1 fixes MetricsCollector duplicate Start, early Stop return and concurrent Stop panic (15/16 before). Terminal one-worker lifecycle cancels query/HTTP context, waits and closes idle HTTP connections. Six tests include blocked query, real local HTTP cancellation, Stop-before-Start, 25x16 interleaved callers and immediate/periodic synthetic Prometheus snapshots. Canonical five-repeat race, full vet/build/lint passed; integration a291407f service/startup scope passed five times with race, full vet/build passed. Isolated function coverage: Start 95.7%, Stop 100%, collectAll 94.1%, constructor 66.7%; no whole-services coverage claim. Actual PostgreSQL collector cancellation and process signal shutdown remain open. Evidence: refactor-metrics-collector-lifecycle-2026-11-13.json.

PR #293 Sonar failed go:S4507 because the shared non-test fixture helper imported runtime/pprof. Source 12fd653d moves profile inspection into _test.go files and injects count callbacks into the shared assertion; no rule suppression/dismissal. Five-repeat selected tests/race, full vet/build/lint passed; new Sonar analysis pending. Integration 0e7d50a4 selected fixture/GameJoin scope passed five times, full vet/build passed. PR #294 full dispatch 43468133456 on immutable a2a48de6 is completed SUCCESS, all 31 jobs passed; its PR rollup has five separate successful checks. This corrects the earlier missing Server CI scope without presenting a queued/running job as acceptance. Receipt: refactor-pr294-server-terminal-2026-11-13.json. No additional PR merged.


Sonar follow-up: current #293 head 12fd653d and #295 head b24d47a1 both reached completed SUCCESS for SonarCloud Code Analysis after the preceding pending snapshot. Full CI matrices remain distinct and pending.


2026-11-13 RF08/RF04: PR #295 follow-up 700aef3a uses real LiveKitRepository against isolated PostgreSQL. Observe the query waiting on an ACCESS EXCLUSIVE table lock, Stop without releasing the blocker, then verify query cancellation and pool return. Separately saturate the real pool, observe WaitCount and verify cancellation preserves the held connection. Local verified-mTLS race ran all seven metrics/PG tests five times without skips; a separate plain loopback race passed. Fresh certificate harness passed both reconnect and required collector contract. Both CI profiles now require explicit PASS and reject skips/missing tests; canonical Python runner 6 tests and integrated runner 10 tests passed. A new cancellation regression found one unavailable write and one purge after cancelled HTTP; guards now avoid treating intentional cancellation as downtime. Full vet/build/lint passed. Evidence: refactor-metrics-postgres-cancellation-2026-11-13.json. Historical b24d47a1 reached 36/36 CI SUCCESS; new 700aef3a CI is pending and must not inherit that result.

PR #293 head 12fd653d failed CI run 43471274475 in TestLimiterAssemblyRollsBackEveryPartialConstruction/12, snapshot before=0 after=1. No failing goroutine stack was captured; final-defer runtime bookkeeping is an inference from completion-channel ordering, and an isolated pre-fix 100-repeat race/cover run passed. Fix afa1802d observes the same exact final count without rerunning fixtures or changing product Stop/cancellation deadlines. 100-repeat race/cover selected scopes passed; deliberate owner omission still fails after 500ms (got=1 want=0). Original code restored and five-repeat tests passed; full vet/build/lint passed. New-head CI remains required. Evidence: refactor-limiter-worker-observation-2026-11-13.json.

Combined source 9e54543d: selected main/services/handlers/middleware lifecycle, fixtures, gamejoin and PostgreSQL scope ran 29 top-level tests five times with race and verified mTLS: 145 passes, zero skips/failures; full vet/build passed. This is not a whole-project, full-process signal or active-media acceptance claim. Evidence: refactor-lifecycle-integrated-scope-2026-11-13.json. Auth/permission cache fixtures and real process shutdown remain open. No additional PR merged.


2026-11-13 RF08: PR #292 follow-up 9c026c88 makes auth/permission middleware fixtures own their cache workers. A regression executes 11 real fixture groups: ten groups retained 37 workers before and an already-owned shutdown control passed. After immediate t.Cleanup(Stop), all groups restore baseline. Real-auth helper now takes testing.TB; direct and inline constructors receive explicit cleanup. Existing HTTP/JWT/bot/session/profile/role/inflight assertions are preserved. Canonical five-repeat tests (3.832s), full middleware race (28.510s), five-repeat fixture race (64.071s), full vet/build and lint 0 issues passed. Three benchmark callers already deferred cache.Close. Shared observation helper is byte-identical to #293 (e0faff7956d7d69819f8cc1799b455abe72b6d10). Integration 9ce26046 preserves its RF11 constructor during conflict resolution; five-repeat tests (4.062s) and race (59.096s), full vet/build passed. Evidence: refactor-middleware-cache-fixtures-2026-11-13.json. New #292 head CI is pending; previous 35245f2d success is historical.

Terminal receipts: PR #293 afa1802d and #295 700aef3a each completed 36/36 SUCCESS. The former includes final-count observation and its negative control; the latter includes real PostgreSQL lock/pool waits, both CI connection profiles and cancelled-poll downtime guards. Source-bound snapshots refactor-pr293-afa-terminal-2026-11-13.json and refactor-pr295-700-terminal-2026-11-13.json distinguish them from older heads. Service-cache fixture inventory, complete ownership reconciliation, real process signal and active-media shutdown acceptance remain open; no extra PR merged.


2026-11-13 RF08: PR #292 follow-up 9e0e1a1d fixes the remaining five ticket fixture cache workers and one thread SQLite HTTP permission resolver. All five real ticket fixtures failed owner cleanup before; the real thread migration/repository/HTTP archive/access/reopen fixture also retained one worker. Named cleanup now restores baseline without removing replay/user/token-version/recipient assertions. Ticket race passed 100 times (4.075s); combined five-repeat tests and race passed (handlers 72.009s, services 3.967s), full vet/build/lint 0 issues passed. Integration 6d41ecea selected five-repeat tests passed (handlers 3.743s, services 0.700s), race passed (handlers 66.425s, services 3.793s), full vet/build passed. Evidence: refactor-service-cache-fixtures-2026-11-13.json. Four direct production generic TTL constructor families were identified (auth, permission middleware, channel permission cache, WS ticket); #291 channel-permission cleanup is not duplicated. New-head #292 CI pending.

Next shutdown-order audit: main registers defer stopOwner before defer owner.Close, so LIFO cleanup closes the ownership connection before cancelling the watch context. database/singleton.go WatchBackendOwner probes once/second and invokes onLost on a probe error while ctx is not cancelled. This identifies an ordering gap to reproduce and fix; no production false-exit incident is claimed. Watch cancellation/join before connection close, real process signal shutdown, non-TTL resource ownership and active-media acceptance remain open. No additional PR merged.


2026-11-13 RF08: PR #296 source 19e56709 / integration 5d2d1aea owns backend-watch cancellation and completion before database pool/session close. Regression tests exposed no cancellation, early concurrent cleanup return and wrong pool ordering. Go AST wiring checks survive CRLF and reject both removed explicit join and reversed fallback defer order. Integrated unit tests passed 100 times; six named real-mTLS race tests passed five times (30 passes, zero skips) on 4bcea6af. Final DDL-template follow-up preserves pgx-quoted generated identifiers; mandatory self-scan exited 0 with zero blocking patterns and 421 review rows, no exclusions. Final integrated host scope passed three times; full vet/build revalidated on 5d2d1aea. PR296 current-head CI pending (17 success/17 pending at observation); old security failure is not current-head acceptance. PR292 exact head 9e0e1a1d completed 36/36 SUCCESS, receipt archived. Whole-process SIGTERM, active-media shutdown and remaining ownership inventory remain open. No additional PR merged.

2026-11-13 RF08 real-process check: built Linux backend from 5d2d1aea; ran in a uniquely owned container with an isolated verified-mTLS PostgreSQL database and private working directory. Real HTTP health reached 200 before SIGTERM. Process exited 0 in 0.172 seconds and emitted server stopped gracefully, without ownership-loss text. Unique fixture database dropped and owned container removed. This covers idle Linux process shutdown only; active media, in-flight workloads, ownership reacquisition and Windows signal/platform behavior remain unverified. Receipt: refactor-process-sigterm-2026-11-13.json.

2026-11-13 RF08: extended real Linux process acceptance on source 5d2d1aea to three sequential boots against the same isolated mTLS PostgreSQL database. Every boot reached HTTP health 200; every concurrent real backend exited nonzero with the ownership guard message, using a different HTTP port to distinguish lock rejection from bind failure. Each owner then exited 0 on SIGTERM with graceful-stop log (0.187/0.156/0.156 seconds); subsequent healthy boots demonstrate ownership reacquisition. Database/container cleanup completed and orchestrator exited 0. Receipt: refactor-process-owner-restart-2026-11-13.json. In-flight requests, active media and Windows remain open.

2026-11-13 RF08: found channel delivery, DM delivery and DM staged-upload cleanup were only deferred, so main closed their database before joining them. New Go AST regression failed for all three owners before the fix. Main now unconditionally joins these workers after HTTP drain and before log shutdown, retaining deferred fallback cleanup. Wiring regression passed 100 times; full Go vet/build passed. This proves shutdown wiring only; blocked in-flight delivery/database cancellation and final real-process rerun are still required. Independently found voice orphan/AFK ticker ownership needs follow-up; not declared fixed by this patch.

2026-11-13 RF08 delivery shutdown follow-up: source 9d08552e rebuilt as real Linux binary and passed three same-database health/exclusion/SIGTERM/restart cycles (0.250/0.141/0.141 seconds, all exit 0). Added real PostgreSQL TestDeliveryStopCancelsPoolWait for channel and DM workers: hold the sole pool connection, observe WaitCount increase, invoke Stop without releasing the connection, require join and verify held connection remains usable. Host three-repeat scope PASS 4.606s; verified-mTLS Docker race five-repeat scope PASS 7.712s; services vet PASS. Scope is pool-wait cancellation and idle process shutdown; blocked SQL query, in-flight HTTP producer and active-media/platform acceptance remain open. New regression currently integrated only; canonical PR publication is still required.

2026-11-13 RF08 canonical delivery shutdown published as draft PR #297, head 1b0e96db. Independent main-based branch includes explicit joins, AST wiring regression and PostgreSQL pool-wait cancellation test, required named-test gate and race selection. First canonical three-repeat run exposed test observation race: worker could register its wait before WaitCount baseline. Capture baseline before contracting pool while holding one of the initially available connections; deadlines unchanged. Corrected host ten repeats PASS 13.594s; real verified-mTLS race five repeats PASS 9.813s, all named channel/DM subtests ran. Full canonical vet/build and six runner tests passed; lint still pending at this observation. Existing outbox code logs intentional context cancellation at ERROR level; separate follow-up required. PR297 CI pending; no PR merged.

PR296 exact head 19e56709 reached terminal 36/36 SUCCESS. Snapshot archived. PR297 local lint first failed because the Go1.26-built linter loaded host Go1.27 files; no source diagnostic was produced. Rerun pinned to Go1.26.11 is active; do not label that first panic as a successful lint run.

2026-11-13 PR297 lint correction: Go1.26.11-pinned golangci-lint 2.12.2 completed with 0 issues after the host Go1.27 incompatibility. Canonical follow-up c80f9e9f adds an explicit runner negative control requiring TestDeliveryStopCancelsPoolWait PASS (seven runner tests pass). Integration ab5ed59d preserves existing metrics/redaction requirements while adding the named shutdown contract; eleven runner tests pass. Newly pushed head requires its own CI; earlier 1b0e96db checks are historical. No extra PR merged.

2026-11-13 RF08 PR297 follow-up ad42f9f7: real PostgreSQL regression reproduced false claim ERROR on intentional cancellation for both channel and DM. Guard requires both returned error and operation context to be context.Canceled; expired deadlines and closed-database failures still emit claim errors. Five host repeats PASS 16.161s; both real-mTLS lifecycle tests with race five repeats PASS 16.632s, named subtests ran. Full Go vet/build and Go1.26.11 lint 0 issues passed; seven canonical/eleven integrated runner tests passed. New claim-logging test is mandatory in PostgreSQL CI and race selection. Retry/acknowledgment logging and remaining worker ownership still need review. Current ad42f9f7 CI required; prior-head checks do not prove it.

2026-11-13 RF08 voice maintenance ownership: regression proved VoiceService had no cleanup-worker shutdown. Integrated implementation retains existing StartOrphanCleanup/StartAFKChecker signatures, makes each worker single-start and terminal, adds optional StopMaintenance ownership, and joins it before hub/database shutdown with deferred fallback. Tests cover 16 concurrent starts/stops, an intentionally blocked sweep, Stop-before-Start, duplicate public starts and terminal restart rejection. Four tests passed 100 times (1.687s); same scope race 100 repeats PASS 4.502s; full Go vet/build passed. Existing sweep-local timeouts remain; I/O cancellation propagation, active-media teardown, canonical publication and final integrated process acceptance remain open.

2026-11-13 PR297 security failure reproduced: reviewed self-scan manifest rejected stale whole-file hashes for channel_delivery.go/dm_delivery.go after cancellation guards. Reviewed all four exact SQL matches: line hashes unchanged, fixed SQL timestamp/attempt arithmetic, event IDs still bound; patch changes only cancellation checks. Refreshed four file hashes without new entries, rule changes or exclusions. Six manifest verifier tests PASS 25.394s. Full local mandatory self-scan is running; current-head CI must still pass. Voice worker source 3e1704e6 remains integrated only and is not yet deployment acceptance.

2026-11-13 RF08 voice maintenance published as draft PR298 canonical 9de59bed. Independent main-based unit scope passed 100 repeats (0.794s), race 100 repeats (4.889s), full vet/build and pinned lint 0 issues. Blocked-sweep test now observes worker cancellation under its lifecycle mutex before asserting Stop remains blocked, replacing a fixed 10ms observation delay. Current-head CI remains required. PR297 security source-hash fix 65355a1d is pushed; full local self-scan session24481 remains live at observation, not a pass claim. No PR merged.

2026-11-13 RF08 PR298 follow-up: voice maintenance owns a cancellable context; AFK database lookup now derives its existing ten-second timeout from worker context and checks cancellation before further candidates/kicks. Blocking getter negative control with restored Background context failed as expected (AFK Stop did not cancel lookup), then original source restored. Five voice maintenance tests passed 100 repeats (0.919s), race 100 repeats (3.853s); final unused private wrapper removed after lint flagged it, final unit 100 repeats PASS 1.013s and lint 0 issues. Full vet/build passed before wrapper removal. Orphan LiveKit calls and active-media shutdown remain open. PR297 full mandatory local self-scan terminal exit 0, zero blocking patterns, 421 review rows, after exact-source manifest refresh; this is not acceptance of all review rows or current CI.

2026-11-13 RF08 PR298 ffd33a9a adds real PostgreSQL AFK cancellation: lock channels with ACCESS EXCLUSIVE, observe ungranted relation lock in pg_locks, Stop without releasing blocker, verify worker joins, held transaction remains usable and voice state survives cancelled lookup. Host three repeats PASS 2.913s; all six voice maintenance tests with verified-mTLS race five repeats PASS 6.045s. Full vet/build and lint 0 issues passed; seven canonical/twelve integrated runner tests passed. Named real-PG test is required and selected in CI race lane. Orphan cleanup deletes voice state before recording usage; directly cancelling that path could lose accounting, so usage durability/cancellation ordering requires separate design and regression evidence. PR297 current head65355a1d has PostgreSQL CI failure under investigation; security fix alone is not all-green acceptance.

2026-11-13 PR297 PostgreSQL CI failure 43495401636/job132127272861 was TestDeleteBefore_RemovesOnlyOlderRows: fresh row could precede the wall-clock cutoff if fixture setup crossed a second. Deterministic negative control advancing cutoff one second reproduced deleted=2 and fresh-row loss; source restored. Test now assigns all three timestamps explicitly (before/equal/after cutoff), requires exactly one deletion and verifies both surviving boundaries. Deliberate production mutation < to <= fails deleted=2; product SQL restored byte-for-byte. Host ten-repeat PASS 6.658s; real-mTLS race five-repeat PASS 3.759s, no skips; repository vet and lint 0 issues PASS. This is test-fixture correction, not a retention product behavior change. New PR297 head CI remains required.

2026-11-13 combined source f87825b8: full vet/build PASS; three real Linux same-database health/owner-exclusion/SIGTERM/restart cycles PASS (0.187/0.172/0.156 seconds, exit 0). Combined main/services/database race is FAIL: backend owner lifecycle fixture DROP DATABASE hit its existing 10-second cleanup deadline on fifth iteration. PostgreSQL log confirmed user-request cancellation; no failing product assertion found. Concurrent DDL/process work was present, but exact contention cause is unproven. Exact generated leftover database had zero sessions and was explicitly dropped with unchanged 10-second timeout; no unrelated database touched. Do not relabel this run green. Receipt refactor-combined-shutdown-2026-11-13.json records named pass/fail events. Additional source audit: creditUsage uses context.Background without timeout and additive SQL is not retry-idempotent; bounded/durable accounting and orphan cleanup cancellation need coordinated work.

2026-11-13 RF08: ownership fixture cleanup diagnostics now retain error type, SQLSTATE, local context error and elapsed time, omitting raw driver messages/DSNs. Original ten-second deadline unchanged; isolated real-mTLS lifecycle count3 PASS 3.984s does not resolve prior combined cleanup failure. Usage accounting regression proved creditUsage passed an unbounded Background context to its repository. It now owns a ten-second timeout and releases context on return, preserving caller-independent session-end behavior. Regression count100 PASS 0.565s, race100 PASS 3.380s; canonical bounded-context plus existing admin-disconnect usage credit count100 PASS 0.589s; full integrated/canonical vet/build and canonical lint 0 issues passed. This bounds an individual credit query; durable pending usage, retry idempotency, joining detached usage calls and whole-orphan-pass budget remain open.

2026-11-13 RF08 usage accounting real-PostgreSQL validation found a product defect: second IncrementMonthlyUsage failed SQLSTATE42702 (ambiguous used_seconds in ON CONFLICT update). Qualifying livekit_monthly_usage.used_seconds preserves intended addition; five real-PG repeats now PASS 3.596s with two 60-second credits totaling120. Corrected misleading idempotent-across-crashes comment: row uniqueness is not replay safety, so ambiguous writes must not be blindly retried. Real locked monthly-usage table test observes pg_locks waiter, holds blocker throughout deadline, confirms credit returns at production ten-second budget, blocking transaction stays usable and no usage row is written. Host deadline PASS11.041s; all three usage tests verified-mTLS race PASS14.523s after SQL fix (initial combined race failed on SQLSTATE42702 and is not relabeled). Full vet/build and lint0 issues PASS. Both PG tests required in CI/race lane; eight canonical/thirteen integrated runner tests pass. Durable accounting, replay keys and bounded whole-orphan shutdown remain open.

2026-11-13 RF08 usage end snapshot: credit duration/month previously used wall clock when async credit ran, including time spent in preceding LiveKit cleanup. Introduced explicit endedAt calculation; leave/switch/admin-disconnect capture at go argument evaluation, orphan sweep uses its existing decision timestamp, channel deletion captures before dispatching cleanup pool. Credit duration and monthly bucket now derive from that snapshot; negative durations still skip. Fixed January-end/60-second regression rejects restored old wall-clock duration/month computation; source restored. Three targeted tests including existing admin-disconnect credit passed100 (0.532s), race100 PASS3.588s; full vet/build and lint0 issues PASS. Durable accounting, retry identity, detached-work join and orphan media cancellation remain open; this does not claim crash-safe delivery.

2026-11-13 durable usage foundation: native PostgreSQL migration054 adds credit identity ledger; separate VoiceUsageRecorder contract transactionally inserts identity and updates aggregate. Matching replays are no-op success, conflicting instance/year/month/amount return ErrConflict. Pool-backed boundary is explicit (RawDB), no retrying ambiguous additive legacy method. Regression first failed missing repository contract; initial migration placed in legacy directory did not create the native table, corrected to native postgres_migrations/054 and legacy draft removed. Real PG tests: sixteen concurrent same-key calls total60, changed payload rejected, aggregate trigger failure rolls back ledger, removing trigger permits same-key retry to total90. Host3 PASS2.504s, mTLS race5 PASS5.886s; full vet/build and lint0 issues PASS. Test mandatory in CI/race lane; runner tests eight canonical/thirteen integrated pass. This foundation is NOT wired into production voice session paths; stable session identities, persist-before-forget handoff, retry worker, migration upgrade/rollback acceptance and lifecycle join remain required before durable accounting is claimed.

2026-11-13 production usage identity wiring: each fresh JoinChannel state receives server-generated UsageSessionID (json excluded); same-channel rejoin keeps it. Leave, switch, admin disconnect, orphan and channel-deletion snapshots carry it to creditUsageSession. Production LiveKit repository capability uses atomic recorder; narrow legacy adapters/mocks retain additive compatibility. Unit real-service join/rejoin/leave/new-session test passed100 (0.618s), ensures recorder receives stable ID, no additive fallback for replay-capable getter and no JSON leak. Real PostgreSQL replay fixture now exercises service credit dispatch: identical session replay adds once, distinct sessions with same times add separately (total210 after prior90). All six voice-usage tests verified-mTLS race PASS15.063s; full vet/build and lint0 issues PASS. Still NOT crash-safe persist-before-forget delivery: session state is ephemeral and dispatch remains asynchronous; pending handoff/retry worker, detached job join, upgrade/rollback and active-media acceptance remain required.

Terminal CI: PR297 exact head c866c90e completed36/36 SUCCESS, including deterministic audit retention fixture, source-bound security review hashes and required delivery cancellation contracts. Snapshot archived separately from prior failed heads. No PR merged.

2026-11-13 native usage migration054 acceptance: test builds actual pre054 schema, seeds legacy monthly total120, runs new DDL in a deliberately aborted transaction and verifies no ledger remains, then upgrades/restarts and verifies total120, one preserved ledger row and one migration journal entry. Invalid month is rejected. Fully qualified regclass lookup avoids public-schema false positives. Host3 PASS2.401s; real verified-mTLS race5 PASS3.594s; final qualified lookup run PASS0.890s; full vet/build and lint0 issues PASS. Required named migration PASS added to PostgreSQL runner; package-only success is rejected by negative control. Canonical nine/integrated fourteen runner tests pass; integrated reported_failure checks and separate email race are preserved. This proves transactional DDL rollback, not application downgrade/backup restore or crash-safe pending usage handoff. No extra PR merged.

2026-11-13 database transaction lifecycle: WithTxOptions appended rollback-also-failed on context cancellation after database/sql had already completed rollback (ErrTxDone). Regression reproduced original false secondary error. Only ignore ErrTxDone when owning context is cancelled; original cancellation remains errors.Is-compatible, actual other rollback errors and uncancelled unexpected early commit remain visible. Three tests cover cancellation, rollback of callback writes and early commit diagnostic. Unit100 PASS2.571s; race100 PASS3.659s; full vet/build and lint0 issues PASS. Existing real-mTLS usage deadline test PASS11.038s now logs only original apply-usage timeout. Integrated patch preserves other transaction changes. Current-head PR CI remains required; durable handoff/retry/join remain open.

2026-11-13 durable pending usage foundation: native migration055 adds applied_at, marks every pre055 atomic credit already applied and indexes pending order. VoiceUsageQueue separates durable enqueue from atomic aggregate+applied-marker transaction; RecordVoiceUsage retains its existing all-or-nothing boundary. Failed aggregate leaves accepted pending job; fresh repository resumes it. Changed pending replay rejects conflict. Sixteen concurrent recovery attempts apply one job once. Final failure injection at applied-marker update rolls back aggregate too, preventing double count on retry. Upgrade test now seeds pre055 credits and verifies they are marked applied without changing120 total. Host replay/recovery count3 PASS3.705s; upgrade3 PASS2.214s; mTLS race5 upgrade PASS3.564s / services PASS9.159s; final marker-failure mTLS race3 PASS4.457s. Full vet/build and lint0 issues passed before final test-only failure injection. Named pending test required in CI/race; nine canonical/fourteen integrated runner tests pass. Pending repository is not yet wired to an owned retry worker or persist-before-forget service path; crash-safe producer delivery remains unproven.

2026-11-13 owned pending usage worker: StartVoiceUsageDelivery uses cancellable parent ownership and single-start terminal maintenance lifecycle, one-second interval, at most32 records and ten-second batch budget. Stop cancels DB work and joins; main defers fallback and explicitly stops it after HTTP drain before logs/database. Two worker tests passed100 (0.625s), AST wiring100 PASS0.660s; removing explicit join fails intended wiring assertion, original restored. Real-PG pending recovery now starts a new service/repository worker and observes automatic durable job application, then verifies caller pool remains usable after Stop. Four named main/services tests x5 verified-mTLS race yielded20 PASS/0SKIP/0FAIL; full vet/build and lint0 issues PASS. Integration preserved existing delivery joins during main conflict resolution; wiring/service unit100 PASS0.686s/0.690s. This connects recovery only; production session-end dispatch still uses atomic recorder asynchronously, so persist-before-forget enqueue and joining detached producer jobs remain open.

2026-11-13 production durable handoff: creditUsageSession now commits EnqueueVoiceUsage before attempting RecordVoiceUsage when the getter supports both contracts. Actual service regression failed before fix (aggregate trigger failure left pending0); after fix accepted pending credit survives, fresh owned worker recovers60 and identical service replay stays60. Failed enqueue never falls back to unsafe additive credit; unit100 PASS0.591s. Real-PG service handoff count3 PASS2.468s; eleven named usage tests mTLS race PASS with zero skips/failures. Full vet/build and lint0 issues PASS; nine canonical/fourteen integrated runner tests pass, new real-PG handoff test mandatory. Canonical behavior commit bf915ddf kept separate from subsequent Sonar refactor. This protects application failure AFTER enqueue commits; the state-forget-to-enqueue window and detached producer shutdown join remain open.

2026-11-13 PR298 Sonar failure 2ff44c99: new reliability ratingE, blocker UPDATE without WHERE in migration055; eight additional empty-body, interface naming and cognitive complexity findings. Canonical bb848eaa uses WHERE applied_at IS NULL, explains alternate-adapter no-op cleanup, names single-method interface Applier, extracts microphone mute and AFK channel policy, and divides migration/recovery/wiring tests into focused stages without dropping assertions. No rule exclusion/dismissal. Twenty-two named main/services/database real-mTLS race tests PASS, zero skips/fails; extra existing mute/permission scope count5 PASS2.133s; canonical vet/build/lint PASS. Integrated status updated to distinguish #297 c866c90e36green from pending #298. Receipt refactor-usage-handoff-quality-2026-11-13.json. New source remote gate remains pending.

2026-11-14 PR298 bb848eaa reached completed Sonar SUCCESS; remaining PostgreSQL CI job43504750014/job132159537575 failed TestPostgresImportPreservesDataAndRejectsReuse because native usage ledger had no SQLite source-table counterpart. Additive legacy migration151 mirrors ledger columns/index, leaving old usage unchanged. Existing import contract now verifies legacy120 preserved and no fabricated credit rows; passed2.430s. No table allowlist or missing-schema validation weakened. Exact unchanged generated-schema cleanup SQL review was revalidated, one whole-file manifest hash refreshed; six verifier tests PASS28.975s. Generic/strict bootstrap test uses actual clean migration150 history, then clears journal and upgrades through151. Initial minimal-schema fixture was correctly rejected by integrated fingerprint guard; fixture fixed, registry/guard unchanged. Canonical portable bootstrap3 PASS4.855s and Docker race1 PASS11.091s; integrated eight-test main/database/services scope including import/accepted credit PASS with zero skips/fails. Canonical compatibility commit77272d28 is separate from producer ownership work.

2026-11-14 canonical14a965ea producer ownership: terminal root admission tracks accepted join/leave/admin-disconnect/orphan/channel-delete operations and their registered usage children. Closing rejects new joins while allowing accepted roots to register children before their own completion; no zero-counter Add/Wait race. Channel deletion pool is counted until its child credits complete. Main joins producers after HTTP drain, before recovery/log shutdown; defer order preserves same fallback. Committed late channel deletion still clears/fences memory and synchronously attempts eviction/accounting/music cleanup in caller ownership. Untracked-dispatch negative control failed intended shutdown-before-credit assertion; original restored. Four admission/service tests unit100 PASS0.913s, race100 PASS4.249s; final late-music cleanup assertion unit100 PASS0.670s; wiring100 PASS0.723s. Real PostgreSQL accepted leave blocked on monthly table proves Stop waits, then commits before returning; host3 PASS2.514s and race5 explicit PASS/0SKIP. Thirty-test targeted canonical mTLS race PASS; corrected integrated8 PASS, full vet/build and final canonical lint0 issues PASS. Receipt refactor-usage-producers-import-2026-11-14.json distinguishes source scopes, original fixture rejection, pending CI and final self-scan. Still not crash-safe before enqueue; non-usage media jobs, active-session final credits and full acceptance remain open.

Final frozen canonical14a965ea mandatory self-scan completed exit0, zero blocking patterns and421 review rows. This follows the final historical fixture and late music-cleanup change; no rule exclusions introduced. Current-head PR298 at observation has10 SUCCESS/24 pending, not terminal acceptance. Primary user worktree untouched; canonical14a965ea and compatibility77272d28 pushed, no PR merged.

2026-11-14 real-process recovery on integrated95bed50e: build actual Linux server and isolated read-only usage probe. Seed one durable unapplied60-second credit before server start (usage0/pending1/applied0). Real server worker applies it; three same-database startup/owner-exclusion/SIGTERM cycles preserve usage60/pending0/applied1, proving no replay increment across those restarts. All process exits0 with graceful-stop logs, shutdown0.313/0.297/0.406s. Probe compiled Go1.26.11 only reads after seed; it never applies the pending credit. Owned database/container cleanup completed, orchestration exit0. Receipt refactor-process-pending-usage-recovery-2026-11-14.json. Idle-process and pre-existing pending recovery proof only; crash-before-enqueue, active-media and physical platforms remain open. PR29814a965ea currently28SUCCESS/6pending, no failure at observation; no merge performed.

Terminal current-head receipt: PR29814a965ea completed36/36 SUCCESS. Exact-head Server CI43509615952 has31/31 jobs completed SUCCESS, including PostgreSQL import/migrations, required usage contracts, race, lint, client/Electron/Playwright and combined Go coverage; other five rollup checks are separately recorded. Snapshot asserts exact head and every terminal status. Earlier bb848eaa PostgreSQL import failure remains historical evidence; new success is not a rerun of old code. This accepts the canonical component CI only, not final composite95bed50e/all-refactor release or physical media. No PR merged.

### 2026-11-14 — Backend owner fixture cleanup observation

- Added a joined, cancellable observer restricted to the exact owned cleanup statement. Failure output includes wait metadata and blocker count without DSNs or unrelated SQL. The cleanup deadline remains 10 seconds; no retry was added.
- Combined race JSON contains 105 passing test events across three terminal passing packages (five repetitions). A controlled PostgreSQL wait probe passed three repetitions; vet, build and pinned golangci-lint passed.
- The earlier cleanup timeout did not reproduce and its root cause remains open. This diagnostic change does not establish whole-project completion. Receipt: `implementation/verification/refactor-owner-cleanup-observation-2026-11-14.json`.

### 2026-11-14 — Cancel independent maintenance owners before join

- Regression reproduced: a blocked orphan sweep delayed AFK cancellation during StopMaintenance. Both terminal owners are now cancelled before either is joined, preserving repeated/concurrent stop semantics.
- Regression failed before the fix. Maintenance tests passed 100 repetitions on host and Linux race; services vet and lint passed. These DSN-free runs skip the PostgreSQL-specific test and do not prove active-media shutdown.
- Receipt: `implementation/verification/refactor-maintenance-cancel-before-join-2026-11-14.json`.

### 2026-11-14 — Join orphan music-stop children

- Deterministic blocking-hook regression failed before the fix: orphan sweep returned while music cleanup still owned stores. The first fixture attempt lacked onlineChecker and was corrected before reproducing the actual assertion failure.
- Music stops still start concurrently before LiveKit eviction; a sweep-local wait group now joins them before releasing the accepted producer slot. The child uses logx.Go for panic reporting.
- Host targeted maintenance/orphan tests passed 10 repetitions (3.480s); Linux race passed 10 repetitions (6.478s). PostgreSQL-specific tests were skipped in these DSN-free runs. Services vet and golangci-lint passed (0 issues). Physical media and all other asynchronous voice paths remain open.
- PR #298 head b69a98e3 Server CI run 43514109922 remains in progress; last checked seven jobs successful, no failed job. This new local child-ownership fix is not yet included in that CI head.

### 2026-11-14 — Own normal-leave media children

- Blocking music-hook regression failed before fix: ShutdownUsageProducers returned before accepted LeaveChannel music cleanup. Normal leave now registers both dual-identity LiveKit eviction and music stop as children of its admitted root. Caller remains asynchronous; terminal owner waits for completion.
- Targeted VoiceUsage/VoiceMaintenance/LeaveChannel tests passed 10 repetitions on host (1.969s) and Linux race (4.452s); services vet and lint passed. DSN-free runs do not establish PostgreSQL-specific acceptance.
- Cross-channel join, move, admin, webhook and mute media ownership remain open. Full active-session/crash-before-enqueue/physical-media acceptance remains open. This change is local to integration; PR #298 CI currently verifies earlier head 59a916e1.

### 2026-11-14 — Own cross-channel switch media children

- Blocking music-hook regression failed before fix for cross-channel JoinChannel shutdown. Old-room eviction and music stop now register beneath the accepted join operation, matching normal leave ownership.
- Integrated targeted tests passed 10 repetitions (4.919s), Linux race passed 10 (11.182s); services vet/lint passed. DSN-free runs skip PostgreSQL-specific tests.
- Canonical transfer initially included unrelated pendingJoins code and failed compilation; restored canonical voice_state.go from its own HEAD and applied only the four leave/switch dispatch changes. Canonical PostgreSQL validation is still running and no delivery success is claimed yet. Admin/move/webhook/mute ownership remains open.

### 2026-11-14 — Own forced-disconnect media cleanup

- Admin music cleanup regression failed before fix: terminal producer shutdown returned while accepted disconnect cleanup still ran. Shared disconnect cleanup now registers LiveKit eviction and music stop with the owner. After terminal closure, committed membership/permission revocation cleanup executes synchronously in its caller instead of escaping or being dropped.
- Targeted VoiceUsage/AdminDisconnectUser/VoiceMaintenance tests passed 10 repetitions (4.079s); Linux race passed 10 (8.898s). Late-member-revocation test passed 10 host repetitions (1.113s) and 10 race repetitions (3.522s), confirming voice-state removal and caller-owned cleanup. Services vet/lint passed before adding the late-member test. These DSN-free runs skip PostgreSQL-specific checks.
- Move, webhook, mute and entrance-hook ownership; late terminal usage credit; crash-before-enqueue and physical media remain open. PR #298 current published head fb269038 CI run 43515470174 is active; this new fix is local integration only.

### 2026-11-14 — Own voice move media children

- MoveUser music cleanup regression failed before fix. MoveUser now enters the terminal operation owner before lookup and registers music/dual-identity eviction children; shutdown rejects new moves before DB work.
- Targeted host tests passed 10 repetitions (6.956s), Linux race 10 (9.871s); services vet/lint passed. DSN-free PostgreSQL skips are not counted as acceptance. Receipt: `implementation/verification/refactor-voice-move-ownership-2026-11-14.json`.
- PR298 fb269038 Server CI run 43515470174 remains live (last checked 10 successful jobs, no failures). Forced-disconnect and move fixes remain local integration. Canonical branch lacks integration-only DisconnectServerMember/pendingJoins, so later transfer must use scoped patches and preserve branch-specific test scope.

### 2026-11-14 — Publish canonical admin/move ownership

- Scoped canonical transfer preserved branch-specific voice_state.go and excluded integration-only DisconnectServerMember test. Canonical real-mTLS PostgreSQL targeted tests passed three repetitions (50.577s), Linux race ten (9.697s), services vet/lint passed.
- Published PR #298 head 2dafbcef. Previous fb269038 CI results do not prove this new head. Receipt: `implementation/verification/refactor-admin-move-canonical-2026-11-14.json`. No merge, release, installed-client or physical-media acceptance is claimed.

### 2026-11-14 — Own administrative mute work

- Admin mute shutdown regression failed before fix. Initial test fixture assumed a single channel lookup and panicked; corrected its notification with sync.Once, then reproduced the actual early-shutdown assertion.
- AdminUpdateState now enters the terminal operation owner before lookup. The async mute leg registers a child; synchronous unmute remains before broadcast and inside the accepted root. New updates after closure return context.Canceled before dependencies.
- Targeted VoiceUsage/AdminUpdateState/VoiceMaintenance tests passed ten repetitions (5.220s); Linux race ten (8.081s); services vet/lint passed. DSN-free PostgreSQL skips are not acceptance. Changes remain local integration, while PR298 2dafbcef CI43516530987 runs. Webhook, entrance-hook and final physical/runtime acceptance remain open.

### 2026-11-14 — Own moderation webhook media work

- Deleted-room webhook regression failed before fix: producer shutdown returned before LiveKit eviction. Accepted webhook checks now hold a root slot and all deleted-room/moderated-user/mute media dispatches register child work.
- After the terminal owner drains, late webhook cleanup runs synchronously in caller ownership, preserving moderation instead of dropping it. A late deleted-room test passed ten repetitions (0.877s).
- Targeted VoiceUsage/EnforceModerationOnJoin/VoiceMaintenance host tests passed ten repetitions (11.931s); final-source Linux race passed ten (15.042s), including late-webhook test. Services vet/lint passed. DSN-free runs skip PostgreSQL-specific tests.
- Local integration only; PR298 published 2dafbcef remains under CI43516530987 (last checked ten successful jobs, none failed). Entrance hook, late terminal quota credit, full integrated/runtime and physical-media acceptance remain open.

### 2026-11-14 — Own entrance hook under accepted join

- Entrance-hook regression failed before fix: terminal shutdown returned before fresh-join hook finished. JoinChannel now registers the async entrance hook as a child of its already accepted operation, retaining asynchronous response behavior.
- Integrated VoiceUsage/VoiceMaintenance/JoinChannel tests passed ten repetitions (12.357s). Mute/webhook/entrance changes were applied to canonical source using scoped edits; canonical PostgreSQL/race/full vet-build-lint validation is running, not yet a success claim. Physical audible entrance sound remains unverified.

### 2026-11-14 — Publish mute/webhook/entrance ownership

- Canonical PR298 head 6236c8b9 now includes all three ownership fixes. Real-mTLS PostgreSQL targeted tests passed three repetitions (72.962s), Linux race ten (28.565s); full Go vet/build and golangci-lint passed with zero issues. Receipt: `implementation/verification/refactor-voice-media-owners-canonical-2026-11-14.json`.
- Current-head CI is pending; previous-head checks are not reused. Final combined acceptance, physical media, active-session shutdown, late terminal credit and crash-before-enqueue remain open.

### 2026-11-14 — Extract music-cleanup shutdown test helper

- Kept all 15 top-level test names (including four independent leave/switch/admin/move regressions) and extracted shared fixture/wait/release assertions. Test source shrank by 71 lines; product code unchanged.
- Four targeted tests passed 20 repetitions on host (2.304s) and Linux race (5.250s). Services vet/lint passed. A Go-overlay negative control restoring detached leave music stop failed the preserved Leave test with the expected early-shutdown assertion (exit1); tracked product source was never mutated.
- Receipt: `implementation/verification/refactor-music-cleanup-test-helper-2026-11-14.json`. Local integration only; canonical 6236c8b9 CI43517792317 remains active, last checked six successful jobs/no failure.

### 2026-11-14 — Preserve late member-revocation usage credit

- Regression failed before fix: completed producer shutdown caused a later committed member revocation to drop its cloud usage credit. Rejected child dispatch now performs the existing bounded accounting handoff synchronously in the late caller; no detached work or additive fallback was introduced.
- Unit/race usage tests passed ten repetitions (3.402s/5.447s). Real-mTLS PostgreSQL late-revocation test passed three host repetitions (2.858s), then three Linux race repetitions (5.377s), verifying applied ledger seconds equal monthly aggregate after repeated revocation. Final services lint: zero issues. Initial PostgreSQL test compile omitted models import; corrected before successful runs.
- Receipt: `implementation/verification/refactor-late-member-usage-credit-2026-11-14.json`. Local integration only; DB availability and ownership ordering still required. This does not solve crash-before-first-enqueue or post-DB-close work.

### 2026-11-14 — Name the shared voice operation owner

- Internal voiceUsageOperations/usageOperations/finishUsageOperation names changed to voiceOperations/operations/finishOperation across eight voice modules/tests. The owner now covers quota, media and entrance work, so its internal name and child log label (voice-operation-child) reflect actual responsibility. Public ShutdownUsageProducers and all test names remain unchanged.
- Targeted voice usage/maintenance/admin/move/webhook/join tests passed three repetitions (9.455s), Linux race three (12.794s). Full Go vet/build and pinned golangci-lint passed (zero issues). DSN-free PostgreSQL skips do not prove database acceptance.
- This is a separate local refactor after behavior fixes. PR298 published source remains 6236c8b9; CI43517792317 remains live, last checked 18 successful jobs and none failed. Final-source/physical acceptance and crash-before-enqueue remain open.

### 2026-11-14 — Address current PR Sonar failure

- Source6236c8b9 Sonar gate failed on new duplication6.1% (limit3%; 144 duplicate test lines); also reported AFK complexity16 vs15. Shared seven regression wait assertions and extracted locked AFK candidate snapshot. No threshold/exclusion changes.
- Canonical tests/race passed ten repetitions (12.144s/14.888s), real-PG AFK cancellation three (2.492s), services vet/lint passed. Overlay restoring detached leave music stop failed the preserved regression (exit1). Scoped integration import passed targeted tests (1.819s).
- Published PR298 fdd59669; new ServerCI43519318350 is pending, so Sonar remediation is not yet externally proven. Receipt: `implementation/verification/refactor-pr298-sonar-source-fix-2026-11-14.json`.

### 2026-11-14 — Own accepted permission/member revocation roots

- Permission recheck regression failed before fix: terminal shutdown returned while fresh permissions were still resolving. Both recheckVoiceAccess and DisconnectServerMember now register accepted root work before snapshot/checks; committed late revocations still run in caller ownership instead of being skipped.
- Targeted usage/maintenance tests passed ten repetitions (3.017s), Linux race ten (6.017s); real-PG late member credit test passed three (3.414s). Services vet/lint passed. Receipt: `implementation/verification/refactor-voice-revocation-root-2026-11-14.json`.
- Published fdd59669 SonarCloud is now COMPLETED SUCCESS; last snapshot nine successful checks/no failures, overall CI still running. New root changes local integration only. Late callback/database ordering and full project acceptance remain open.

### 2026-11-14 — Require real-PG permission recheck ownership

- Added real permission service/repository test with channels locked by a separate PostgreSQL transaction. Shutdown waits for the pending lookup and resulting missing-channel revocation cleanup. Initial assertion incorrectly expected missing-channel state retained; corrected to actual no-permission behavior without product policy changes.
- Three host repetitions passed (3.070s); three verified-mTLS Linux race repetitions passed (6.027s). Overlay removing only recheck root admission failed with expected early-shutdown assertion (exit1).
- Made recheck ownership and late-member credit tests mandatory in PostgreSQL runner; extended missing-test negative controls. All 14 runner tests passed. Receipt: `implementation/verification/refactor-postgres-recheck-ownership-2026-11-14.json`. Local integration only; physical media and final project acceptance remain open.

### 2026-11-14 — Publish canonical recheck/late-credit ownership

- PR298 head527a3ad3 includes recheck root ownership and synchronous late-credit handoff, with existing permission revocation rather than integration-only membership API. Nine named host test events passed (5.057s); nine verified-mTLS Linux race events passed (6.376s). Nine canonical runner tests passed.
- Evidence correction: postgresServerFixture already seeds channel; the blocked lookup test removes the session due to absent ConnectVoice permissions, not channel absence. Initial late-credit canonical fixture used nonexistent ch1 and failed; corrected to actual reader/channel/default identities before passing. Earlier recheck receipt interpretation corrected.
- Receipt: `implementation/verification/refactor-permission-credit-canonical-2026-11-14.json`. Current-head CI pending; physical/runtime and final whole-project acceptance remain open.

### 2026-11-14 — Own deleted-channel music stop

- Active-shutdown cleanup inspection found admitted DeleteVoiceChannel still dispatched music stop directly through logx.Go. Its eviction pool was owned, but the music child could outlive terminal shutdown. New regression failed before fix, then music stop was registered with the accepted root.
- Targeted usage/channel deletion tests passed ten repetitions (3.029s), Linux race ten (5.938s), services vet/lint passed. DSN-free PostgreSQL skips are not database acceptance.
- This fixes a prerequisite in shared cleanup, not active-session shutdown finalization. Active sessions still need explicit main lifecycle finalization and durable final credit proof before that gate can close. PR298 published527a3ad3 CI43520591216 is live (last checked seven successful jobs, none failed); this fix remains local integration.

### 2026-11-14 — Finalize active voice sessions on graceful shutdown

- Missing finalizer regression failed before implementation. Added terminal sync.Once finalizer: stops maintenance, joins producers, snapshots remaining channels and one end timestamp, then uses at most four channel workers to complete existing closed-owner cleanup without deleting DB channel rows. Concurrent16/repeated calls credit two cloud sessions once, skip self-hosted accounting, stop both music channels and clear voice state.
- Main explicitly/deferred finalizes sessions after HTTP/producer drain and before recovery/log/database shutdown. Channel cleanup accepts captured end time so queue delay does not extend usage.
- Host and verified-mTLS Linux race new wiring/active/native-credit tests passed three repetitions; existing usage wiring passed. Full vet/build/lint passed; runner14 passed and active-session PG test became mandatory. Receipt: `implementation/verification/refactor-active-voice-shutdown-2026-11-14.json`.
- Local integration only. Actual LiveKit/device eviction, process-signal active session, failure recovery, pool-bound runtime and credit-before-network-delay acceptance remain open; this does not close whole RF08 or crash-before-enqueue.

### 2026-11-14 — Credit a session before LiveKit eviction waits

- Real-PG blocked-media regression failed before fix: active shutdown had no ledger row while media lookup waited. completeDeletedVoiceSession now performs bounded usage handoff before both participant eviction attempts. Native credit ledger was applied while media remained blocked and shutdown still joined media completion.
- Two native tests passed three host repetitions (5.300s) and three verified-mTLS Linux race repetitions (8.339s); services vet/lint passed. Made blocked-media test mandatory; runner14 passed. Receipt: `implementation/verification/refactor-voice-credit-before-eviction-2026-11-14.json`.
- Only per-session LiveKit ordering proven. Music-stop delay, queued sessions before enqueue, active process signal, actual network/device eviction and crash-before-first-enqueue remain open. PR298 current published527a3ad3 last snapshot32/34 successful, none failed, overall still pending.

### 2026-11-14 — Stage active shutdown accounting before all media

- First extracted state detachment without behavior changes (91842423; targeted tests3 passed1.434s). Two six-session real-PG regressions then failed: blocked music or first eviction prevented all credits from being persisted.
- Shutdown now detaches and attempts every session accounting handoff using one captured end time before starting any channel music/eviction workers. Shared eviction helper avoids duplicate credit attempts. In healthy DB tests all six ledger rows were applied with equal durations while either music or media lookup stayed blocked; shutdown still joined cleanup.
- Native tests passed three host repetitions (14.358s) and three verified-mTLS Linux race repetitions (18.507s); full vet/build/lint passed, runner14 passed. The staged test is mandatory. Receipt: `implementation/verification/refactor-staged-voice-shutdown-2026-11-14.json`.
- Separately archived published PR298 source527a3ad3 terminal36/36 checks, including31/31 ServerCI jobs in `implementation/verification/refactor-pr298-527-terminal-2026-11-14.json`. That source does not include local active/staged shutdown. DB handoff failure, pre-enqueue crash, active signal/runtime worker bound and physical-media acceptance remain open.

### 2026-11-14 — Verify shutdown worker bound and failed-apply recovery

- Eight-channel test observes four blocked media workers after all eight credits; no fifth starts before release and shutdown waits for all cleanup. Overlay removing the bound failed with the exact fifth-worker assertion (exit1), leaving tracked product source unchanged.
- Real-PG finalizer test rejects monthly aggregation via trigger after durable enqueue; final credit remains pending, then a fresh repository/owned recovery worker applies it once after fault removal. Monthly aggregate equals saved ledger seconds and another apply finds no work.
- Both tests passed three host repetitions (3.473s) and three verified-mTLS Linux race repetitions (6.330s); services vet/lint and runner14 passed. Recovery test is mandatory. Receipt: `implementation/verification/refactor-voice-shutdown-bound-recovery-2026-11-14.json`.
- Local integration only. This proves service/repository recovery, not process crash, pre-enqueue failure or physical media. Active process signal and final-source delivery/whole-project acceptance remain open.

### 2026-11-14 — Prepare active-process SIGTERM probe; engine failure

- Built Linux server from source81a6c385 and standalone probe for real login, one-shot WS ticket, voice_join observed before signal, and post-exit native usage-ledger checks. Source and hashes archived; no token/DSN output.
- Execution failed before fixture creation: owned-container docker run returned Linux Engine API HTTP500; independent docker ps also returned500 after waiting. Both handles were confirmed terminal; no duplicate run was launched and shared Docker was not restarted. The attempt did not execute login/join/SIGTERM.
- Receipt: `implementation/verification/refactor-active-signal-attempt-2026-11-14.json`; probe/harness text under `implementation/verification/active-voice-signal-2026-11-14/`. Cleanup finally attempted owned-container removal but engine inventory was unavailable, so verify mount/source ownership and remaining QA container state after engine recovery before retry. Active process/physical media and full-project acceptance remain open.

### 2026-11-14 — Publish canonical staged active shutdown

- Published PR298 head22aae5bb with active-session finalization, all-credit-before-media phases, bounded media pool, owned deleted-channel music stop and mandatory native tests. Branch-specific operation field retained; no integration-only membership API copied.
- Canonical full vet/build/lint passed; runner9 passed. Final targeted JSON has29 passing and13 skipped events (including skipped native subtests; parent pass does not prove them). Docker now fails immediately with Desktop unable to start. Current-head native/race evidence must come from CI, not old527 green receipt or integration results.
- Receipt: `implementation/verification/refactor-active-shutdown-canonical-2026-11-14.json`. No merge/release/physical acceptance claimed; active process signal and owned-container inventory remain pending engine recovery.

### 2026-11-14 — Verify terminal snapshot waits for accepted state publication

- Added deterministic admitted-operation test: shutdown closes admission while accepted join has not published state; accepted operation then publishes under the voice lock and finishes. Finalizer must credit that identity and remove its state. Twenty host repetitions passed (0.727s), services vet/lint passed.
- Overlay moving producer join after the snapshot failed with snapshot-missed-accepted-join assertion (exit1), without tracked product mutation. Receipt: `implementation/verification/refactor-voice-accepted-shutdown-snapshot-2026-11-14.json`.
- Local integration only; Docker unavailable, new-test Linux race pending. Published22aae5bb Sonar SUCCESS; ServerCI43524233537 remains live (last checked seven successful jobs, none failed). This modeled-operation test is not physical media or OS-process acceptance.

### 2026-11-14 — Forget orphan voice metadata on terminal shutdown

- No-active-session regression failed: terminal finalizer left orphan room passphrases/contexts/versions, screen viewers, move grants and offline markers. Added final locked cleanup after owned media workers join, with snapshot revision advance for orphan viewer removal. Ordinary channel deletion still preserves unrelated entries.
- Shutdown/channel-deletion tests passed20 repetitions (1.112s); services vet/lint passed. Receipt: `implementation/verification/refactor-terminal-voice-metadata-2026-11-14.json`. Removing references is not memory zeroization.
- Local integration only, new-test race pending Docker availability. Current published22aae5bb CI43524233537 remains active;11 successful jobs/no failure, PostgreSQL still in progress. Late terminal calls, process and physical-media acceptance remain open.

### 2026-11-14 — Fence room key creation after terminal voice cleanup

- Regression failed before fix: MusicRoomKey recreated forgotten room metadata after ShutdownVoiceSessions. Added mu-protected terminal flag set atomically with final map cleanup; shared locked creator rejects both music and media key paths with context.Canceled before cache reuse or generation. Media workers still join before terminal flag/key removal.
- Shutdown/key tests passed20 repetitions (4.573s); services vet/lint passed. Receipt: `implementation/verification/refactor-terminal-voice-key-fence-2026-11-14.json`. Local integration only; new race pending Docker, no zeroization or physical-media claim.
- Published22aae5bb ServerCI43524233537 remains live;18 successful jobs/no failure, PostgreSQL still in progress. Active process and final whole-project acceptance remain open.

### 2026-11-14 — Native active-shutdown CI passed; terminal-key followup prepared

- Published22aae5bb PostgreSQL job132225881418 completed SUCCESS. Downloaded completed log, verified all four mandatory active shutdown tests passed and selected native race step completed SUCCESS with TestVoiceUsagePostgres included. Receipt: `implementation/verification/refactor-pr298-22-native-ci-2026-11-14.json`. Overall43524233537 still live on repository shards; do not report overall green yet.
- Canonical local fbf10657 now contains accepted-snapshot test, orphan metadata cleanup and terminal key creation fence. Host tests20 passed4.524s, full vet/build/lint passed. Not pushed to avoid cancelling existing native/repository CI; receipt: `implementation/verification/refactor-terminal-key-canonical-prepared-2026-11-14.json`. Its new race proof remains pending, distinct from published22.

### 2026-11-14 — Make mandatory PostgreSQL service list reviewable

- Extracted the18 required native service test names into one module-level tuple, one name per line. Selection and mandatory-pass checks use the same unchanged ordered tuple. AST comparison against previous source proved exact ordered identity; all14 runner tests passed (0.077s before quote formatting; final pass rerun). No new skips, filters or weakened checks.
- Local integration only. Published22aae5bb repository shards completed without failure; Combined Go statement coverage is the last live ServerCI job at the latest poll. Prepared canonical fbf10657 remains unpushed until that terminal receipt is captured.

### 2026-11-14 — Archive active-shutdown terminal CI and publish key followup

- Source22aae5bb completed36/36 PR checks and31/31 ServerCI jobs SUCCESS. Exact-head terminal receipt: `implementation/verification/refactor-pr298-22-terminal-2026-11-14.json`; includes native PostgreSQL, selected/full-shard race, coverage, frontend/Electron/mobile checks. Scope remains source/CI, not physical or installed-client acceptance.
- Only after capturing terminal evidence, pushed prepared fbf10657 terminal key/orphan metadata followup. Existing tests20 and full vet/build/lint passed locally; new-source native/race and Sonar await new CI. Previous22 green is not reused forfbf. PR remains draft/unmerged. Active process SIGTERM still awaits local Docker recovery.

### 2026-11-14 — Isolate terminal media task panics from worker lifetime

- Eight-channel all-music-panic regression failed before fix: logx.Go recovered each worker panic but workers exited, stranding the remaining task queue. Added synchronous logx.Run using existing component/type/stack panic logging; Go now launches Run. Terminal workers guard music and each session eviction individually, without retries.
- Existing logx Go tests passed20 repetitions (1.432s); voice shutdown tests20 passed (1.098s), observing all8 music attempts and16 identity lookups despite hook panics. Full vet/build/lint passed. Receipt: `implementation/verification/refactor-shutdown-task-panic-isolation-2026-11-14.json`.
- Local integration only; new race remains pending Docker/CI. Hook attempt is not successful music stop; other worker pools and credit-stage panic behavior still need review. Publishedfbf10657 CI43526056404 remains live, last checked12 successful jobs/no failure. Final whole-project/process/physical acceptance remains open.

### 2026-11-14 — Isolate channel cleanup credit/identity panics

- Credit and eviction panic regressions failed before fix: all4 deletion workers exited and stranded their queue. Guarded the credit attempt and each main/screen identity separately using synchronous logx.Run; reused guarded credit helper in active finalization. Late closed-owner music callback now has its own boundary. No failed operation is retried or labelled successful.
- Final three deletion cases (credit/eviction/late-music), active credit-panic case, existing shutdown/deletion and Go logger tests passed10 repetitions: services0.963s, logx1.065s. They observe all8 credit and16 identity attempts. Full vet/build/lint passed. Receipt: `implementation/verification/refactor-channel-cleanup-panic-isolation-2026-11-14.json`.
- Local integration only, new native/race pending Docker/CI. Publishedfbf10657 run43526056404 remains live with20 successful jobs/no failure at last poll. Other worker pools and full project/process/physical acceptance remain open.

### 2026-11-14 — Archive terminal key CI and publish canonical panic isolation

- Publishedfbf10657 completed36/36 checks and31/31 ServerCI jobs SUCCESS. Exact-head receipt: `implementation/verification/refactor-pr298-fbf-terminal-2026-11-14.json`.
- Canonical transfer initially imported integration-specific panic_type log policy, failing existing completion-log tests. Corrected by extracting Run from canonical HEAD recovery body, preserving panic field and pkg.ErrText error redaction without weakening tests. Host services/logx tests10 passed0.998s/1.032s; full vet/build/lint passed.
- Published3a16b910 only after previous terminal CI was archived. New-head CI/native/race pending; receipt: `implementation/verification/refactor-panic-isolation-canonical-2026-11-14.json`. No native/physical/process success inferred from host tests.

### 2026-11-14 — Require active voice process SIGTERM in Linux native lane

- Added separate test-executable process invoking production main, fresh minimal environment, owned loopback DB and normal login/one-shot WS ticket/voice_join. Requires socket active before SIGTERM, successful exit/graceful marker and exactly one applied native credit equal to monthly total. Not release-artifact or physical media proof.
- Native runner now rejects missing/skip/wrong-package process result. Integration runner15 and canonical runner10 tests passed; full vet/build/lint passed in both trees. Windows runtime skipped as expected; no POSIX acceptance claimed yet.
- Canonical transfer initially lacked integration backendWatchTestPool; supplied a scoped loopback/verified-TLS owned DB fixture. Source review corrected child DSN from pgx KV ConnString to URL preserving TLS parameters before CI.
- Archived previous3a16b910 terminal36/36 checks and31/31 jobs in `implementation/verification/refactor-pr298-3a16-terminal-2026-11-14.json`, then published6162072e process contract. Receipt: `implementation/verification/refactor-active-process-ci-contract-2026-11-14.json`. New-head CI is authoritative; local standalone-binary Docker and physical acceptance remain open.

### 2026-11-14 — Aktif süreç mTLS fixture düzeltmesi

PR #298 `6162072e` koşusunda yeni süreç testi, repository işinin düz PostgreSQL bağlantısını TLS zorunlu fixture ile kullanması nedeniyle başarısız oldu. SQL kaynak taraması da doğrudan DDL `ExecContext(fmt.Sprintf(...))` çağrılarını engelledi. `2ac1f132` sabit DDL şablonlarını adlandırır ve mevcut sertifikalı E2E fixture’ını yalnız aktif süreç testine bağlar; TLS doğrulaması, fallback yasağı ve zorunlu PASS kapısı korunur. Yerel kaynak taraması 0 blok, vet başarılı, lint 0 sorun, runner 10 test başarılı. Windows süreç koşusu atlanır; yeni Linux CI 43530862476 sonucu bekleniyor. Gerçek süreç kabulü henüz kanıtlanmadı. Ayrıntı: `implementation/verification/refactor-active-process-mtls-correction-2026-11-14.json`.

### 2026-11-14 — Aktif süreç WebSocket sözleşmesi düzeltmesi

`2ac1f132` güncel güvenlik kontrolünden geçti; mTLS süreç fixture’ı giriş aşamalarını geçti fakat katılma olayı 46,50 saniyede zaman aşımına uğradı. Fixture yanlış `data` yük alanını kullanıyordu; üretim `ws.Event` sözleşmesi `d` kullanır. `7a5e44ba` gönderimde doğrudan `ws.Event`/`ws.VoiceJoinData` kullanır, alımda `d` okur ve kendi kullanıcı/kanal/join olay eşleşmesini korur. Yerel derleme (Windows POSIX atlaması), vet ve lint 0 sorun. Linux kabulü yeni kaynakta hâlâ bekleniyor. Önceki hata anlık görüntüsü: `implementation/verification/refactor-pr298-2ac-native-failure-2026-11-14.json`.

### 2026-11-14 — Aktif süreç native race kapısı hazırlığı

Birleşik CI işine yalnız `TestActiveVoiceProcessPostgresSignal` için ayrı `go test -race .` adımı eklendi. Normal zorunlu test koşusundan sonra, aynı sahipli mTLS fixture ile çalışır; bağlantı değişkeninin boş olması shell kapısıyla reddedilir. Windows yerel koşusu bu kabulü sağlayamaz. Kanonik PR’a aktarım, halen çalışan `7a5e44ba` normal süreç sonucundan sonra yapılacak; bu hazırlık çalıştırılmış race kanıtı değildir.

### 2026-11-14 — Gerçek Linux aktif süreç SIGTERM kabulü

PR #298 `7a5e44ba` native PostgreSQL işi 132251172133 SUCCESS. Zorunlu aktif süreç testi 3,12 saniyede PASS: normal giriş/tek kullanımlık WS ticket ve üretim `d` sözleşmesiyle katılım; sinyal öncesi açık soket ve sıfır kredi; SIGTERM sonrası başarılı/graceful süreç çıkışı. Sonuç: kredi 1, pending 0, applied 1, aggregate 2 saniye = ledger 2 saniye. Aynı işte seçili repository/service/database race adımı da geçti; aktif süreç bu kaynakta race ile çalışmadı. `058b2117` ayrı aktif süreç race adımını PR’a gönderir; yeni CI bekleniyor. Kanıt: `implementation/verification/refactor-pr298-7a5-native-process-success-2026-11-14.json`. Bu araçlı test executable kanıtıdır; yayın binary’si, LiveKit/cihaz, pre-enqueue crash kabulü değildir.

### 2026-11-14 — Aktif kredi için süreç restart kabulü hazırlığı

Birleşik süreç testi ilk aktif SIGTERM sonrası kredi satırının tüm alanlarını JSONB ile snapshot alır, aynı sahipli veritabanıyla ikinci gerçek sunucu sürecini açar, health ve graceful SIGTERM çıkışını doğrular. İkinci kapanışta aggregate=ledger/count/pending kontrolleri ve kredi payload/created_at/applied_at dahil tam satır eşitliği zorunludur. Windows test derlemesi (POSIX atlaması), vet ve lint 0 sorun geçti; native çalıştırma henüz yapılmadı. Aktif süreç race head `058b2117` CI tamamlanmadan kanonik dala yeni push yapılmayacak. Önceki `7a5e44ba` native işi SUCCESS olsa da sonraki push tüm workflow’u iptal etti; bütün commit için 36/36 başarı iddiası yok.

### 2026-11-14 — Aktif süreç native race kabulü

PR #298 `058b2117` native PostgreSQL işi 132254279430 SUCCESS. Zorunlu normal süreç PASS (1 kredi/pending0/applied1, usage2=ledger2) sonrasında ayrı `go test -race . -run ^TestActiveVoiceProcessPostgresSignal$` adımı da SUCCESS, 13,383 saniye. Parent ve üretim main’i çağıran ayrı child executable race ile derlenir; child başarısız çıkışı kabul edilmez. Kanıt: `implementation/verification/refactor-pr298-058-native-race-success-2026-11-14.json`. Tüm workflow için dört repository shard’ı halen çalışıyor; bu kayıt 36/36 başarı iddiası değildir. Restart takip değişikliği kanonik dalda yerel `956c95ab`, uzak dala henüz gönderilmedi. Yayın binary’si, fiziksel medya ve pre-enqueue crash kapıları açık.

### 2026-11-14 — Terminal aktif süreç race teslimatı ve restart takibi

PR #298 `058b2117` terminal 36/36 SUCCESS; Server CI 43532722522 terminal 31/31 SUCCESS. Tam kanıt `implementation/verification/refactor-pr298-058-terminal-2026-11-14.json`. Böylece normal ve race aktif süreç kabulü aynı kaynak için tüm CI ile birlikte kaydedildi. Ardından hazır restart testi `956c95ab` uzak dala gönderildi; bu yeni kaynak önceki başarıyı devralmaz. Yeni Linux normal/race restart sonucu bekleniyor; yerel kanonik vet/lint ve Windows derlemesi geçti.

### 2026-11-14 — Birleşik kaynakta eski inceleme hash’i

Tam self-scan, mevcut DM delivery fixture incelemesinin dosya hash’i constructor refactor’ları sonrasında eskidiği için exit1 verdi. `server/services/dm_delivery_test.go:114` sorgusu yeniden incelendi: tek SQL sabiti içindeki sabit interval aritmetiği, mesaj kimliği bağlı argüman; satır hash’i değişmemiştir. Mevcut kaydın yalnız dosya hash’i güncellendi; yeni istisna yok (50 kayıt). Manifest doğrulaması başarılı, doğrulayıcının 6 testi başarılı. Yeni tam tarama çalışıyor; henüz başarı kanıtı değildir. Bu düzeltme birleşik ağaca özgüdür; kanonik PR manifest’i körlemesine değiştirilmedi.

### 2026-11-14 — Ayrı üretim sunucu binary’siyle süreç kabulü hazırlığı

Birleşik fixture artık test executable’ında `main()` çağırmaz; mutlak ve düzenli `HICHAT_ACTIVE_VOICE_SERVER_BINARY` dosyasını başlatır, eksikse başarısız olur. Normal CI önce `go build`, native race adımı önce `go build -race` ile aynı kaynakta ayrı sunucu üretir; parent ve server birlikte race ile çalışır. Login/WS/aktif SIGTERM/aynı DB ile restart/tam kredi satır eşitliği koşulları korunur. Windows test derlemesi POSIX atlaması, tam vet ve lint 0 sorun geçti; native yeni binary modu henüz çalıştırılmadı. Yayımlanmış binary/kurulum ve fiziksel medya kanıtı değildir. Mevcut `956c95ab` CI terminal olmadan kanonik dala gönderilmeyecek. Tam kaynak taraması, ayrıca düzeltilen mevcut DM review hash’iyle hâlen çalışıyor.

### 2026-11-14 — Restart kabulü normal/native race başarılı

`956c95ab` native iş 132259056257 SUCCESS: normal süreç 4,21 saniye PASS, tam kredi satırı restart sonrası aynı (`retained_credit=true`), iki gözlemde credits1/pending0/applied1 ve usage2=ledger2. Ayrı native race adımı 17,227 saniye PASS. Tam kanıt `implementation/verification/refactor-pr298-956-native-restart-success-2026-11-14.json`. Tüm CI terminal değil; iki repository shard’ı sürüyor. Kanıt hâlâ üretim main’ini çağıran test executable’ı içindir; ayrı `go build` binary hazırlığı henüz native çalıştırılmadı.

### 2026-11-14 — Terminal restart kaynağı

`956c95ab` PR #298 terminal 36/36 SUCCESS, Server CI 43534190503 terminal 31/31 SUCCESS; kaynak-bağlı tam kayıt `implementation/verification/refactor-pr298-956-terminal-2026-11-14.json`. Ayrı üretim binary hazırlığı kanonik ağaçta da test derleme/vet/lint 0 sorun aldı, henüz push/native kabul yok. Birleşik tam taramada izlenmeyen coverage raporları üçüncü taraf innerHTML nedeniyle BLOK üretti; bu çıktılar korunuyor. CI temiz checkout kapsamını eşleyen `1dfb78e4` izlenen kaynak arşivinde tam tarama hâlen çalışıyor (exec session49944); manifest50 geçerli, sonuç bekleniyor. Bu ayrım ürün kodu hatasını gizleyen yeni exclude veya istisna eklemez.

### 2026-11-14 — Ayrı üretim binary’si native kabulü

PR #298 `a9f00ad9` native iş 132264989679 SUCCESS. Gerçek `go build` sunucusuyla normal süreç testi 3,46 saniye PASS: iki gözlemde credits1/pending0/applied1 ve usage2=ledger2; restart tam satır eşitliği `retained_credit=true`. `go build -race` sunucusu ve `go test -race` parent adımı 15,027 saniye PASS. Kanıt: `implementation/verification/refactor-pr298-a9f-production-binary-native-success-2026-11-14.json`. Bu source-built server kabulüdür, yayın artifact/kurulum veya fiziksel medya kanıtı değildir. Tüm CI henüz terminal değil. Ayrı kayıt: izlenen `1dfb78e4` kaynak arşivi tam self-scan exit0, 0 BLOK, mevcut 50 review kaydı; `implementation/verification/refactor-production-process-clean-scan-2026-11-14.json`. Kanal silme sırası düzeltmesi bu taranan kaynakta bulunmaz, kendi doğrulamasını gerektirir.

### 2026-11-14 — Kanal silmede bütün kredi devirleri önce

Eski kaynak Go overlay ile üç senaryoda FAIL verdi: 8 oturum varken medya başladığında kabul açık eviction yolunda 4, kapanmış admission eviction yolunda 1, kapanmış admission music yolunda 0 kredi devredilmişti. Ayrı ve en fazla dört worker kullanan muhasebe aşaması bütün devir denemelerini birleştirir; sonra müzik/LiveKit temizliği başlar. Kabul açık yol asenkron owned child olarak kalır; geç committed silmede caller kendi tamamlanmasını bekler. Her task panic izolasyonu korunur. İlgili testler iki ağaçta 20 tekrarda, tam servis paketleri 84,788/84,509 saniyede geçti; vet/lint 0 sorun. Runner 15/10 test başarılı. Yeni altı oturumlu gerçek PG testi mandatory PASS listesine eklendi; native ve race sonucu henüz yok. Kanıt `implementation/verification/refactor-channel-delete-credit-ordering-2026-11-14.json`. DB yavaşlığı mevcut kredi context süreleri boyunca medya fazını geciktirebilir; bu sıra garantisi başarılı enqueue/eviction veya ilk enqueue öncesi crash garantisi değildir. Kanonik PR’a mevcut a9f00ad9 CI terminal olduktan sonra gönderilecek.

### 2026-11-14 — Terminal üretim binary kabulü ve kanal silme takibi

`a9f00ad9` terminal PR 36/36 SUCCESS, Server CI 43535987403 31/31 SUCCESS; tam kaynak-bağlı kayıt `implementation/verification/refactor-pr298-a9f-terminal-2026-11-14.json`. Bundan sonra `15ee5781` kanal silme muhasebe sırası düzeltmesi PR #298’e gönderildi. Bu yeni kaynak önceki CI başarısını devralmaz; yeni zorunlu altı oturumlu PostgreSQL testi ve native race sonucu bekleniyor.

### 2026-11-14 — Link preview worker join

RF08 tekrar kontrolünde `linkPreviewService.Stop` yalnız cancel ediyor, kabul edilmiş repository worker’ını beklemiyordu. Bloke repository testinin eski kaynak overlay koşusu exit1: Stop dönerken worker hâlâ çalışıyor. `Stop` artık lifecycle iptalini ve pending done snapshot’ını kayıt mutex’i altında yapar; worker cleanup aynı mutex’e ihtiyaç duyduğu için kilit bırakıldıktan sonra bütün done kanallarını bekler. Eşzamanlı iki Stop, yeni admission reddi, caller completion ve tekrarlı Stop sınanır. Main tabanlı ayrı dal `4e3f0349`, draft PR #299. Hedefli testler 20 tekrar, tam servis paketi 91,150 saniye, tam vet/build ve lint0 başarılı. Birleşik ağaç hedefli20/vet/lint0 başarılı. Linux race ve bütün CI henüz bekleniyor. Kanıt `implementation/verification/refactor-link-preview-worker-shutdown-2026-11-14.json`. #298 veya primary dirty ağaç değişiklikleri bu küçük PR’a taşınmadı.

### 2026-11-14 — Kanal silme native kabulü ve WS fixture onarımı

`15ee5781` native PostgreSQL işi 132269921518 SUCCESS: zorunlu altı oturumlu kanal silme testi admitted-eviction/closed-eviction/closed-music yollarında PASS; her birinde medya bloke iken altı kredi uygulanmış, pozitif/eşit süre ve aggregate=ledger koşulları sağlandı. Seçili native race ve üretim normal/race süreç adımları da SUCCESS. Tam workflow terminal FAILURE: Go base işi 132269921616, oyun WS fixture’ında Game A snapshot’ını Game B beklentisinde gördü. Kanıt `implementation/verification/refactor-pr298-15ee-native-success-ci-fixture-failure-2026-11-14.json`. `ready` ilk asenkron snapshot’ın tamamlandığı garantisi vermediği için fixture dört ilk snapshot’ın bitmesini bekler. Üç olumsuz gizlilik kontrolü Gorilla read timeout ile bozulmuş bağlantıyı tekrar okumak yerine tek canlı okuyucu kullanır, cleanup’ta close/join eder. Oyun kimliği beklentisi aynı kaldı; timeout pencereleri 200ms olarak korundu. Kanonik tam WS paketi üç tekrar, ilgili senaryo 50 tekrar (30,725s), birleşik WS+ek registration testi 10 tekrar (7,529s), her iki ağaç vet/lint0 geçti. Birleşik ek registration testi kör kopyayla silinmedi. Fixture düzeltmesi `ed69e2fe` PR #298’e gönderildi; yeni Server CI 43539375616 sonucu bekleniyor. PR açıklaması son davranış/kanıt/açık risklerle yenilendi.

### 2026-11-14 — Link preview terminal CI

PR #299 `4e3f0349` terminal 36/36 SUCCESS, Server CI 43538402278 terminal 31/31 SUCCESS. Yeni `TestLinkPreviewStopJoinsCanceledWorker` doğrudan Linux services shard2/8 logunda seçili; iş 132272908014 SUCCESS, services -race 155,781 saniye. Tam kaynak-bağlı kanıt `implementation/verification/refactor-pr299-4e3-terminal-2026-11-14.json`. Draft PR açık; birleştirme, nihai birleşik kaynak ve fiziksel/provider runtime kabulü iddiası yok.

### 2026-11-14 — Terminal ses CI ve snapshot callback sahipliği

#298 `ed69e2fe` terminal PR36/36 SUCCESS, Server CI43539375616 31/31 SUCCESS; tam kayıt `implementation/verification/refactor-pr298-ed69-terminal-2026-11-14.json`. PR açıklaması güncel terminal kanıtla uzlaştırıldı.

RF08 envanterinde `RequestGameActivitySnapshot` detached callback’i Hub callback owner shutdown’ından kaçıyordu. Üç eski-kaynak overlay regresyonu doğrulandı: owner bitmeden callback’in sürmesi, shutdown sonrası kabul, aynı kullanıcının ikinci snapshot’ının öne geçmesi. İlk join gözleminin zamanlama-only penceresi owner stopSubmit/shutdownDone fazlarıyla güçlendirildi; son negatif koşu üçünde de exit1. Callback Hub.mu altında reserve edilir, kilit bırakıldıktan sonra mevcut 8 worker/256 pending dispatcher’a submit edilir. Kullanıcı FIFO, başka kullanıcı ilerlemesi, panic izolasyonu ve Hub shutdown join aynı owner’da kalır; yeni lifecycle döngüsü eklenmez. Main tabanlı ayrı dal `3e0b131c`, draft #300. Güncel snapshot testleri50 tekrar (4,349s), tam WS (4,670s), mevcut callback testleri20 tekrar; birleşik snapshot+registration20 tekrar (4,130s), iki ağaç tam vet/build ve lint0 başarılı. Sağlıklı üç gizlilik gözlemi ve ilk snapshot bariyeri fixture’a dahil; birleşik ek registration testi korunur. Yeni kaynak Linux race/tam CI bekleniyor. Kanıt `implementation/verification/refactor-game-activity-snapshot-ownership-2026-11-14.json`.


### 2026-11-14 — Backup worker ownership and quality-gate follow-up

RF08 backup owner no longer returns from Stop while accepted periodic/manual/restore work is active. Admission closes under lifecycleMu before cancellation and join. Concurrent Shutdown callers share one final DB-only cycle; any caller cancellation cancels that cycle and every caller joins. Main stops background backup work before log sinks close, while the final snapshot stays after writer drain. Initial two regressions failed against original source. Lifecycle matrix passed20 in canonical and integrated trees; initial full services passed89.510/90.121 seconds, vet/build and Windows/Linux lint0 passed. Published draft #301 source1b47c315 failed Sonar at7.4% duplicated new lines and two complexity findings. Follow-up ae4175f3311eeb05649d0e004723c32111d851cc shares the blocked-command fixture, extracts the cancellation table subcase and separates snapshot creation/verified promotion without removing assertions or adding exclusions. New full services84.756 seconds, vet/build, Windows/Linux lint0 and both lifecycle20 passed. Current Server CI run43549219967 is pending behind the previous running job; no restart/cancellation was issued. Linux real helper-process cancellation/race acceptance and complete current-source CI remain open. No live HF restore, partial restore resume, subprocess descendant guarantee, deployment or installed-client acceptance is claimed. Receipt: implementation/verification/refactor-backup-service-ownership-2026-11-14.json.

Published snapshot callback source3e0b131cc03fb19253d78ac70f0c10b2c1f20f9e (#300) subsequently completed36/36 checks, including31/31 ServerCI jobs in43541778893. Terminal receipt implementation/verification/refactor-pr300-3e0-terminal-2026-11-14.json records that exact source; PR description updated. This closes that source's pending CI statement above, not whole RF08 or final combined-source/provider/device acceptance.


### 2026-11-14 — Own voice WebSocket callbacks

RF08 inventory found eight voice/screen-watch handlers launching detached callbacks. Two original-source regressions failed: Hub owner shutdown completed while activity callback ran, and post-shutdown activity was admitted. Separate old-source overlay failed cross-event same-user order (leave overtook activity). Voice callback admission now reserves under Hub.mu and submits outside it through existing bounded presence dispatcher: same-user FIFO, other-user progress, eight workers/256 pending, panic isolation, cancellation of queued work and join of running callbacks. Full admission queue applies backpressure; moderation authorizer still runs before service invocation. Three lifecycle/order scenarios30 passed; full WS3 passed11.342s; integrated voice/snapshot/registration20 passed5.824s; canonical full vet/build and Windows/Linux lint0 plus integrated vet/build/lint0 passed. Published source882bd6c3, draft #302. Linux race/full CI and physical voice/LiveKit remain open. P2P/typing callbacks are separate remaining ownership inventory. Receipt implementation/verification/refactor-ws-voice-callback-ownership-2026-11-14.json. No RF08/project-wide completion or release claim.


### 2026-11-14 — Backup Linux command fixture acceptance

Current backup CI sourceae4175f3 failed service shard7/8 job132307706666: self-reexecuted services test helper did not report readiness in3 seconds. Exact startup root cause remains unproven (original helper passed once without race under local Ubuntu WSL). Replaced whole test-binary reexec with a fixed minimal /bin/sh fixture writing its PID before exec sleep; path passed positionally, no provider credentials. Readiness3s, cancellation2s and exact PID ESRCH assertions are unchanged. New Linux test binary executed in WSL20 times successfully. A separate runner overlay deliberately ignoring context failed the cancellation assertion at2s and its owned fixture self-exited at20.01s with exit1. Linux crosscompile/lint0 passed. Published follow-up source936c4259; current-source race/CI acceptance remains pending. No provider backup/restore or subprocess descendant guarantee is inferred.


### 2026-11-14 — Extend callback ownership to P2P and typing

Three new original-source subcases failed owner join: P2P end, channel typing and DM typing. Shared dispatchOwnedCallback now admits all client voice/P2P/typing callbacks under Hub.mu and submits through the existing bounded owner. Canonical lifecycle30 passed; full WS3 initially failed because an existing validated-P2P fixture used a bare Hub literal without dispatcher. Updated that fixture to NewHub plus shutdown cleanup, preserving DTO/authenticated-actor/invalid-signal assertions; full WS3 then passed11.816s. Canonical full vet/build and Windows/Linux lint passed before the constructor-only fixture update. Guarded integrated port detected its newer call_id contract, so scoped edits preserved that signature and wire compatibility test; both fixtures use owned constructors. Integrated lifecycle/DTO/wire20 passed5.687s, full WS3 passed16.148s, lint0 passed. Local canonical follow-up ed53302a not yet pushed: current PR302 source882bd6c3 has32 successful checks and two repository shards still running. Do not attribute that source's CI to this follow-up. Receipt refactor-ws-voice-callback-ownership-2026-11-14.json. Physical media/final combined-source/race acceptance remain open.


### 2026-11-14 — Publish shared callback owner after terminal voice proof

PR302 source882bd6c395e0adcefb9d509b73eb5757392ab66f completed36/36 successful checks; Server CI43549779679 terminalsuccess. Archived source-bound check/job metadata in implementation/verification/refactor-pr302-882-terminal-2026-11-14.json. Only after this terminal proof, pushed ed53302a with shared voice/P2P/typing owner and rewrote PR title/body to final scope. Full current canonical vet/build passed after constructor fixture change. Current ed53302a race/full CI remains pending; previous-source green is not inherited. Refactor-wide, provider/device and final combined acceptance remain open.


### 2026-11-14 — Diagnostics worker ownership and backup terminal proof

DiagnosticsHandler bounded sends to four but lacked a shutdown owner; new regression failed on missing owner. Added mutex-serialized admission/worker registration, terminal Stop, lifecycle cancellation and join including send/log completion. Main stops diagnostics after HTTP drain before log sinks/writers close. Retained204, backpressure, filename and60s timeout. Synchronous logx.Run extracts canonical existing panic policy so worker completion follows recovery logging; integrated stronger redaction is preserved. Concurrent/repeated Stop and late admission tested. Diagnostics20 passed9.296s; integrated diagnostics/logx20 passed9.769/1.463s; canonical full handlers/logx passed5.614/1.464s; canonical full vet/build, Windows/Linux lint0 and integrated full vet/build/lint0 passed. Source39a1476b published draft #303; Linux race/full CI pending. Mock sender only, no real email/provider acceptance. Receipt refactor-diagnostics-worker-ownership-2026-11-14.json.

Backup PR301 source936c42596908f036f6f8e3635241ac9902b4624a subsequently completed36/36 checks; Server CI43550268177 terminalsuccess, including its Linux real-process cancellation race shard. Exact-source check/job proof archived refactor-pr301-936-terminal-2026-11-14.json. Whole RF08, provider backup/restore and final combined acceptance remain open.


### 2026-11-14 — Prove diagnostics completion-log ownership

Added a blocking completion logger regression: Stop must still wait after canceled send returns until its error log finishes, and exactly one cancellation completion log remains. A counterfactual overlay releasing worker ownership before logging failed with Stop escaped completion logging. Current canonical stop tests30 passed2.047s; complete handlers passed5.805s, logx cachedpass, full vet and lint0 passed. Follow-up c5eb283f is local only while PR303 source39a1476b CI remains active; no newer-source CI claim. This strengthens the send-plus-logging boundary without changing product behavior.


### 2026-11-14 — Shared client callback CI terminal; music drain regression

PR302 shared client callback sourceed53302ae2c5a58cf3596927979a5d48f4b21c10 completed36/36 successful checks; Server CI43550903641 terminalsuccess,31/31 jobs. Archived refactor-pr302-ed5-terminal-2026-11-14.json and updated PR description. Final combined-source/physical acceptance remains open.

RF10 shutdown inspection found StopAll stops bot state/process cancellation but does not join accepted playback loops. Separate clean main-based music-worker-shutdown worktree reproduced this with actual Enqueue and blocked playTrackFn: TestMusicStopAllJoinsAcceptedPlaybackWorker fails StopAll returned while accepted playback worker was running. No provider calls. This is an unfixed local red regression, not published or integrated. Implement a terminal owner that serializes admission and worker registration, drains already-removed/replaced bots too, and joins outside bot/session/lifecycle locks; verify concurrent stop, late enqueue/resume, panic cleanup and in-flight creation/extraction rather than only counting current map entries. Existing integration shuttingDown fence must be preserved. Whole RF10 remains open.


### 2026-11-14 — Music terminal work owner implementation

Actual Enqueue/blocked playback regression failed first (local0b9a999d). Added global service work owner with admission/registration under s.mu, lifetime independent of current bot map, cancellation for enqueue/restore/getOrCreate, and join after stop releases channel/session/bot locks. Playback/publication/disconnect/idle callbacks register before launch; synchronous panic boundary finishes recovery logging before worker release. Active/removed playback, concurrent StopAll, late enqueue/restore, blocked extraction and blocked connection passed20 in both trees. Initial canonical full services90.120s/logx6.947s passed; vet/build and Windows/Linux lint0 passed; integrated vet/build/lint0 passed. Initial integrated full failed existing explicit-stop error contract; corrected terminal rejection to errBotStoppedExplicitly rather than weakening that assertion. Post-fix targets20 passed2.675/2.716s. Current fe6852fd pushed, no draft PR yet; final full canonical session40360/integrated1607 active with persisted temp logs. Current-source race/CI and physical/provider acceptance remain open. Receipt refactor-music-worker-shutdown-2026-11-14.json. No whole RF10 closure claim.


### 2026-11-14 — Diagnostics original fix terminal and logging-test follow-up

PR303 source39a1476b12e59702582cd3c9b37000a6369f3052 completed36/36 checks, ServerCI43551511745 terminalsuccess31/31. Exact-source proof archived refactor-pr303-39a-terminal-2026-11-14.json. After terminal completion, pushed c5eb283fd4d5957940a33001f5e636a06df13aeb (completion-log regression only). Current-source full CI remains pending; previous source green is not inherited. Product behavior unchanged by the follow-up. No whole RF08 or refactor-wide acceptance claim.


### 2026-11-14 — Music current full services verified and draft published

Final fe6852fd canonical services81.591s and integrated services82.588s passed; final logx cachedpass. The earlier explicit-stop compatibility failure is fixed while retaining its existing assertion. Published draft #304; current Linux race/full CI pending. Persisted source-bound receipt refactor-music-worker-shutdown-2026-11-14.json updated. No real provider/media/physical-device, final combined acceptance or whole RF10 closure claim.


### 2026-11-14 — Music producer panic cleanup proof

Added actual Enqueue/connect-panic test: panic still reaches request recovery, bot map empties, and terminal StopAll drains registered producers. Removing Enqueue finish in a temporary source overlay fails ownership leaked after connect panic at2.12s. Positive panic/waiter/StopAll matrix20 passed2.979s canonical and3.893s integrated; Windows lint0 passed. Current Linux test binary executed under Ubuntu WSL with --exec passed20 (no race). Initial shell-mediated regex invocation exit127 is not accepted evidence. Local follow-up410bf58b is not yet pushed while PR304 sourcefe6852fd CI remains active. Receipt refactor-music-worker-shutdown-2026-11-14.json updated; current-follow-up full CI/real provider/media acceptance remain open.


### 2026-11-14 — Playback guard cancellation and terminal source receipts

Actual Enqueue with hanging DNS guard showed another owner gap: StopAll waited5.07s for independent guard deadline, rather than canceling it (regression failed at1s). Derive both the5s-bounded guard and pipeline context from music lifetime; keep timeout/security guard policy and unset-cancelFn rejection semantics, and treat service cancellation as intentional early exit. URL shutdown test30 passed0.551s with no music_bot_error; existing guard-deadline/Skip/Stop cases2 passed10.961s; integrated lifecycle20 passed2.886s. Full services102.753/101.276s passed, logx cachedpass; canonical vet/build and Windows/Linux lint0 passed. New fec953fe published to draft304 after previousfe6852fd completed36/36 checks (ServerCI43552868347); archive refactor-pr304-fe6-terminal-2026-11-14.json. Current fec953fe full CI/race pending, not inherited. Receipt refactor-music-worker-shutdown-2026-11-14.json updated.

Diagnostics currentc5eb283fd4d5957940a33001f5e636a06df13aeb completed36/36 checks, ServerCI43552802835 terminalsuccess31/31. Archived refactor-pr303-c5e-terminal-2026-11-14.json and updated PR303 body. RF08/RF10, actual provider/device and final combined acceptance remain open.


### 2026-11-14 — First combined candidate terminal and RF03 verdict correction

Frozen integration8ec41413f7ac03f72a53a1c11010df76283d1cf2 (draft305) completed36/36 checks and31/31 ServerCI jobs in43557593050. Last repository shard completed successfully after13m35s; no live job was canceled/restarted. Archived refactor-integration-8ec-terminal-2026-11-14.json. Current musicfec953fe also completed36/36/31 ServerCI jobs43556692114 (refactor-pr304-fec-terminal-2026-11-14.json).

Local frozen candidate: client4824 passed/1 skipped, line67.53%/branch64.04%, TypeScript and production build exit0, lint0errors/2warnings. Clean tracked archive self-scan exit0/zero blocking matches/434 review rows,50 exact reviewed records; guardrail synchronization passed. Source-bound preflight/tooling records archived. CI UTF-8 checked3228 files with0 invalid and client Build passed, satisfying RF01 for that exact source. Requirement audit refactor-integration-8ec-requirement-audit-2026-11-14.json keeps other cards unproven until reviewed individually. Acceptance structure remains valid:261 behaviors,248 pending,2 accepted,11 excluded; no bulk status edits.

RF03 audit reproduced nine zero-exit false-green cases in structured client/server reports (only skips, unfinished Go output, test/suite/package failure and invalid counts). Separate draft306 sourcecc932e8a fixes the verdict; all50 runner/frozen-source/acceptance tests pass, and actual4824/0/1 client report remains compatible. Only after8ec terminal, guarded port of both runner files into integration passed50 again. This follow-up creates a new combined source requiring fresh CI; old green is not inherited. Runtime/provider/device and remaining RF01-RF30 acceptance stay separate.


### 2026-11-14 — Second combined candidate terminal, detailed baseline and RF23 provenance

Combined23d1796be815bd28032210e8750dfc2b3546e110 completed36/36 checks and31/31 ServerCI jobs43559040263. Individual quality fixcc932e8a (draft306) also completed36/36/31 in43558434893. Source-bound receipts refactor-integration-23d-terminal-2026-11-14.json and refactor-pr306-cc9-terminal-2026-11-14.json archived before further porting.

Clean detached8ec baseline: server Go JSON4324 passed/84 skipped/0 failed in207.528s, welcome-bot20 passed/0 skipped/0 failed in10.358s. Includes subtests; Windows Go1.27.4, CGO0, no race, test provider env absent. Server source fingerprints remained identical; bot module additionally bound to clean Git tree. These local counts do not replace Linux race/native PostgreSQL CI. Baseline records preserve slow-test timing and explicit skipped profile boundaries; acceptance ledger unchanged.

RF23 audit found required clean committed-source default absent despite byte-bound manifest. Six Git dirtiness/HEAD-change cases failed first. New publisher checks Git cleanliness before snapshot and clean/same HEAD afterward; mismatch aborts before backend pause or Space commit, without cleaning/staging caller work. Existing byte binding, digest, remote parent, managed deletion and exact deployed-commit handoff retained. Actual workflow EXPECTED_COMMIT consumes steps.source.outputs.deployed_commit. Source388a9fc8 published draft307;20 publication and35 canonical Python tests passed, guarded integration all44 Python tests passed. Fake API only; local SDK1.1.4, pinned CI SDK check pending. Port performed only after23d terminal. Next combined source requires fresh CI; no whole RF02/RF23/RF30 completion claim. Receipt refactor-publish-clean-source-2026-11-14.json.

### RF04 ve RF28 kabul doğrulaması, 14 Kasım 2026

RF04'te yalnız aynı havuz üzerinde ikinci migration çağrısı yerine bağlantıları
kapatıp aynı PostgreSQL şemasını yeni havuzla açan kontrol eklendi. Yerel Windows
Go 1.27.4 / PostgreSQL 18.6 koşusunda beş üst seviye migration/veri sözleşmesi
atlamasız geçti. Ayrı verify-full mTLS fixture'ında sunucu sertifikasının yanlış
kök ile ve istemci sertifikasının farklı kullanıcı kimliğiyle reddi doğrulandı.
SQLite alt testleri, genel loopback PostgreSQL ve mTLS sonuçları ayrı tutuluyor.
Kanıt: `implementation/verification/refactor-rf04-local-live-2026-11-14.json`.

RF28 üretim Chromium paketinde iki oturumlu eşzamanlı gönderme/düzenleme/silme
dahil 15/15 test geçti. Ayrı yedek/kurtarma senaryosu gerçek bir açık gösterdi:
kimlik geri yükleniyor, fakat eski mesaj sender-key replay korumasında kalıyordu.
Kaynak sürümüne bağlı kanal önbelleği eklendi; daha sonra WebSocket create/update
yazmalarının bu etiketi ezdiği de iki regresyonla doğrulandı ve düzeltildi.
Replay protokolü gevşetilmedi. Son birleşik yerel kripto/store/WS koşusunda
196 test geçti; bunlar üretim tarayıcısı kabulünün yerine geçmez.

Açık kalanlar: WebSocket düzeltmesiyle üretim kurtarma E2E'sinin tamamlanması,
kaynak etiketsiz eski kanal yedeklerinin geçmiş uyumluluğu, güncel adayın tüm CI
kontrolleri ve diğer RF kartlarının madde madde kabul denetimi. Eski KDF/format
sabit fixture'larının anahtarları geri yüklemesi, eski geçmişin okunabildiği
anlamına gelmiyor. 248 ürün davranışı topluca kabul edilmiş sayılmadı.

14 Kasım devam doğrulaması: `c9ddad08` CI'ında 35/36 kontrol geçti. Üretim
kurtarma testi yedek oluşturmayı, yanlış parola reddini, kimlik parmak izini ve
ilk geçmiş mesajını doğruladı; yalnız yenileme sonrası aynı kanalda boş gövde
kaldı. Mevcut anahtarlar hazır olduğunda erken geçmişi yenileyen yol eklendi.
Oturum bu sırada değişirse yenileme çalışmıyor. Son yerel birleşik koşu 263/263.

Kaynak etiketsiz eski kayıt için salt okunur imza/AEAD doğrulaması eklendi.
Yükseltme yalnız aynı mesaj/kanal/zaman ve doğrulanmış aynı metin için geçerli;
canlı replay durumu değiştirilmez. Düzenlenmiş eski kayıtlar, ekler ve eksik
başlangıç anahtarı bu otomatik yolun dışında kalır. Üretim E2E artık hem yeni
etiketli hem test fixture'ında etiketi kaldırılmış yedekle geri yükleme ve
sayfa yenilemesini sınayacak. Bu iki yeni tarayıcı sonucu henüz bekleniyor.

14 Kasım üretim kabul kilometre taşı: `8c341d74` adayının 36/36 kontrolü geçti.
Normal Chromium 15/15; yeni etiketli ve eski etiketsiz metin yedeği kurtarma
profili setup dahil 3/3; WebKit 1/1 ve e-posta kurtarma 2/2 başarılı. İki kripto
senaryosu da kimliği, geçmiş mesajını ve yenileme sonrasını UI'da doğruladı.
Kanıtlar `refactor-integration-8c3-terminal-2026-11-14.json` ve
`refactor-rf28-8c3-production-e2e-2026-11-14.json` altında.

RF28 tam kapanışı için kayıp HTTP yanıtı testinin yanına gerçek tarayıcı
çevrimdışı/çevrimiçi testi eklendi. Hesap tercihlerinin iki oturum ve aynı
storage üzerinde A/B/A izolasyonu ayrı geçici DB profilinde sınanacak. Rol
senaryoları artık her testte kendi sentetik sunucusunu yeniliyor; sayfalar hata
yolunda da kapanıyor. Profil kümeleri gerçek Playwright discovery ile ayrıldı;
çakışan modlar reddediliyor. Bu yeni matriste henüz tarayıcı sonucu yok.


### RF28 — isolated fixture deletion follow-up (2026-11-14)

Candidate eca7d4fc CI43570586532 failed in production Chromium: the second role test could not reset the preceding thread fixture (PostgreSQL channels_starter_message_id_fkey, HTTP500). The offline retry case passed only on retry. The cascade now explicitly clears target-server thread starter links inside its transaction before descendant deletion; unrelated-server links remain covered. SQLite and native local PostgreSQL cascade suites passed. The new cycle fixture also passed before the fix, so it does not independently reproduce the CI failure. Offline retry waits for the composer send ticket to release after the failure toast; draft and duplicate checks remain. Fresh browser CI is required. Receipt: implementation/verification/refactor-thread-cascade-ci-followup-2026-11-14.json.


### RF08 — Ping failure ownership acceptance (2026-11-14)

Added a driver-level Ping failure fixture which opens a real database/sql connection before rejecting Ping. It verifies cause preservation, no returned owner, exactly one driver Close, zero pool connections and no reconnect through the failed pool. Existing migration-failure and successful ownership-transfer tests remain; the three constructor tests passed locally. This fills the missing Ping branch evidence and does not stand in for native PostgreSQL, race or whole worker-lifecycle acceptance. Receipt: implementation/verification/refactor-rf08-ping-cleanup-2026-11-14.json.


### RF06 — verified legacy backup restore rehearsal (2026-11-14)

TestLegacyRecoveryFromVerifiedBackup now creates a consistent SQLite VACUUM INTO snapshot of a verified migration144 fixture with user/server/channel/message data and an empty ledger. It rejects an unknown index added after the backup without stamping migration history, closes the edited DB, restores the snapshot into a separate owned file, then upgrades and reopens it through NewLegacy. User/message graph preservation, current migration ledger, absence of the unknown index, integrity_check and foreign_key_check are asserted on both opens. Targeted test passed (2.203s); combined legacy/rollback/initialization tests passed (6.350s). Receipt: implementation/verification/refactor-rf06-legacy-restore-rehearsal-2026-11-14.json. This is synthetic SQLite recovery evidence, not production backup availability or PostgreSQL import proof.


### RF03/RF28 — retry-only success is not stable acceptance (2026-11-14)

Detailed b177 browser logs show 14 first-attempt passes plus 2 flaky cases (DM reply navigation sidebar locator; reused-browser login username field). The job was successful under the previous policy; no stable-browser completion claim follows. Crypto3, preference2, WebKit1 and mail2 passed. New CLI configuration regression initially failed because failOnFlakyTests was false; CI now enables it and isolation/profile guards pass. Browser artifact upload now runs regardless of job result so a strict flaky failure retains its diagnostics. Do not remove retries or assertions to hide the two open failures. Receipts: refactor-rf28-b177-production-browser-2026-11-14.json and refactor-rf03-browser-flaky-gate-2026-11-14.json.


### RF08 — deterministic cancellation during refresh sweep (2026-11-14)

The private sweep loop now accepts its tick channel; the existing owner still allocates/stops the hourly ticker, cancels once and joins done. A new test holds the replay-evidence mutex and uses an unbuffered tick rendezvous to establish an in-flight sweep before cancellation. The loop cannot report done until the mutex is released; afterward it exits and preserves live refresh evidence while removing the expired record. Existing owner start/duplicate-start/cancel/restart and refresh tests remain. Targeted suite passed locally, 0.504s; Linux race and current-source CI remain required. Receipt: implementation/verification/refactor-rf08-sweep-cancellation-2026-11-14.json.


### RF28 — cold DM list lost during key readiness (2026-11-14)

Strict CI43572875547 correctly failed the same two retry-only browser cases and retained diagnostics. The DM response contained the conversation but the DOM showed an empty list: refreshEncryptedHistory invalidated the outstanding metadata list together with encrypted history. New regression failed before the fix. E2EE key readiness now preserves that list request while still clearing/aborting message history; default invalidation semantics and stale-request tests remain. Two store files pass156 tests, TypeScript and ESLint pass. The account-switch screenshot showed the real server-waking phase; login helper now waits for the actual form (90s) before filling, without a fixed sleep. Fresh strict production CI remains required. Receipt: implementation/verification/refactor-rf28-dm-list-key-readiness-2026-11-14.json.


### RF11 — required preview/notifier cleanup contracts (2026-11-14)

Link-preview and online-friend constructors previously returned interfaces omitting Stop, so startup rollback and shutdown treated actual owned-resource cleanup as optional capability assertions. A declared-result contract test failed for both factories before the change. Constructors and Services now retain runtime interfaces embedding the unchanged request interfaces plus Stop; rollback and shutdown register/call cleanup directly. Relevant service, wiring, startup/lifecycle/rollback tests passed, as did go build ./... and go vet ./services . on Windows. Linux race/current-source CI remain required; other RF11 contracts are not automatically closed. Receipt: implementation/verification/refactor-rf11-required-preview-notifier-ownership-2026-11-14.json.


### RF28 — explicit online retry dispatch proof (2026-11-14)

Strict CI43573607343 passed the previous DM and account-switch cases first try, but offline retry was flaky: second Enter left the draft unchanged. ReadOnly=false alone did not resolve this. The retry now uses actual Send Message button actionability, which includes composer/send-permission gates, and additionally requires the real POST response status201. All draft, count and reload assertions remain. navigator.onLine alone is not a send-ready signal. The exact transient gate is not independently proven by the snapshot; no product root-cause closure claim. Profile/isolation checks pass; fresh strict production CI required. Receipt: implementation/verification/refactor-rf28-offline-dispatch-proof-2026-11-14.json.


### RF11 — voice constructor retains all shutdown owners (2026-11-14)

The declared Voice constructor result previously exposed request/channel-deletion methods but omitted StopMaintenance, ShutdownUsageProducers, ShutdownVoiceSessions and ShutdownVoiceStateFanout. The new declared-result regression failed before the change. Named VoiceRuntime and Services now retain those lifecycle guarantees; startup rollback and main shutdown use direct calls in the existing call/defer order. Relevant voice lifecycle/accounting/channel, wiring and initialization tests pass in services and main; build and vet pass. This is compile-time ownership and fixture proof, not physical media or Linux race acceptance. Receipt: implementation/verification/refactor-rf11-voice-runtime-ownership-2026-11-14.json.


### RF11 — game-join transport adapter separation (2026-11-14)

initServices now only binds gameJoinOfferCallback; JSON serialization,2048-byte limit, strict typed decoding and bounded context ownership moved unchanged into a dedicated transport adapter. Tests verify DTO/actor/physical-connection and response preservation, deadline and post-call cancellation, and seven invalid payload categories without service dispatch. Existing GameJoin service/wiring/initialization tests plus build and vet pass. No domain authorization or wire fields changed. Whole RF11 and Linux race/current CI acceptance remain open. Receipt: implementation/verification/refactor-rf11-game-join-adapter-2026-11-14.json.


### RF28 — smoke waits for actual signed-out readiness (2026-11-14)

CI43574345347 passed offline retry (including201), DM history and role cases first try. Only Chromium login/recovery smoke was flaky: first password-field visibility used15s while screenshot showed the real server-waking screen. Its initial form readiness gate now matches the shared login helper at90s. Keyboard/recovery/focus/script-error assertions and strict flaky rejection remain. No fixed sleep or rate-limit bypass. Fresh full production CI required. Receipt: implementation/verification/refactor-rf28-smoke-auth-readiness-2026-11-14.json.


### RF11 — configured email provider guarantees delivery capabilities (2026-11-14)

NewResendSender previously returned only EmailSender; startup silently asserted VerificationSender and CategorySender, allowing an enabled provider to omit those capabilities without a build error. Declared-result regression failed for both missing interfaces. The factory now returns Provider embedding all three contracts; initServices retains it and passes narrow dependencies directly. Disabled configuration remains nil. Relevant provider/email/service/wiring/startup tests, build and vet passed; no actual provider mail was sent. Current-source production mail profile and Linux race remain CI gates. Receipt: implementation/verification/refactor-rf11-email-provider-contract-2026-11-14.json.


### RF11 — optional email configuration matrix (2026-11-14)

configuredEmailProvider now owns the unchanged three-field enablement predicate and provider setup outside initServices. All8 presence/absence combinations are tested:7 incomplete configurations remain nil and the complete provider preserves sender configuration. Relevant startup/wiring/email tests, build and vet pass. No external email was sent and no production configuration changed. Updated receipt: implementation/verification/refactor-rf11-email-provider-contract-2026-11-14.json.


### RF11 — auth voice revocation dependency at construction (2026-11-14)

Auth no longer relies on post-construction SetVoiceDisconnecter. Constructor requires an explicit VoiceDisconnecter argument; production passes the existing voice runtime, while isolated media-free callers explicitly pass nil. Declared-parameter regression failed before the change. Revocation spy harness now uses constructor injection, preserving its full fan-out assertions. Other concrete mutation fixtures keep their voice assertions; no acceptance test removed. Targeted auth/password/revocation/anonymization/application-removal/handler/middleware/wiring/startup tests passed in4 packages, build and vet passed, exact-hit manifest remains valid50. No HTTP/WS wire change or local race claim. Receipt: implementation/verification/refactor-rf11-auth-voice-constructor-2026-11-14.json.


### RF11 — friend-request repository adapter separation (2026-11-14)

Friend-ID projection and pair-status/error mapping moved unchanged out of initServices into a two-method repository adapter. Tests prove context/identity preservation, stable list order, empty-list and list-error handling, accepted-only edge mapping, wrapped NotFound as nonfriend, and propagation of other pair failures. Existing policy, wiring and initialization tests plus build and vet pass. No policy or wire behavior changed. Remaining post-construction observers/resolvers and full current-source race/CI acceptance remain open. Receipt: implementation/verification/refactor-rf11-friend-request-adapter-2026-11-14.json.


### RF11 — membership voice cleanup dependency at construction (2026-11-14)

ServerService now takes its membership voice cleanup callback at construction; production passes DisconnectServerMember and the later setter is removed. Constructor contract regression failed first. Leave/removal-failure/server-scoped voice/admitted-join/permission leave-rejoin tests keep their assertions and now inject cleanup in the harness constructor. Targeted services/main tests, build and vet pass. The livekit_integration-tagged fixture compiles with zero tests selected; this is not live media proof. Receipt: implementation/verification/refactor-rf11-membership-voice-constructor-2026-11-14.json.


### RF11 — friendship email queue at construction (2026-11-14)

Friendship constructor now explicitly takes EmailEnqueuer before its existing policy arguments; production injects the previously created delivery service and the late setter is removed. Declared-parameter regression failed before the change. Every affected social-email fixture now supplies the queue during construction, preserving policy-denial/no-enqueue, persistence-failure, best-effort provider error and content/dedupe assertions. Relevant services/handlers/main tests, build and vet pass. Isolated no-email fixtures explicitly select nil. DM auto-accept still has a cyclic construction dependency and remains a separate open RF11 item. Receipt: implementation/verification/refactor-rf11-friendship-email-constructor-2026-11-14.json.


### RF11 — friendship/DM construction cycle removed (2026-11-14)

DM only needs friendship edge reads, so it now consumes the existing repository graph adapter rather than the friendship writer service. The same adapter is parity-tested against FriendshipService.AreFriends for accepted/pending/blocked/missing/error cases. DM is constructed first and injected as the explicit DMRequestAcceptor parameter of FriendshipService; the late setter and cycle are removed, without a mutable holder. Constructor contract regression failed before the change. Existing auto-accept/DM/policy/notification/wiring/startup assertions pass across3 packages, build and vet pass. No privacy policy or wire-field change. Fresh Linux race/native and production CI remain required. Receipt: implementation/verification/refactor-rf11-friendship-dm-cycle-2026-11-14.json.


### RF11 — real composed friendship/DM wiring (2026-11-14)

A real file-backed SQLite fixture with embedded migrations now builds initRepositories and initServices directly, without service/repository doubles. Both explicit and mutual-request friendship acceptance change a preexisting pending DM to accepted. The first subsequent DM message is verified persisted with its author/content and the channel remains accepted, exercising the committed friendship reader and auto-accept dependency together. Targeted test and vet pass. All constructor-owned resources are closed before DB cleanup. This is in-process SQLite wiring proof, separate from HTTP/WS and native PostgreSQL. Receipt: implementation/verification/refactor-rf11-friendship-dm-composed-2026-11-14.json.


### RF11 — reaction delivery dependency group (2026-11-14)

Channel reaction constructor now explicitly takes ReactionNotificationDependencies (notification repository, preference reader, user reader); SetNotificationDelivery is removed. The constructor contract regression failed before the change. Existing preference-mode, self/removal and dedupe assertions use constructor wiring and pass with wiring/composed startup tests. Reaction-only fixtures explicitly choose a zero-value disabled group. Build and vet pass; handler package compiled but selected no tests in the targeted run. Existing optional writer capability gate is unchanged and remains an audit boundary. Receipt: implementation/verification/refactor-rf11-reaction-notification-constructor-2026-11-14.json.


### RF11 — channel reaction writer capability made explicit (2026-11-14)

Two declared-type regressions failed first: notification factory omitted reaction-write capability and the channel reaction dependency could accept a repository without it. New ReactionNotificationWriter and factory NotificationStore preserve that capability through composition; the channel reaction constructor consumes the narrow writer directly and its optional runtime assertion is removed. Explicit nil/prefs-disabled behavior, privacy checks, dedupe SQL and wire fields remain. Targeted repository/services/main tests, build and vet pass in the local SQLite profile. DM/group reaction assertions remain separate open work; native PostgreSQL/Linux race/current-source CI and whole RF11 acceptance remain required. Receipt: implementation/verification/refactor-rf11-reaction-writer-contract-2026-11-14.json.


### RF11 — DM/group reaction writer contracts (2026-11-14)

DM now receives its reaction writer as an explicit narrow constructor dependency; its ordinary inbox repository remains for other operations. Group uses NotificationStore because the same dependency also serves unread-summary refresh; its field is now named notifications. Constructor regressions failed first. Runtime reaction-writer capability assertions are removed from both paths; nil explicitly disables isolated fixtures. The group inbox fixture fails on unexpected reaction writes. Private reaction/privacy/block/pending/author-membership, DM/group, wiring and composed startup tests pass across4 packages; build and vet pass. Intermediate compile check caught and preserved the group unread-summary dependency. Fresh native PostgreSQL/Linux race/production CI and whole RF11 audit remain required. Receipt: implementation/verification/refactor-rf11-private-reaction-writer-contracts-2026-11-14.json.


### Exact-hit review after DM constructor change (2026-11-14)

Manifest validation rejected the changed dm_delivery_test.go source hash. Re-review against14d proves the only source change is an explicit nil reaction-writer argument; the reviewed SQL interval literal and bound message ID atline114 are unchanged. Exactly one file hash was updated; rule, line hash, reason, proof reference and50-record total remain unchanged. Manifest validation and6 validator tests pass. Full current-source security scan remains CI-owned. Receipt: implementation/verification/refactor-reviewed-dm-constructor-manifest-2026-11-14.json.


### RF13 — channel notification choice omitted from offline cache (2026-11-14)

Four real codec/store regressions failed: channelMessageNotifications true/false was absent from the known cache fields, leaving no acknowledged snapshot for offline startup. The existing boolean is now cacheable and type-checked.63 codec/store/notification-preference tests pass, including offline restore, account switch isolation and malformed value rejection. This behavior fix is separate from defaults/codec deduplication. No wire or storage key changed. Receipt: implementation/verification/refactor-rf13-channel-notice-cache-2026-11-14.json.


### RF13 — notification defaults as pure shared contract (2026-11-14)

After the separate channel-notice cache fix, NotificationPreferences and defaults moved byte-identically into a store-free module; existing notification utility imports remain compatible through re-exports. Codec cache-field and boolean lists now derive from those defaults. Round-trip tests cover every default and its boolean opposite, plus unknown-field exclusion.112 tests across6 preference/API/consumer files, production TypeScript+Vite build and targeted ESLint pass. No warning suppression changed; existing audio vendor/WASM and chunk-size warnings remain. Whole RF13 and current-source production acceptance remain open. Receipt: implementation/verification/refactor-rf13-pure-notification-defaults-2026-11-14.json.


### RF13 — overlay device flags excluded from account patches (2026-11-14)

Voice slice already classifies compatibility/video/streams/welcome/go-live overlay flags as device-local, but preferences sanitizer omitted those five exclusions. Six codec/store regressions failed: flags survived sanitize and actual account store.set data. The exclusion list is aligned;106 codec/store/consumer tests pass, including outgoing patch containing only masterVolume. This is an action/codec reproduction, not an observed production leak. Behavior fix precedes shared scope-list extraction. Receipt: implementation/verification/refactor-rf13-overlay-device-scope-2026-11-14.json.


### RF13 — shared device-local voice field contract (2026-11-14)

After the separate overlay exclusion behavior fix, codec and voice slice consume one store-free 30-key list. The slice type-checks keys against VoiceSettings. Actual setter/server-apply/account-reset tests retain device flags without account sync while account masterVolume applies. Seven files / 194 tests, targeted ESLint and production TypeScript/Vite build pass. Existing build warnings remain. Full RF13 and current-source CI acceptance remain open. Receipt: implementation/verification/refactor-rf13-shared-voice-device-scope-2026-11-14.json.


### RF13 — pure accessibility defaults contract (2026-11-14)

Accessibility types/defaults moved unchanged to a store-free module. Existing style imports remain compatible through re-exports; DOM application stays separate. All 24 prior cache keys match defaults exactly; codec field and boolean lists now derive from that contract. Every default and boolean opposite round-trips with unknown fields excluded.133 tests across5 codec/store/consumer/DOM files, targeted ESLint, TypeScript/Vite build and diff check pass. Full RF13/current-source CI acceptance remain open. Receipt: implementation/verification/refactor-rf13-pure-accessibility-contract-2026-11-14.json.


### RF13 — account reset projects the shared device scope (2026-11-14)

The previous 30 explicit current-field copies exactly matched the shared device scope. Reset now projects that same list, preventing a third scope declaration from drifting. Seeded slice tests retain all device fields and persisted values under both preservation modes, while preMuteVolumes is retained only when requested.129 tests across5 consumer/voice files, targeted ESLint, TypeScript build and diff check pass. This is state-level evidence, not physical active-session acceptance; whole RF13 remains open. Receipt: implementation/verification/refactor-rf13-device-reset-projection-2026-11-14.json.


### RF13 — composed voice store session-state preservation (2026-11-14)

A full voiceStore regression seeds active transport/media state, then runs preference reset with session preservation and server hydration. Channel, URL/token, room key, mute/deafen/stream flags, restoration map and callback identity remain; account volumes change without leave/send callbacks.68 voice store tests, ESLint, TypeScript build and diff check pass. This is direct store-state evidence, not physical media or the complete bootstrap/account adapter path. Whole RF13 remains open. Receipt: implementation/verification/refactor-rf13-active-voice-state-2026-11-14.json.


### RF13 — composed account adapter preserves voice state (2026-11-14)

The real applyAccountPreferences adapter used by bootstrap now has a composed voiceStore test: reset/preserve plus account hydration retain transport/media state and callbacks while applying account volume. Null fenced reads do not hydrate data.124 tests across voiceStore/preferencesStore/sync hook, targeted ESLint and TypeScript build pass. Bootstrap loader invocation and physical media remain outside this test; whole RF13 remains open. Receipt: implementation/verification/refactor-rf13-composed-account-adapter-2026-11-14.json.


### RF05 — current lexical boundary audit (2026-11-14)

Current postgres_dialect has no regex/upsert text rewrite: native migration dispatch is preserved and ordinary repository markers pass through lexical binding. Local bind/migration-dispatch contract selection passes, including malformed quoted tokens, escapes, comments, dollar strings and bind bounds. This does not establish complete production query-family inventory or native result equivalence. Existing cursor/list corpus is explicitly representative. RF05 remains open pending positive/negative fixture mapping for all used families; no injection vulnerability is inferred from the gap. Receipt: implementation/verification/refactor-rf05-current-boundary-audit-2026-11-14.json.


### RF05 — mutation family result equivalence (2026-11-14)

Shared dialect contracts now exercise role-style UPDATE RETURNING and cascade-style DELETE IN SELECT. Matching/missing updates, literal bound values, owner-mismatch zero effects, matching deletion and remaining rows are asserted before rollback. The same contract passed SQLite and dedicated PostgreSQL18.6 with zero skips. Owned temporary container stopped; dev containers untouched. Local loopback/non-TLS/non-race evidence does not replace CI race/TLS gates. Full family inventory remains open. Receipt: implementation/verification/refactor-rf05-mutation-equivalence-2026-11-14.json.


### RF05 — query inventory resolves explicit constants (2026-11-14)

Existing AST inventory now resolves same-file explicit string constants/constant concatenations through parser object bindings, preserving local shadowing and leaving mutable/dynamic SQL unresolved. Regression failed before implementation;3 tool contracts pass. Current candidate counts: 659 direct literals, 31 constants, 273 unresolved across 182 files. These are navigation candidates, not execution/coverage proof. Full fixture mapping remains open. Receipt: implementation/verification/refactor-rf05-query-constant-inventory-2026-11-14.json.


### RF05 — bound query constant expression traversal (2026-11-14)

A failing regression showed the new resolver bounded constant references but accepted excessive parenthesized nesting. Actual expression depth and total node visits are now bounded; unsupported branches return no partial SQL. Four tool tests pass and production inventory counts remain659 literals/31 constants/273 unresolved. This is tooling correctness, not a product SQL defect or RF05 closure. Receipt: implementation/verification/refactor-rf05-inventory-expression-bounds-2026-11-14.json.


### RF05 — dynamic channel search producer/test mapping (2026-11-14)

Unresolved PostgreSQL channel count/page expressions map to shared bound conditions, optional explicit channel and dynamic allowed-channel IN list. Three actual repository tests pass on both SQLite and dedicated PostgreSQL18.6 with zero skips: count/data filtering and intersection, empty allow-list, stable equal-rank timestamp pagination. Source hashes and producer locations recorded. This proves those shared contracts, not identical relevance/ILIKE semantics or DM search coverage. Temporary container stopped. Full RF05 remains open. Receipt: implementation/verification/refactor-rf05-dynamic-channel-search-mapping-2026-11-14.json.


### RF05 — dynamic DM search result contract (2026-11-14)

New real repository contract covers cross-channel count/page isolation, equal-content reverse append order, source sequence, beyond-end offset and empty/no-match queries. It passes on SQLite and dedicated PostgreSQL18.6 with no skips. Temporary container stopped. This verifies shared result invariants, not identical relevance/ILIKE semantics; full RF05 remains open. Receipt: implementation/verification/refactor-rf05-dm-search-contract-2026-11-14.json.


### RF05 — mandatory named native contract gates (2026-11-14)

The native runner already executes complete repository/database packages. It now additionally requires exact package/test PASS pairs for PostgreSQL dialect subtest and DM search contract, so missing/renamed tests or wrong-package events cannot silently satisfy the gate. Regression failed before fix;16 runner tests pass. Synthetic event tests prove gate behavior, not a fresh native suite execution. Full RF05 remains open. Receipt: implementation/verification/refactor-rf05-required-native-gates-2026-11-14.json.


### RF07 — recovery contract layer matrix (2026-11-14)

Current-source selection passes8 top-level Go tests across services/handlers/models,11 client tests across4 files, plus2 SQLite auth-session atomic/replay/concurrent-proof tests. Evidence is mapped per layer rather than treating mocked handlers as composed HTTP acceptance. Provider failure/timeout, full registration/legacy login mapping, normalization/schema parity and physical provider acceptance remain explicit open rows. RF07 remains open. Receipt: implementation/verification/refactor-rf07-recovery-layer-matrix-2026-11-14.json.


### RF07 — recovery provider and persistence failure contracts (2026-11-14)

Two new service tests cover fake provider failure, cancellation during send, actual context deadline during send and persistence failure before send. Cause wrapping is preserved; sender receives normalized stored address and a proof matching the persisted SHA256 hash; storage failure prevents delivery. All pass without printing proof values. These are service/fake-provider contracts; public HTTP failure mapping and real delivery remain separate. RF07 remains open. Receipt: implementation/verification/refactor-rf07-provider-failure-contracts-2026-11-14.json.


### RF07 — recovery HTTP failure envelope (2026-11-14)

Actual handler/encoder tests cover wrapped provider diagnostic, deadline and cancellation: current500/INTERNAL generic envelope, no session/cooldown headers. Existing successful known/unknown/cooldown equality also passes;2 top-level tests/7 cases. Stub service means this is handler evidence. Known provider failure500 differs from unknown-success200, so outage enumeration equivalence is not established and remains an explicit RF07 risk; no wire/status change made here. Receipt: implementation/verification/refactor-rf07-recovery-http-failures-2026-11-14.json.


### RF07 — account-neutral operational recovery failures (2026-11-14)

Security correction to the former failure-path status contract: valid forgot-password requests now retain the exact generic200 body for account-dependent lookup/storage/provider failures, including wrapped domain sentinels, cancellation and deadlines. A dedicated prelookup ErrPasswordRecoveryUnavailable sentinel preserves server-wide disabled400; malformed input and IP429 remain unchanged. Fixed diagnostic events contain no identifier, proof or raw provider detail. Service error causes and token workflow remain unchanged. OpenAPI documents this intentional operational-error500-to200 correction. Six error-class regressions failed before the fix and pass afterward; disabled recovery is verified before lookup. Independent read-only boundary investigation and candidate review found no concrete surviving status/body/header bypass. Full local handlers/services tests pass (7.321s/91.517s), focused final regressions and vet pass, and5 forgot/reset UI tests pass. This closes the observed status/body/header distinction, not timing equivalence or real email delivery. Linux race/current-source CI and whole RF07 remain open.


### RF07 — composed HTTP registration/legacy login contract (2026-11-14)

A new test composes actual AuthHandler with actual auth service and explicit fake repositories. New registration without email returns400 before username lookup; an existing email-less account logs in with correct password, receives access token and HttpOnly refresh cookie, and never returns the password hash. Wrong password remains401 with no cookie. Focused legacy/recovery/credential handler tests and handler vet pass. This closes that composed handler/service compatibility gap, not real database/browser acceptance or whole RF07.


### RF07 — actual identifier case semantics across databases (2026-11-14)

New repository contract verifies existing username case-insensitive lookup and exact stored-email lookup (different email casing is not found), using actual migrated SQLite and dedicated PostgreSQL18.6. Both pass with no skips. Recovery trims identifier boundaries in its existing model/service tests; this test prevents inventing incompatible email case-folding without reconciling registration/uniqueness. Dedicated loopback/non-TLS container stopped after verification. This is case-boundary storage evidence, not complete RF07 or physical provider acceptance.


### RF09 — bounded service projection calls (2026-11-14)

New service contract exercises0/1/1001 members. Exactly one scoped bulk call each for profiles, roles, nicknames and timeouts; per-user profile lookup fails the test. Output order and nickname projection remain. New contract plus existing bulk-timeout test pass, final new test and service vet pass. These are service-to-repository operation counts, not physical SQL counts; repository batch splitting, actual two-database parity and RF29 p95/wait evidence remain separate. RF09 remains open.


### RF09 — real SQL query counts and bounded profile measurement (2026-11-14)

New forwarding TxQuerier counter records actual QueryContext executions against the migrated database. Public profile reads use0 queries for empty IDs and1 query for1/1001 requested IDs (only one existing user, remaining IDs absent). Server member projection uses one scoped query and returns the two expected members. Counter/parity tests pass on SQLite and dedicated PostgreSQL18.6,3 tests each/no skips; repository vet passes. Existing100-message/2-distinct-user fixture,1 warmup+30 samples: SQLite per-user p95=11.6743ms vs bulk524.9us; PostgreSQL105.6592ms vs1.0548ms. Pool wait0 in both paths. These are small sequential local fixture measurements, not capacity/concurrent load evidence or1001 actual members. Owned non-TLS loopback PostgreSQL stopped. Full RF09/RF29 population/load/error mapping remains open.


### RF09 — actual large population and query failure contracts (2026-11-14)

Large-population fixture now inserts1001 actual members and1001 unrelated users in addition to the existing seed. SQLite and PostgreSQL18.6 both return exactly1003 server members in username order with credentials excluded, using one QueryContext call. Public projection returns all1001 requested existing profiles with duplicate/missing IDs handled, also one call. Separate injected query failures propagate with errors.Is and no successful partial projection. All3 projection tests pass locally on SQLite; large-population test passes native PostgreSQL; repository vet passes. Owned temporary PostgreSQL stopped. Concurrent load/p95 at this population and complete service/group error mapping remain open, so RF09 is not closed.


### RF09 — service bulk failure boundaries (2026-11-14)

New member profile/role failure cases preserve wrapped causes, return no successful partial membership, and forbid later nickname/timeout enrichment or per-user fallback. Group history profile failure similarly propagates without per-user fallback. Existing bulk-author/missing-author contract remains. Four selected top-level tests pass, including0/1/1001 population and profile/role subcases; service vet passes. Non-fatal nickname/timeout behavior and API fields are unchanged. Full RF09/RF29 acceptance remains open.


### RF11 — channel reaction emoji resolver constructor (2026-11-14)

Reaction constructor now requires an explicit EmojiResolver argument. Production constructs the emoji service before reactions and injects it; channel ReactionService setter is removed. Nil explicitly disables custom emoji, preserving existing tests. Constructor regression failed with7 inputs before change; channel/DM custom emoji, removal-only, nil-resolver, notification and wiring selections across services/handlers/main pass afterward. Server build and targeted vet pass. Test fixtures inject during construction, while Unicode-only fixtures explicitly select nil. DM resolver setter remains separate open work; full RF11/current-source Linux race acceptance remain open.


### RF11 — DM reaction emoji resolver constructor (2026-11-14)

DM constructor now requires explicit EmojiResolver; all11 call sites updated. Production constructs shared emoji service before DM/channel reactions; both late setters are removed. Custom-emoji fixtures inject resolver at construction; other fixtures explicitly select nil. Constructor regression failed before change. Selected DM/reaction/privacy/wiring tests across services/handlers/ws/main, server build and targeted vet pass. The reviewed SQL fixture changed only by adding nil constructor argument; its exact SQL line/rule/reason/proof remain unchanged, only source hash updated after comparison. Manifest50 records valid and6 validator tests pass. Full RF11 and fresh source-bound Linux race/native/production CI remain required.


### RF11 — recipient-private broadcaster construction (2026-11-14)

SpamInboxService and MediaLabelService now require explicit broadcaster arguments;15 calls updated and late setters removed. Production injects hub; isolated fixtures explicitly select nil. Constructor regressions failed before change. Existing media-label tests and new spam-decision constructor test assert only owner delivery after persistence, preserving payload and rejecting public/server/multiple-owner broadcasts. Targeted services/handlers/main tests, server build and vet pass. No wire fields changed. Whole RF11/current-source native/race CI remain open.


### RF11 — voice/media composition domain boundary (2026-11-14)

Entrance/music construction and both voice hook bindings now live in initVoiceMediaServices, completing this mutually dependent composition before returning to startup. initServices receives both services and no longer interleaves these bindings with auth/cosmetics construction. Existing startup wiring/composed service tests, entrance fresh/rejoin/reject/switch/nil-hook and voice deletion regressions, build and root vet pass. This is a domain wiring extraction; the setter-based cycle remains explicitly open and is not represented as completed constructor migration. No media/provider acceptance claimed.


### RF11 — voice request interface excludes composition mutation (2026-11-14)

SetEntranceHook, SetMusicBotHook and SetAppLogger moved from request-facing VoiceService to composition-owned VoiceRuntime. Concrete behavior and hook nil modes remain unchanged. Regression failed because request interface exposed all3 methods; it now confirms only runtime owner exposes them. Eight voice fixture return declarations preserve the runtime type for setup rather than regaining capabilities with assertions. Hook/deletion/composed wiring tests pass; handlers/ws compile (selected filter matches no tests there), server build and targeted vet pass. This narrows capability ownership; setter cycle and complete RF11 acceptance remain open.


### RF11 — constructor-owned voice integration factory (2026-11-14)

NewVoiceService now requires an explicit integration factory argument. It initializes state, constructs the mutually dependent entrance/music integrations against VoiceService, binds both hooks, then allocates fanout workers. Production obtains both runtime services through that synchronous factory; app logger is constructed beforehand. Nil explicitly selects standalone voice without media hooks. Both entrance/music setter methods are removed. Constructor arity regression failed before change; a new behavior test verifies initialized state, no workers during factory execution, exactly one factory call and hooks installed before return. Fourteen constructor call sites updated. Existing isolated behavior fixtures seed private test state before operations; they are not presented as factory wiring proof. Focused constructor/hook/wiring tests, build and vet pass. Full local services/handlers/ws/main packages pass in94.034/7.487/5.447/14.610s. No changed source has an exact-hit manifest record. Startup failure/disabled integration matrix and fresh Linux race/native/production CI still require final RF11 audit; physical media remains separate.


### RF11 — voice integration startup failure/disabled matrix (2026-11-14)

Additional constructor tests prove factory panic identity propagates with initialized state but no allocated voice fanout worker. Nil factory and explicit nil/nil returned hooks are deterministic standalone modes; factory call count and worker creation remain explicit. Constructor/interface/root wiring/composed startup selections and service/root vet pass. This verifies voice-owned worker allocation order, not cleanup of arbitrary resources a future external factory might allocate before panicking. Full RF11 dependency audit remains open. Also restored254 content-identical formatting-only files after normalized index comparison; meaningful commits and unrelated untracked artifacts preserved.


### RF11 — voice runtime dependency group owns logger (2026-11-14)

VoiceRuntimeDependencies groups integration construction and app logger in the explicit final constructor argument. Production passes logger before integrations run; zero value selects standalone/no persistent logging. Voice SetAppLogger is removed from runtime/concrete service and main late wiring. Seventeen constructor calls updated to explicit groups. Required-group regression failed before change. Logger-ready-before-factory and actual info/error logging test passes, alongside constructor disabled/panic/hook/root wiring selections. Server build, targeted vet and diff check pass. No changed file has an exact-hit record. Full RF11 audit and source-bound CI remain open.


### RF11 — P2P logger constructor ownership (2026-11-14)

P2P constructor now requires explicit P2PAppLogger; production injects existing appLogService and standalone tests select nil. Late setter and request-interface logger mutation removed. Constructor regression failed before change. Actual logger error path and explicit disabled mode pass, as do P2P service/WebSocket and composed root wiring selections. Handler package compiles with no selected tests. Server build, targeted vet and diff check pass. No changed P2P file has an exact-hit record. Full RF11/current-source CI remain open.


### RF11 — auth logger selected by constructor option (2026-11-14)

WithAuthAppLogger uses existing AuthOption composition to select optional persistent logger before return. Production supplies appLogService; explicit nil disables it. AuthService/concrete setter and main late binding removed. Request-interface regression failed before change. Actual auth warning path and disabled mode, recovery/handler and composed wiring selections pass; server build, targeted vet and diff check pass. No reviewed exact-hit source changed. Auth middleware cache invalidation still has a separate late construction dependency; whole RF11 and current-source CI remain open.


### RF11 — backup logger constructor ownership (2026-11-14)

Backup constructor now takes explicit optional logger. Long-lived production service receives appLogService; early pre-database restore and isolated test fixture explicitly select nil. Late setter/main binding removed. Required-parameter regression failed before change. Actual info/error logger and disabled mode, root wiring and all21 tests declared in backup_service_test.go pass (restore/snapshot/rotation/shutdown/cancellation). Server build, targeted vet and diff check pass. No external HF bucket or real backup restore claim; whole RF11 and current-source CI remain open.


### RF08/RF11 — remove unreachable PostgreSQL boot restore owner (2026-11-14)

Current main requires PostgreSQL DATABASE_URL before boot restore. Config.Database.Path is DATABASE_URL and Backup.DBPath chooses the same nonempty DATABASE_URL; Restore returns immediately for remote DSNs. Therefore the temporary boot BackupService was an unreachable-work/no-op owner, not a demonstrated active orphan on the current product. Removed this obsolete boot block and corrected legacy Restore lifecycle documentation. Legacy Restore implementation remains; all21 backup file tests pass. Full root tests pass13.614s; config compiles with no test files. Server build/vet pass. Actual remote backup recovery, uploads behavior and remaining lifecycle audit are not claimed complete.


### RF11 — independent auth identity cache owner (2026-11-14)

AuthUserCache extracts TTL identity-cache ownership from AuthMiddleware. Middleware constructor explicitly accepts a shared owner or nil for a standalone owner;7 existing callers select standalone until root sharing is wired. Existing TTL, pointer projection and invalidation behavior remain. New shared-owner test proves invalidation across middleware instances; standalone isolation test prevents cross-owner identity reuse. Full middleware/cache/root tests pass2.043/0.320/14.315s, build and targeted vet pass. No exact-hit source changed. This is the ownership extraction step; service invalidator setter cycle remains open until the same owner is injected at composition.


### RF11 — shared auth cache constructor wiring (2026-11-14)

initServices now owns AuthUserCache before auth construction, passes it through WithAuthUserCacheInvalidator and Services, and routes inject that identical owner into middleware. Auth invalidator setter is removed. Startup rollback and service cleanup own the new worker; repeated middleware/service Close remains idempotent. Real SQLite composed root test uses initRoutes middleware: prime identity, LogoutAllDevices, confirm targeted cache eviction/unrelated identity retained and old token401. Existing revocation harness injects at construction; older isolated anonymization/application fixtures seed their private invalidator before operations and are not factory proof. Services/middleware/handlers full tests pass98.586/1.966/7.701s. Initial full root run exposed expected worker-count2-to3 change; corrected exact count retains return-to-baseline assertion, then full root passes15.435s including rollback/route/manifest tests. Build/vet pass. Admin/member still bind the same independent owner after routes, a separate remaining constructor task. Whole RF11 and native/race/current-source CI remain open.


### RF11 — admin/member identity writers share constructor cache owner (2026-11-14)

AdminUserService and MemberService now take explicit UserCacheInvalidator arguments;9 constructor call sites updated. Production injects the existing shared AuthCache before routes, both cache setters and main late bindings removed. Required-parameter/request-interface regression failed before implementation. Existing admin invalidation and profile HTTP fixtures inject at construction. Composed real SQLite root test now verifies Member.UpdateProfile and AdminUser.SetPlatformAdmin evict the same primed identity owner, middleware reloads the admin flag, unrelated identity remains and LogoutAllDevices rejects the old token. Selected admin/profile/avatar/middleware/handler/root tests, build, vet and final composed wiring tests pass. No exact-hit source changed. Permission-cache route lifecycle wiring is separate; whole RF11 and current-source race/native/CI remain open.


### RF11 — independent revision-fenced permission cache owner (2026-11-14)

PermissionCache now owns grant storage, revision mutex and all invalidation methods independently of PermissionMiddleware. Constructor explicitly accepts shared owner or nil standalone state;8 callers updated. Existing in-flight all/user/server invalidation tests now invalidate the owner while withholding an older admin lookup; stale publication remains rejected. New two-middleware test shares initial/fresh grants with one repository lookup per revision. Full middleware/cache/root tests pass2.239/0.349/15.885s; final permission selection, build and vet pass. This is owner extraction; production role/member/server fan-out still binds after routes until the next composition step. Whole RF11/current-source CI remain open.


### RF11 — permission owner and fan-out exist before routes (2026-11-14)

initServices now constructs PermissionCache, owns its rollback/cleanup and builds the channel/server cache invalidation composite before writers/routes. initRoutes receives this same cache. Role/member/server setters currently bind the composite within service composition, no longer after routes. Auth ownership invalidation uses a constructor option; conditional capability assertion and setter removed. Real SQLite composition test primes route permission then Role.Update revokes it; next middleware request403 proves shared invalidation. Ownership success/audit/factor/password/session scenarios now inject option through bound harness;4.344s selected services pass. Full root/middleware15.009/2.016s, build/vet pass. Startup exact worker count is4 and cleanup returns to baseline. No reviewed exact-hit file changed. Remaining role/member/server constructor setter migration and full RF11/current-source race/native acceptance stay open.


### RF11 — role permission invalidator constructor (2026-11-14)

Role constructor explicitly receives PermissionInvalidator; production injects the already composed shared fan-out and removes the late setter. Constructor regression failed before change. Existing permission-change invalidates-all, cosmetic-only preserves-cache and delete invalidates-all tests inject during construction and pass; real root primed-grant revocation403 and wiring tests also pass. Standalone native mutation fixture explicitly selects nil, retaining its prior mode. Build/vet/diff check pass; no reviewed exact-hit file changed. Member/server setter migrations and fresh native/race/current-source CI remain open.


### CI follow-up — promoted permission cache Close selector (2026-11-14)

Server CI43634370619 on188a4a48 failed golangci-lint job132567817027 with one staticcheck QF1008 at middleware/permission.go157: explicit embedded PermissionCache selector is redundant. Stop now calls promoted Close directly; same owner and idempotent join behavior. Full middleware tests1.979s and vet pass. Local golangci-lint binary unavailable; fresh CI must establish lint success. Other jobs are not claimed terminal here.


### RF11 — member permission invalidator constructor (2026-11-14)

Member constructor now requires PermissionInvalidator after identity invalidator, before optional profile notifier. Seven calls updated; production passes shared fan-out and setter removed. Kick/ban/role-change fixtures inject during construction; constructor regression failed before implementation. Selected service/middleware/handler/root cache/wiring tests pass, build/vet pass. Fresh dedicated PostgreSQL18.6 TestPostgresMemberRoleReplacement passes all9 subcases/no skips, including second-write/commit failures, duplicate retry, protected/foreign roles and concurrent grant/revocation. Temporary loopback/non-TLS container stopped; Windows run is non-race. No reviewed exact-hit file changed. Server constructor migration and fresh source-bound CI remain open; the earlier lint correction is separately committed.


### RF11 — server permission invalidator constructor (2026-11-14)

Server constructor now explicitly receives PermissionInvalidator;3 calls updated and final production permission setter removed. Constructor regression failed before change. Leave success/removal-failure fixtures inject at construction; fixture initially retained nil, and failing targeted invalidation assertion caught it before correction. Isolated leave/rejoin cache fixture seeds private test state before operations and is not constructor proof. Join/leave/rejoin/delete event, real route grant revocation and wiring selections pass; build/vet/diff check pass. No reviewed exact-hit source changed. Prior CI lint job onf40043e9 now confirms SUCCESS; overall CI still in progress. Full RF11 requirement audit/native/race and current unpushed source validation remain open.


### RF11 — app log factory declares sink/health runtime contract (2026-11-14)

NewAppLogService now returns AppLogRuntime, retaining ConsumeRecord and Health alongside existing service lifecycle. Services keeps that declared runtime type; handlers retain narrow AppLogService. Main directly binds app sink and passes Health to runtime stats, removing capability assertions and silent zero-health fallback. Declared-result regression failed before change. Existing AppLog pipeline/health and root wiring/startup selections pass10.858/0.774s after removing a now-unused main import; build/vet/diff check pass. No reviewed exact-hit source changed. Current-source CI and full RF11 audit remain open.

### RF11 — explicit bot runtime constructor dependencies (2026-11-14)

Bot construction now declares disconnect, broadcast, membership and permission integrations in `BotRuntimeDependencies`. Production supplies each capability explicitly; standalone fixtures use explicit zero values. Removed the late permission setter and optional runtime type assertions. The constructor regression failed before the change. Existing bot/application scope, invocation, revocation and handler/wiring tests passed (services 3.698s, handlers 1.031s, root 0.855s). `go build ./...`, scoped `go vet` and diff checks passed. This is bounded RF11 evidence; full RF11 acceptance and current-head CI remain open.

### RF11 — combined constructor verification and source-bound CI (2026-11-14)

On `bcf04a08`, `go test ./services ./middleware ./handlers ./ws . -count=1` passed: services 95.950s, middleware 2.124s, handlers 7.471s, ws 5.480s, root 14.885s. This includes constructor, actual cache/friendship composition, startup rollback, shutdown ownership, route manifest and route gate tests present in those packages. Local Windows execution is not Linux race or physical-device proof.

Remote source `f40043e96c8a95465d6d403c7b2b759d4ddcae5e` completed Server CI 43634600863 and all 36 PR checks successfully; receipt: `implementation/verification/refactor-integration-f400-terminal-2026-11-14.json`. Later constructor commits require their own CI. RF11 remains open: comprehensive callback wiring coverage and required/optional dependency classification must still be audited; Hub logger/moderation wiring remains post-service composition because of the service/Hub cycle. Existing name-based setter completeness tests are not execution proof for every callback.

### RF11 — validated Hub runtime composition boundary (2026-11-14)

The Hub/service cycle now has a declared `ws.RuntimeDependencies` composition step after service construction and before callback registration or Hub.Run. `ConfigureRuntime` rejects a missing logger or moderation authorizer before changing either field. Removed both individual setters. Standalone `NewHub` behavior remains unchanged; this validates production composition rather than claiming all callback wiring is complete.

The boundary regression failed before implementation. Behavioral tests verify rejection of each missing dependency, retention of installed dependencies after rejected composition, logger dispatch and both authorizer decisions. A source-order regression guards the production validation call before callback registration/Run. Full `go test ./ws . -count=1` passed (5.492s/15.146s), and the added source-order regression passed separately. `go build ./...` and `go vet ./ws .` passed. The initial test compile caught a mistaken cleanup method name; corrected to Hub.Shutdown before the successful run. Current-head Linux CI and the complete RF11 callback audit remain open.

### RF11 — reject typed-nil Hub runtime integrations (2026-11-14)

A follow-up negative regression demonstrated that an interface containing a nil logger or authorizer pointer passed the first runtime validation. Startup validation now checks nil-capable concrete implementations before publishing either dependency. Both typed-nil subcases failed before the correction; the regression also checks that rejected composition retains the installed logger and authorizer. Full `go test ./ws . -count=1` passed (5.464s/14.892s), followed by successful build and scoped vet. This closes the typed-nil gap in the new boundary, not the remaining project-wide dependency/callback audit.

### RF11 — declared lifecycle-aware presence notification entry point (2026-11-14)

Added the narrow `OnlineFriendPresenceNotifier` contract and included it in the factory runtime result. Presence callbacks now require this contract directly, removing capability discovery and its alternate background-context fallback. The concrete production notifier keeps its existing lifecycle-derived fresh five-second budget and shutdown cancellation. Callback spies now implement the same presence entry point as production. The factory contract regression failed first; the fresh-budget/shutdown test now calls through the declared factory result without a concrete assertion.

Selected notifier/presence/wiring/startup tests passed (services 0.566s/root 0.867s), build and scoped vet passed, and the updated interface-only notifier tests passed again (0.576s). An unused time import exposed by removing the fallback was removed before successful validation. Full callback execution coverage and the notifier notification-repository capability assertion remain open RF11 work.

### RF11 — explicit online notification persistence capabilities (2026-11-14)

Online friend notifier construction now takes the guarded notification writer explicitly and a separate optional `OnlineFriendCandidateReader` (nil deliberately selects the existing per-friend path). Removed both runtime repository capability assertions. Production passes both from `NotificationRuntimeStore`, retained by the repository factory and composition bundle; other domain consumers retain their narrower `NotificationStore` contract. No notification SQL or eligibility decision changed. All eight constructor call sites are explicit about bulk versus standalone operation.

The constructor contract regression failed first (six inputs rather than seven); it also verifies the factory exposes both declared capabilities. Selected notifier/presence/wiring/startup tests passed (services 0.627s/root 0.798s), repository online-friend tests passed (5.191s), build and scoped vet passed; final notifier regression rerun passed (0.565s). Initial broadening of the shared interface caused unrelated group fixtures to fail compilation, resolved by the separate production runtime contract. Current-head CI and complete callback execution coverage remain open.

### RF11 — actual online-notifier composition and combined verification (2026-11-14)

Added a real SQLite composition test using initRepositories, initServices and the declared notifier runtime contract. A Hub wrapper provides a fixed visible-user input; the production repositories and notifier persist exactly one notice across repeated online calls. After resetting the epoch and committing a blocked friendship, another call adds no notice. Stop causes the next presence call to return context.Canceled. The test passed initially (1.105s) and across three consecutive executions (1.605s); scoped vet and diff checks passed. This is not a real socket/client or PostgreSQL acceptance claim.

The five-package full test run against source 3f0c2470 passed: services 96.344s, middleware 2.043s, handlers 8.127s, ws 5.411s, root 15.232s. The new composition test was then verified separately as above. Complete callback registration/execution coverage and current aggregate Linux race CI remain open.

### RF11 — P2P callback registration boundary and payload routing (2026-11-14)

Extracted the five existing P2P registrations into registerP2PCallbacks with a narrow registrar interface; callback bodies and service calls are unchanged. Tests execute every captured callback for success and service-error cases, checking the exact actor, receiver, call type, call IDs and signal payload reaching the matching service method. Selected P2P callback/wiring/route tests passed (0.753s), build and scoped vet passed. Transport scheduling and physical media are separate; the complete Hub callback matrix remains open.

Remote source 08cf44f2432722f166a85eb394bff38a2cd5fc63 completed run 43635956632 with all 36 PR checks successful. Receipt: implementation/verification/refactor-integration-08cf-terminal-2026-11-14.json. This does not prove later Hub/presence/P2P commits; the next aggregate requires its own CI.

### RF11 — voice callback registration and bounded work (2026-11-14)

Extracted eight voice callbacks behind voiceCallbackRegistrar. A comparison with the previous source confirmed the callback bodies match exactly. Executable registration tests check complete payload routing, including partial-update nil pointers, moderator/target/channel identities, screen-share watching and activity. Both success and service-error paths execute all callbacks. Failed join does not write activity; successful join shares one context across user/channel/server bookkeeping. Moderation and bookkeeping contexts carry the broadcast deadline and are canceled when callbacks return.

Selected voice/P2P/wiring/route tests passed (0.773s), followed by successful build, root vet and diff checks. This verifies service routing, not socket scheduling, LiveKit or physical media. Game-activity and complete production callback composition acceptance remain open. CI 43637258866 is still in progress for the previous pushed source; no failing job observed.
