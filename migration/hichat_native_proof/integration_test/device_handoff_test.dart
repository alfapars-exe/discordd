import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:hichat_native_proof/src/rust/frb_generated.dart';
import 'package:hichat_native_proof/app/api.dart';
import 'package:hichat_native_proof/app/device_vault.dart';
import 'package:hichat_native_proof/app/device_store.dart';
import 'package:hichat_native_proof/src/rust/api/simple.dart' as rust;

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'legacy retirement to DPAPI vault survives restart and fences a second owner',
    (tester) async {
      await RustLib.init();
      final qaFile = File(const String.fromEnvironment('HICHAT_QA_FILE'));
      final qa = jsonDecode(await qaFile.readAsString()) as Map;
      final api = HiChatApi('http://127.0.0.1:18080');
      DeviceVault? vault;
      try {
        await api.login(qa['username'] as String, qa['password'] as String);
        vault = await DeviceVault.open(api);
        final status = await vault.status();
        expect(status['phase'], 'intent');
        await expectLater(DeviceVault.open(api), throwsA(anything));
        await File('${qaFile.parent.path}/handoff-native-intent.json')
            .writeAsString(jsonEncode(status['intent']), flush: true);
        final capsule = File(
          '${qaFile.parent.path}/handoff-native-capsule.json',
        );
        for (var n = 0; n < 240 && !await capsule.exists(); n++) {
          await Future<void>.delayed(const Duration(milliseconds: 250));
        }
        expect(await capsule.exists(), isTrue);
        final text = await capsule.readAsString();
        final imported = await vault.importCapsule(text);
        expect(imported['status'], 'imported');
        expect(imported['pending'], 1);
        final first = await vault.preparePeer(
          'handoff-peer',
          'peer-device',
          'handoff-msg-00000001',
          'İlk aktarım mesajı',
        );
        expect(first['wire']['header']['messageNumber'], 0);
        await vault.close();
        final scope = jsonEncode([api.origin.toString(), api.session!.userId]);
        final staged = await DeviceStore.open(scope);
        final saved = (await staged.load())!;
        final snapshot = jsonDecode(saved['snapshot'] as String);
        expect(
          snapshot['portablePending'][0]['manifest']['payload']['ciphertext'],
          'UNCHANGED_CIPHERTEXT',
        );
        expect(
          snapshot['portablePending'][0]['manifest']['payload']['client_request_id'],
          'request-00000001',
        );
        expect(
          snapshot['stores']['messageCache'][0]['value']['content'],
          'Taşınan geçmiş: şğıöçü 👋',
        );
        expect(snapshot['preferences']['theme'], 'dark');
        // Emulate interruption after the durable import but before activation.
        saved['phase'] = 'dormant';
        await staged.save(saved);
        await staged.close();
        vault = await DeviceVault.open(api);
        expect((await vault.status())['phase'], 'active');
        expect((await vault.importCapsule(text))['status'], 'already-imported');
        final retry = await vault.preparePeer(
          'handoff-peer',
          'peer-device',
          'handoff-msg-00000001',
          'İlk aktarım mesajı',
        );
        expect(retry, first);
        await expectLater(
          vault.preparePeer(
            'handoff-peer',
            'peer-device',
            'handoff-msg-00000001',
            'changed',
          ),
          throwsA(anything),
        );
        final second = await vault.preparePeer(
          'handoff-peer',
          'peer-device',
          'handoff-msg-00000002',
          'Sonraki mesaj',
        );
        expect(second['wire']['header']['messageNumber'], 1);
        final root = Platform.environment['LOCALAPPDATA']!;
        final hash = await rust.deviceScopeId(scope: scope);
        final bytes = await File(
          '$root/HiChatMigrationProof/device-vault/$hash.sealed',
        ).readAsBytes();
        expect(latin1.decode(bytes).contains('privateKey'), isFalse);
        expect(latin1.decode(bytes).contains('UNCHANGED_CIPHERTEXT'), isFalse);
        await expectLater(
          rust.protectDeviceStore(
            data: bytes,
            scope: 'wrong-scope',
            decode: true,
          ),
          throwsA(anything),
        );
        await File(
          '${qaFile.parent.path}/handoff-native-receipt.json',
        ).writeAsString(
          jsonEncode({
            'dpapiProtected': true,
            'singleOwner': true,
            'restartRestoresActiveState': true,
            'retryPreservesCiphertext': true,
            'counterAfterRestart': second['wire']['header']['messageNumber'],
            'pendingPreserved': 1,
            'physicalDevices': false,
          }),
        );
      } finally {
        await vault?.close();
        await api.logout();
        api.close();
      }
    },
  );
}
