# HiChat ses işleme — uygulama ve doğrulama

23 Ekim 2026. Yerel çalışma ağacında uygulandı; yayımlama yapılmadı.

## Uygulanan davranış

- LiveKit, özel aramalar ve mikrofon testi aynı `createMicrophonePipeline` fabrikasını kullanıyor. Görüşme sırasında test mevcut işlenmiş çıkışı dinliyor.
- Sıra: kaynak mikrofon → seçilen motor → enerji kapısı → mikrofon kazancı → çıkış. Konuşma hattı 48 kHz mono; müzik profilinde model, kapı ve konuşma işlemleri kapalı.
- RNNoise varsayılan; DFN3 güçlü seçenek. GTCRN, DTLN, Speex, WebRTC ve model kapalı seçenekleri korunuyor. GTCRN/DTLN için 16 kHz sınırı açıklanıyor.
- DFN bağlayıcı, WASM ve model dosyaları eşleşen sürümden, yerel SHA-256 özetleriyle sabitlendi. DFN ve DTLN çıkarımı ayrı Worker'da, ses giriş/çıkışı AudioWorklet'te çalışıyor.
- Hazırlık ve çalışma hatalarında ücretsiz yedek uygulanıyor; kullanıcı tercihi değiştirilmeden fiilen çalışan motor gösteriliyor. WebRTC yalnızca kaynak track ayarı doğrulandığında etkin gösteriliyor.
- Tarayıcı gürültü azaltması kapatılamıyorsa ikinci model bağlanmıyor. AudioWorklet'siz ham track yedeğinde kullanılamayan kazanç arayüzde devre dışı gösteriliyor; kayıtlı değer korunuyor.
- Motor hazırlığı, cihaz/profil değişimi ve yayımlama sıralanıyor; eski istekler iptal ediliyor. Susturma, sunucu susturması ve bas-konuş korunuyor.
- Hassasiyet 100 kapıyı kapatıyor. Orta/50 için −52/−58 dBFS, 300 ms bekleme; 10 ms ön tampon, 5 ms açılma, 80 ms kapanma. RMS/dBFS ve kapı durumu arayüzde.
- Krisp arayüzden kaldırıldı; kod ve paket korundu. Eski seçimler yerel ve hesap tercihlerinde RNNoise'a taşınıyor. GTCRN sunucu doğrulamasına eklendi.

Uygulama ayrıntıları: [ses hattı README](../../client/src/audio/README.md).

## Otomatik doğrulama

| Kontrol | Sonuç | Kanıt |
| --- | --- | --- |
| Tüm istemci testleri | 180 dosya, 1.874 test geçti; 0 başarısız | [Vitest JSON](vitest-results.json) |
| Gerçek dağıtılan WASM/model ve enerji kapısı | 15 test geçti | `node --experimental-vm-modules --test scripts/audio-engines.verify.mjs scripts/audio-gate.test.mjs` |
| TypeScript | `tsc -b` geçti | İstemci tip denetimi |
| Üretim derlemesi | `vite build` geçti | Mevcut chunk boyutu/dinamik import/Vite yapılandırma uyarıları sürüyor |
| İlgili ESLint ve diff denetimi | Geçti | Değiştirilen ses, ayar, arama ve test dosyaları |
| Sunucu tercih doğrulaması | `models` ve `services` geçti | `go test ./models ./services -run 'Preferences\|VoicePreferences' -count=1` |

Regresyonlar motor/cihaz değişimlerini, geç hazırlık sonuçlarını, izin reddini,
mikrofon testini başlatırken durdurmayı, kaynak sahipliğini, LiveKit SDK
yeniden başlatmasını, kapı histerezisini, hassasiyet 100 geçişlerini ve gerçek
WASM bozulmasını kapsıyor. Sessiz ses hata sayılmıyor; ana iş parçacığı
duraksamasıyla geciken kalp atışları yanlış motor/kapı hatası oluşturmuyor.

DFN için 100 ısınma karesinden sonra ek 1.000 karede WASM doğrusal belleği
31.129.600 baytta sabit kaldı. Bu sınırlı örnekleme, saatler süren oturumlarda
bellek sızıntısı olmayacağının kanıtı değildir.

## Gerçek tarayıcı ve aktarım

Kullanıcının yetkilendirdiği izole Chrome oturumunda gerçek WASM/model
dosyaları, AudioWorklet, Worker ve yerel LiveKit sunucusu kullanıldı.
İki LiveKit katılımcısı ve iki doğrudan RTCPeerConnection arasında alıcı
sesi ölçüldü ve Opus/WebM olarak kaydedildi.

- Altı ücretsiz seçenek için LiveKit ve P2P aktarımı geçti. Beş yazılım
  motorunda seçilen motorun gerçekten hazır olması şart; yedek motor başarı
  sayılmıyor. WebRTC için bu, aktarım ve ayar sözleşmesi kontrolüdür.
- Türkçe temiz/fan/klavye/ani gürültü örnekleri, RNNoise/DFN3/GTCRN/DTLN/Speex
  üzerinden geçti: 20 koşu, 40 alıcı kaydı; hepsi başarılı.
- Bu 40 kayıt kontrollü karşılaştırma için LiveKit DTX/RED kapalıyken alındı;
  üretimdeki konuşma profilinin kodlama ayarlarıyla aynı değildir. Üretim
  profili DTX/RED açık ve `forceStereo: false` kullanır; ayrı altı seçenekli
  aktarım kontrolünün tamamı bu gerçek profil üzerinden de geçti
  ([üretim profili kanıtı](chrome-transport-report.json)).
- Kaynak 44,1 kHz AudioContext'e çözümlenerek verildi; ortak işleme hattı
  48 kHz çıkış sağladı. Göndericinin işlenmiş track'i kullandığı doğrulandı.
- Kapalı modelle gerçek kapı testi: hassasiyet 50'de eşik altı giriş sessiz;
  100'de geçiyor; tekrar 50'de kapanıyor. Kazanç %100→%200 olduğunda çıkış
  gücü dört katına çıktı ve kapının giriş seviyesi değişmedi.
- DFN3 için 20 oluşturma/işleme/kapatma döngüsü ve ayrıca 180 saniyelik
  kesintisiz kontrol geçti. İkincisinde 2.930 ölçümün tamamı sonlu ve sıfırdan
  farklıydı; hata alınmadı. Bu sayı PCM örnek sayısı değil, periyodik ölçüm sayısıdır.
- Ana tarayıcı koşusu 28, Türkçe kayıt matrisi 16 Worker oluşturdu;
  kapanışta her ikisinde de etkin Worker ve açık AudioContext sayısı sıfırdı.
- [Beş hata/yedek senaryosu](chrome-fallback-report.json) gerçek tarayıcı
  ses grafiğinde geçti: bozuk DFN dosyası, kullanılamayan AudioWorklet,
  doğrulanamayan WebRTC, yeni model öncesi ve mevcut model güncellemesinde
  kapatılamayan tarayıcı filtresi. Aygıt/yetenek durumları testte taklit
  edildi; yedek çıkışların gerçek PCM ürettiği kontrol edildi.

Kanıtlar: [tarayıcı raporu](chrome-audio-report.json),
[20 koşuluk kayıt matrisi](chrome-fixtures-report.json),
[gerçek kapı kontrolü](chrome-gate-report.json).

[Alıcı dosyalarının bağımsız denetiminde](receiver-audit.md) 40/40 kayıt
çözüldü; sonlu, boş olmayan PCM üretildi ve tam ölçek örneği bulunmadı.
Hizalaması yeterli 28 kayıtta sessizlik taraması yapılabildi; 12 kayıt için
bu kontrol belirsiz bırakıldı. DFN3/ani gürültü/LiveKit kaydının konuşma
başlangıcında 20 ms'lik tam sessizlik adayı var. Kayıt/model/zaman hizalaması
farklarından ayrılmadığı için doğrulanmış ağ kesintisi veya kusursuz ses
aktarımı sonucu çıkarılmıyor. Ayrıntılı sayaçlar ve konumlar raporda.

Bu aday için [eşzamanlı yerel/alıcı kaydıyla ek inceleme](dfn-transient-paired-audit.md)
yapıldı. İlk konuşma dalgası alıcıda bulundu: başlangıca özel yaklaşık 87 ms
hizalamada korelasyon 0,946 ve tam sessiz başlangıç karesi sıfır. İlerleyen
konuşmanın ofseti yaklaşık 52 ms; bütün kayda tek ofset uygulamak bu yeni
kayıtta yapay sessizlik adayı oluşturuyor. Önceki 20 ms bulgu kesin kesinti
olarak doğrulanmadı; özgün 40 kayıt ve bulgu korundu. Bu tek tekrar, eski
kaydın kesin nedenini veya bütün kayıtlarda kesinti olmadığını kanıtlamaz.
Üretim kodunda bu belirsiz aday nedeniyle değişiklik yapılmadı.

Ego ortamındaki minimal AudioWorklet takılması, kullanıcı yeniden
başlatmalarından sonra da sürdü. İzole Chrome'da minimal test ve bütün
motorlar çalıştı. İlk alıcı sessizliği test düzeneğinin uzak HTMLAudioElement
oynatımını başlatmamasından kaynaklandı; gerçek görüşmedeki oynatım adımı
eklendiğinde aktarım başarılı oldu. Bu eski tanı denemeleri, son başarılı
kayıtların kalite ölçümü olarak kullanılmamalıdır.

## Ses karşılaştırması

[Dinleme sayfası](listening.html), aynı dört girdiyi ve beş motorun 20
model çıktısını ve 40 alıcı kaydını sunuyor. Fan, klavye ve ani gürültü sentetik; Türkçe konuşma FLEURS
kaynağından ve lisansı/kayıt özetleri raporda.

- [Gürültü azalması, kare işlem süresi ve dalga biçimi gecikmesi](report.md)
- [STOI / ESTOI ve bütün olumlu/olumsuz değişimler](intelligibility.md)

DFN karşılaştırması uygulama varsayılanını kullanıyor: arayüzde %70 → 10 dB
bastırma sınırı. Bu örnekte fan/klavye için birçok anlaşılabilirlik puanı
iyileşiyor; temiz ve ani gürültülü örnekte bütün motorların puanında küçük
düşüşler var. Sonuçlardan evrensel motor sıralaması çıkarılmamalı.

## Kapsam sınırları

Kayıt 16 kHz kaynaklı, tek konuşmacılı ve tek cümleli. 8 kHz üzerindeki
sesin korunmasını veya farklı konuşmacı/ortamlardaki kaliteyi kanıtlamaz.
STOI/ESTOI insan dinleme testi, kelime doğruluğu yüzdesi veya genel ses
kalitesi puanı değildir. Model raporundaki gecikme ağ/aygıt gecikmesi değildir.

Tarayıcı aktarım testleri sentetik/yerel dosya kaynağı kullanır; mikrofon
izni istemez. Üretilmiş track fiziksel aygıt kısıtlarını desteklemediği için
yakalama ayarları testte taklit edilir ve kaydedilir. Bu test WebRTC'nin
gürültü azaltma kalitesini veya AEC/AGC'nin gerçek mikrofon davranışını
doğrulamaz. Gerçek mobil aygıt, farklı tarayıcılar, akustik yankı, uzun
görüşmeler ve insan dinlemesiyle kalite kabulü henüz yapılmadı.
Aktarım yerel ağ ve aynı tarayıcı sürecinde sınandı. Paket kaybı, gerçek
internet koşulları ve fiziksel cihazlar arası görüşme bu kabulün kapsamında
değildir; yeniden bağlanma/SDK yeniden başlatma davranışları regresyon
testleriyle kontrol edildi.
