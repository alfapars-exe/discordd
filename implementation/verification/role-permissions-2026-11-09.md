# HiChat rol ve kanal yetkileri — 9 Kasım 2026

Temel commit `b661581d`. Denetim yerel ve izole PostgreSQL üzerinde yapıldı. Canary veya üretim dağıtımı yapılmadı.

## Yetki matrisi

24 isim ve bit değeri iki kaynakta tek tek karşılaştırıldı. Kanal düzeyinde değiştirilebilen 10 bitin listesi de eşleşti. Her satır için HTTP yetki ara katmanında yalnız ilgili bite sahip üye 204, boş role sahip üye 403 aldı. Bu 48 kontrol ortak karar mekanizmasını sınar. Rol düzenleyicisinde 24 anahtarın her biri açılıp kapatıldı ve kaydetme işlemine doğru bit maskesinin iletildiği doğrulandı. Eksik TimeoutMembers ve ManageNicknames seçenekleri Türkçe ve İngilizce etiketleriyle eklendi. Tabloda ayrıca işlem düzeyinde incelenen kod ve yapılan ek kontroller yer alır. Her ürün işlemi iki tarayıcı hesabında ayrı ayrı yürütülmedi.

| Yetki ve bit | Kanal istisnası | İşlem | İstemci | Sunucudaki denetim | Gözlem |
|---|---|---|---|---|---|
| `ManageChannels` · 1 | Yok | Kanal oluşturma, düzenleme ve silme | ChannelTree | init_routes_server.go → Channel | İki hesaplı testte ses kanalı oluşturuldu. |
| `ManageRoles` · 2 | Yok | Rol oluşturma ve atama | MembersSettings | roleService ve memberService.ModifyRoles | İkinci rol atandı ve geri alındı. Alt sıradaki Admin rolünün yetkisiz devri reddedildi. |
| `KickMembers` · 4 | Yok | Üye çıkarma | MemberCard | Member.Kick ve memberService | Rol hiyerarşisi ve hedefin izin önbelleğinin iptali. |
| `BanMembers` · 8 | Yok | Üye yasaklama ve yasağı kaldırma | MemberCard | Member.Ban ve Unban | Süreli ve kalıcı yasak servis testleri. |
| `ManageMessages` · 16 | Var | Başkalarının mesajlarını silme ve sabitleme | ChannelChatProvider ve PinnedMessages | messageService.Delete ve pinService | Kanalda okuma ve yönetme gerekir. Gizli mesajın sabitleme yanıtına girmesi engellendi. |
| `SendMessages` · 32 | Var | Mesaj gönderme | ChannelChatProvider | messageService.Create | Kanal görünürlüğü ve gönderme birlikte denetlenir. Bildirim testinde iki hesapla mesaj gönderildi. |
| `ConnectVoice` · 64 | Var | Sese bağlanma | DestinationView | voiceService.JoinChannel ve GenerateToken | Normal bağlantının yetki iptalinde kapatılması ve tekrar katılımın reddi servis testinde geçti. |
| `Speak` · 128 | Var | Mikrofon yayını | RoleSettings ve ses kontrolleri | voicePublishSources ve LiveKit token | Konuşma biti mikrofon ve mevcut kamera davranışını yönetir. Susturma yayını kapatır. |
| `Stream` · 256 | Var | Ekran paylaşımı | Kanal yetki editörü ve Go Live | GenerateScreenShareToken, UpdateState ve voicePublishSources | Ekran ve ekran sesi kaynakları için izin gerekir. Yalnızca konuşma izniyle paylaşım reddedildi. |
| `Admin` · 512 | Yok | Yönetici istisnası | hasPermission ve RoleSettings | Permission.Has ve kanal çözümleyicisi | Kanal istisnalarını aşar. Korunan sahip rolü ve rol sırası ayrıca denetlenir. |
| `ManageInvites` · 1024 | Yok | Davet yönetimi | ServerList | Invite.List, Create ve Delete | Üç uçta sunucu rolü denetlenir. |
| `ReadMessages` · 2048 | Var | Mesaj geçmişini okuma | Kanal sohbeti ve iletme seçicisi | PermCanReadChannel, mesaj, arama ve pin servisleri | Görme ve okuma birlikte gerekir. Okunamayan kanala kimlikle arama boş sonuç verir. |
| `ViewChannel` · 4096 | Var | Kanal listesinde görünme | ChannelTree ve StartupPreview | channelService.GetAllGrouped | İki hesap, iki kanal türü, çoklu rol, açık ret, rol kaldırma ve yeniden yükleme Chromium ile sınandı. |
| `MoveMembers` · 8192 | Var | Üye taşıma veya sesten çıkarma | VoiceUserContextMenu | voiceService.MoveUser ve AdminDisconnectUser | Başkasını taşımada kaynak ve hedef kanal denetlenir. Yönetici taşımasının oturum istisnası korundu. |
| `MuteMembers` · 16384 | Var | Üyeyi sunucu düzeyinde susturma | VoiceUserContextMenu | voiceService.AdminUpdateState | Hedefin kanalında kontrol edilir. Susturma kaldırılırken yayın kaynakları tekrar hesaplanır. |
| `DeafenMembers` · 32768 | Var | Üyenin işitmesini kapatma | VoiceUserContextMenu | voiceService.AdminUpdateState | Hedefin kanalı kullanılır. Fiziksel ses çıkışı denenmedi. |
| `UseSoundboard` · 65536 | Yok | Ses panelinden çalma | SoundboardPanel | Soundboard.Play | Çalma düğmesi de geçerli ses sunucusunun bitini kullanır. |
| `ManageSoundboard` · 131072 | Yok | Ses paneli kayıtlarını yönetme | SoundboardPanel ve EntranceServerSettings | Soundboard ve entrance yazma uçları | Çalma ve yönetim kontrolleri ayrı. |
| `TimeoutMembers` · 262144 | Yok | Üyeye zaman aşımı uygulama veya kaldırma | MembersSettings | Member.Timeout ve RemoveTimeout | Eşit veya üst rolün zaman aşımını değiştirme servis testlerinde reddedilir. |
| `ManageNicknames` · 524288 | Yok | Başka üyenin takma adını değiştirme | MemberCard | memberService.SetNickname | Kendi adını değiştirme ayrı kurala tabi. |
| `ManageExpressions` · 1048576 | Yok | Emoji ve çıkartma yönetimi | EmojiSettings ve StickerSettings | init_routes_expressions.go | Kopyalama dahil hedef sunucunun yazma izni aranır. |
| `UseEntranceSound` · 2097152 | Yok | Ses kanalına katılırken giriş sesi | RoleSettings ve giriş sesi seçimi | entranceService katılım denetimi | Sunucu ve kanal ayarları, kişisel seçim ve moderasyon da çalmayı etkiler. |
| `ManageApplications` · 4194304 | Yok | Uygulama kurulumu ve kaldırılması | settingsNavigation | Bot.ListInstallations, Install ve RevokeInstallation | Yönetim uçları sunucu rolünü ister. |
| `ManageEvents` · 8388608 | Yok | Etkinlik oluşturma ve yönetme | ServerEventsModal | ServerEvent.Create, Update ve Cancel | Üyelik ve yönetim biti sınanır. Gizli etkinlik kanalının kimliği normal üyeye verilmez. |

## Görünürlük ve erişim yolları

- **Liste ve açık oturum.** Temel rol bitleri birleşir. Kanal reddi temel izni kaldırır. Aynı bit için başka bir roldeki açık kanal izni kazanır. Yönetici tüm kanalları görür. Liste ve metin kanalındaki etkin yetki artık aynı hesaplamadan üretilir. Aktif ses kanalı liste filtresini aşamaz.
- **WebSocket.** Kanal adı ve konusu taşıyan güncellemelerde alıcılar güncel kanal yetkilerine göre seçilir. İki Chromium oturumunda özel kanal konusu yalnız sahibin soketine ulaştı. Her iki hesabın görebildiği kanaldaki sonraki güncelleme diğer hesabın soketine de ulaştı. Alt konuşma oluşturma ve arşivleme olayları üst kanalın görme ve okuma yetkilerini gerektirir. Normal kanal oluşturma ve sıralama olayları liste yenileme sinyali taşır. Sunucu kapsamındaki silme ve izin değişikliği olaylarında kanal kimliği veya rol maskesi bulunabilir. Bu olaylar kanal adı ve mesaj içeriği taşımaz.
- **Doğrudan erişim ve arama.** Mesaj, sabitleme, alt konuşma ve arama yollarında URL veya mesaj kimliği tek başına yetmez. Arama testleri, açık kimlikle okunamayan kanalı ve sunucu genelindeki sonuçları kapsar. Moderatör silme ile sabitleme artık hedef kanalın etkin yetkisini kullanır. Chromium oturumlarından aynı özel kanalın mesajları doğrudan istendi. Sahip okuyabildi, normal üye 403 aldı. Kendi mesajını silme davranışı korunur.
- **Bildirimler.** İki hesaplı PostgreSQL ve Chromium testinde açık kanal bildirimi, kullanıcı tercihi, sessize alınmış kanal ve gizli kanal sınandı. Daha önce işletim sistemine teslim edilmiş bir bildirimin geri çekilmesi sınanmadı.
- **Windows başlangıcı.** Paylaşılan React başlangıç bileşeni, önceki hesaptan veya çevrimdışı sürede geri alınmış izinlerden gelen kanal adlarını doğrulamadan çizmez. Hesap kapsamlı yerel önbellekte eski adlar bulunabilir. Tarayıcı yeniden yükleme, aynı tarayıcıda hesap değişimi ve başlangıç bileşeni sınandı.
- **Kanal istisnasını sıfırlama.** Devralmaya dönülürken veritabanı yazımı başarısız olursa işlem hata döndürür.
- **Cihaz kapsamı.** Paketlenmiş Windows uygulamasında fiziksel soğuk açılış yapılmadı.
- **Ses oturumu.** Normal kullanıcı için ConnectVoice iptali rol/kanal değişikliği sonrası sunucu oturumunu kapatır, yeniden katılmayı engeller ve LiveKit çıkarma işlemini tetikler. ViewChannel tek başına liste görünürlüğünü belirler. Moderatörün taşıdığı oturuma ait istisna kanal listesine isim eklemez. Gerçek cihazda medya kesilme süresi ve çok sunuculu süreçler arası iptal ölçülmedi.

## Tekrarlama

- Sunucu paketleri için `go test ./...` komutunu `server` dizininde çalıştır. Gerçek PostgreSQL teslim testleri yerel ve izole `HICHAT_TEST_POSTGRES_DSN` ile çalışır.
- Tarayıcı testleri için `e2e` altında izole mTLS PostgreSQL ile `playwright test role-visibility.spec.ts channel-notifications.spec.ts --project=chromium` çalıştır.
- Yetki çözümleyicisi tekil ve toplu hesap denkliğini, okuma ve arama kontrollerini, hiyerarşi, üst role müdahale ve kanal istisnasında yetki yükseltme kontrollerini sunucu testleriyle kapsar.

**Yerel sonuçlar.** Go paketleri geçti. PostgreSQL üzerinde sekiz ek kanal teslim testi geçti. İstemcide 12 dosyada 130 test, TypeScript denetimi ve değiştirilen bileşenlerin ESLint kontrolü geçti. Chromium çalıştırmasında bir hazırlık ve iki ürün senaryosu geçti. Test sunucusunda fixture sıfırlanırken eski LiveKit örneğini temizleme işlemi yabancı anahtar uyarısı üretti. Denetim medya aktarımı için harici bir LiveKit odası kullanmadı.
