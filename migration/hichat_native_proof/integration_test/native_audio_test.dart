import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart' as rtc;
import 'package:livekit_client/livekit_client.dart';
import 'package:hichat_native_proof/app/api.dart';
import 'package:hichat_native_proof/app/media.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'Windows captures only owned synthetic tone window into encrypted room',
    (tester) async {
      final file = File(const String.fromEnvironment('HICHAT_QA_FILE'));
      final qa = jsonDecode(await file.readAsString()) as Map;
      final api = HiChatApi('http://127.0.0.1:19090');
      final voice = VoiceController(api);
      try {
        expect(
          await File('${file.parent.path}/native-audio-source-ready').exists(),
          isTrue,
        );
        await api.login(qa['username'] as String, qa['password'] as String);
        await voice.join(
          qa['serverId'] as String,
          qa['voiceChannelId'] as String,
        );
        final sources = await rtc.desktopCapturer.getSources(
          types: [rtc.SourceType.Window],
        );
        final source = sources.singleWhere(
          (s) => s.name.contains('HiChat Synthetic Tone QA'),
        );
        await voice.setScreen(true, sourceId: source.id, audio: true);
        expect(
          voice.room!.localParticipant!.getTrackPublicationBySource(
            TrackSource.screenShareAudio,
          ),
          isNotNull,
        );
        await File('${file.parent.path}/native-audio-published')
            .writeAsString('synthetic-window-only');
        final receipt = File('${file.parent.path}/native-audio-receipt.json');
        for (var i = 0; i < 120 && !await receipt.exists(); i++) {
          await Future<void>.delayed(const Duration(milliseconds: 250));
        }
        expect(await receipt.exists(), isTrue);
        final result = jsonDecode(await receipt.readAsString()) as Map;
        expect((result['audioEnergy'] as num) > 0, isTrue);
        expect(result['encryptedRoom'], isTrue);
        await voice.setScreen(false);
        expect(
          voice.room!.localParticipant!.getTrackPublicationBySource(
            TrackSource.screenShareAudio,
          ),
          isNull,
        );
      } finally {
        await voice.leave();
        await api.logout();
        api.close();
        await File('${file.parent.path}/native-audio-stop')
            .writeAsString('stop');
      }
    },
  );
}
