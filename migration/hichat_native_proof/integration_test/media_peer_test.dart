import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart' hide ConnectionState;

import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:livekit_client/livekit_client.dart';
import 'package:hichat_native_proof/app/api.dart';
import 'package:hichat_native_proof/app/media.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('Windows decodes encrypted Chrome synthetic camera frames', (
    tester,
  ) async {
    const fixture = String.fromEnvironment('HICHAT_QA_FILE');
    final file = File(fixture);
    final qa = jsonDecode(await file.readAsString()) as Map<String, dynamic>;
    final api = HiChatApi('http://127.0.0.1:19090');
    final voice = VoiceController(api);
    try {
      for (var i = 0; i < 120; i++) {
        if (await File('${file.parent.path}/media-peer-ready.json').exists()) {
          break;
        }
        await Future<void>.delayed(const Duration(seconds: 1));
      }
      expect(
        await File('${file.parent.path}/media-peer-ready.json').exists(),
        isTrue,
      );
      await api.login(qa['username'] as String, qa['password'] as String);
      await voice.join(
        qa['serverId'] as String,
        qa['voiceChannelId'] as String,
      );
      final peer = jsonDecode(
        await File('${file.parent.path}/media-peer-ready.json').readAsString(),
      ) as Map;
      final requireScreen = peer['screenPublished'] == true;
      num frames = 0, screenFrames = 0;
      var rendered = 0;
      for (var i = 0; i < 100; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 200));
        final videos = <RemoteVideoTrack>[];
        for (final participant in voice.room!.remoteParticipants.values) {
          for (final publication in participant.videoTrackPublications) {
            final track = publication.track;
            if (track is RemoteVideoTrack) {
              videos.add(track);
              final stats = await track.getReceiverStats();
              if (publication.source == TrackSource.screenShareVideo) {
                screenFrames = stats?.framesDecoded ?? 0;
              } else {
                frames = stats?.framesDecoded ?? 0;
              }
            }
          }
        }
        if (videos.length != rendered) {
          await tester.pumpWidget(
            MaterialApp(
              home: Scaffold(
                body: Column(
                  children: [
                    for (final track in videos)
                      Expanded(child: VideoTrackRenderer(track)),
                  ],
                ),
              ),
            ),
          );
          rendered = videos.length;
        }
        if (frames > 10 && (!requireScreen || screenFrames > 10)) break;
      }
      expect(frames, greaterThan(10));
      if (requireScreen) expect(screenFrames, greaterThan(10));
      await File('${file.parent.path}/media-receipt.json').writeAsString(
        jsonEncode({
          'windowsDecodedFrames': frames,
          'windowsDecodedScreenFrames': screenFrames,
          'source': 'Chrome fake camera',
          'encryptedRoom': voice.room?.e2eeManager != null,
          'physicalDevices': false,
        }),
      );
    } finally {
      await tester.pumpWidget(const SizedBox.shrink());
      await voice.leave();
      await api.logout();
      api.close();
      await File('${file.parent.path}/media-peer-stop').writeAsString('stop');
    }
  }, timeout: const Timeout(Duration(minutes: 4)));
}
