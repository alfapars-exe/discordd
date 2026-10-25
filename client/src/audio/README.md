# Mikrofon işleme hattı

HiChat mikrofon sesini kullanıcının cihazında işler. Ortak fabrika
`client/src/audio/microphonePipeline.ts` içindedir. LiveKit işlemcisi,
P2P arama oturumu ve bağımsız mikrofon testi bu fabrikayı kullanır.
Görüşme sırasında mikrofon testi kayıtlı görüşme hattının işlenmiş track'ini
dinler; aynı sesi tekrar temizlemez.

Eski `RNNoiseProcessor`, `DtlnProcessor`, `SpeexProcessor` ve
`VadGateProcessor` dosyaları bu akışlardan çağrılmaz. Yeni entegrasyonlar
`createMicrophonePipeline` kullanmalıdır; eski DTLN sınıfındaki
ScriptProcessor yolu yeni canlı işleme hattının parçası değildir.

```text
Kaynak mikrofon track'i
  → 48 kHz AudioContext / seçili motor
  → enerji kapısı
  → mikrofon kazancı
  → işlenmiş MediaStreamTrack
  → LiveKit / P2P / mikrofon testi
```

Konuşma çıkışı mono 48 kHz'dir. Web Audio, farklı örnekleme hızındaki
kaynağı bu bağlama dönüştürür. GTCRN ve DTLN model içinde 16 kHz kullanır;
48 kHz çıkışa dönmek kaybolan 8 kHz üzeri içeriği geri getirmez.
Müzik profili stereo kullanır; model, kapı, AEC, AGC ve tarayıcı gürültü
azaltması kapalıdır. Mikrofon kazancı müzikte de kullanılabilir.

## Motorlar ve dosyalar

- **Standart / RNNoise:** varsayılan, 48 kHz.
- **Güçlü / DeepFilterNet3:** 48 kHz; v1.2.1 bağlayıcı ve aynı sürümün
  yükleyicisindeki resmî v2 dosyalarıyla özetleri eşleşen WASM/model paketi.
  Model ayrı Worker'da çalışır; AudioWorklet yalnızca sınırlı PCM kuyruğunu
  taşır. Worker sonlandırıldığında özel WASM belleği de bırakılır.
- **GTCRN:** model 16 kHz; arayüzde bant genişliği sınırı açıklanır.
- **DTLN:** model 16 kHz; AudioWorklet giriş/çıkışı, ayrı klasik Worker içinde
  WASM çıkarımı. Ana iş parçacığında ScriptProcessorNode kullanılmaz.
- **Speex:** 48 kHz, 10 ms kareler.
- **WebRTC:** tarayıcının kaynak track üzerindeki gürültü azaltması.
- **Kapalı:** model kullanılmaz; hassasiyet 100 değilse enerji kapısı çalışır.

Krisp arayüzden gizlidir. Kod, paket ve eski değerlerin okunması korunur;
eski Krisp tercihleri yerel kayıt ve hesap senkronizasyonunda RNNoise'a
dönüştürülür. Diğer tercihler korunur.

Varlık sürümleri, özetleri ve lisanslar:

- `client/public/audio-engines/v1/manifest.json`
- `client/public/audio-engines/v1/README.md`
- `client/public/audio-engines/v1/licenses/`
- `client/public/dtln/asset-manifest.json`
- `client/public/dtln/THIRD_PARTY_LICENSES.txt`

DFN modelinin dağıtım adı `deepfilter-model.bin` dosyasıdır; içeriği modelin
orijinal sıkıştırılmış arşividir. Bazı sunucular `.tar.gz` için
`Content-Encoding: gzip` gönderdiğinden fetch arşivi otomatik açar ve model
yükleyicisine yanlış baytlar ulaşır. Nötr uzantı ve SHA-256 doğrulaması bu
belirsizliği giderir. Eski arşiv uyumluluk için korunur.

## Geçiş ve kaynak sahipliği

Yeni motor hazırlanırken eski hat korunur. Her değişiklik bir nesil numarası
ve iptal sinyali taşır; yalnızca son istek bağlanır. Eski hazırlıkların
sonradan tamamlanması motoru, tarayıcı filtresini veya susturma durumunu
geri alamaz. Aygıt/profil değişiminde yeni kaynak hazırlanır; yayın
seçenekleri için LiveKit track'i gerçekten yeniden yayımlanır.

Özel motorlarda tarayıcı `noiseSuppression` kapalıdır; WebRTC seçiminde
açıktır. AEC ve AGC konuşma profillerinde korunur. Yakalama ayarları işlenmiş
çıkışa değil kaynak track'e uygulanır. LiveKit init/restart kilidi içinde
SDK'nin aynı kilidi isteyen `applyConstraints` çağrısı beklenmez; SDK'nin
yeniden başlatma ayarları kilit dışından güncellenir.

WebRTC ancak kaynak track'in `getSettings().noiseSuppression` değeri `true`
olduğunda etkin gösterilir. Tarayıcı isteği yok sayarsa tercih korunur;
etkin motor kapalı, durum yedek ve açıklama görünür olur. Kullanılabilir
enerji kapısı ve kazanç bu durumda çalışmayı sürdürür.

Özel motor için kapatma isteğine rağmen tarayıcı gürültü azaltması açık
kalırsa ikinci model bağlanmaz; doğrulanan WebRTC yoluna geçilir ve nedeni
gösterilir. Mevcut motora ayar güncellenirken de bu kontrol yapılır.
AudioWorklet kurulamadığı için ham track kopyasına dönülen durumda yazılım
kazancı da kullanılamaz; giriş ses kaydırıcısı açıklamayla devre dışı olur,
kullanıcının kaydedilmiş değeri korunur.

Kaynak track'in sahibi fabrika çağırıcısıdır. Fabrika kendi çıkışını,
bağlamını, worklet'lerini ve motorunu kapatır; kaynak mikrofonu durdurmaz.
Çağırıcı, iptal edilen geç yakalama sonuçlarını da durdurur. Mikrofon testi
görüşme track'ini ödünç aldığında bu track'i durdurmaz.

Kullanıcının motor tercihi ile gerçekten çalışan motor ayrı tutulur.
Model hazır mesajı ve gerçek başlangıç çıkarımı olmadan etkin gösterilmez.
Hatalarda ücretsiz yedek sırası RNNoise → WebRTC'dir. Tercih değiştirilmez;
yedek motor arayüzde gösterilir. AudioWorklet kullanılamıyorsa kapı
desteklenmiyor olarak gösterilir. Susturma, sunucu susturması ve bas-konuş
çıkışı geçişlerden önce kapatır; asenkron işlemler bu kararı tersine çeviremez.

AudioContext/AudioWorklet başlatma adımları zaman aşımı ve iptal ile
sınırlıdır; takılan bir tarayıcı modülü mikrofonu sonsuza kadar bekletmez.
Motor kalp atışları ses genliğinden bağımsızdır. Kapı işlemcisi çöker veya
çalışmayı durdurursa kapı devre dışı olarak gösterilir; temizleme motoru ve
kazanç üzerinden ses aktarımı sürer. Bu yedekte kapı etkinmiş gibi görünmez.

## Manuel enerji kapısı

Hassasiyet 100 kapıyı tamamen devre dışı bırakır. Orta profil ve hassasiyet
50 için açılma −52 dBFS, kapanma −58 dBFS, bekleme 300 ms'dir. Kapı 10 ms
enerji penceresi ve ön tampon, 5 ms açılma ve 80 ms kapanma kullanır.
Kazanç kapıdan sonra uygulanır; ses seviyesi kaydırıcısı kapı eşiğini
değiştirmez. Zamanlama örnek sayısıyla hesaplanır; render blok boyutuna
bağlı değildir. Ölçerler RMS/dBFS gösterir.

Kapı konuşmacı tanımaz. Yüksek klavye sesi veya başka bir konuşmacı kapıyı
açabilir. Model gücü ile kapı ön ayarı ayrı kontrollerdir; otomatik ortam
kalibrasyonu uygulanmaz.

## Doğrulama komutları

`client` dizininde:

```sh
npm run test:audio
npm run test:audio:gate
npm run test:audio:wasm
npm run build
```

`test:audio:wasm` gerçek dağıtılan WASM/model dosyalarını Node VM içinde
çalıştırır; tarayıcı, ses aygıtı veya ağ aktarımı kanıtı değildir. Bozuk dosya,
başlatma, iptal, yedek, motor/cihaz geçişleri ve kapı davranışı ayrı
regresyonlarla doğrulanır.

Tarayıcı aktarım probu `client/src/audio/engines/transportBrowserProbe.mjs`
içindedir. Yalnızca loopback LiveKit geliştirme sunucusunu kabul eder;
iki katılımcı ve iki doğrudan P2P eş arasında işlenmiş track'in gerçekten
gönderildiğini ve karşı uç PCM'ini kontrol eder. Gerçek mikrofon açmaz.
Seçilen motor yerine yedek çalışırsa testi başarısız sayar. Karşı uç kayıtları
`recordingBase64(id)` ile dışa aktarılabilir.

Türkçe karşılaştırma örneğinin kaynağı ve CC-BY-4.0 atfı
`client/public/audio-test-fixtures/provenance.json` içindedir. Örnek 16 kHz
kaynaklıdır; tam bant ses korumasını veya fiziksel mikrofon/AEC kalitesini
kanıtlamaz. Sentetik fan, tuş ve ani gürültü karışımları tekrar üretilebilir
karşılaştırma içindir. Kullanıcı konuşmaları kaydedilmez.

Gerçek cihaz, mobil platform, uzun görüşme ve insan dinlemesiyle
doğrulanmayan kalite iddiaları bu testlerden çıkarılmamalıdır.
