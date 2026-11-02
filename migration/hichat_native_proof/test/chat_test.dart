import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:hichat_native_proof/app/api.dart';
import 'package:hichat_native_proof/app/chat.dart';
import 'package:hichat_native_proof/app/chat_crypto.dart';
import 'package:hichat_native_proof/app/chat_view.dart';

http.Response ok(Object? data) => http.Response(
  jsonEncode({'success': true, 'data': data}),
  200,
  headers: {'content-type': 'application/json; charset=utf-8'},
);
final channel = <String, dynamic>{
  'e2ee_enabled': true,
  'id': 'dm',
  'other_user': {'id': 'peer', 'display_name': 'Eş'},
};
Map<String, dynamic> message(String id, {Map? payload}) => {
  'id': id,
  'dm_channel_id': 'dm',
  'user_id': 'owner',
  'sender_device_id': 'device',
  'encryption_version': 1,
  'ciphertext': 'cipher',
  'e2ee_metadata': 'meta',
  'source_sequence': id.substring(1),
  'created_at': id,
  ...?payload,
};

class Crypto implements ChatCrypto {
  final log = <String>[];
  Map<String, dynamic>? pending;
  List<Map<String, dynamic>> reviews = [];
  bool? confirmed;
  Object? receivedFileKeys;
  @override
  Future<Map<String, dynamic>> status() async => {'phase': 'active'};
  @override
  Future<void> registerFreshDevice() async {}
  @override
  Future<dynamic> chat(Map<String, dynamic> c) async {
    log.add(c['op'] as String);
    switch (c['op']) {
      case 'inspect':
        return {
          'pending': [?pending],
          'trustAlerts': [],
          'sessionReviews': reviews,
        };
      case 'renew_session_review':
        return reviews.single;
      case 'confirm_session':
        confirmed = c['approved'] as bool;
        if (confirmed!) reviews = [];
        return {'plaintext': '{"content":"restored","file_keys":[]}'};
      case 'prepare':
        pending = {
          'id': c['id'],
          'channel': c['channel'],
          'state': 'prepared',
          'plaintext': c['plaintext'],
          if (c['files'] != null)
            'files': [
              {
                'name': 'encrypted_0.bin',
                'data': base64Encode([0, 1, 255, 42]),
              },
            ],
          'payload': {
            'encryption_version': 1,
            'ciphertext': 'cipher',
            'sender_device_id': 'device',
            'e2ee_metadata': 'meta',
          },
        };
        return pending;
      case 'attempt':
        if (c['automatic'] == true &&
            (pending!['retryBlocked'] == true ||
                (pending!['retryAt'] as int? ?? 0) > (c['now'] as int))) {
          throw StateError('retry_not_due');
        }
        if (pending!['state'] == 'prepared' &&
            c['delivery'] == 'idempotent-v1') {
          pending!['delivery'] = 'idempotent-v1';
          pending!['payload']['client_message_id'] = pending!['id'];
        }
        pending!['state'] = 'attempted';
        pending!['retryBlocked'] = false;
        pending!['attempts'] = (pending!['attempts'] as int? ?? 0) + 1;
        pending!['retryAt'] = (c['now'] as int? ?? 0) + 1000;
        return pending;
      case 'retry_failure':
        pending!['retryAt'] =
            (c['now'] as int) +
            max(1000, (c['retryAfterSeconds'] as int? ?? 0) * 1000);
        pending!['retryBlocked'] = c['blocked'];
        return pending;
      case 'ack':
        pending = null;
        return {'plaintext': '{"content":"sent"}'};
      case 'receive':
        return {
          'plaintext': jsonEncode({
            'content': 'message ${c['message']['id']}',
            'file_keys': receivedFileKeys,
          }),
        };
    }
    throw StateError('Unexpected crypto command');
  }
}

HiChatApi apiFor(
  Future<http.Response> Function(http.Request) handler, {
  bool reliable = false,
}) => HiChatApi(
  'https://example.com',
  client: MockClient((r) async {
    if (r.url.path == '/api/dms/send-capabilities') {
      return reliable
          ? ok({'text_idempotency_version': 1})
          : http.Response('404 page not found', 404);
    }
    return handler(r);
  }),
)..session = const Session('access', 'refresh', 'owner', 'Kullanıcı');

void main() {
  test(
    'malformed attachment metadata cannot block authenticated message history',
    () async {
      for (final metadata in [
        42,
        'bad',
        [
          null,
          'bad',
          {'filename': 42},
          {'filename': 'safe.txt'},
        ],
      ]) {
        final crypto = Crypto()..receivedFileKeys = metadata;
        final api = apiFor(
          (r) async => r.url.path == '/api/dms'
              ? ok([channel])
              : ok({
                  'messages': [message('m1')],
                  'has_more': false,
                }),
        );
        final c = ChatController(
          api,
          () async => crypto,
          pollInterval: const Duration(hours: 1),
          retryInterval: const Duration(hours: 1),
        );
        await c.initialize();
        await c.select(channel);
        expect(c.error, isNull);
        expect(c.messages.single['displayContent'], 'message m1');
        expect(
          c.messages.single['fileKeys'],
          metadata is List
              ? [
                  {'filename': 'safe.txt'},
                ]
              : isEmpty,
        );
        await c.close();
        api.close();
      }
    },
  );

  test('multipart retry keeps encrypted file bytes and refuses old-server downgrade', () async {
    for (final supported in [false, true]) {
      var posts = 0;
      final crypto = Crypto();
      final api = HiChatApi(
        'https://example.com',
        client: MockClient((r) async {
          if (r.url.path.endsWith('send-capabilities')) {
            return ok({
              'text_idempotency_version': 1,
              if (supported) 'multipart_idempotency_version': 1,
            });
          }
          if (r.url.path == '/api/dms') return ok([channel]);
          if (r.url.path.endsWith('/prekey-bundles')) return ok([]);
          if (r.method == 'POST') {
            posts++;
            expect(r.url.path.endsWith('/idempotent'), true);
            expect(
              r.headers['content-type'],
              startsWith('multipart/form-data;'),
            );
            expect(r.bodyBytes, containsAllInOrder([0, 1, 255, 42]));
            expect(latin1.decode(r.bodyBytes), contains('encrypted_0.bin'));
            if (posts == 1) throw http.ClientException('lost acknowledgment');
            return ok(
              message('m1', payload: crypto.pending!['payload'] as Map),
            );
          }
          return ok({'messages': []});
        }),
      )..session = const Session('access', 'refresh', 'owner', 'Owner');
      final c = ChatController(
        api,
        () async => crypto,
        retryInterval: const Duration(hours: 1),
        pollInterval: const Duration(hours: 1),
      );
      await c.initialize();
      c.selected = channel;
      await c.send(
        'attachment',
        files: [
          {
            'name': 'source.txt',
            'mime': 'text/plain',
            'data': base64Encode([42]),
          },
        ],
      );
      if (supported) {
        await c.resumePrepared(crypto.pending!['id'] as String);
        expect(posts, 2);
        expect(c.error, isNull);
      } else {
        expect(posts, 0);
        expect(crypto.pending!['retryBlocked'], true);
        expect(crypto.log, isNot(contains('attempt')));
      }
      await c.close();
      api.close();
    }
  });
  test('session approval requires a matching current public device; cancellation does not', () async {
    for (final registered in [false, true]) {
      final crypto = Crypto()
        ..reviews = [
          {
            'token': 'review',
            'user': 'peer',
            'device': 'device',
            'identityKey': 'identity',
            'messageId': 'm1',
            'channel': 'dm',
          },
        ];
      var rosterReads = 0;
      final api = apiFor((r) async {
        if (r.url.path == '/api/users/peer/devices') {
          rosterReads++;
          return ok(
            registered
                ? [
                    {'device_id': 'device', 'identity_key': 'identity'},
                  ]
                : [],
          );
        }
        return ok([channel]);
      });
      final c = ChatController(
        api,
        () async => crypto,
        retryInterval: const Duration(hours: 1),
        pollInterval: const Duration(hours: 1),
      );
      await c.initialize();
      c.messages = [message('m1')];
      await c.confirmSession('review', true);
      expect(rosterReads, 1);
      if (registered) {
        expect(crypto.confirmed, true);
        expect(c.messages.single['displayContent'], 'restored');
      } else {
        expect(crypto.confirmed, isNull);
        await c.confirmSession('review', false);
        expect(crypto.confirmed, false);
        expect(rosterReads, 1);
      }
      await c.close();
      api.close();
    }
  });
  testWidgets(
    'session confirmation requires the explicit verification checkbox',
    (tester) async {
      final crypto = Crypto()
        ..reviews = [
          {
            'token': 'review',
            'user': 'peer',
            'device': 'device',
            'identityFingerprint': 'fingerprint',
            'fingerprint': 'message',
            'messageId': 'm1',
            'channel': 'dm',
          },
        ];
      final api = apiFor((_) async => ok([channel]));
      final c = ChatController(
        api,
        () async => crypto,
        retryInterval: const Duration(hours: 1),
        pollInterval: const Duration(hours: 1),
      );
      await tester.runAsync(() => c.initialize());
      c.selected = channel;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(body: ChatView(controller: c)),
        ),
      );
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 50)),
      );
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('İncele'));
      await tester.tap(find.text('İncele'));
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 50)),
      );
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<FilledButton>(find.widgetWithText(FilledButton, 'Onayla'))
            .onPressed,
        isNull,
      );
      await tester.tap(find.byType(CheckboxListTile));
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 50)),
      );
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<FilledButton>(find.widgetWithText(FilledButton, 'Onayla'))
            .onPressed,
        isNotNull,
      );
      expect(crypto.confirmed, isNull);
      await tester.tap(find.text('Vazgeç'));
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 50)),
      );
      await tester.pumpAndSettle();
      expect(crypto.confirmed, false);
      await tester.pumpWidget(const SizedBox());
      await tester.runAsync(() async {
        await c.close();
        api.close();
      });
    },
  );

  for (final width in [320.0, 390.0]) {
    testWidgets(
      'chat content is accessible and fits keyboard viewport at $width',
      (tester) async {
        tester.view.physicalSize = Size(width, 640);
        tester.view.devicePixelRatio = 1;
        tester.view.viewInsets = const FakeViewPadding(bottom: 260);
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        addTearDown(tester.view.resetViewInsets);
        final semantics = tester.ensureSemantics();
        final api = apiFor((_) async => ok([channel]));
        final crypto = Crypto();
        final c = ChatController(
          api,
          () async => crypto,
          pollInterval: const Duration(hours: 1),
        );
        c.selected = channel;
        c.messages = [
          {...message('m1'), 'displayContent': 'Mesaj: şğıöçü 👋'},
        ];
        c.pending = [
          {
            'id': 'pending-00000001',
            'state': 'prepared',
            'plaintext': '{"content":"Bekleyen mesaj"}',
          },
        ];
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(body: ChatView(controller: c)),
          ),
        );
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 50)),
        );
        await tester.pumpAndSettle(
          const Duration(milliseconds: 100),
          EnginePhase.sendSemanticsUpdate,
          const Duration(seconds: 3),
        );
        expect(find.bySemanticsLabel(RegExp('Mesaj: şğıöçü 👋')), findsWidgets);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        await tester.runAsync(() async {
          await c.close();
          api.close();
        });
        semantics.dispose();
      },
    );
  }
  test('persist attempt before POST; sent echo cannot skip unfetched incoming rows', () async {
    final crypto = Crypto();
    var reads = 0, posts = 0;
    final api = apiFor((r) async {
      if (r.url.path == '/api/dms') return ok([channel]);
      if (r.url.path.endsWith('/prekey-bundles')) return ok([]);
      if (r.method == 'POST') {
        posts++;
        expect(crypto.log.last, 'attempt');
        return ok(message('m3', payload: jsonDecode(r.body) as Map));
      }
      reads++;
      if (reads == 1) {
        return ok({
          'messages': [message('m1')],
          'has_more': false,
        });
      }
      expect(r.url.queryParameters['after'], 'm1');
      return ok({
        'messages': [message('m2'), message('m3')],
        'has_more_after': false,
      });
    });
    final c = ChatController(
      api,
      () async => crypto,
      pollInterval: const Duration(hours: 1),
    );
    await c.initialize();
    await c.select(channel);
    await c.send('Türkçe 👋');
    await c.refresh();
    expect(c.error, isNull);
    expect(posts, 1);
    expect(c.messages.map((m) => m['id']), ['m1', 'm2', 'm3']);
    await c.close();
    api.close();
  });
  test('ambiguous network result is retained and reconciled without duplicate POST', () async {
    final crypto = Crypto();
    var posts = 0, delivered = false;
    final api = apiFor((r) async {
      if (r.url.path == '/api/dms') return ok([channel]);
      if (r.url.path.endsWith('/prekey-bundles')) return ok([]);
      if (r.method == 'POST') {
        posts++;
        delivered = true;
        throw http.ClientException('connection lost after commit');
      }
      return ok({
        'messages': delivered ? [message('m1')] : [],
        'has_more': false,
      });
    });
    final c = ChatController(
      api,
      () async => crypto,
      pollInterval: const Duration(hours: 1),
    );
    await c.initialize();
    await c.select(channel);
    await c.send('keep me');
    expect(c.pending.single['state'], 'attempted');
    expect(c.error, contains('doğrulanmadı'));
    await c.retryPending();
    expect(posts, 1);
    await c.refresh();
    await c.refresh();
    expect(posts, 1);
    expect(c.pending, isEmpty);
    expect(c.messages.length, 1);
    await c.close();
    api.close();
  });
  test(
    'idempotent endpoint retry reuses durable bytes after lost response',
    () async {
      final crypto = Crypto(), bodies = <String>[];
      final api = apiFor((r) async {
        if (r.url.path == '/api/dms') return ok([channel]);
        if (r.url.path.endsWith('/prekey-bundles')) return ok([]);
        if (r.method == 'POST') {
          expect(r.url.path, '/api/dms/dm/messages/idempotent');
          bodies.add(r.body);
          if (bodies.length == 1) throw http.ClientException('response lost');
          return ok(message('m1', payload: jsonDecode(r.body) as Map));
        }
        return ok({'messages': [], 'has_more': false});
      }, reliable: true);
      final c = ChatController(
        api,
        () async => crypto,
        pollInterval: const Duration(hours: 1),
      );
      await c.initialize();
      await c.select(channel);
      await c.send('durable');
      expect(c.pending.single['delivery'], 'idempotent-v1');
      await c.resumePrepared(c.pending.single['id'] as String);
      expect(bodies.length, 2);
      expect(bodies[0], bodies[1]);
      expect(c.pending, isEmpty);
      expect(c.error, isNull);
      await c.close();
      api.close();
    },
  );
  test(
    'automatic retry honors durable deadline without a selected conversation',
    () async {
      final crypto = Crypto(), bodies = <String>[];
      var time = DateTime.utc(2030);
      final api = apiFor((r) async {
        if (r.url.path == '/api/dms') return ok([channel]);
        if (r.url.path.endsWith('/prekey-bundles')) return ok([]);
        if (r.method == 'POST') {
          bodies.add(r.body);
          if (bodies.length == 1) throw http.ClientException('response lost');
          return ok(message('m1', payload: jsonDecode(r.body) as Map));
        }
        return ok({'messages': [], 'has_more': false});
      }, reliable: true);
      final c = ChatController(
        api,
        () async => crypto,
        clock: () => time,
        retryInterval: const Duration(hours: 1),
        pollInterval: const Duration(hours: 1),
      );
      await c.initialize();
      await c.select(channel);
      await c.send('durable');
      c.selected = null;
      await c.retryPending();
      expect(bodies.length, 1);
      time = time.add(const Duration(seconds: 2));
      await c.retryPending();
      expect(bodies.length, 2);
      expect(bodies[0], bodies[1]);
      expect(c.pending, isEmpty);
      await c.close();
      api.close();
    },
  );
  test('Retry-After survives scheduler restart and permanent rejection stops automatic POSTs', () async {
    final crypto = Crypto();
    var time = DateTime.utc(2030), posts = 0;
    final api = apiFor((r) async {
      if (r.url.path == '/api/dms') return ok([channel]);
      if (r.url.path.endsWith('/prekey-bundles')) return ok([]);
      if (r.method == 'POST') {
        posts++;
        return http.Response(
          '{"success":false,"code":"THROTTLED"}',
          posts == 1 ? 429 : 409,
          headers: {'retry-after': '20'},
        );
      }
      return ok({'messages': [], 'has_more': false});
    }, reliable: true);
    ChatController make() => ChatController(
      api,
      () async => crypto,
      clock: () => time,
      retryInterval: const Duration(hours: 1),
      pollInterval: const Duration(hours: 1),
    );
    var c = make();
    await c.initialize();
    await c.select(channel);
    await c.send('persist');
    await c.close();
    c = make();
    await c.initialize();
    time = time.add(const Duration(seconds: 19));
    await c.retryPending();
    expect(posts, 1);
    time = time.add(const Duration(seconds: 2));
    await c.retryPending();
    expect(posts, 2);
    expect(c.pending.single['retryBlocked'], true);
    time = time.add(const Duration(days: 1));
    await c.retryPending();
    expect(posts, 2);
    await c.close();
    api.close();
  });
  test(
    'logout fences an in-flight automatic retry and its late acknowledgment',
    () async {
      final crypto = Crypto(),
          late = Completer<http.Response>(),
          started = Completer<void>();
      var time = DateTime.utc(2030), posts = 0;
      final api = apiFor((r) async {
        if (r.url.path == '/api/auth/logout') return ok(null);
        if (r.url.path == '/api/dms') return ok([channel]);
        if (r.url.path.endsWith('/prekey-bundles')) return ok([]);
        if (r.method == 'POST') {
          posts++;
          if (posts == 1) throw http.ClientException('response lost');
          started.complete();
          return late.future;
        }
        return ok({'messages': [], 'has_more': false});
      }, reliable: true);
      final c = ChatController(
        api,
        () async => crypto,
        clock: () => time,
        retryInterval: const Duration(hours: 1),
        pollInterval: const Duration(hours: 1),
      );
      await c.initialize();
      await c.select(channel);
      await c.send('protected');
      time = time.add(const Duration(seconds: 2));
      final retry = c.retryPending();
      await started.future;
      await api.logout();
      late.complete(ok(message('m1')));
      await retry;
      expect(crypto.log, isNot(contains('ack')));
      expect(c.messages, isEmpty);
      expect(c.pending, isEmpty);
      expect(posts, 2);
      await c.retryPending();
      expect(posts, 2);
      await c.close();
      api.close();
    },
  );
  test('initial offline protected-store lookup recovers without opening messages UI', () async {
    final crypto = Crypto();
    var opens = 0, time = DateTime.utc(2030);
    final api = apiFor((_) async => ok([channel]));
    final c = ChatController(
      api,
      () async {
        opens++;
        if (opens == 1) throw const ApiFailure('NETWORK_ERROR');
        return crypto;
      },
      clock: () => time,
      retryInterval: const Duration(hours: 1),
      pollInterval: const Duration(hours: 1),
    );
    await c.initialize();
    expect(opens, 1);
    await c.retryPending();
    expect(opens, 1);
    time = time.add(const Duration(seconds: 5));
    await c.retryPending();
    expect(opens, 2);
    expect(c.active, true);
    expect(c.selected, isNull);
    await c.initialize();
    expect(opens, 2);
    await c.close();
    api.close();
  });
  test(
    'late history cannot expose previous account content after invalidation',
    () async {
      final crypto = Crypto(), response = Completer<http.Response>();
      final api = apiFor((r) async {
        if (r.url.path == '/api/dms') return ok([channel]);
        if (r.url.path == '/api/auth/logout') return ok(null);
        return response.future;
      });
      final c = ChatController(
        api,
        () async => crypto,
        pollInterval: const Duration(hours: 1),
      );
      await c.initialize();
      final load = c.select(channel);
      await Future<void>.delayed(Duration.zero);
      await api.logout();
      response.complete(
        ok({
          'messages': [message('m1')],
        }),
      );
      await load;
      expect(c.messages, isEmpty);
      expect(c.channels, isEmpty);
      expect(crypto.log, isNot(contains('receive')));
      await c.close();
      api.close();
    },
  );
  test(
    'query parameters survive token refresh without being encoded into path',
    () async {
      var reads = 0;
      final api = apiFor((r) async {
        if (r.url.path == '/api/auth/refresh') {
          return ok({
            'access_token': 'new',
            'refresh_token': 'rotated',
            'user': {'id': 'owner'},
          });
        }
        expect(r.url.path, '/api/dms/dm/messages');
        expect(r.url.queryParameters['after'], 'message /? ü');
        reads++;
        if (reads == 1) return http.Response('{"success":false}', 401);
        return ok({'messages': []});
      });
      await api.request(
        'GET',
        '/api/dms/dm/messages',
        query: {'after': 'message /? ü', 'limit': '50'},
      );
      expect(reads, 2);
      api.close();
    },
  );
}
