import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:hichat_native_proof/src/rust/frb_generated.dart';
import 'package:hichat_native_proof/app/api.dart';
import 'package:hichat_native_proof/app/chat.dart';
import 'package:hichat_native_proof/app/device_vault.dart';

class ExpiredAccessFixture extends http.BaseClient {
  final inner = http.Client();
  bool armed = false, injected = false;
  int refreshes = 0;
  bool dropNextSend = false;
  final sendBodies = <String>[];
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    if (armed &&
        !injected &&
        request.method == 'GET' &&
        request.url.path == '/api/devices') {
      injected = true;
      return http.StreamedResponse(
        Stream.value(utf8.encode('{"success":false}')),
        401,
      );
    }
    if (request.url.path == '/api/auth/refresh') {
      refreshes++;
    }
    if (request.method == 'POST' &&
        request.url.path.endsWith('/messages/idempotent')) {
      sendBodies.add((request as http.Request).body);
      final response = await inner.send(request);
      if (dropNextSend) {
        dropNextSend = false;
        expect(response.statusCode, 201);
        await response.stream.drain<void>();
        throw http.ClientException('fixture discards committed response');
      }
      return response;
    }
    return inner.send(request);
  }

  @override
  void close() {
    inner.close();
  }
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'real Go PostgreSQL DM through Rust FFI survives DPAPI reopen and DH turns',
    (tester) async {
      await RustLib.init();
      final file = File(const String.fromEnvironment('HICHAT_CHAT_QA_FILE'));
      final fixture = jsonDecode(await file.readAsString()) as Map;
      final users = fixture['users'] as List;
      final apis = <HiChatApi>[],
          vaults = <DeviceVault>[],
          chats = <ChatController>[];
      final transports = <ExpiredAccessFixture>[];
      try {
        for (final u in users) {
          final transport = ExpiredAccessFixture();
          transports.add(transport);
          final api = HiChatApi('http://127.0.0.1:19090', client: transport);
          apis.add(api);
          await api.login(u['username'] as String, u['password'] as String);
          final sessionId = api.session!.sessionId;
          expect(sessionId, isNotEmpty);
          transport.armed = true;
          final vault = await DeviceVault.open(api);
          vaults.add(vault);
          if ((await vault.status())['phase'] == 'intent') {
            await vault.registerFreshDevice();
          }
          expect(transport.injected, true);
          expect(transport.refreshes, 1);
          expect(api.session!.sessionId, sessionId);
          final chat = ChatController(
            api,
            () async => vault,
            pollInterval: const Duration(hours: 1),
          );
          chats.add(chat);
          await chat.initialize();
          expect(chat.error, isNull);
          final channel = chat.channels.singleWhere(
            (r) => r['id'] == fixture['channelId'],
          );
          await chat.select(channel);
          expect(chat.error, isNull);
        }
        transports[0].dropNextSend = true;
        await chats[0].send('Rust Windows → eş: şğıöçü 👋');
        expect(chats[0].error, isNotNull);
        final pendingId = chats[0].pending.single['id'] as String;
        expect(chats[0].pending.single['delivery'], 'idempotent-v1');
        await chats[0].close();
        await vaults[0].close();
        vaults[0] = await DeviceVault.open(apis[0]);
        final resumed = ChatController(
          apis[0],
          () async => vaults[0],
          pollInterval: const Duration(hours: 1),
        );
        chats[0] = resumed;
        await resumed.initialize();
        await resumed.resumePrepared(pendingId);
        expect(resumed.error, isNull);
        expect(transports[0].sendBodies.length, 2);
        expect(transports[0].sendBodies[0], transports[0].sendBodies[1]);
        await resumed.select(
          resumed.channels.singleWhere((r) => r['id'] == fixture['channelId']),
        );
        expect(chats[0].error, isNull);
        await chats[1].refresh();
        expect(chats[1].error, isNull);
        expect(
          chats[1].messages.last['displayContent'],
          'Rust Windows → eş: şğıöçü 👋',
        );
        await chats[1].send('DH yanıtı 🔐');
        expect(chats[1].error, isNull);
        await chats[0].refresh();
        expect(chats[0].error, isNull);
        expect(chats[0].messages.last['displayContent'], 'DH yanıtı 🔐');
        final device = (await vaults[0].status())['deviceId'];
        await chats[0].close();
        await vaults[0].close();
        final reopened = await DeviceVault.open(apis[0]);
        vaults[0] = reopened;
        expect((await reopened.status())['deviceId'], device);
        final next = ChatController(
          apis[0],
          () async => reopened,
          pollInterval: const Duration(hours: 1),
        );
        chats[0] = next;
        await next.initialize();
        await next.select(
          next.channels.singleWhere((r) => r['id'] == fixture['channelId']),
        );
        expect(
          next.messages.first['displayContent'],
          'Rust Windows → eş: şğıöçü 👋',
        );
        expect(next.messages.last['displayContent'], 'DH yanıtı 🔐');
        await next.send('Yeniden açıldıktan sonra');
        expect(next.error, isNull);
        await chats[1].refresh();
        expect(chats[1].error, isNull);
        expect(
          chats[1].messages.last['displayContent'],
          'Yeniden açıldıktan sonra',
        );
        await expectLater(DeviceVault.open(apis[0]), throwsA(anything));
        final remote = await apis[0].request(
          'GET',
          '/api/dms/${fixture['channelId']}/messages',
        ) as Map;
        expect((remote['messages'] as List).length, 3);
        for (final m in remote['messages'] as List) {
          expect(m['content'], isNull);
          expect(m['encryption_version'], 1);
        }
        await File('${file.parent.path}/chat-windows-receipt.json')
            .writeAsString(
              jsonEncode({
                'realGoAPI': true,
                'postgresMutualTLS': true,
                'rustFFI': true,
                'freshDeviceRegistration': true,
                'bidirectionalEncryptedDM': true,
                'dhTurn': true,
                'dpapiReopen': true,
                'secondOwnerExcluded': true,
                'lostResponseAfterCommit': true,
                'durableIdempotentRetryAfterReopen': true,
                'identicalRetryPOSTBytes': true,
                'serverMessages': 3,
                'physicalDevices': false,
              }),
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
  );
}
