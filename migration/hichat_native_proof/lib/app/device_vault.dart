import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import '../src/rust/api/simple.dart' as rust;
import 'api.dart';
import 'device_store.dart';
import 'chat_crypto.dart';

class DeviceVault implements ChatCrypto {
  final HiChatApi api;
  final DeviceStore store;
  final int authScope;
  Future<void> _tail = Future.value();
  bool _closing = false;
  Future<void>? _closeFuture;
  StreamSubscription<void>? _auth;
  DeviceVault._(this.api, this.store, this.authScope) {
    _auth = api.invalidations.listen((_) => unawaited(close()));
  }
  void current() {
    if (_closing || !api.isCurrent(authScope)) {
      throw const ApiFailure('SESSION_CHANGED');
    }
  }

  Future<T> _serial<T>(Future<T> Function() action) {
    final result = _tail.then((_) async {
      current();
      return action();
    });
    _tail = result.then<void>((_) {}, onError: (Object _) {});
    return result;
  }

  static Uint8List randomBytes(int n) {
    final r = Random.secure();
    return Uint8List.fromList(List.generate(n, (_) => r.nextInt(256)));
  }

  static Future<DeviceVault> open(HiChatApi api) async {
    final scope = api.generation, owner = api.session?.userId;
    if (owner == null) throw const ApiFailure('LOGIN_REQUIRED');
    final key = jsonEncode([api.origin.toString(), owner]);
    final store = await DeviceStore.open(key);
    if (!api.isCurrent(scope)) {
      await store.close();
      throw const ApiFailure('SESSION_CHANGED');
    }
    final vault = DeviceVault._(api, store, scope);
    try {
      if (await store.load() == null) {
        final private = randomBytes(32);
        final public = await rust.transferPublicKey(private: private);
        vault.current();
        final id = randomBytes(32)
            .map((b) => b.toRadixString(16).padLeft(2, '0'))
            .join();
        await store.save({
          'version': 1,
          'revision': 0,
          'phase': 'intent',
          'private': base64Encode(private),
          'intent': {
            'version': 1,
            'intentId': id,
            'owner': owner,
            'backend': api.origin.toString(),
            'publicKey': public,
          },
        });
        private.fillRange(0, 32, 0);
      }
      final saved = await store.load();
      if (saved?['version'] != 1 ||
          saved?['intent']?['owner'] != owner ||
          saved?['intent']?['backend'] != api.origin.toString() ||
          ![
            'intent',
            'registering',
            'dormant',
            'active',
          ].contains(saved?['phase'])) {
        throw const ApiFailure('INVALID_DEVICE_STORE');
      }
      if (saved?['phase'] == 'active') {
        await vault._verify(saved!);
      }
      if (saved?['phase'] == 'registering') {
        await vault._finishRegistration(saved!);
      }
      if (saved?['phase'] == 'dormant') {
        await vault._verify(saved!);
        vault.current();
        saved['phase'] = 'active';
        saved.remove('private');
        saved['revision'] = (saved['revision'] as int) + 1;
        await store.save(saved);
      }
      vault.current();
      return vault;
    } catch (_) {
      await vault.close();
      rethrow;
    }
  }

  @override
  Future<Map<String, dynamic>> status() => _serial(() async {
    final d = (await store.load())!;
    current();
    return {
      'phase': d['phase'],
      'revision': d['revision'],
      'intent': d['intent'],
      if (d['snapshot'] != null)
        'deviceId': _registration(
          jsonDecode(d['snapshot'] as String),
        )['deviceId'],
    };
  });
  static Map _registration(dynamic snapshot) =>
      (snapshot['stores']['registration'] as List).firstWhere(
            (r) => r['key'] == 'primary',
          )['value']
          as Map;
  Future<void> _verify(Map<String, dynamic> d) async {
    final devices = await api.request('GET', '/api/devices') as List? ?? [];
    current();
    await rust.verifyTransferredRoster(
      snapshot: d['snapshot'] as String,
      roster: jsonEncode(devices),
    );
    current();
  }

  Future<void> _finishRegistration(Map<String, dynamic> d) async {
    final registration = _registration(jsonDecode(d['snapshot'] as String));
    final devices = await api.request('GET', '/api/devices') as List? ?? [];
    current();
    if (!devices.any((r) => r['device_id'] == registration['deviceId'])) {
      await api.request('POST', '/api/devices', body: d['registrationBody']);
      current();
    }
    await _verify(d);
    current();
    d['phase'] = 'active';
    d.remove('private');
    d.remove('registrationBody');
    d['revision'] = (d['revision'] as int) + 1;
    await store.save(d);
    current();
  }

  /// New identity, independent of the old client's ratchets and history.
  @override
  Future<void> registerFreshDevice() => _serial(() async {
    final d = (await store.load())!;
    if (d['phase'] == 'registering') return _finishRegistration(d);
    if (d['phase'] != 'intent') throw const ApiFailure('DEVICE_ALREADY_ACTIVE');
    final device = randomBytes(16)
        .map((b) => b.toRadixString(16).padLeft(2, '0'))
        .join();
    final result = jsonDecode(
      await rust.chatTransition(
        snapshot: '{}',
        command: jsonEncode({
          'op': 'initialize',
          'owner': api.session!.userId,
          'device': device,
        }),
        entropy: randomBytes(32),
      ),
    ) as Map<String, dynamic>;
    current();
    d['snapshot'] = jsonEncode(result['snapshot']);
    d['registrationBody'] = result['registration'];
    d['phase'] = 'registering';
    d['revision'] = (d['revision'] as int) + 1;
    // Save keys before any registration request. Restart reuses this identity.
    await store.save(d);
    current();
    await _finishRegistration(d);
  });

  @override
  Future<dynamic> chat(Map<String, dynamic> command) => _serial(() async {
    final d = (await store.load())!;
    if (d['phase'] != 'active') throw const ApiFailure('DEVICE_NOT_ACTIVE');
    if (command['op'] == 'prepare' ||
        command['op'] == 'attempt' ||
        command['op'] == 'confirm_session') {
      await _verify(d);
      current();
    }
    final result = jsonDecode(
      await rust.chatTransition(
        snapshot: d['snapshot'] as String,
        command: jsonEncode(command),
        entropy: randomBytes(32),
      ),
    ) as Map<String, dynamic>;
    current();
    final next = jsonEncode(result['snapshot']);
    if (d['snapshot'] != next) {
      d['snapshot'] = next;
      d['revision'] = (d['revision'] as int) + 1;
      await store.save(d);
    }
    current();
    return result['output'];
  });

  Future<Map<String, dynamic>> importCapsule(String capsule) =>
      _serial(() async {
        final d = (await store.load())!;
        current();
        final c = jsonDecode(capsule) as Map;
        final hash = await rust.deviceScopeId(
          scope: jsonEncode([
            for (final k in [
              'version',
              'intentId',
              'owner',
              'backend',
              'sourceDeviceId',
              'targetPublicKey',
              'ephemeralKey',
              'salt',
              'nonce',
              'ciphertext',
            ])
              c[k],
          ]),
        );
        current();
        if (d['phase'] == 'active') {
          if (d['capsuleHash'] != hash) {
            throw const ApiFailure('DEVICE_ALREADY_ACTIVE');
          }
          return {'status': 'already-imported'};
        }
        if (d['phase'] == 'intent') {
          final private = base64Decode(d['private'] as String);
          late String plain;
          try {
            plain = await rust.openDeviceCapsule(
              capsule: capsule,
              private: private,
              intent: jsonEncode(d['intent']),
            );
          } finally {
            private.fillRange(0, private.length, 0);
          }
          current();
          d['snapshot'] = plain;
          d['capsuleHash'] = hash;
          d['phase'] = 'dormant';
          d['revision'] = (d['revision'] as int) + 1;
          await _verify(d);
          current();
          await store.save(d);
          // Read back the protected durable snapshot before granting ownership.
          final saved = (await store.load())!;
          if (saved['capsuleHash'] != hash || saved['snapshot'] != plain) {
            throw const ApiFailure('TRANSFER_READBACK_FAILED');
          }
        } else if (d['capsuleHash'] != hash) {
          throw const ApiFailure('TRANSFER_CONFLICT');
        }
        await _verify(d);
        current();
        d['phase'] = 'active';
        d.remove('private');
        d['revision'] = (d['revision'] as int) + 1;
        await store.save(d);
        current();
        final snapshot = jsonDecode(d['snapshot'] as String);
        return {
          'status': 'imported',
          'deviceId': _registration(snapshot)['deviceId'],
          'sessions': (snapshot['stores']['sessions'] as List).length,
          'pending': (snapshot['portablePending'] as List).length,
        };
      });
  Future<Map<String, dynamic>> preparePeer(
    String user,
    String device,
    String id,
    String plaintext,
  ) => _serial(() async {
    final d = (await store.load())!;
    if (d['phase'] != 'active') throw const ApiFailure('DEVICE_NOT_ACTIVE');
    current();
    final result = jsonDecode(
      await rust.prepareTransferredPeer(
        snapshot: d['snapshot'] as String,
        user: user,
        device: device,
        id: id,
        plaintext: plaintext,
        nonce: randomBytes(12),
      ),
    ) as Map<String, dynamic>;
    current();
    d['snapshot'] = jsonEncode(result['snapshot']);
    d['revision'] = (d['revision'] as int) + 1;
    await store.save(d);
    current();
    return result['request'] as Map<String, dynamic>;
  });
  Future<void> close() => _closeFuture ??= _close();
  Future<void> _close() async {
    if (_closing) return;
    _closing = true;
    await _auth?.cancel();
    await _tail;
    await store.close();
  }
}
