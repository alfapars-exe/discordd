import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:hichat_native_proof/app/api.dart';

void main() {
  test('matches Go cookie-only login, rotation and logout contract', () async {
    var refreshed = false;
    final api = HiChatApi(
      'https://example.com',
      client: MockClient((r) async {
        expect(r.headers['X-HiChat-Client'], 'web');
        Object? data;
        String? cookie;
        if (r.url.path.endsWith('/login')) {
          data = {
            'access_token': 'expired',
            'user': {'id': 'u1', 'display_name': 'User'},
          };
          cookie = 'hichat_refresh=original; Path=/api/auth; Secure; HttpOnly; SameSite=Strict';
        } else if (r.url.path.endsWith('/refresh')) {
          expect(r.headers['cookie'], 'hichat_refresh=original');
          data = {'access_token': 'fresh'};
          cookie = 'hichat_refresh=rotated; Path=/api/auth; Secure; HttpOnly';
          refreshed = true;
        } else if (r.url.path.endsWith('/logout')) {
          expect(r.headers['cookie'], 'hichat_refresh=rotated');
          expect(jsonDecode(r.body)['expected_user_id'], 'u1');
          cookie = 'hichat_refresh=; Max-Age=0; Path=/api/auth';
        } else {
          expect(r.headers.containsKey('cookie'), isFalse);
          if (!refreshed) return http.Response('{"success":false}', 401);
          data = [];
        }
        return http.Response(
          jsonEncode({'success': true, 'data': data}),
          200,
          headers: {
            'set-cookie': ?cookie,
            'content-type': 'application/json; charset=utf-8',
          },
        );
      }),
    );
    await api.login('u', 'p');
    expect(api.session!.refreshToken, isEmpty);
    await api.request('GET', '/api/servers');
    expect(refreshed, isTrue);
    await api.logout();
    expect(api.session, isNull);
    api.close();
  });
}
