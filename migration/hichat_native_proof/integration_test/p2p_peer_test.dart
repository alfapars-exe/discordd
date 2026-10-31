import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart' as rtc;
import 'package:hichat_native_proof/app/api.dart';
import 'package:hichat_native_proof/app/p2p.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'Windows receives direct video and exchanges synthetic audio with Chromium',
    (tester) async {
      final file = File(const String.fromEnvironment('HICHAT_QA_FILE'));
      final qa = jsonDecode(await file.readAsString()) as Map;
      final api = HiChatApi('http://127.0.0.1:19090');
      final renderer = rtc.RTCVideoRenderer();
      final preview = rtc.RTCVideoRenderer();
      final call = P2PController(
        api,
        diagnostics: (e) => debugPrint('P2P_QA: $e'),
        capture: (video) async {
          final sources = await rtc.desktopCapturer.getSources(
            types: [rtc.SourceType.Window],
          );
          final source = sources.singleWhere(
            (s) => s.name.contains('HiChat Synthetic P2P QA'),
          );
          final stream = await rtc.navigator.mediaDevices.getDisplayMedia({
            'video': {
              'deviceId': {'exact': source.id},
              'mandatory': {'frameRate': 15.0},
            },
            'audio': true,
          });
          preview.srcObject = stream;
          return stream;
        },
      );
      try {
        expect(
          await File('${file.parent.path}/native-p2p-ready').exists(),
          isTrue,
        );
        await renderer.initialize();
        await preview.initialize();
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: Column(
                children: [
                  Expanded(child: rtc.RTCVideoView(renderer)),
                  Expanded(child: rtc.RTCVideoView(preview)),
                ],
              ),
            ),
          ),
        );
        await api.login(qa['username'] as String, qa['password'] as String);
        await call.connect();
        call.dial((qa['peer'] as Map)['userId'] as String, video: true);
        num frames = 0, energy = 0;
        for (var i = 0; i < 180; i++) {
          await Future<void>.delayed(const Duration(milliseconds: 250));
          if (call.remote != null) {
            renderer.srcObject = call.remote;
            await tester.pump();
          }
          final pc = call.peer;
          if (pc == null) continue;
          for (final report in await pc.getStats()) {
            if (i == 10 && report.type == 'outbound-rtp') {
              debugPrint(
                'P2P_SEND_PROBE: ${jsonEncode({
                  for (final key in ['kind', 'mediaType', 'framesEncoded', 'framesSent', 'bytesSent', 'packetsSent', 'frameWidth', 'frameHeight']) key: report.values[key],
                })} preview=${preview.videoWidth}x${preview.videoHeight}',
              );
            }
            if (report.type == 'inbound-rtp') {
              final decoded = (report.values['framesDecoded'] as num?) ?? 0;
              if (decoded > frames) frames = decoded;
              final received = (report.values['totalAudioEnergy'] as num?) ?? 0;
              if (received > energy) energy = received;
            }
          }
          if (i > 10 && frames > 10 && energy > 0) break;
        }
        expect(frames > 10, isTrue, reason: call.failure);
        expect(energy > 0, isTrue);
        final browser = File('${file.parent.path}/native-p2p-browser.json');
        for (var i = 0; i < 120 && !await browser.exists(); i++) {
          await Future<void>.delayed(const Duration(milliseconds: 250));
        }
        expect(await browser.exists(), isTrue);
        await File('${file.parent.path}/native-p2p-receipt.json').writeAsString(
          jsonEncode({
            'windowsFrames': frames,
            'windowsAudioEnergy': energy,
            'browser': jsonDecode(await browser.readAsString()),
            'physicalDevices': false,
            'syntheticSourcesOnly': true,
          }),
        );
        await call.end();
        expect(call.local, isNull);
        expect(call.peer, isNull);
      } finally {
        renderer.srcObject = null;
        preview.srcObject = null;
        await renderer.dispose();
        await preview.dispose();
        await call.shutdown();
        await api.logout();
        api.close();
        await File('${file.parent.path}/native-p2p-stop').writeAsString('stop');
      }
    },
  );
}
