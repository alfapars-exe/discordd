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

## Doğrulama

Go testleri logger başlatma sırasını, maskelemeyi, tek HTTP tanı kaydını, kuyruk
önceliğini, toplu yazımı, kapanış sınırını, önizleme iptallerini ve presence
gizlilik davranışını kapsar. Repo testleri varsayılan olarak SQLite kullanır;
aynı testler yalnız yerel bir `HICHAT_TEST_POSTGRES_DSN` ile PostgreSQL üzerinde
de çalıştırılabilir. Üretim veritabanı test hedefi olarak kullanılmaz.

Yerel test/derleme sonucu canlı kabul yerine geçmez. Dağıtım sonrasında readiness,
gerçek önizleme önbellek kullanımı, müzik zaman aşımı davranışı, DB bekleme süresi,
istek gecikmesi ve yönetici ekranındaki kayıtlar ayrıca kontrol edilmelidir.
