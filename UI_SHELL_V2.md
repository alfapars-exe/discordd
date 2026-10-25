# HiChat UI Shell V2 — geçiş ve doğrulama notları

Tarih: 22 Ekim 2026. Bu belge uygulanan ön yüz değişikliklerini, geri dönüş yolunu ve henüz tamamlanmayan kabul kontrollerini ayırır. **Production’a yayın veya tüm kabul senaryolarının başarıyla tamamlandığı anlamına gelmez.** `docs/` özel/ignore edildiği için belge depo kökünde tutulur.

23 Ekim 2026 güncellemesi: Bu belge önceki **yalnız arayüz** diliminin tarihsel kaydıdır. Kullanıcının kabul ettiği P0–P11 uygulama planı geçerli kapsamdır; madde bazlı kaynak ve durum kaydı [implementation/coverage.json](implementation/coverage.json) içindedir. Aşağıdaki eski “bu sürüm eklemez” sınırlamaları yeni plandan özellik çıkarmak için kullanılamaz. Grup DM, kalıcı alt başlıklar, TOTP, oturumlar, etkinlikler, oyun/overlay ve tam müzik oynatıcı yeni kapsamda yer alır. Web ve Windows hedeflenir; ana sohbet alanı tek kalır.

## 1. Kapsam ve sınırlar

- Discord referanslarına yakın sunucu şeridi, bağlama özel DM/kanal listesi, tek içerik alanı, kalıcı ses bölümü ve gruplandırılmış ayarlar. HiChat adı, ikon sistemi ve mevcut işlevler korunur.
- V2 etkin olduğunda sohbet sekmeleri ve bölünmüş paneller kullanıcı arayüzünde bulunmaz. Eski düzen yalnızca derleme bayrağıyla kullanılabilen teknik geri dönüş yoludur; kullanıcıya gelişmiş panel seçeneği sunulmaz.
- Var olan mesajlaşma, ses, kamera, ekran paylaşımı, ses panosu, arama, bildirim, profil ve yönetim bileşenleri yeniden kullanılır. Ekran paylaşımında tarayıcı kendi izin/kaynak seçicisini, Electron mevcut ekran/pencere seçicisini kullanır.
- Bu sürüm grup DM, gerçek thread, MFA, yeni oturum yönetimi, QR ile giriş, yeni etkinlik/oyun altyapısı veya desteklenmeyen bir aygıt kataloğu eklemez. Referans ekranındaki bir özellik için çalışmayan düğme eklenmez.
- **Yeni arayüz için ücretli paket, abonelik veya ödeme duvarı eklenmez.** Ücretsiz kullanım; rol izinlerini, üyelik sınırlarını, platform yöneticisi kontrolünü, cihaz/tarayıcı yeteneklerini veya mevcut sunucu limitlerini atlamak anlamına gelmez.
- Önceki yalnız arayüz dilimi sunucu API sözleşmesi, veritabanı şeması ve şifreleme protokolünü değiştirmiyordu. Yeni P0–P11 planı bu katmanları eklemeli ve doğrulanmış adımlarla genişletecektir. Yerel uygulama/test çalışması production verisini taşımaz veya silmez.

## 2. Teknik davranış ve ayarlara erişim

- `Destination`/`navigate` tek gezinme hedefini yönetir; eski `openTab` çağrıları V2’de merkezi gezinmeye uyarlanır. `/channels/*` korunur, tarayıcı geri/ileri hedefe bağlanır. Sunucu başlangıcı rastgele kanalı okundu işaretleyerek açmaz.
- Taslaklar hesap + konuşma türü + sunucu/konuşma kimliğiyle bellek içinde ayrılır: metin, dosya, yanıt, mention ve emoji bilgileri. Gönderim bileti/sürümü yalnızca kendi taslağını tamamlar; eski gönderim yeni yazılan metni veya başka konuşmayı temizlemez. Oturum temizliği geç kalan tamamlamaları geçersiz kılar. Bellek içi taslaklar sayfa yenilemesinden sonra kurtarma garantisi vermez.
- Görüşme ve ses çıkışı sahipleri içerik görünümünün üzerinde kalır. “Aramaya dön” yalnızca gezinir; tekrar katılma veya bağlantıyı kesme işlemi yapmaz. P2P aramasında P2P’nin gerçek kontrolleri kullanılır; LiveKit aygıt tercihleri P2P’ye uygulanıyormuş gibi gösterilmez.
- Ses panosu başka sunucudayken açılırsa önce bağlı olunan ses sunucusuna dönülür; eski sunucu temizliği bittikten sonra, hâlâ aynı görüşmedeyse açılır. Eski sunucunun geç liste yanıtı yeni listeyi değiştiremez.
- Ayar penceresi odağı sınırlar ve açan öğe hâlâ mevcutsa kapanışta geri verir. İç içe diyalog/emoji seçici Escape işlemi dış ayar penceresini birlikte kapatmamalıdır. Yetki veya ayarın sunucu bağlamı kaybolduğunda eski yönetim içeriği kaldırılır.

Ayarlarda tanımlanan **28 hedefin tamamı** hem gezinme tanımında hem içerik göstericisinde bulunur; bu statik kapsam kontrolü her işlemin canlı test edildiği anlamına gelmez.

| Bağlam / giriş | Hedefler | Erişim |
|---|---|---|
| Hesap / kullanıcı bölümü dişli düğmesi | Profil, güvenlik, şifreleme, engellenenler, kozmetikler, görünüm, erişilebilirlik, ses, giriş sesleri, geri bildirim, tanılama, genel uygulama | Normal kullanıcı. Genel uygulama yalnızca Electron’da. Yönetici hesabındaki geri bildirim mevcut yönetici gelen kutusunu açmaya devam eder. |
| Sunucu / seçili sunucu başlık menüsü | Genel sunucu, kanallar, roller, üyeler, davetler, emojiler, çıkartmalar, sunucu giriş sesleri | Mevcut izin kontrolüne göre. Yalnızca giriş seslerine yetkili kullanıcı doğrudan o bölüme girer; normal üyeye yönetim girişi gösterilmez. |
| Platform / ana sayfadaki Yönetici → Kayıtlı Kullanıcılar | LiveKit örnekleri, kota, sunucular, kullanıcılar, raporlar, günlükler, geri bildirim, bağlantılar | Yalnızca `is_platform_admin`. Bağlantılar yalnızca Electron’da. |

Arama, önce izin ve bağlam filtresi uygulanmış hedefler üzerinde çalışır; gizli yönetim veya masaüstüne özel hedefleri görünür yapmaz. Sunucu ayarlarının mevcut grup düzeyindeki menü izinleri korunur; gerçek yönetim işlemleri kendi bileşen ve sunucu yetkilendirmelerinden geçmeye devam eder.

## 3. Açma, önizleme ve geri dönüş

`VITE_UI_SHELL_V2` **derleme zamanı** ayarıdır. Ayar verilmediğinde veya `true` olduğunda tek-hedefli V2 arayüzü kullanılır; yalnızca açıkça `false` verilmesi eski düzeni geri dönüş amacıyla açar. Production çalışma zamanı ortam değişkenini değiştirmek, önceden derlenmiş JavaScript’i değiştirmez.

Yerel geliştirme — depo kökünden PowerShell:

```powershell
Set-Location client
$env:VITE_UI_SHELL_V2 = "true"
npm run dev
```

Derlenmiş önizleme — `client/` içinde:

```powershell
$env:VITE_UI_SHELL_V2 = "true"
npm run build
npm run preview
```

Bayrağı değiştirirken çalışan geliştirme sunucusunu yeniden başlatın. Önizlemede bayrağı yalnızca `npm run preview` öncesinde değiştirmek yeterli değildir; yeniden derleyin. Örnek konfigürasyon `client/.env.example` içindedir. Mevcut yerel `.env` dosyalarının diğer değerlerini koruyun; gerçek sırları sürüm kontrolüne eklemeyin.

Docker — depo kökünden, yalnızca **yerel imaj derleme** örnekleri:

```powershell
docker build --build-arg VITE_UI_SHELL_V2=true -t hichat:ui-shell-v2 .
docker build --build-arg VITE_UI_SHELL_V2=false -t hichat:ui-shell-classic .
```

Dockerfile ön yüz aşaması bu build arg’ı Vite’a iletir; varsayılan `true` değeridir. Klasik düzene geri dönmek için build sırasında `false` verin. Barındırma/CI sistemi de değeri ön yüzün derlendiği aşamaya iletmelidir. Container’ın yalnızca çalıştırma ortamına eklemek yeterli olmaz. Bu komutlar yayın, push veya canlı ortama geçiş yapmaz.

Yayın öncesinde aşağıdaki kabul matrisi tamamlanır ve mevcut yayın süreciyle ayrıca production geçişi yapılır. Geri dönüşte son bilinen sağlam artefakt yeniden dağıtılabilir veya `false` ile ön yüz/imaj yeniden derlenip dağıtılır. Şema göçü olmadığı için veritabanı geri alma adımı gerekmez. Bağlantı, taslak veya izin gerilemesi varsa kabul edilmiş sayılmaz; yeni sürüm dağıtımı durdurulur.

## 4. Kanıt ve kabul matrisi

“Kod/test” statik incelemeyi veya yerel otomatik testleri ifade eder; canlı çok kullanıcılı, gerçek cihazlı veya production doğrulamasının yerine geçmez.

| Alan | Mevcut kanıt | Canlı / kalan kabul |
|---|---|---|
| Tek hedef, sunucu/DM ayrımı, geçmiş | Merkezi gezinme ve responsive shell kodu; ilgili regresyon testleri | Son entegrasyon ve tarayıcı sonuçları aşağıdaki kayıt alanına eklenecek. |
| Taslak, dosya, yanıt, gönderim yarışı | Bellek içi anahtarlı store, sürümlü gönderim ve oturum temizliği; ilgili regresyon testleri | Gerçek hesaplar arası teslim, başarısız yükleme ve çevrimdışı tekrar deneme henüz bu belgeyle doğrulanmış sayılmaz. |
| Ayar erişimi ve odak | 28 hedef statik olarak kapsanıyor; kapsam, yetki kaybı, sunucu değişimi, Tab ve iç içe Escape testleri | Gerçek normal kullanıcı/moderatör/yönetici, yüzde 200 yakınlaştırma ve tüm iç içe seçiciler kontrol edilecek. |
| Ses ve P2P bölümü | Doğru bağlı sunucuya dönüş ve yeniden bağlantı yapmama kontrolleri; cihaz tercihleri testleri | Gerçek ses, kamera, ekran paylaşımı, yeniden bağlanma ve pencere boyutu değişiminde bağlantı sürekliliği henüz canlı doğrulanmadı. |
| Ses panosu | Dönüşten sonra açma, reddedilen dönüş ve eski sunucu yanıtı regresyonları | Canlı oynatma/yükleme ve çok kullanıcılı ses dağıtımı ayrıca doğrulanacak. |
| Görsel düzen | Referans ekranlar ve CSS; hedef genişlikler 390, 768, 1024, 1440, 2560 px | Her genişlikte ana sayfa, DM, kanal, ses, ayarlar ve giriş; mobil klavye ve yatay taşma sonuçları bekleniyor. |
| Mesaj araçları ve yönetim | Mevcut işlevler yeniden kullanılıyor; API/şema değişikliği yok | Düzenleme/silme/yanıt/tepki/ek/sabitleme/kaydetme/arama ve yetki kaldırma akışlarının tamamı canlı denenmiş olarak işaretlenmiyor. |

Doğrulama durumu — önceki boş şablonlar yerine açık takip kaydı:

- Otomatik test, derleme ve lint sonuçları: en güncel uygulama diliminin kanıtı `implementation/verification/` altında tutulur; geçmiş sonuçlar yeni özelliklerin kabulü yerine geçmez.
- Tüm 33 referansın beş genişlik ve %200 yakınlaştırma karşılaştırması: açık; `p0.visual-acceptance` kaydı.
- Gerçek Windows/web cihazları ve iki bağımsız istemciyle ses, kamera, paylaşım ve şifreli müzik: açık; `p0.real-device-gate` kaydı.
- Windows kurulumu, Docker, temiz ortam ve geri dönüş: açık; `p0.release-checks` ve `p0.deployment-boundary` kayıtları.
- Production yayın: **Yapılmadı; bu değişiklik için ayrı yayın adımı gerekir.**

Bu alanlar beklemedeyken “tüm kabul koşulları tamamlandı” denmemelidir.

## 5. İnceleme yöntemi ve REA sınırı

`reverse-engineer-anything` yönergeleri; hedefi sınırlandırma, hipotezi gözlemden ayırma, mevcut kaynak kodu ile runtime kanıtını karıştırmama ve doğrulanmamış kapsamı açıkça yazma amacıyla kullanıldı. Discord referansları, kullanıcı ekran görüntüleri, Ego Lite gözlemleri ve HiChat’in yerel kaynakları karşılaştırıldı.

REA’nın doğrudan tarayıcı/runtime bağlantısı mevcut incelemede sağlanamadı; bu değişikliğe **REA runtime yakalama kanıtı dahil değildir**. Kaynak incelemesi veya Ego Lite çıktıları REA runtime çıktısı olarak sunulmaz. Discord’un tüm özelliklerinin, bütün izin kombinasyonlarının veya HiChat’in bütün canlı işlevlerinin eksiksiz incelendiği iddia edilmez. Gözlenen tasarım örüntüleri kullanılır; gizli API, hesap sırrı veya doğrulanmamış özellik taklit edilmez.
