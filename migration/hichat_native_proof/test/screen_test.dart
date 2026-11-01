import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:hichat_native_proof/app/api.dart';
import 'package:hichat_native_proof/app/screen.dart';

void main() {
  for (final width in [320.0, 390.0, 1280.0]) {
    testWidgets('login fits ${width.toInt()}px and handles MFA', (
      tester,
    ) async {
      tester.view.physicalSize = Size(width, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final api = HiChatApi(
        'https://example.com',
        client: MockClient((request) async {
          final payload = jsonDecode(request.body) as Map;
          expect(payload['username'], 'kullanıcı');
          expect(payload['mfa_code'], '123456');
          return http.Response('{"success":false,"code":"MFA_INVALID"}', 401);
        }),
      );
      await tester.pumpWidget(
        MaterialApp(home: HiChatScreen(apiFactory: (_) => api)),
      );
      await tester.enterText(
        find.byKey(const Key('origin')),
        'https://example.com',
      );
      await tester.enterText(find.byKey(const Key('username')), 'kullanıcı');
      await tester.enterText(find.byKey(const Key('password')), 'secret');
      await tester.enterText(find.byKey(const Key('mfa')), '123456');
      await tester.ensureVisible(find.byKey(const Key('login')));
      await tester.tap(find.byKey(const Key('login')));
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 100)),
      );
      await tester.pumpAndSettle();
      expect(
        find.text('Doğrulama kodu geçersiz veya kullanılmış.'),
        findsOneWidget,
        reason: tester
            .widgetList<Text>(find.byType(Text))
            .map((t) => t.data)
            .join('|'),
      );
      expect(tester.takeException(), isNull);
    });
  }
}
