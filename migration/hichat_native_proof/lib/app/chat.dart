import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';

import 'api.dart';
import 'chat_crypto.dart';

/// Uses the existing Go REST contract; crypto and durable outbox live in Rust.
/// The legacy DM endpoint is not idempotent. A possibly committed POST is never
/// automatically repeated: matching history can reconcile it after reconnect.
class ChatController extends ChangeNotifier {
  final HiChatApi api;
  final Future<ChatCrypto> Function() open;
  final int authScope;
  final Duration pollInterval;
  final Duration retryInterval;
  final DateTime Function() now;
  late final StreamSubscription<void> _auth;
  Timer? _poll;
  Timer? _retry;
  bool _retryQueued = false;
  bool _initialized = false, _initializationPaused = false;
  int _initializationFailures = 0, _initializeAt = 0;
  Future<void> _tail = Future.value();
  bool _closed = false;
  int _selection = 0;
  String? _after;
  bool busy = false, active = false, hasMore = false;
  String? error;
  String? lastPreparedId;
  Map<String, dynamic>? selected;
  List<Map<String, dynamic>> channels = [],
      messages = [],
      pending = [],
      trustAlerts = [];
  ChatController(
    this.api,
    this.open, {
    this.pollInterval = const Duration(seconds: 5),
    this.retryInterval = const Duration(seconds: 1),
    DateTime Function()? clock,
  }) : authScope = api.generation,
       now = clock ?? DateTime.now {
    _auth = api.invalidations.listen((_) => unawaited(close()));
    _retry = Timer.periodic(retryInterval, (_) {
      unawaited(retryPending());
    });
  }
  bool get current => !_closed && api.isCurrent(authScope);
  void _check() {
    if (!current) throw const ApiFailure('SESSION_CHANGED');
  }

  void _changed() {
    if (current) notifyListeners();
  }

  Future<void> _run(Future<void> Function() action) {
    final result = _tail.then((_) async {
      _check();
      busy = true;
      error = null;
      _changed();
      try {
        await action();
      } catch (e) {
        if (current) error = messageFor(e);
      } finally {
        busy = false;
        _changed();
      }
    });
    _tail = result.catchError((Object _) {});
    return result;
  }

  static String messageFor(Object e) {
    final code = e is ApiFailure ? e.code : e.toString();
    if (code.contains('identity_changed')) {
      return 'Karşı cihazın kimliği değişti. Gönderim durduruldu; kimliği karşı tarafla doğrulayın.';
    }
    if (code.contains('DEVICE_NOT_ACTIVE')) {
      return 'Önce cihaz devrini tamamlayın veya yeni bir cihaz oluşturun.';
    }
    if (code.contains('recipient_no_keys') ||
        code.contains('incompatible_device')) {
      return 'Alıcının uyumlu şifreleme cihazı bulunamadı. Mesaj şifresiz gönderilmedi.';
    }
    if (code.contains('SESSION_CHANGED')) {
      return 'Oturum değişti. Tekrar giriş yapın.';
    }
    if (code.contains('DELIVERY_UNCERTAIN')) {
      return 'Gönderim sonucu doğrulanamadı. Mesaj korunuyor; geçmiş eşitlendiğinde yeniden kontrol edilecek. Yinelenmeyi önlemek için otomatik tekrar gönderilmez.';
    }
    if (code.contains('DELIVERY_PAUSED')) {
      return 'Otomatik gönderim durduruldu. Mesaj korunuyor; hesap, cihaz ve izinleri kontrol edin.';
    }
    return 'İşlem tamamlanamadı. Bağlantıyı ve cihaz durumunu kontrol edip tekrar deneyin.';
  }

  static bool _permanentFailure(Object e) {
    if (e is! ApiFailure) return true;
    if ([400, 401, 403, 404, 405, 409, 410, 422].contains(e.status)) {
      return true;
    }
    return e.status == 0 &&
        ![
          'NETWORK_ERROR',
          'REQUEST_TIMEOUT',
          'INVALID_RESPONSE',
        ].contains(e.code);
  }

  Future<ChatCrypto> _vault() async {
    final v = await open();
    _check();
    return v;
  }

  Future<void> initialize() => _run(_initialize);
  Future<void> _initialize() async {
    if (_initialized) return;
    try {
      final v = await _vault();
      active = (await v.status())['phase'] == 'active';
      _check();
      channels = _maps(await api.request('GET', '/api/dms'));
      _check();
      if (active) await _outbox(v);
      _poll ??= Timer.periodic(pollInterval, (_) {
        if (!current || busy || selected == null || !active) return;
        unawaited(refresh());
      });
      _initialized = true;
      _initializationFailures = 0;
      _initializationPaused = false;
    } catch (e) {
      _initializationFailures++;
      final backoff = min(
        250000,
        1000 * (1 << min(_initializationFailures, 8)),
      );
      final retryAfter = e is ApiFailure ? e.retryAfterSeconds * 1000 : 0;
      _initializeAt =
          now().millisecondsSinceEpoch +
          max(backoff, retryAfter).toInt() +
          Random.secure().nextInt(201);
      _initializationPaused = _permanentFailure(e);
      rethrow;
    }
  }

  Future<void> register() => _run(() async {
    final v = await _vault();
    await v.registerFreshDevice();
    _check();
    active = true;
    await _outbox(v);
  });
  static List<Map<String, dynamic>> _maps(dynamic rows) => (rows as List? ?? [])
      .map((r) => Map<String, dynamic>.from(r as Map))
      .toList();
  Future<void> _outbox(ChatCrypto v) async {
    final state = await v.chat({'op': 'inspect'}) as Map;
    _check();
    pending = _maps(state['pending'])
        .where((p) => p['state'] != 'acknowledged')
        .toList();
    trustAlerts = _maps(state['trustAlerts']);
  }

  Future<void> create(String user) => _run(() async {
    final row = await api.request(
      'POST',
      '/api/dms',
      body: {'user_id': user.trim()},
    );
    _check();
    final channel = Map<String, dynamic>.from(row as Map);
    channels = [channel, ...channels.where((c) => c['id'] != channel['id'])];
    selected = channel;
    _selection++;
    messages = [];
    _after = null;
  });
  Future<void> select(Map<String, dynamic> channel) async {
    selected = channel;
    _selection++;
    messages = [];
    _after = null;
    hasMore = false;
    _changed();
    await refresh();
  }

  Future<void> refresh({bool older = false}) {
    final epoch = _selection, channel = selected?['id'] as String?;
    return _run(() async {
      if (channel == null || epoch != _selection) return;
      final query = <String, String>{'limit': '50'};
      if (older && messages.isNotEmpty) {
        query['before'] = messages.first['id'] as String;
      }
      // Read every intervening message in order after reconnect, not just last 50.
      if (!older && _after != null) {
        query['after'] = _after!;
      }
      final page = await api.request(
        'GET',
        '/api/dms/${Uri.encodeComponent(channel)}/messages',
        query: query,
      ) as Map;
      _check();
      if (epoch != _selection) return;
      final v = await _vault();
      active = (await v.status())['phase'] == 'active';
      _check();
      final rows = _maps(page['messages']);
      if (rows.isEmpty && !older && query['after'] != null) return;
      for (final m in rows) {
        if (m['dm_channel_id'] != channel) {
          throw const ApiFailure('MESSAGE_SCOPE_MISMATCH');
        }
        String? content;
        if (m['encryption_version'] == 0) {
          content = m['content'] as String?;
        } else if (active) {
          try {
            final decoded =
                await v.chat({'op': 'receive', 'message': m}) as Map;
            _check();
            if (epoch != _selection) return;
            final payload = jsonDecode(decoded['plaintext'] as String) as Map;
            content = payload['content'] as String;
          } catch (e) {
            const unreadable = [
              'session_missing',
              'recipient_envelope_missing_or_ambiguous',
              'sent_plaintext_unavailable',
              'prekey_missing',
              'authentication_failed',
              'message_replay',
              'invalid_payload',
            ];
            if (!unreadable.any(e.toString().contains)) rethrow;
          }
        }
        _check();
        if (epoch != _selection) return;
        messages = [
          ...messages.where((old) => old['id'] != m['id']),
          {...m, 'displayContent': content},
        ];
      }
      messages.sort((a, b) {
        final sa = BigInt.tryParse('${a['source_sequence']}'),
            sb = BigInt.tryParse('${b['source_sequence']}');
        if (sa != null && sb != null) return sa.compareTo(sb);
        return '${a['created_at']}'.compareTo('${b['created_at']}');
      });
      if (older || query['after'] == null) hasMore = page['has_more'] == true;
      // Sending a newer message cannot skip incoming rows not yet fetched.
      if (!older && rows.isNotEmpty) _after = rows.last['id'] as String;
      if (active) {
        // Reconcile a lost HTTP acknowledgment using exact sender/payload/source.
        await _outbox(v);
        for (final p in pending.where((p) => p['channel'] == channel)) {
          for (final m in rows) {
            if (m['user_id'] == api.session!.userId &&
                m['sender_device_id'] == p['payload']['sender_device_id'] &&
                m['ciphertext'] == p['payload']['ciphertext'] &&
                m['e2ee_metadata'] == p['payload']['e2ee_metadata']) {
              await v.chat({'op': 'ack', 'id': p['id'], 'message': m});
              _check();
            }
          }
        }
        await _outbox(v);
      }
    });
  }

  static String _id() => List.generate(
    16,
    (_) => Random.secure().nextInt(256).toRadixString(16).padLeft(2, '0'),
  ).join();
  Future<void> send(String content) {
    final channel = selected, epoch = _selection;
    return _run(() async {
      lastPreparedId = null;
      if (channel == null || epoch != _selection || content.trim().isEmpty) {
        return;
      }
      if (content.runes.length > 4000) {
        throw const ApiFailure('MESSAGE_TOO_LONG');
      }
      final v = await _vault();
      if (channel['e2ee_enabled'] != true) {
        await api.request(
          'PATCH',
          '/api/dms/channels/${Uri.encodeComponent(channel['id'] as String)}/e2ee',
          body: {'enabled': true},
        );
        _check();
        channel['e2ee_enabled'] = true;
      }
      final user = (channel['other_user'] as Map)['id'] as String;
      final owner = api.session!.userId;
      final bundles = <Map<String, dynamic>>[];
      for (final target in {user, owner}) {
        final rows = _maps(
          await api.request(
            'GET',
            '/api/users/${Uri.encodeComponent(target)}/prekey-bundles',
          ),
        );
        _check();
        bundles.addAll(rows.map((b) => {...b, 'user_id': target}));
      }
      final id = _id();
      await v.chat({
        'op': 'prepare',
        'id': id,
        'channel': channel['id'],
        'user': user,
        'plaintext': jsonEncode({'content': content, 'file_keys': []}),
        'bundles': bundles,
      });
      _check();
      lastPreparedId = id;
      await _deliver(v, id, epoch);
    });
  }

  Future<void> resumePrepared(String id) => _run(() async {
    final v = await _vault();
    await _deliver(v, id, _selection);
  });

  Future<void> retryPending() async {
    if (!current || busy || _retryQueued) return;
    if (!_initialized) {
      if (_initializationPaused ||
          now().millisecondsSinceEpoch < _initializeAt) {
        return;
      }
      _retryQueued = true;
      try {
        await initialize();
      } finally {
        _retryQueued = false;
      }
      return;
    }
    if (!active) return;
    if (!pending.any(_retryDue)) return;
    _retryQueued = true;
    try {
      await _run(() async {
        final v = await _vault();
        await _outbox(v);
        final channelsSeen = <String>{};
        var sent = 0;
        for (final p in List<Map<String, dynamic>>.from(pending)) {
          if (!channelsSeen.add(p['channel'] as String)) continue;
          if (!_retryDue(p)) continue;
          try {
            await _deliver(v, p['id'] as String, _selection, automatic: true);
          } catch (_) {
            _check();
          }
          if (++sent >= 4) break;
        }
      });
    } finally {
      _retryQueued = false;
    }
  }

  bool _retryDue(Map<String, dynamic> p) =>
      (p['state'] == 'prepared' || p['delivery'] == 'idempotent-v1') &&
      p['retryBlocked'] != true &&
      (p['retryAt'] as num? ?? 0) <= now().millisecondsSinceEpoch;

  Future<void> _deliver(
    ChatCrypto v,
    String id,
    int epoch, {
    bool automatic = false,
  }) async {
    var attempted = false;
    try {
      // Load the canonical request from the durable store, never from a UI copy.
      var reliable = false;
      try {
        final capabilities = await api.request(
          'GET',
          '/api/dms/send-capabilities',
        );
        reliable =
            capabilities is Map &&
            capabilities['text_idempotency_version'] == 1;
      } on ApiFailure catch (e) {
        if (e.status != 404 && e.status != 405) rethrow;
      }
      _check();
      final prepared = await v.chat({
        'op': 'attempt',
        'id': id,
        'now': now().millisecondsSinceEpoch,
        'automatic': automatic,
        if (reliable) 'delivery': 'idempotent-v1',
      }) as Map;
      _check();
      attempted = true;
      final result = await api.request(
        'POST',
        '/api/dms/${Uri.encodeComponent(prepared['channel'] as String)}/messages${prepared['delivery'] == 'idempotent-v1' ? '/idempotent' : ''}',
        body: prepared['payload'],
      ) as Map;
      _check();
      if (result['user_id'] != api.session!.userId ||
          result['sender_device_id'] !=
              prepared['payload']['sender_device_id']) {
        throw const ApiFailure('ACKNOWLEDGMENT_MISMATCH');
      }
      await v.chat({'op': 'ack', 'id': id, 'message': result});
      _check();
      if (epoch == _selection && selected?['id'] == prepared['channel']) {
        final content =
            (jsonDecode(prepared['plaintext'] as String) as Map)['content']
                as String;
        messages = [
          ...messages.where((m) => m['id'] != result['id']),
          {...Map<String, dynamic>.from(result), 'displayContent': content},
        ];
      }
    } catch (e) {
      _check();
      final blocked = _permanentFailure(e);
      if (!e.toString().contains('retry_not_due')) {
        await v.chat({
          'op': 'retry_failure',
          'id': id,
          'now': now().millisecondsSinceEpoch,
          'blocked': blocked,
          'retryAfterSeconds': e is ApiFailure ? e.retryAfterSeconds : 0,
        });
        _check();
      }
      if (!attempted) rethrow;
      throw ApiFailure(blocked ? 'DELIVERY_PAUSED' : 'DELIVERY_UNCERTAIN');
    } finally {
      if (current) await _outbox(v);
    }
  }

  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    _selection++;
    _poll?.cancel();
    _retry?.cancel();
    await _auth.cancel();
    channels = [];
    messages = [];
    pending = [];
    trustAlerts = [];
    lastPreparedId = null;
    selected = null;
    // The owning screen releases the vault after queued crypto is drained.
  }
}
