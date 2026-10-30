import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:livekit_client/livekit_client.dart';
import 'package:hichat_native_proof/app/api.dart';
import 'package:hichat_native_proof/app/media.dart';
import 'package:hichat_native_proof/app/screen.dart';
import 'package:hichat_native_proof/src/rust/frb_generated.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() async => RustLib.init());
  testWidgets(
    'local Go login, WebCrypto archive, encrypted LiveKit room and logout',
    (tester) async {
      const fixturePath = String.fromEnvironment('HICHAT_QA_FILE');
      if (fixturePath.isEmpty) {
        fail('Pass HICHAT_QA_FILE pointing to ignored synthetic local fixture');
      }
      final qa = jsonDecode(
        await File(fixturePath).readAsString(),
      ) as Map<String, dynamic>;
      final api = HiChatApi('http://127.0.0.1:19090');
      Future<void> until(Finder finder) async {
        for (var i = 0; i < 150; i++) {
          await tester.pump(const Duration(milliseconds: 200));
          if (finder.evaluate().isNotEmpty) return;
        }
        fail('Expected UI state not reached');
      }

      await tester.pumpWidget(
        MaterialApp(
          theme: ThemeData.dark(),
          home: HiChatScreen(apiFactory: (_) => api),
        ),
      );
      await tester.enterText(
        find.byKey(const Key('origin')),
        'http://127.0.0.1:19090',
      );
      await tester.enterText(
        find.byKey(const Key('username')),
        qa['username'] as String,
      );
      await tester.enterText(
        find.byKey(const Key('password')),
        qa['password'] as String,
      );
      await tester.ensureVisible(find.byKey(const Key('login')));
      await tester.tap(find.byKey(const Key('login')));
      await until(find.byKey(const Key('logout')));
      expect(api.session?.userId, qa['userId']);
      await tester.tap(find.text('Geçmiş'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Hesabımdaki şifreli yedeği al'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const Key('backup')),
        jsonEncode(qa['backup']),
      );
      await tester.enterText(
        find.byKey(const Key('recovery')),
        qa['recovery'] as String,
      );
      await tester.ensureVisible(find.byKey(const Key('restore')));
      await tester.tap(find.byKey(const Key('restore')));
      await until(find.text('Geçmiş mesaj: şğıöçü 👋'));
      final voice = VoiceController(api);
      try {
        await voice.join(
          qa['serverId'] as String,
          qa['voiceChannelId'] as String,
        );
        expect(voice.room?.connectionState, ConnectionState.connected);
        expect(voice.room?.e2eeManager, isNotNull);
        expect(voice.microphone, isFalse);
      } finally {
        await voice.leave();
      }
      await tester.tap(find.byKey(const Key('logout')));
      await tester.pumpAndSettle();
      expect(api.session, isNull);
      expect(find.text('Geçmiş mesaj: şğıöçü 👋'), findsNothing);
    },
    timeout: const Timeout(Duration(minutes: 3)),
  );
}
