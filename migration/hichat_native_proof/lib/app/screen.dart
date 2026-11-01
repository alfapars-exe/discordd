import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart' as rtc;
import 'package:livekit_client/livekit_client.dart';

import '../src/rust/api/simple.dart' as rust;
import 'api.dart';
import 'media.dart';
import 'archive_store.dart';
import 'p2p.dart';
import 'p2p_view.dart';
import 'game_overlay.dart';
import 'device_vault.dart';
import 'device_handoff_view.dart';

typedef HistoryReader = Future<String> Function({
  required String backupJson,
  required String password,
  required String owner,
});

class HiChatScreen extends StatefulWidget {
  final HiChatApi Function(String)? apiFactory;
  final HistoryReader? historyReader;
  const HiChatScreen({super.key, this.apiFactory, this.historyReader});
  @override
  State<HiChatScreen> createState() => _HiChatScreenState();
}

class _HiChatScreenState extends State<HiChatScreen> {
  final origin = TextEditingController(
    text: Uri.base.scheme.startsWith('http') ? Uri.base.origin : '',
  );
  final username = TextEditingController(),
      password = TextEditingController(),
      mfa = TextEditingController();
  final recovery = TextEditingController(), backup = TextEditingController();
  HiChatApi? api;
  VoiceController? voice;
  P2PController? p2p;
  GameOverlay? overlay;
  Future<DeviceVault>? _vault;
  Future<DeviceVault> _openVault() => _vault ??= DeviceVault.open(api!);
  String? error, serverId, channelId;
  bool busy = false, restoring = false;
  bool shareAudio = false;
  int selection = 0;
  List<dynamic> servers = [], channels = [], history = [];
  @override
  void dispose() {
    _vault?.then((v) => v.close(), onError: (Object _) {});
    overlay?.removeListener(_changed);
    voice?.removeListener(_changed);
    voice?.leave();
    p2p?.shutdown();
    overlay?.shutdown();
    api?.close();
    for (final c in [origin, username, password, mfa, recovery, backup]) {
      c.dispose();
    }
    super.dispose();
  }

  String _code(Object e) {
    if (e is ApiFailure) {
      const messages = {
        'MFA_REQUIRED': 'İki adımlı doğrulama kodunuzu girin.',
        'MFA_INVALID': 'Doğrulama kodu geçersiz veya kullanılmış.',
        'MFA_RATE_LIMITED':
            'Çok fazla doğrulama denemesi. Bir süre sonra tekrar deneyin.',
        'ACCOUNT_DISABLED': 'Bu hesap devre dışı bırakılmış.',
        'HTTP_401': 'Kullanıcı adı, parola veya oturum bilgisi geçersiz.',
        'HTTP_429': 'Çok fazla deneme. Bir süre sonra tekrar deneyin.',
        'NETWORK_ERROR': 'Sunucuya ulaşılamıyor. Bağlantınızı kontrol edin.',
        'REQUEST_TIMEOUT': 'Sunucu zamanında yanıt vermedi. Tekrar deneyin.',
        'HTTPS_ORIGIN_REQUIRED': 'Geçerli bir HTTPS sunucu adresi girin.',
        'LOGIN_REQUIRED': 'Devam etmek için giriş yapın.',
        'SCREEN_AUDIO_UNAVAILABLE': 'Paylaşım sesi alınamadı. Paylaşım durduruldu; ses iznini ve Windows desteğini kontrol edin.',
        'SESSION_CHANGED': 'Oturum değişti. Gerekirse tekrar giriş yapın.',
      };
      if (messages.containsKey(e.code)) return messages[e.code]!;
      if (e.code.contains(' ')) return e.code;
    }
    return 'İşlem tamamlanamadı. Bağlantıyı ve girilen bilgileri kontrol edin.';
  }

  Future<void> _run(Future<void> Function() action) async {
    if (busy) return;
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await action();
    } catch (e) {
      if (mounted) setState(() => error = _code(e));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> _login() => _run(() async {
    if (username.text.trim().isEmpty || password.text.isEmpty) {
      throw const ApiFailure('Kullanıcı adı ve parola gerekli.');
    }
    final client =
        widget.apiFactory?.call(origin.text) ?? HiChatApi(origin.text);
    api?.close();
    api = client;
    await client.login(username.text, password.text, mfa: mfa.text);
    password.clear();
    mfa.clear();
    if (!mounted || api != client) return;
    voice = VoiceController(client)..addListener(_changed);
    p2p = P2PController(client);
    overlay = GameOverlay(voice!, p2p!)..addListener(_changed);
    setState(() {});
    final scope = client.generation;
    final result = await client.request('GET', '/api/servers');
    if (!mounted || !client.isCurrent(scope)) return;
    setState(() => servers = (result as List?) ?? []);
    final saved = await loadArchive(
      client.origin.toString(),
      client.session!.userId,
    );
    if (mounted && client.isCurrent(scope) && saved != null) {
      backup.text = saved;
    }
  });
  void _changed() {
    if (mounted) setState(() {});
  }

  Future<void> _logout() async {
    final oldVault = _vault;
    _vault = null;
    oldVault?.then((v) => v.close(), onError: (Object _) {});
    final old = api;
    final oldVoice = voice;
    final oldP2P = p2p;
    final oldOverlay = overlay;
    oldOverlay?.removeListener(_changed);
    overlay = null;
    p2p = null;
    setState(() {
      voice = null;
      api = null;
      history = [];
      servers = [];
      channels = [];
      serverId = null;
      channelId = null;
      backup.clear();
      recovery.clear();
      error = null;
    });
    oldVoice?.removeListener(_changed);
    // Invalidate the HTTP/crypto scope immediately, before waiting for device shutdown.
    final revoke = old?.logout();
    try {
      await oldVoice?.leave();
      await oldOverlay?.shutdown();
      await oldP2P?.shutdown();
      await revoke;
    } catch (_) {
      if (mounted) {
        setState(
          () => error =
              'Yerel çıkış yapıldı; sunucudaki oturum kapatma doğrulanamadı.',
        );
      }
    } finally {
      old?.close();
    }
  }

  Future<void> _selectServer(String? id) => _run(() async {
    final client = api!;
    final scope = client.generation;
    setState(() {
      serverId = id;
      channelId = null;
      channels = [];
    });
    if (id == null) return;
    final result = await client.request(
      'GET',
      '/api/servers/${Uri.encodeComponent(id)}/channels',
    );
    if (mounted && client.isCurrent(scope) && serverId == id) {
      setState(
        () => channels = ((result as List?) ?? [])
            .expand((group) => (group['channels'] as List?) ?? [])
            .where((c) => c['type'] == 'voice')
            .toList(),
      );
    }
  });
  Future<void> _downloadBackup() => _run(() async {
    final client = api!;
    final scope = client.generation;
    final result = await client.request('GET', '/api/e2ee/key-backup');
    if (result == null) {
      throw const ApiFailure('Bu hesapta kurtarma yedeği bulunamadı.');
    }
    if (mounted && client.isCurrent(scope)) {
      setState(() => backup.text = jsonEncode(result));
    }
  });
  Future<void> _restore() async {
    if (restoring || api?.session == null) return;
    final client = api!;
    final scope = client.generation;
    final owner = client.session!.userId;
    final encrypted = backup.text;
    if (encrypted.length > 48 * 1024 * 1024) {
      setState(() => error = 'Yedek çok büyük.');
      return;
    }
    final secret = recovery.text;
    recovery.clear();
    setState(() {
      restoring = true;
      error = null;
    });
    try {
      final reader = widget.historyReader ?? rust.restoreHistory;
      final restored = await reader(
        backupJson: encrypted,
        password: secret,
        owner: owner,
      );
      if (!mounted || api != client || !client.isCurrent(scope)) return;
      setState(() => history = jsonDecode(restored) as List);
      try {
        await saveArchive(client.origin.toString(), owner, encrypted);
      } catch (_) {
        if (mounted && api == client && client.isCurrent(scope)) {
          setState(
            () => error = 'Geçmiş açıldı; tarayıcı veya cihaz şifreli yedeğin saklanmasına izin vermedi.',
          );
        }
      }
    } catch (failure) {
      if (mounted && api == client && client.isCurrent(scope)) {
        final known = [
          'backup_authentication_failed',
          'backup_account_mismatch',
          'invalid_backup',
          'unsupported_backup_version',
          'invalid_backup_contents',
        ].where((code) => failure.toString().contains(code)).firstOrNull;
        debugPrint('history_restore_failure: ${known ?? failure.runtimeType}');
        setState(
          () => error = known == null
              ? 'Geçmiş motoru çalıştırılamadı. Tarayıcı desteğini ve uygulama sürümünü kontrol edin.'
              : 'Yedek açılamadı: kurtarma parolası, hesap veya yedek biçimi uyuşmuyor.',
        );
      }
    } finally {
      if (mounted) setState(() => restoring = false);
    }
  }

  Widget _input(
    TextEditingController c,
    String label,
    String key, {
    bool secret = false,
    TextInputAction action = TextInputAction.next,
  }) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 8),
    child: TextField(
      key: Key(key),
      enabled: !busy && !restoring,
      controller: c,
      obscureText: secret,
      autocorrect: !secret,
      enableSuggestions: !secret,
      textInputAction: action,
      autofillHints: key == 'username'
          ? const [AutofillHints.username]
          : key == 'password'
          ? const [AutofillHints.password]
          : null,
      decoration: InputDecoration(
        labelText: label,
        border: const OutlineInputBorder(),
      ),
      onSubmitted: (_) {
        if (key == 'password' || key == 'mfa') _login();
      },
    ),
  );
  Widget _loginView() => Center(
    child: ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 480),
      child: AutofillGroup(
        child: ListView(
          shrinkWrap: true,
          padding: const EdgeInsets.all(24),
          children: [
            const Text(
              'HiChat’e giriş',
              style: TextStyle(fontSize: 28, fontWeight: FontWeight.bold),
            ),
            _input(origin, 'Sunucu adresi (https://…)', 'origin'),
            _input(username, 'Kullanıcı adı veya e-posta', 'username'),
            _input(
              password,
              'Parola',
              'password',
              secret: true,
              action: TextInputAction.done,
            ),
            _input(
              mfa,
              'İki adımlı doğrulama / kurtarma kodu (gerekirse)',
              'mfa',
              action: TextInputAction.done,
            ),
            const SizedBox(height: 12),
            FilledButton(
              key: const Key('login'),
              onPressed: busy ? null : _login,
              child: Text(busy ? 'Bağlanıyor…' : 'Giriş yap'),
            ),
            const SizedBox(height: 12),
            const Text(
              'Parolanız kaydedilmez. Erişim anahtarı bellekte tutulur; oturum yenileme sunucunun güvenli çereziyle yapılır.',
            ),
          ],
        ),
      ),
    ),
  );
  Widget _historyView() => ListView(
    padding: const EdgeInsets.all(20),
    children: [
      const Text('Şifreli geçmişi taşı', style: TextStyle(fontSize: 24)),
      const Text(
        'Eski uygulamada oluşturulan kurtarma yedeğini açın. Bu işlem yedekteki mesaj önbelleğini okur; eski cihazın gönderim anahtarlarını etkinleştirmez. Önbellekte bulunmayan şifreli mesajlar bu ekranda açılamaz.',
      ),
      const SizedBox(height: 12),
      OutlinedButton(
        onPressed: busy ? null : _downloadBackup,
        child: const Text('Hesabımdaki şifreli yedeği al'),
      ),
      TextField(
        key: const Key('backup'),
        enabled: !busy && !restoring,
        controller: backup,
        maxLines: 4,
        decoration: const InputDecoration(
          labelText: 'Şifreli yedek JSON',
          border: OutlineInputBorder(),
        ),
      ),
      _input(recovery, 'Kurtarma parolası', 'recovery', secret: true),
      FilledButton(
        key: const Key('restore'),
        onPressed: restoring ? null : _restore,
        child: Text(
          restoring ? 'Yedek açılıyor…' : 'Geçmişi aç ve şifreli yedeği sakla',
        ),
      ),
      Text('${history.length} geçmiş mesajı'),
      for (final item in history)
        Card(
          child: ListTile(
            title: Semantics(
              label: item['content'] as String,
              excludeSemantics: true,
              child: SelectableText(item['content'] as String),
            ),
            subtitle: Text(
              '${item['dmChannelId'] ?? item['channelId']} • ${item['messageId']}',
            ),
          ),
        ),
    ],
  );
  Future<void> _shareScreen() async {
    final controller = voice;
    if (controller == null) return;
    if (controller.screen) {
      await controller.setScreen(false);
      return;
    }
    String? sourceId;
    if (!kIsWeb &&
        [
          TargetPlatform.windows,
          TargetPlatform.linux,
          TargetPlatform.macOS,
        ].contains(defaultTargetPlatform)) {
      final sources = await rtc.desktopCapturer.getSources(
        types: shareAudio && defaultTargetPlatform == TargetPlatform.windows
            ? [rtc.SourceType.Screen]
            : [rtc.SourceType.Screen, rtc.SourceType.Window],
      );
      if (!mounted || controller != voice) return;
      sourceId = await showDialog<String>(
        context: context,
        builder: (context) => SimpleDialog(
          title: const Text('Paylaşılacak ekran veya pencere'),
          children: [
            for (final source in sources)
              SimpleDialogOption(
                onPressed: () => Navigator.pop(context, source.id),
                child: Text(source.name),
              ),
          ],
        ),
      );
      if (sourceId == null) return;
    }
    if (controller == voice) {
      await controller.setScreen(true, sourceId: sourceId, audio: shareAudio);
    }
  }

  Future<void> _chooseDevice(String kind) async {
    final controller = voice;
    if (controller == null) return;
    final devices = await Hardware.instance.enumerateDevices(type: kind);
    if (!mounted || controller != voice) return;
    final device = await showDialog<MediaDevice>(
      context: context,
      builder: (context) => SimpleDialog(
        title: const Text('Aygıt seç'),
        children: [
          for (final device in devices)
            SimpleDialogOption(
              onPressed: () => Navigator.pop(context, device),
              child: Text(device.label.isEmpty ? 'Adsız aygıt' : device.label),
            ),
        ],
      ),
    );
    if (device != null && controller == voice) {
      await controller.selectDevice(device);
    }
  }

  Widget _voiceView() {
    final controller = voice!;
    final room = controller.room;
    final tracks = <VideoTrack>[];
    if (room != null) {
      for (final p in <Participant>[
        if (room.localParticipant != null) room.localParticipant!,
        ...room.remoteParticipants.values,
      ]) {
        for (final publication in p.videoTrackPublications) {
          final track = publication.track;
          if (track is VideoTrack) tracks.add(track);
        }
      }
    }
    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        const Text('Ses ve görüntü', style: TextStyle(fontSize: 24)),
        if (overlay?.supported == true)
          OutlinedButton(
            onPressed: busy
                ? null
                : () => _run(() async {
                    final hud = overlay!;
                    if (hud.target != null) {
                      await hud.select(null);
                      return;
                    }
                    final sources = await rtc.desktopCapturer.getSources(
                      types: [rtc.SourceType.Window],
                    );
                    if (!mounted || hud != overlay) return;
                    final selected = await showDialog<String>(
                      context: context,
                      builder: (context) => SimpleDialog(
                        title: const Text('Oyun penceresini seç'),
                        children: [
                          for (final source in sources)
                            SimpleDialogOption(
                              onPressed: () =>
                                  Navigator.pop(context, source.id),
                              child: Text(source.name),
                            ),
                        ],
                      ),
                    );
                    if (hud == overlay && selected != null) {
                      await hud.select(selected);
                    }
                  }),
            child: Text(
              overlay!.target == null
                  ? 'Oyun katmanını aç'
                  : 'Oyun katmanını kapat',
            ),
          ),
        if (overlay?.supported == true)
          const Text(
            'Katman, seçilen oyun öndeyken görünür. Pencereli ve kenarlıksız mod desteklenir.',
          ),
        if (overlay?.failure != null)
          Text(overlay!.failure!, style: const TextStyle(color: Colors.orange)),
        DropdownButtonFormField<String>(
          key: const Key('servers'),
          initialValue: serverId,
          decoration: const InputDecoration(labelText: 'Sunucu'),
          items: servers
              .map(
                (s) => DropdownMenuItem<String>(
                  value: s['id'] as String,
                  child: Text(s['name'] as String),
                ),
              )
              .toList(),
          onChanged: busy ? null : _selectServer,
        ),
        DropdownButtonFormField<String>(
          key: ValueKey('channels:$serverId'),
          initialValue: channelId,
          decoration: const InputDecoration(labelText: 'Ses kanalı'),
          items: channels
              .map(
                (c) => DropdownMenuItem<String>(
                  value: c['id'] as String,
                  child: Text(c['name'] as String),
                ),
              )
              .toList(),
          onChanged: (id) => setState(() => channelId = id),
        ),
        const SizedBox(height: 16),
        if (kIsWeb || defaultTargetPlatform == TargetPlatform.windows)
          SwitchListTile(
            title: const Text('Paylaşım sesini dahil et'),
            subtitle: Text(
              kIsWeb ? 'Tarayıcı seçiminde ses iznini de etkinleştirin.' : 'Ekran ile sistem sesi paylaşılır; HiChat kendi sesini dışlar.',
            ),
            value: shareAudio,
            onChanged: controller.screen || controller.connecting
                ? null
                : (value) => setState(() => shareAudio = value),
          ),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            FilledButton(
              onPressed: busy || controller.connecting || channelId == null
                  ? null
                  : () => _run(() async {
                      await p2p?.disconnect();
                      await controller.join(serverId!, channelId!);
                    }),
              child: Text(
                controller.connecting ? 'Bağlanıyor…' : 'Şifreli odaya katıl',
              ),
            ),
            OutlinedButton(
              onPressed: room == null && !controller.connecting
                  ? null
                  : () => controller.leave(),
              child: const Text('Ayrıl'),
            ),
            OutlinedButton(
              onPressed: room == null || controller.connecting
                  ? null
                  : () => _run(
                      () => controller.setMicrophone(!controller.microphone),
                    ),
              child: Text(
                controller.microphone ? 'Mikrofonu kapat' : 'Mikrofonu aç',
              ),
            ),
            OutlinedButton(
              onPressed: room == null || controller.connecting
                  ? null
                  : () => _run(() => controller.setCamera(!controller.camera)),
              child: Text(controller.camera ? 'Kamerayı kapat' : 'Kamerayı aç'),
            ),
            OutlinedButton(
              onPressed: room == null || controller.connecting
                  ? null
                  : () => _run(_shareScreen),
              child: Text(
                controller.screen ? 'Paylaşımı durdur' : 'Ekranı paylaş',
              ),
            ),
          ],
        ),
        if (controller.failure != null)
          Text(
            controller.failure!,
            style: const TextStyle(color: Colors.orange),
          ),
        const SizedBox(height: 12),
        if (room != null)
          Wrap(
            spacing: 8,
            children: [
              TextButton(
                onPressed: () => _run(() => _chooseDevice('audioinput')),
                child: const Text('Mikrofon seç'),
              ),
              TextButton(
                onPressed: () => _run(() => _chooseDevice('audiooutput')),
                child: const Text('Hoparlör seç'),
              ),
              TextButton(
                onPressed: () => _run(() => _chooseDevice('videoinput')),
                child: const Text('Kamera seç'),
              ),
            ],
          ),
        Text(
          room == null
              ? 'Görüşmeye bağlı değilsiniz.'
              : '${room.connectionState.name} • ${room.remoteParticipants.length + 1} katılımcı',
        ),
        const Text(
          'Ekran/sistem sesi yakalama desteği tarayıcıya ve işletim sistemine bağlıdır. Mobil tarayıcı desteği cihaz üstünde ayrıca doğrulanır.',
        ),
        for (final track in tracks)
          AspectRatio(aspectRatio: 16 / 9, child: VideoTrackRenderer(track)),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final signedIn = api?.session != null;
    return Scaffold(
      appBar: AppBar(
        title: Text(
          signedIn ? 'HiChat • ${api!.session!.displayName}' : 'HiChat',
        ),
        actions: [
          if (signedIn)
            IconButton(
              key: const Key('logout'),
              tooltip: 'Çıkış yap',
              onPressed: _logout,
              icon: const Icon(Icons.logout),
            ),
        ],
      ),
      body: SafeArea(
        child: Column(
          children: [
            if (error != null)
              MaterialBanner(
                content: Text(error!),
                actions: [
                  TextButton(
                    onPressed: () => setState(() => error = null),
                    child: const Text('Kapat'),
                  ),
                ],
              ),
            Expanded(
              child: signedIn
                  ? (selection == 0
                        ? _voiceView()
                        : selection == 1
                        ? _historyView()
                        : selection == 2
                        ? P2PView(
                            controller: p2p!,
                            beforeConnect: () => voice!.leave(),
                          )
                        : DeviceHandoffView(open: _openVault))
                  : _loginView(),
            ),
          ],
        ),
      ),
      bottomNavigationBar: signedIn
          ? NavigationBar(
              selectedIndex: selection,
              onDestinationSelected: (i) => setState(() => selection = i),
              destinations: const [
                NavigationDestination(
                  icon: Icon(Icons.headset),
                  label: 'Görüşme',
                ),
                NavigationDestination(
                  icon: Icon(Icons.history),
                  label: 'Geçmiş',
                ),
                NavigationDestination(
                  icon: Icon(Icons.call),
                  label: 'Doğrudan ara',
                ),
                NavigationDestination(
                  icon: Icon(Icons.devices),
                  label: 'Cihaz devri',
                ),
              ],
            )
          : null,
    );
  }
}
