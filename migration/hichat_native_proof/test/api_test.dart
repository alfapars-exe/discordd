import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:hichat_native_proof/app/api.dart';

http.Response ok(Object? data) => http.Response(
  jsonEncode({'success': true, 'data': data}),
  200,
  headers: {'content-type': 'application/json; charset=utf-8'},
);
Map<String, dynamic> tokens(String access) => {
  'access_token': access,
  'refresh_token': 'refresh',
  'user': {'id': 'u1', 'display_name': 'İstanbul'},
};
void main() {
  test('requires secure origins and accepts local development', () {
    for (final input in [
      'http://example.com',
      'https://user:password@example.com',
      'https://example.com/path',
      'https://example.com?token=x',
    ]) {
      expect(() => normalizeOrigin(input), throwsA(isA<ApiFailure>()));
    }
    expect(normalizeOrigin('https://example.com/api').path, '');
    expect(normalizeOrigin('http://127.0.0.1:19090').port, 19090);
  });
  test(
    'MFA is forwarded and redirects are refused without leaking credentials',
    () async {
      final api = HiChatApi(
        'https://example.com',
        client: MockClient((r) async {
          expect(r.followRedirects, isFalse);
          expect(jsonDecode(r.body)['mfa_code'], '123456');
          return http.Response(
            jsonEncode({'success': false, 'code': 'MFA_INVALID'}),
            401,
          );
        }),
      );
      await expectLater(
        api.login(' user ', 'secret', mfa: '123456'),
        throwsA(isA<ApiFailure>().having((e) => e.code, 'code', 'MFA_INVALID')),
      );
      expect(api.session, isNull);
    },
  );
  test('concurrent expired requests share exactly one refresh', () async {
    int refreshes = 0;
    final gate = Completer<void>();
    final api = HiChatApi(
      'https://example.com',
      client: MockClient((r) async {
        if (r.url.path.endsWith('/login')) return ok(tokens('expired'));
        if (r.url.path.endsWith('/refresh')) {
          refreshes++;
          await gate.future;
          return ok({'access_token': 'fresh', 'refresh_token': 'rotated'});
        }
        if (r.headers['Authorization'] == 'Bearer expired') {
          return http.Response('{"success":false}', 401);
        }
        expect(r.headers['Authorization'], 'Bearer fresh');
        return ok([]);
      }),
    );
    await api.login('u', 'p');
    final a = api.request('GET', '/api/servers');
    final b = api.request('GET', '/api/servers');
    await Future<void>.delayed(const Duration(milliseconds: 20));
    gate.complete();
    await Future.wait([a, b]);
    expect(refreshes, 1);
  });
  test('late login response cannot resurrect a signed-out session', () async {
    final gate = Completer<http.Response>();
    final api = HiChatApi(
      'https://example.com',
      client: MockClient((r) => gate.future),
    );
    final login = api.login('u', 'p');
    final rejected = expectLater(
      login,
      throwsA(
        isA<ApiFailure>().having((e) => e.code, 'code', 'SESSION_CHANGED'),
      ),
    );
    await api.logout();
    gate.complete(ok(tokens('late')));
    await rejected;
    expect(api.session, isNull);
  });
  test('late account data cannot cross logout boundary', () async {
    final gate = Completer<http.Response>();
    final api = HiChatApi(
      'https://example.com',
      client: MockClient((r) async {
        if (r.url.path.endsWith('/login')) return ok(tokens('access'));
        if (r.url.path.endsWith('/logout')) return ok(null);
        return gate.future;
      }),
    );
    await api.login('u', 'p');
    final pending = api.request('GET', '/api/e2ee/key-backup');
    final rejected = expectLater(
      pending,
      throwsA(
        isA<ApiFailure>().having((e) => e.code, 'code', 'SESSION_CHANGED'),
      ),
    );
    await api.logout();
    gate.complete(ok({'private': 'old-account'}));
    await rejected;
  });
}
