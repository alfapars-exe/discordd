import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:hichat_native_proof/src/rust/frb_generated.dart';
import 'package:hichat_native_proof/app/api.dart';
import 'package:hichat_native_proof/app/chat.dart';
import 'package:hichat_native_proof/app/device_vault.dart';

Future<void> waitFor(File file) async {
  for (var n = 0; n < 720; n++) {
    if (await file.exists()) return;
    await Future<void>.delayed(const Duration(milliseconds: 250));
  }
  throw StateError('LOCAL_INTEROP_PEER_TIMEOUT');
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'legacy TypeScript to Rust handoff preserves live ratchet and bound DM history',
    (tester) async {
      await RustLib.init();
      final fixtureFile = File(
        const String.fromEnvironment('HICHAT_CHAT_QA_FILE'),
      );
      final qa = jsonDecode(await fixtureFile.readAsString()) as Map;
      final users = qa['users'] as List;
      final base = fixtureFile.parent.path;
      final apis = <HiChatApi>[],
          vaults = <DeviceVault>[],
          chats = <ChatController>[];
      try {
        for (final u in users) {
          final api = HiChatApi('http://127.0.0.1:18080');
          apis.add(api);
          await api.login(u['username'] as String, u['password'] as String);
          vaults.add(await DeviceVault.open(api));
        }
        expect((await vaults[0].status())['phase'], 'intent');
        await vaults[1].registerFreshDevice();
        await File('$base/interop-intent.json').writeAsString(
          jsonEncode((await vaults[0].status())['intent']),
          flush: true,
        );
        final peer = ChatController(
          apis[1],
          () async => vaults[1],
          pollInterval: const Duration(hours: 1),
        );
        chats.add(peer);
        await peer.initialize();
        await peer.select(
          peer.channels.singleWhere((c) => c['id'] == qa['channelId']),
        );
        await waitFor(File('$base/interop-source-sent.json'));
        await peer.refresh();
        expect(peer.error, isNull);
        expect(
          peer.messages.last['displayContent'],
          'Eski istemciden canlı mesaj 👋',
        );
        await peer.send('Rust yanıtı: canlı DH 🔐');
        expect(peer.error, isNull);
        await File('$base/interop-reply-ready')
            .writeAsString('ready', flush: true);
        final capsule = File('$base/interop-capsule.json');
        await waitFor(capsule);
        final imported = await vaults[0].importCapsule(
          await capsule.readAsString(),
        );
        final source = jsonDecode(
          await File('$base/interop-source-receipt.json').readAsString(),
        ) as Map;
        expect(imported['deviceId'], source['device']);
        expect(source['sourceFenced'], true);
        expect(source['legacyReplyDecrypted'], true);
        final migrated = ChatController(
          apis[0],
          () async => vaults[0],
          pollInterval: const Duration(hours: 1),
        );
        chats.add(migrated);
        await migrated.initialize();
        await migrated.select(
          migrated.channels.singleWhere((c) => c['id'] == qa['channelId']),
        );
        expect(migrated.error, isNull);
        expect(migrated.messages.length, 2);
        expect(
          migrated.messages.first['displayContent'],
          'Eski istemciden canlı mesaj 👋',
        );
        expect(
          migrated.messages.last['displayContent'],
          'Rust yanıtı: canlı DH 🔐',
        );
        await migrated.send('Devirden sonra aynı cihazla');
        expect(migrated.error, isNull);
        await peer.refresh();
        expect(peer.error, isNull);
        expect(
          peer.messages.last['displayContent'],
          'Devirden sonra aynı cihazla',
        );
        await peer.send('Devir sonrası yanıt');
        expect(peer.error, isNull);
        await migrated.refresh();
        expect(migrated.error, isNull);
        expect(migrated.messages.last['displayContent'], 'Devir sonrası yanıt');
        await File('$base/chat-handoff-receipt.json').writeAsString(
          jsonEncode({
            'realLegacyTypeScriptInterop': true,
            'goPostgresAPI': true,
            'rustFFI': true,
            'sourceRetiredAndFenced': true,
            'sameDeviceAfterTransfer': true,
            'boundLegacyHistoryReadableInChat': true,
            'bidirectionalMessagesAfterHandoff': true,
            'dhTurnAcrossHandoff': true,
            'serverMessages': 4,
            'physicalDevices': false,
          }),
          flush: true,
        );
      } finally {
        for (final c in chats) {
          await c.close();
        }
        for (final v in vaults) {
          await v.close();
        }
        for (final a in apis) {
          await a.logout();
          a.close();
        }
      }
    },
    timeout: const Timeout(Duration(minutes: 12)),
  );
}
