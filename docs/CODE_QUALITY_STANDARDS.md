# HiChat kod kalitesi ve okunabilirlik standardı

26 Ekim uygulama kanıtı: ilk grup yerelde doğrulandı. Güncel sonuçlar ve kalan kabul sınırları [görev izleme tablosunda](REFACTORING_TASKS.md) ve [manifestli raporda](../implementation/verification/refactoring-implementation-2026-10-26.json) izlenir. Bu belge tüm görevlerin tamamlandığını göstermez.

> 26 Ekim uygulaması: .editorconfig ve check-text-encoding.py kaynak kapısı eklendi. Kayıp çıktı cihazı ve kaynak yaşam döngüsü iyileştirmeleri ilgili sahiplik testleriyle ilerliyor; bu belgenin bütün standartlarının tüm depoda tamamlandığı iddia edilmez.

Tarih: 25 Ekim 2026. Bu standart mevcut React/TypeScript, Go, Electron, Windows native, Capacitor ve yayın araçları mimarisine uygulanır. Bir yeniden yazım talimatı değildir. Refactoring görevi, korunacak davranışı ve ölçülebilir faydayı [REFACTORING_TASKS.md](REFACTORING_TASKS.md) içinde belirtir; test kabulü [TEST_STRATEGY.md](TEST_STRATEGY.md) ile değerlendirilir. Mevcut `SECURE-CODING.md` ve somut repository sözleşmeleri korunur.

## 1. Değişikliğin birimi ve kapsamı

- Her PR tek bir davranış sınırını veya bağımlılık ilişkisini iyileştirir. Önce karakterizasyon testi, sonra taşıma/ayırma, gerekiyorsa ayrı PR'da davranış düzeltmesi yapılır. Toplu isim değiştirme, formatlama ve mimari değişiklik aynı diff'e karıştırılmaz.
- Başlangıç çalışma ağacı kaydedilir. Başkasının değişikliği reset/clean ile kaldırılmaz; commit'e yalnız görevin dosyaları alınır. Paralel işler aynı state/contract dosyasını değiştirecekse bir sahibi ve sırası belirlenir.
- Mevcut HTTP/WS/IPC payload, status/hata kodu, preference JSON, IndexedDB alanı, crypto ciphertext/backup biçimi ve dış entegrasyon korunur. Sözleşme değişikliği refactoring gibi sunulmaz; versiyonlama, eski istemci ve rollout testi olan ayrı görev gerekir.
- Görev faydası örneğin kaldırılan dependency cycle, tek yerde doğrulanan sözleşme, test edilebilir resource owner, azaltılan sorgu sayısı veya ölçülen gecikmedir. Dosyayı küçültmek tek başına gerekçe değildir.
- Geniş `BaseService`, generic superstore, otomatik DI container veya yeni framework eklenmez. Mevcut constructor/function parametreleri ve dar arayüzler yeterliyse bunlar kullanılır.

## 2. Kaynak kod biçimi ve encoding

**UTF-8 zorunludur.** Yeni metin dosyaları UTF-8 olarak yazılır; var olan dosyada newline/BOM tarzı gereksiz değiştirilmeyecektir. Geçersiz byte'ı sessizce replacement character'a dönüştüren toplu dönüşüm yapılmaz. RF01 kapsamında `client/src/components/voice/VoiceProvider.tsx:262` ve `client/src/components/dm/GroupDMCall.tsx:60` build engeli bağlamdaki amaçlanan metin doğrulanarak düzeltilir; ardından repository'nin tracked source metinlerinde geçerli UTF-8 kontrolü CI'a eklenir. İkili, model, WASM, asset ve generated vendor dosyaları bu kontrolden türüne göre ayrılır.

Go için `gofmt` kanoniktir. TS/JS'de mevcut ESLint ve dosyanın çevresindeki stil kullanılır; noktalı virgül/quote tercihi için toplu diff çıkarılmaz. RF26 kapsamında repository kökünde `.editorconfig` ile UTF-8, final newline, whitespace ve dile göre indentation tanımlanır; önce etkilenen dosyalarda uygulanır. Ek bir formatter varsayılan olarak kurulmaz. Lint otomatik düzeltmeleri yalnız görev kapsamındaki dosyalara uygulanır ve diff gözden geçirilir.

Uzun satıra sıkıştırılmış birden fazla yan etki ayrılır. Özellikle `p2pCallStore.ts:136–209`, group history ve yeni native/IPC kodunda koşul, kaynak sahipliği ve state yazımı ayrı satırlarda görünür olmalıdır. Yorum blokları bozuk yapıyı örtmek için kullanılmaz.

| Sinyal | Uygulanacak inceleme |
|---|---|
| Bir fonksiyon yaklaşık 80 satırı aşıyor | Birden fazla sorumluluk, hata/cleanup yolları veya bağımsız saf hesap var mı bak; eşik otomatik bölme zorunluluğu değildir. |
| Generated/test olmayan dosya yaklaşık 400 satırı aşıyor | Alan sınırlarını, import bağımlılıklarını ve test kurulumu maliyetini incele. Cohesion yüksekse boyut tek başına hata sayılmaz. |
| Derin koşul/nested async | Guard clause, isimlendirilmiş predicate ve explicit result ile akışı sadeleştir; await sonrası geçerlilik kontrollerini kaybetme. |
| Aynı kural birkaç yerde yazılmış | Önce gerçekten aynı sözleşme olduğunu kanıtla; ortak saf yardımcı veya metadata çıkar. Benzer görünen domain politikalarını zorla birleştirme. |
| Tekrarlanan magic number | Birimi ve kapsamı adıyla belli sabit/policy kullan. Protokol sabiti ile ayarlanabilir operasyon değerini ayır. |

Bu eşikler review sinyalidir; satır sayısını düşürmek için tek satırlık kod veya gereksiz küçük fonksiyonlar üretmek kabul edilmez.

## 3. İsimlendirme, türler ve veri sınırları

- TypeScript bileşenleri `PascalCase`, React hook'ları yalnız gerçek hook ise `useX`, diğer fonksiyonlar eylem odaklı `camelCase` kullanır. Go mevcut paket konvansiyonunu ve kısa, anlamlı receiver isimlerini korur. Kullanıcı görünen metinler EN/TR kaynaklarında; API alanları mevcut `snake_case` biçiminde kalır.
- İsim birimi taşır: `timeoutMs`, `durationSeconds`, `maxBytes`, `ownerId`, `authGeneration`. `data`, `value`, `state` yalnız yakın bağlamda anlamı tek olduğunda uygundur. İsimler gerçek sahipliği açıklamalı; `current()` gibi predicate'ler mümkün olduğunca `isCurrentCall`/`isCurrentSession` olmalıdır.
- `client/tsconfig.app.json` ve `electron/tsconfig.json` içindeki strict ayarlar korunur. `unknown` dış girdinin başlangıç türüdür; JSON/API/IPC/localStorage/backup sınırında parse+validate edilir. `as Foo` doğrulama yerine kullanılmaz.
- `any`, çift cast ve lint suppression yayılmaz. SDK'nın yayınlamadığı receiver/sender bilgisi gerekiyorsa tek dar adapter içinde capability guard, açıklama ve test bulunur; kullanım yerleri SDK iç alanına doğrudan erişmez.
- Missing, `null`, boş string ve default farklı anlam taşıyorsa bu ayrım korunur. `||` ile sıfır/false/boş değeri yanlışlıkla default'a çevirmek yerine sözleşmeye uygun `??` veya açık kontrol kullanılır.
- Discriminated union, gerçekten farklı geçerli durumları ayırmak için kullanılır. Örneğin kaynak hazır olmadan `published=true` yazmayı mümkün kılan bağımsız boolean kümeleri yerine mümkün olduğunda typed state tercih edilir; her modüle yeni state-machine kütüphanesi eklenmez.
- Settings alanının default, type/range, device-local/account-sync ve legacy migration kararı aynı typed tanımda izlenir. RF13 bu sözleşmenin `voiceSettingsSlice` ve `preferencesStore` arasında çoğalmasını azaltır; yeni alan ekleyen PR tüm sınıflandırmaları ve sınır testlerini taşır.

## 4. Katman ve modül sınırları

| Katman | Sorumluluk | Kaçınılacak bağımlılık |
|---|---|---|
| React component | Görünüm, erişilebilir etkileşim, kullanıcı niyetini iletme | SQL, ham IPC, kripto protokolü, uzun yaşayan medya kaynağını render içinde sahiplenme. |
| React hook | React yaşam döngüsünü bağımsız controller'a bağlama | Bir hook içinde platform seçimi + uzun async süreç + persistence + UI hata politikasının tamamı. |
| Zustand store | Domain state ve eylemler; selector ile tüketim | Başka store'un iç state'ini rastgele değiştirme; import cycle'ı dinamik import ile kalıcı olarak gizleme. |
| Saf domain yardımcı | Validation, merge, sıralama, policy, codec | `window`, clock, global store, ağ ve dosya yan etkisi. |
| Platform/transport adapter | Fetch, LiveKit, WebRTC, Electron IPC, native plugin | UI kararı ve tekrar eden account/permission politikası. |
| Go handler/middleware | Parse/validate, auth context, servis çağrısı, HTTP yanıt | SQL veya çok adımlı domain orchestration. |
| Go service | Yetkili use-case, transaction/iş akışı kararı, dış portlar | HTTP response yazma veya ortak mutable global üzerinden servis bulma. |
| Repository/database | Parametreli SQL, transaction, dialect, kalıcı veri sözleşmesi | UI biçimlendirme, transport status, dış ağ sağlayıcısı. |
| Composition/bootstrap | Bağımlılıkları kurma, lifecycle başlatma/durdurma | Çalışma sırasında service locator olarak her modüle açılma. |

Dar arayüz tüketen paketin ihtiyacına göre tanımlanır; tüm repository'yi yansıtan dev mock interface oluşturulmaz. Saat, random, dosya sistemi ve dış HTTP yalnız test ihtiyacı kanıtlanan sınırlarda enjekte edilir. Mevcut `MicrophonePipeline`, `P2PMicrophoneSession`, `P2PCameraSession`, `P2PScreenAudioSession`, `logx` ve auth-generation mekanizmaları yeniden kullanılacaktır.

Store refactoring'de public action imzaları ilk PR'da korunur. `messageStore`, `dmStore`, `groupDMStore` ortak history/merge yardımcılarını paylaşabilir; farklı şifreleme, yetki ve gönderim semantiği tek jenerik pipeline'a zorlanmaz. Preferences hydration'ın composition katmanında bağlanması cycle'ı kaldırır; bir genel event bus'a dönüşmesi gerekmez.

## 5. Async, concurrency ve kaynak sahipliği

Her uzun yaşayan kaynak için dört soru koddan cevaplanmalıdır: kim oluşturur, kim kullanabilir, hangi olay geçersiz kılar, kim kapatır? Paylaşılan çağrı pipeline'ını ödünç alan mikrofon testi onu dispose edemez; kendi pipeline'ını oluşturan test ise tüm kaynaklarını kapatır.

- `AbortSignal`/Go `context.Context` sınırdan bağımlı operasyona aktarılır. Bir API iptal edilemiyorsa geç gelen sonuç sahiplik kontrolünden sonra derhal serbest bırakılır. Abort, yalnız UI state yazımını atlamak değildir.
- Auth owner/generation, call/channel/room ve operation revision kontrolleri await sonrası commit/publish/notify öncesinde yapılır. Bir kaynağın eski callback'i yeni sahibin kaynağını kapatamaz.
- Mutasyon sırasında kaynak değişimi prepare → validate → commit → retire sırasını korur. Mute/deafen/permission iptali hazırlanan track'i de sessiz tutar. Controller dışına ham kaynak yerine gerekiyorsa typed handle/lease çıkarılır.
- Cleanup idempotent olur; listener unsubscribe, timer clear, track stop, worker terminate, AudioContext close, socket/process close aynı sahibin kapanışında tamamlanır. Async cleanup hatası açıkça ele alınır; `void dispose()` ancak bilinçli ve gözlenebilir bir best-effort yol ise kullanılır.
- Go goroutine başlatan fonksiyon durdurma koşulunu ve bekleme/timeout yolunu tanımlar. Sınırsız goroutine/queue/buffer yerine mevcut kapasite ve backpressure politikası kullanılır. Mutex tutulurken kontrolsüz ağ/DB çağrısı yapılmaz.
- Retry yalnız geçici hatada ve idempotency/güncel sahiplik koşuluyla yapılır; üst sınır, backoff, jitter ve iptal yolu vardır. Yetki reddi, yanlış input veya kullanıcı iptali otomatik retry nedeni değildir. Bekleme süreleri fake clock ile unit-test edilebilir olur.
- Browser `online` olayı sunucu sağlığı kabul edilmez; gerçek transport yeniden bağlanması gözlenir. `setInterval(async ...)` üst üste iş başlatabiliyorsa single-flight veya kontrollü scheduling kullanılır.

## 6. Hata, doğrulama ve log standardı

Hata sonucu kullanıcıya dönen sözleşme, operasyonel kayıt ve iç neden olarak ayrılır. Beklenen validation/permission/cancellation sonuçları exception gürültüsüne dönüştürülmez; beklenmeyen hata da sessiz `catch {}` ile kaybolmaz.

- Go hataları nedenini koruyarak sarılır; `errors.Is/As` veya mevcut domain error kodlarıyla sınıflandırılır. Handler hata metni karşılaştırarak iş kuralı seçmez. TS adapter `unknown` hatayı typed/domain sonucuna çevirir; kullanıcıya ham stack/SDK metni basılmaz.
- Doğrulama güven sınırında yapılır: request, WS frame, IPC payload, native bridge, local cache ve backup. Saf domain fonksiyonları doğrulanmış tip alır; tekrar doğrulama yalnız farklı güven sınırında anlamlıysa yapılır.
- HTTP status/error code/JSON merkezi mevcut `server/pkg/response.go` yoluyla tutarlı üretilir. Partial upload gibi mevcut 207 sözleşmesi refactoring sırasında normal 200'e çevrilmez.
- Mevcut `server/pkg/logx` ve çalışma ağacındaki `ERROR_MANAGEMENT.md`/pipeline çalışması uzlaştırılır; ikinci logger/queue/diagnostic sistemi kurulmaz. RF24 mevcut dirty değişikliklerin doğrulanması ve sahipliği netleşmeden aynı dosyalara paralel refactoring yapmaz.
- Hata bir sahip tarafından kaydedilir. Alt katman hem loglayıp hem döndürüyor, üst katman tekrar logluyorsa kayıt sahipliği netleştirilir. `request_id`, olay adı, hata kodu, süre ve gerekli anonim bağlam kullanılır; credential, cookie, token, parola, key material, plaintext mesaj ve tam request body eklenmez.
- Redaction son görsel panelde değil kalıcı/uzak sink'ten önce uygulanır. Log kuyruğu kapasitesi, timeout, drop davranışı ve kapanış flush'ı ölçülür. Logging ana işin sınırsız beklemesine neden olmaz.
- Bilinçli best-effort catch yanında neden ve etkisi kısa yazılır. Kullanıcının izin penceresini kapatması ile gerçek aygıt arızası ayrı işlenir; stale işlemin hatası yeni oturumda toast oluşturmaz.

## 7. Veri, kripto, API ve migration uyumluluğu

SQL parametreli kalır; identifier dinamikse allowlist kullanılır. Mevcut SQLite/libSQL/PostgreSQL farkları database/dialect sınırında tutulur. Basit SQL string değiştirme ile yeni dialect semantiği eklenmez; ilgili sorgu her hedef DB'de contract testinden geçer. Servis içindeki loop sorgularını bulk hale getirme, boş input/duplicate ID/sıralama/yetki davranışını da korumalıdır.

Transaction sınırı iş invariant'ına göre belirlenir. Delete/anonymize/import gibi çok adımlı işlerde ara hata sonucu test edilir. Yeni index/schema gerekiyorsa additive migration, eski/yeni uygulama birlikte çalışma süresi, backfill ve rollback/backup-restore provası yazılır; destructive down migration otomatik varsayılmaz. Mevcut migration dosyası yeniden yazılmaz.

Kripto modülerleştirme algoritma/protokol tasarımı değişikliği değildir. `keyStorage.ts` façade'ı, IndexedDB store/key isimleri ve backup wire formatı korunur. Parsed backup önce `unknown` olarak doğrulanır, ancak bundan sonra import/clear aşamasına geçer. Hata halinde önceki keys, metadata ve sealed pending-send kayıtlarının geri gelmesi fixture ile kanıtlanır. Alanı temizleme/silme performans optimizasyonu gibi sunulamaz.

HTTP route golden, OpenAPI ve client type uyumu birlikte kontrol edilir. Golden dosyası test geçsin diye körlemesine güncellenmez; intended route değişikliği ayrıca incelenir. WS operation ve IPC channel isimleri string taşırken mevcut izin/sender doğrulaması değişmeden kalır. Internal helper yeniden adlandırması wire alanını yeniden adlandırma nedeni değildir.

## 8. UI, platform ve bağımlılık kuralları

- Bileşenler kullanıcıya görünen eylem ve durum üzerinden adlandırılır. Renk, spacing ve font mevcut theme token'larından alınır; yalnız ölçülen dinamik layout/konum gibi gerçek runtime değerleri açıkça sınırlı inline/CSS variable yolunda kalabilir. UI düzeni refactoring PR'ında sebepsiz değişmez.
- Yeni string EN/TR kaynaklarına eklenir; 21 namespace envanteri parity kontrolüne katılır. Plural/interpolation farklılıkları açıklanmış istisna ile ele alınır. Raw error key veya backend İngilizce metni kullanıcı mesajı olmaz.
- Modal/menu focus yönetimi, semantic control, accessible name, klavye escape/return, reduced motion ve zoom korunur. Erişilebilirlik yalnız aria attribute sayısına göre kabul edilmez.
- Electron main/preload/renderer sınırları typed sözleşmeyle ayrılır. Yeni IPC dar yetki, sender/origin doğrulama ve bounded payload ile açılır. Renderer'a genel dosya/process komut yüzeyi verilmez. Test/typecheck standardı client ile sınırlı kalmaz; RF20/RF26 Electron TS dosyalarını da kapsar.
- Native helper başlatma, çıkış kodu, timeout, stdout/stderr sınırı ve cleanup parent process tarafından yönetilir. C++/Kotlin/Swift lint/build ilk kez zorunlu yapılmadan mevcut baseline çıkarılır. Template test native işlev testi yerine kullanılamaz.
- `nativePlugins.ts` yalnız platform adapter'ıdır; auth, izin ve UI politikasının ikinci kopyası olmaz. Web/Electron no-op ile Android/iOS davranışı ayrı test edilir. Platform capability algısı sürüm/UA tahminine tercih edilir.
- Bağımlılık eklemek önce mevcut API/utility ile çözülüp çözülemediği üzerinden değerlendirilir. Kullanılmayan paket iddiası import/config/build/runtime/native kullanım taramasıyla doğrulanır; yalnız metin aramasında çıkmadığı için kaldırılmaz. Removal ayrı küçük PR ve build/runtime kanıtı taşır.
- Lockfile reproducible kurulumun kaynağıdır. Scanner/tool/action güncellemesi tek görevde, sürüm/digest ve sonuçla yapılır. RF03 coverage sağlayıcısı dışında bu plan varsayılan olarak yeni test framework'ü gerektirmez. Gizli/obsolete engine bağımlılıkları ancak gerçek dynamic import ve paketleme bağımlılığı doğrulandıktan sonra çıkarılır.

## 9. Test ve dokümantasyon yazımı

Test adı tetikleyiciyi ve beklenen davranışı anlatır: `account changes while capture is pending -> late track is stopped`. Arrange/act/assert görünür kalır. Başarı ve izin reddi yanında iptal/timeout/partial failure gerçek çıktı/state ile doğrulanır. Bir fonksiyonun içindeki her satıra karşılık test yazılmaz; kullanıcı/veri invariant'ları test edilir.

Mocks yalnız dış sınırdadır. Repository SQL testinde gerçek DB, crypto doğrulamasında gerçek primitive, kaynak cleanup testinde sayılabilen handle kullanılır. Test yalnız `mockCalled` değil sonuç, owner ve yan etkiyi de denetler. Snapshot/golden yalnız kararlı sözleşmede kullanılır; geniş UI dump'ının güncellenmesi incelemenin yerini almaz.

Yorumlar neden, invariant ve kısıtı açıklamalıdır. Kodun söylediğini tekrar eden veya geçmiş hata günlüğü gibi uzayan yorumlar ilgili test/ADR'ye taşınabilir. Örneğin VoiceProvider'ın hâlâ eager olduğuna dair eski Vite yorumu mevcut `AppLayout` lazy import'u ile uzlaştırılır; sırf yorumda yazıyor diye yeniden lazy-loading işi açılmaz.

Public API/port ve kritik resource owner dokümantasyonu input/output, sahiplik, cancellation, hata, idempotency ve uyumluluk koşullarını yazar. İç küçük getter için gereksiz JSDoc eklenmez. `TODO` kullanılacaksa takip görevi ve tamamlanma koşulu bulunur; belirsiz `fix later` bırakılmaz.

Dokümanlar sonuç ile öneriyi ayırır. Tarih/commit, kaynak yolu ve test sonucu belirtilir; mevcut testin adı güncel PASS iddiası değildir. Performans sayılarına ortam/yük/ölçüm yöntemi eşlik eder. Güvenlik açığı veya production-ready iddiası yalnız kaynak incelemesinden türetilmez.

## 10. PR kabul listesi

1. RF kimliği, somut problem, korunacak davranış ve ölçülebilir kazanım yazıldı.
2. Değişen dosyalar görev kapsamında; başka çalışma ağacı değişikliği veya toplu formatlama yok.
3. Public API/WS/IPC/veri formatı aynı; değişiklik gerekiyorsa ayrı sözleşme ve migration/rollout kararı var.
4. Riskli davranış refactoring öncesinde characterization ile sabitlendi; ilgili negatif ve race/cleanup senaryoları geçti.
5. Lint/typecheck/build ve etkilenen testler gerçekten çalıştırıldı; komut, exit code ve skip/blocked durumu açık.
6. Yeni cycle, kontrolsüz global, kaynak kaçağı, sessiz catch, broad cast veya temelsiz bağımlılık eklenmedi.
7. Hata/log/veri sınırı mevcut projeyle tutarlı; hassas içerik diagnostic çıktıya taşınmadı.
8. Gerekli rollback/revert ve operasyon kabulü yazıldı; build sonucu runtime veya cihaz kabulü gibi sunulmadı.

Belge-only PR için uygulama testlerini sebepsiz tekrar çalıştırmak gerekmez; yollar, RF kimlikleri, bağlantılar, encoding ve tutarlı durum ifadeleri doğrulanır. Uygulama PR'ında ise [TEST_STRATEGY.md](TEST_STRATEGY.md) risk matrisi ve ilgili coverage hedefleri uygulanır. P0 ancak doğrulanmış kritik güvenlik/veri kaybı/işlev hatasıdır; okunabilirlik borcu sırf büyük dosyada olduğu için P0 yapılmaz.
