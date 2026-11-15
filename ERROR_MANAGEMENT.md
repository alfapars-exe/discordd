# Hata yönetimi ve operasyonel günlükler

Sunucu `slog` WARN/ERROR olayları yapılandırılmış konsol çıktısına ve asenkron
`app_logs` yazıcısına gönderilir. Sentry yapılandırılmışsa ERROR olayları Sentry'ye
de iletilir. Paket başlangıcında oluşturulan bileşen logger'ları etkin logger'ı
izler; `Init` öncesinde oluşturulmaları seviye veya alan kaybına yol açmaz.

## Kayıt ve gizlilik

- `created_at` olayın gerçekleşme zamanıdır; yazım zamanı değildir.
- `request_id`, `event_code`, `component`, `error_kind`, `occurrence_count` ve
  `last_seen_at` yönetim API'sinde ayrı alanlardır.
- HTTP yanıt yardımcıları istek kimliğini hata yanıtının `correlation_id` alanına
  taşır. Ayrıntısı kaydedilmemiş 5xx yanıtlarını istek middleware'i yakalar.
- Erişim kayıtları ayrı hata olayı olarak tekrar saklanmaz veya Sentry'ye
  gönderilmez. İstemci iptali, yanıt başlamadıysa yalnız log/metrikte 499 olarak
  gözlemlenir; istemciye yapay bir 499 yanıtı gönderilmez.
- Gizli alan adları, Bearer/Authorization/Cookie değerleri, URL kullanıcı bilgisi
  ve bilinen gizli sorgu parametreleri çıktılardan önce maskelenir. İstek gövdesi
  ve tam önizleme URL'si tanı kaydına eklenmez.
- Bir tanı kaydı en fazla 8 KiB'dir. Büyük metadata değerleri kesilir veya çıkarılır.

## Performans ve kayıp davranışı

Yazıcı, 512 ERROR ve 256 WARN/INFO yuvası kullanır. İstek akışı veritabanı yazımını
beklemez. En fazla 64 olay veya 1 saniye sonunda toplu yazım yapılır. Aynı batch
içindeki maskelenmiş içeriği ve istek/kullanıcı/sunucu kimliği aynı olaylar
birleştirilir; farklı istek kimlikleri birleştirilmez.

Her DB yazımı 2 saniye ile sınırlıdır. Kapanışta toplam 5 saniyelik boşaltma
bütçesi vardır. DB kesintisi, süreç çökmesi veya kuyruk taşması durumunda kayıp
olabilir; sınırsız yeniden deneme ve disk spool'u kullanılmaz. Hata yazıcısının
kendi hataları tekrar kuyruğa gönderilmez. Silinmiş hesap kayıtlarını engelleyen
DB kuralları toplu yazımda da korunur.

`GET /api/admin/logs/health` yalnız platform yöneticilerine açıktır ve DB sorgusu
yapmadan kuyruk doluluğunu, seviyeye göre düşen kayıtları, yazım kayıplarını,
birleştirilen olayları ve son başarılı yazım zamanını verir. Sayaçlar süreç
başlangıcından itibaren birikir. Yönetici günlük ekranı bu bilgileri gösterir.

`app_logs` saklama süresi **7 gündür**. Eski kayıtlar başlangıçta ve saatlik olarak
1000 satırlık partilerle, 2 saniyelik iş bütçesi içinde temizlenir. Listeleme de
7 günlük pencereyi uygular. Denetim günlükleri ve runtime metrikleri kendi saklama
politikalarını kullanmaya devam eder. Paylaşılan eski log dosyası içeri aktarılmaz.

## Erişim logları ve metrikler

Başarılı sürüm, sağlık/readiness, müzik durumu ve istemci günlük istekleri DEBUG
seviyesindedir. Başarısız yanıtlar ve 2 saniyeyi aşan istekler görünür kalır.
`LOG_LEVEL=debug` ayrıntılı erişim incelemesi için kullanılabilir.

Örneklemeden bağımsız olarak bütün HTTP istekleri sayılır. Rota anahtarları
ServeMux şablonlarıdır. Dakikalık metrikler DB havuz sınırını, DB bekleme sayısı ve
süre farkını, log yazıcısının sağlığını ve rota gecikmelerini içerir. En yoğun 32
rota ayrı tutulur; kalan rotaların histogramı `other` altında birleştirilir.
`p50_ms_upper`, `p95_ms_upper`, `p99_ms_upper` sabit histogram kovalarının üst
sınırlarıdır; `-1` 60 saniyenin üzerindeki kovayı belirtir. Bu ek bilgiler
`runtime_telemetry.diagnostics` JSON metninde de saklanır.

PostgreSQL havuzu `POSTGRES_MAX_OPEN_CONNS` (varsayılan 4) ve
`POSTGRES_MAX_IDLE_CONNS` (varsayılan 2) ile ayarlanır. Açık bağlantı 1–256,
boş bağlantı 0–açık bağlantı sınırı arasında olmalıdır. Ayarlamadan önce DB
bekleme süresi ve gerçek istek gecikmesi birlikte karşılaştırılmalıdır.

## Hata kaydı arama

`GET /api/admin/logs` mevcut `level`, `category`, `search`, `limit`, `offset`
parametrelerine ek olarak `request_id`, `event_code`, `component`, `from`, `to`
filtrelerini kabul eder. Tarihler RFC3339 olmalıdır. Sıralama
`created_at DESC, id DESC` şeklindedir. Serbest arama istek kimliği, bileşen ve
olay kodunu da kapsar. SQLite saatleri UTC olarak, PostgreSQL offset'leri ise
korunarak gösterilir.

## Düzeltilen uygulama akışları

- Önizleme önbelleği SQLite ve RFC3339 tarihlerini okur. Başarılı sonuç 24 saat,
  başarısız sonuç 1 dakika saklanır. Aynı URL aynı dış isteği paylaşır; en fazla
  dört dış istek çalışır. Bütün bekleyenler iptal olursa ortak iş iptal edilir
  ve istemci iptali negatif önbelleğe yazılmaz. SSRF kontrolleri korunur.
- Önizleme hata kodları: `PREVIEW_INVALID_URL`, `PREVIEW_BLOCKED`,
  `PREVIEW_CACHE_READ`, `PREVIEW_CACHE_WRITE`, `PREVIEW_TIMEOUT`,
  `PREVIEW_UPSTREAM`, `PREVIEW_CACHED_FAILURE`, `PREVIEW_BUSY`, `PREVIEW_STOPPING`.
- Presence bildirimleri adayların tercih/engel bilgilerini toplu okur. Asıl
  yazım güncel gizlilik kontrollerini transaction içinde tekrar uygular. Bildirim
  bütçesi presence güncellemesinden sonra başlar, 5 saniye ile sınırlıdır ve
  kapanışta iptal edilir. Başarı/atlama/hata sayıları tek hata özetine eklenir.
- Müzik zaman aşımı mevcut `MUSIC_*` kodu korunarak 504 olur. İstemci iptali
  generic 500 oluşturmaz. YouTube'un erişim veya ağ sorunlarının kalktığı ancak
  gerçek çalışma zamanı denemesiyle doğrulanabilir.
- İstemci log hız sınırının ortak bütçesine ek olarak yalnız ERROR için 5 kayıtlık
  rezerv vardır; rezerv her 5 saniyede bir token yeniler. INFO bu rezervi
  tüketemez. 10 dakika kullanılmayan kullanıcı bucket'ları temizlenir.

## Uygulama günlüğünde bağımlılık panic'leri

Eski kayıt temizliği ve her yazım girişimi mevcut `logx.Run` ile korunur. Hatalı
bakım işi sonlanır; yazıcı yeni olayları işlemeye devam eder. Başarısız yazım
girişimi bir kez `WriteFailures` sayacına eklenir. Tekil yazımda başarıyla dönen
kayıtların gruplanmış olayları `FailedEvents` sayacından çıkarılır; sonucu
doğrulanamayan kalan olaylar bu sayaca eklenir. Toplu yazım panic'inde bütün
girişimin sonucu belirsiz sayılır. Bu sayaç kesin veri kaybı ölçümü değildir.
Panic'ten önce depoya yazılmış olabilecek kayıtlar otomatik yeniden denenmez.

Panic tanısı yalnız bir kez `app_log.write` veya `app_log.purge` bileşeniyle
üretilir. Mevcut pipeline bu bileşenleri uygulama günlüğü sink'ine yönlendirmez;
depolama hatası aynı kuyruğa geri beslenmez. Dış log/Sentry akışı devam eder.

## Audit kuyruğu ve kapanış

Audit `Write` çağrısı kullanıcı veya audit deposuna erişmez; olayın kimlik ve
verilmiş snapshot değerlerini kopyalayıp sınırlı kuyruğa alır. Dolu kuyruk ve
kapanmış servis yeni olayı kabul etmez. Eksik kullanıcı snapshot'ları tek yazıcıda
ortak iki saniyelik bütçeyle tamamlanır. Çağıranın verdiği snapshot olay anındaki
değeri korur; verilmemişse kayıt anındaki kullanıcı bilgisi kullanılır. Okuma
başarısızsa kimlik korunur ve mevcut bilinmeyen kullanıcı gösterimi sürer.

İlk `Stop` çağrısı kabulü kapatır ve aktif işin context'ini iptal eder. Aktif
veritabanı işlemi iptalle başarısız olabilir; hata kaydı üretilir. Kuyrukta kalan
olaylar, ilk `Stop` anından başlayan toplam beş saniyelik taze context ile yazılır.
Sonraki `Stop` çağrıları süreyi uzatmaz. Süre dolunca kalan olaylar kuyruktan
çıkarılır ve sayıları tek uyarıda bildirilir; başarısız yazım ayrıca hata kaydı
üretir. Her `Stop`, aynı yazıcının çıkışını bekler; sahipsiz veritabanı goroutine'i
bırakılmaz. Süre sınırının işlemesi depoların context iptaline uymasına bağlıdır.
Her olay mevcut `logx.Run` ile ayrı korunur. Bağımlılık panic'i aynı olay için
bir hata kaydı üretir ve yazıcı sonraki olaya devam eder. Hatalı olay otomatik
yeniden denenmez; veritabanına yazımdan sonraki bir panic mükerrer satır üretmez.
Snapshot zamanlayıcısı panic sırasında da iptal edilir.
Bu kuyruk kalıcı teslim garantisi vermez.

## İstemci tercih mutasyonları

Zustand durumu eşzamanlı abonelerini çağırmadan önce kaydeder. Bir abone hata
verdiğinde `completePreferenceMutation`, güncel hesap/sunucu bağlamına ve hâlâ
sahip olunan alanlara ait önbellek ve gönderim kuyruğu adımlarını tamamlar.
Durum mutasyonu bir kez çalışır; abonenin asıl hatası çağırana iletilir.

Bildirim ve tamamlama birlikte hata verirse `AggregateError.errors` iki hatayı
korur; `cause` tamamlama sırasında yakalanan hataya bağlanır. Hesap/sunucu nesli
geçersizleşen işlem, yeni bağlamın önbelleğini veya kuyruğunu değiştiremez.
Sunucudan uygulama ve sıfırlama yolları önbelleği tamamlar; sunucuya geri yazmaz.

Doğrulanmış GET/PATCH sonucu, yükleme/kayıt bildirimi yayımlanmadan önce hesap
önbelleğine alınır; kabul edilmiş PATCH kuyruktan çıkarılır. Yazıcı tutamacı,
aboneler çalışmadan ayrılır. İç içe yeniden denemeler aynı yazıcıya katılır;
hesabı değişmiş bekleyen yazıcı yeni bağlamın durumunu tüketmeden durur.

Reddedilen GET/PATCH işlemleri, kendilerine ait tutamacı `finally` içinde
serbest bırakır. Eski hesap işleminin temizliği yeni hesabın işini değiştiremez.
Zamanlayıcı ve yeniden deneme düğmesi reddedilmeleri hesap kapsamıyla gözler;
tanı kaydı yalnız sabit olay kodunu taşır, tercih veya hata içeriğini taşımaz.

Kayıt, giriş, oturum geri yükleme, odaklanma/çevrimiçi olayları ve kullanıcının
`preferences_changed` olayı, sahipsiz tercih görevlerini `startPreferenceTask`
ile gözler. Görevin başladığı bağlam geçerliyse sabit kaynak etiketiyle tanı
üretilir. Tercih yükleme hatası başarılı kimlik doğrulamayı geri almaz.

Yerel depolama yazımı mevcut en iyi çaba davranışını sürdürür. Kota veya erişim
engeli durumunda bellek kuyruğu yetkilidir; kalıcı teslim garantisi verilmez.
Hata veren abonenin ardından atlanan diğer abonelerin bildirimi ve asenkron
fetch/save hata yolları ayrı yaşam döngüsü sınırlarıdır.

## Doğrulama

Go testleri logger başlatma sırasını, maskelemeyi, tek HTTP tanı kaydını, kuyruk
önceliğini, toplu yazımı, kapanış sınırını, önizleme iptallerini ve presence
gizlilik davranışını kapsar. Repo testleri varsayılan olarak SQLite kullanır;
aynı testler yalnız yerel bir `HICHAT_TEST_POSTGRES_DSN` ile PostgreSQL üzerinde
de çalıştırılabilir. Üretim veritabanı test hedefi olarak kullanılmaz.

Yerel test/derleme sonucu canlı kabul yerine geçmez. Dağıtım sonrasında readiness,
gerçek önizleme önbellek kullanımı, müzik zaman aşımı davranışı, DB bekleme süresi,
istek gecikmesi ve yönetici ekranındaki kayıtlar ayrıca kontrol edilmelidir.


Legacy preference import captures the binding and imported-marker key before observer publication. Recovery data is persisted before assignment; queued local-apply failures remain retryable. Joined account mismatch prevents backup assignment. The UI owns each import attempt by binding and identity, observes rejection, prevents duplicate active attempts and ignores retired or unmounted completion. Persistent failing error observers and broader acquisition/native cases remain open.

Hesap tercihleri bağlanırken sunum hazırlığı, bağlama bildirimi yayımlanmadan önce o nesle ayrılır. Bildirim hata fırlatsa da kaydedilmiş hesabın sunumu hazırlanır; bildirim yeni bir bağlama oluşturursa eski hazırlık bunu ezmez. Sıfırlama bildirimi sırasında yeni bir nesil oluştuğunda dıştaki eski bind çağrısı durur. Ayrık tercih işleri hemen çağrılan async sarmalayıcıyla senkron fabrika hatalarını ve Promise retlerini tek gözlemlenen ret yoluna dönüştürür; tanı bildirimi yalnız hâlâ geçerli nesle aittir.

Mesaj silme olayında okunmamış sayacı bildirimi veya mesaj store bildirimi hata fırlatsa da kalan aynı oturuma ait silme adımları çalıştırılır ve önbellek temizliği beklenir. Her adım öncesinde sahiplik yeniden doğrulanır. İlk bildirim hatası korunur; birden çok hata AggregateError ile nedenleriyle birlikte döner. Önbellek temizleme hatası için mevcut sabit, en iyi çaba uyarısı korunur. Kanal sayacı yalnız yüklenmiş karşı taraf mesajı için azaltılır; bildirim hatasından doğan yeniden teslim ikinci azaltma yapmaz. Kalıcı silme günlüğü ve sınırlı arama bekleme kuyruğu henüz eklenmedi.
