import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:hichat_native_proof/src/rust/frb_generated.dart';
import 'package:hichat_native_proof/app/api.dart';
import 'package:hichat_native_proof/app/chat.dart';
import 'package:hichat_native_proof/app/device_vault.dart';

Future<void> waitFor(File file) async {
  for (var n = 0; n < 1200; n++) {
    if (await file.exists()) return;
    await Future<void>.delayed(const Duration(milliseconds: 250));
  }
  throw StateError('WEB_HANDOFF_FIXTURE_TIMEOUT');
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'native peer verifies browser handoff messages over the real API',
    (tester) async {
      await RustLib.init();
      final file = File(const String.fromEnvironment('HICHAT_CHAT_QA_FILE'));
      final qa = jsonDecode(await file.readAsString()) as Map,
          u = qa['users'][1] as Map;
      final base = file.parent.path, api = HiChatApi('http://127.0.0.1:18080');
      DeviceVault? vault;
      ChatController? chat;
      try {
        await api.login(u['username'] as String, u['password'] as String);
        vault = await DeviceVault.open(api);
        if ((await vault.status())['phase'] == 'intent') {
          await vault.registerFreshDevice();
        }
        final owned = vault;
        chat = ChatController(
          api,
          () async => owned,
          pollInterval: const Duration(hours: 1),
        );
        await chat.initialize();
        await chat.select(
          chat.channels.singleWhere((c) => c['id'] == qa['channelId']),
        );
        await File('$base/web-handoff-peer-ready')
            .writeAsString('ready', flush: true);
        final restarted = await File('$base/web-handoff-reply-ready').exists();
        if (!restarted) {
          await waitFor(File('$base/web-handoff-source-sent.json'));
          await chat.refresh();
          expect(chat.error, isNull);
          expect(
            chat.messages.last['displayContent'],
            'Eski istemciden web devri 👋',
          );
          await chat.send('Web devri öncesi Rust yanıtı 🔐');
          expect(chat.error, isNull);
          await File('$base/web-handoff-reply-ready')
              .writeAsString('ready', flush: true);
        } else {
          expect(
            chat.messages.first['displayContent'],
            'Eski istemciden web devri 👋',
          );
        }
        await waitFor(File('$base/web-handoff-target-sent'));
        await chat.refresh();
        expect(chat.error, isNull);
        expect(
          chat.messages.last['displayContent'],
          'Web devrinden sonra aynı cihaz',
        );
        await chat.send('Windows eşinden web hedefine yanıt');
        expect(chat.error, isNull);
        await File('$base/web-handoff-peer-receipt.json').writeAsString(
          jsonEncode({
            'goPostgresAPI': true,
            'rustNativePeer': true,
            'legacySourceMessageDecrypted': true,
            'browserHandoffMessageDecrypted': true,
            'replyToBrowserSent': true,
            'peerRestartedForContinuation': restarted,
            'physicalDevices': false,
          }),
          flush: true,
        );
      } finally {
        await chat?.close();
        await vault?.close();
        await api.logout();
        api.close();
      }
    },
    timeout: const Timeout(Duration(minutes: 15)),
  );
}
