# Refactor kabul durumu

13 Kasım 2026. Bu matris [görev kartlarının](REFACTORING_TASKS.md) kapsamını korur. Kaynak veya CI başarısı tek başına bir kartı kapatmaz. Aşağıdaki açık kapılar tamamlanmadan bütün proje için refactor tamamlandı denemez. PR bağlantıları teslimat yerini gösterir; birleştirme veya yayın kanıtı değildir.

## Görevler ve kalan kabul kapıları

| Görev | Mevcut kanıt veya teslimat | Kapanış için kalan doğrulama |
|---|---|---|
| RF01 | UTF-8 kapısı ve üretim build kanıtı görev defterinde. | Nihai birleşik kaynakta aynı kapının geçmesi. |
| RF02 | Kaynak manifestine bağlı dondurulmuş baseline var. | Nihai birleşik kaynak için yeni sabit baseline; eski sayıları yeni HEAD sonucu saymama. |
| RF03 | [#224](https://github.com/alfapars-exe/discordd/pull/224), [#263](https://github.com/alfapars-exe/discordd/pull/263), [#264](https://github.com/alfapars-exe/discordd/pull/264) ve [#260](https://github.com/alfapars-exe/discordd/pull/260). | Birleşik kaynakta tam race/coverage; tüm gerekli profiller ve zorunlu testlerin gerçekten çalışması. |
| RF04 | [#221](https://github.com/alfapars-exe/discordd/pull/221), gerçek PostgreSQL ve mTLS testleri. | Nihai migration/repository sözleşmeleri ve zorunlu skip denetimi; ortam güvenliği korunmalı. |
| RF05 | Placeholder/literal/comment, NULL ve sonuç eşdeğerliği testleri var. | Görev kartındaki bütün kullanılan sorgu ailelerinin corpus ile eşleşmesi henüz tam kanıtlanmadı. |
| RF06 | Bilinen SQLite şema fingerprint'leri ve rollback testleri #221 kapsamında. | Gerçek kullanıcı yedeğiyle restore ve belgelenen recovery adımlarının kabulü. |
| RF07 | [#225](https://github.com/alfapars-exe/discordd/pull/225), [#252](https://github.com/alfapars-exe/discordd/pull/252), [#265](https://github.com/alfapars-exe/discordd/pull/265). | Nihai kaynakta recovery/MFA/refresh sözleşmelerinin birlikte doğrulanması. |
| RF08 | Auth worker start/stop ve başarısız initialization cleanup testleri var. | Son kaynakta kaynak sahipliği ve shutdown yollarının bütün kapsamıyla uzlaştırılması. |
| RF09 | #221 üye/grup sorguları ve ölçümleri. | Son kaynakta query kapsamı, sonuç eşdeğerliği ve ölçüm bütçelerinin korunması. |
| RF10 | [#239](https://github.com/alfapars-exe/discordd/pull/239) eski music session kontrolünü reddediyor. | Karttaki concurrency/cleanup yollarının tamamının kanıt eşlemesi ve runtime kabulü. |
| RF11 | [#223](https://github.com/alfapars-exe/discordd/pull/223) constructor bağımlılıkları; hedefli race, PostgreSQL ve tam build/vet. | Güncel head CI, birleşik başlangıç/shutdown kabulü ve karttaki kalan setter/lifecycle kapsamının denetimi. |
| RF12 | Mikrofon output politikası ve controller testleri. | Büyük screen-share hook ayrımı, bütün platform characterization ve gerçek cihaz kabulü açık. |
| RF13 | [#226](https://github.com/alfapars-exe/discordd/pull/226) tercih eşlemesi ve senkronizasyon ayrımı. | Son kaynakta account switch, eski yanıt, codec ve yerel alan izolasyonu kabulünü uzlaştırma. |
| RF14 | [#229](https://github.com/alfapars-exe/discordd/pull/229), [#230](https://github.com/alfapars-exe/discordd/pull/230), [#267](https://github.com/alfapars-exe/discordd/pull/267). | Birleşik reconnect/transport lifecycle, yarış ve uzun oturum kaynak doğrulaması. |
| RF15 | Kararlı geçmiş düzeltmesi main'de; [#240](https://github.com/alfapars-exe/discordd/pull/240), [#268](https://github.com/alfapars-exe/discordd/pull/268), [#269](https://github.com/alfapars-exe/discordd/pull/269). | Kanal/DM ortak fixture'ları, yetki kaybı, hesap değişimi ve nihai sıralama/read cursor kabulü. |
| RF16 | [#228](https://github.com/alfapars-exe/discordd/pull/228) backup self-device handshake koruması ve storage öncesi saf JSON/base64 içerik doğrulaması. | Storage/codec/orchestration ayrımının tamamı ve karttaki legacy/current/bozuk backup matrisi henüz kapanmadı. |
| RF17 | [#233](https://github.com/alfapars-exe/discordd/pull/233), [#261](https://github.com/alfapars-exe/discordd/pull/261); arama ölçümleri görev defterinde. | İlk sorgunun tam tarama/bellek maliyeti, iptal ve büyük cache sınırlarının nihai kabulü. |
| RF18 | [#257](https://github.com/alfapars-exe/discordd/pull/257) picker klavye ve listener cleanup. | Paketli gerçek capture, owner crash/reload ve cihaz kabulü. |
| RF19 | Scoped preload disposer ve updater abonelik testleri. | Splash/runtime state machine ve gerçek indirme/kurulum/yeniden başlatma kabulü. |
| RF20 | IPC güvenlik düzeltmeleri ve mevcut testler. | Registrar/overlay sorumluluk ayrımının kartın tamamını karşıladığı henüz kanıtlanmadı; sender/session ve çoklu ekran kabulü açık. |
| RF21 | [#242](https://github.com/alfapars-exe/discordd/pull/242) Windows helper; [#251](https://github.com/alfapars-exe/discordd/pull/251) upgrade doğrulayıcısı. | Fiziksel Windows cihazı, overlay/DPI/çoklu ekran ve gerçek kullanıcı profile continuity kabulü. |
| RF22 | [#243](https://github.com/alfapars-exe/discordd/pull/243), [#244](https://github.com/alfapars-exe/discordd/pull/244): Android emülatör/iOS simülatör kanıtı. | Fiziksel Android/iOS ses, ekran paylaşımı, interruption ve upgrade kabulü. |
| RF23 | İçeriğe bağlı manifest tasarımı ve doğrulayıcılar mevcut. | Güncel artifact hash'leri, son CI/provenance, provider readiness ve Windows update bulunabilirliği. |
| RF24 | [#247](https://github.com/alfapars-exe/discordd/pull/247) redaction ve log testleri. | Üretim tarayıcı koşusunda görülen app-log batch timeout'unun kök nedeni ve kayıp/geri basınç kabulü. |
| RF25 | Locale parity, klavyeyle auth/recovery ve erişilebilir kontrollerin testleri. | Ayarlar/picker/voice kapsamının tamamı ve gerçek ekran okuyucu kabulü. |
| RF26 | [#249](https://github.com/alfapars-exe/discordd/pull/249) kullanılmayan bağımlılıklar; hedefli format/lint. | Kalan statik analiz ve okunabilirlik işleri; nihai birleşik kaynak standardı. |
| RF27 | [#232](https://github.com/alfapars-exe/discordd/pull/232), welcome bot HTTP/WS timeout, redirect ve shutdown testleri. | Son kaynakta bot modülünün tam sözleşme ve deployment kanıtının uzlaştırılması. |
| RF28 | [#238](https://github.com/alfapars-exe/discordd/pull/238): temiz PR dalında üretim Chromium 11/11, WebKit 1/1. | Güncel CI, birleşik üretim çok kullanıcılı matris ve hesap/yetki/offline/recovery senaryolarının tam eşlemesi. |
| RF29 | Arama, geçmiş, grup profil ve WS ölçümleri görev defterinde. | Aynı nihai kaynakta API/DB/client/kaynak bütçeleri, yük profilleri ve uzun oturum/medya ölçümleri. |
| RF30 | Kaynak, yerel test ve PR CI kanıtları ayrı tutuluyor. | Birleştirme, paketlenmiş runtime, dağıtım, desteklenen platform/DB matrisi ve gerekli fiziksel cihaz kabulü tamamlanmadı. |

## Teslimatın sınırları

Bu tablo tam kabul sertifikası değildir. Görev kartlarının bütün Acceptance Criteria maddeleri tek tek kanıtlanmadan bir satır kapatılmaz. Mevcut 248 ürün kabul maddesi kanıtsız kapatılmaz veya refactor hedefinden sessizce çıkarılmaz. Fiziksel cihaz ya da üretim erişimi gerektiren işler, kaynak testleriyle tamamlanmış sayılmaz.

CI anlık görüntüleri [verification dizininde](../implementation/verification/refactor-pr-snapshot-2026-11-13.json) commit kimliklerine bağlıdır; yeni push sonrasında önceki başarı güncel head'in sonucu değildir. Yinelenen #270 kapatılmıştır; LiveKit silme temizliğinin kanonik PR'ı [#222](https://github.com/alfapars-exe/discordd/pull/222)'dir.
