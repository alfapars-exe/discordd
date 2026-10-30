import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:livekit_client/livekit_client.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'api.dart';

void validateMediaToken(Map<String, dynamic> data, String owner) {
  final parts = (data['token'] as String).split('.');
  if (parts.length != 3) throw const ApiFailure('INVALID_MEDIA_TOKEN');
  final subject = (jsonDecode(
    utf8.decode(base64Url.decode(base64Url.normalize(parts[1]))),
  ) as Map)['sub'];
  final index = data['e2ee_key_index'];
  final epoch = data['e2ee_key_epoch'];
  if (subject != owner ||
      data['e2ee_passphrase'] is! String ||
      (data['e2ee_passphrase'] as String).isEmpty ||
      index is! int ||
      epoch is! int ||
      index < 0 ||
      index > 255 ||
      epoch < 0 ||
      epoch > 9007199254740991 ||
      epoch % 256 != index ||
      data['e2ee_key_context'] is! String ||
      (data['e2ee_key_context'] as String).isEmpty) {
    throw const ApiFailure('ENCRYPTED_MEDIA_CREDENTIALS_REQUIRED');
  }
  final url = Uri.parse(data['url'] as String);
  if (url.scheme != 'wss' &&
      !(url.scheme == 'ws' &&
          ['localhost', '127.0.0.1', '::1'].contains(url.host))) {
    throw const ApiFailure('SECURE_MEDIA_URL_REQUIRED');
  }
}

/// Shared-key publishing must use the authoritative SFrame slot, not SDK slot 0.
class IndexedKeyProvider extends BaseKeyProvider {
  final int index;
  IndexedKeyProvider(BaseKeyProvider base, this.index)
    : super(base.keyProvider, base.options);
  @override
  int getLatestIndex(String participantId) => index;
}

class VoiceController extends ChangeNotifier {
  final HiChatApi api;
  Room? room;
  WebSocketChannel? _socket;
  StreamSubscription<dynamic>? _subscription;
  Timer? _heartbeat, _keyCheck;
  EventsListener<RoomEvent>? _events;
  BaseKeyProvider? _keyProvider;
  int _operation = 0;
  bool connecting = false;
  String? failure;
  bool microphone = false, camera = false, screen = false;
  VoiceController(this.api) {
    api.invalidations.listen((_) {
      unawaited(leave());
    });
  }

  Future<void> join(String serverId, String channelId) async {
    await leave();
    final operation = ++_operation;
    final scope = api.generation;
    final owner = api.session?.userId;
    if (owner == null) throw const ApiFailure('LOGIN_REQUIRED');
    bool current() => operation == _operation && api.isCurrent(scope);
    connecting = true;
    failure = null;
    notifyListeners();
    try {
      final ticket = await api.request(
        'POST',
        '/api/auth/ws-ticket',
      ) as Map<String, dynamic>;
      if (!current()) return;
      final ws = api.origin.replace(
        scheme: api.origin.scheme == 'https' ? 'wss' : 'ws',
        path: '/ws',
        queryParameters: {'ticket': ticket['ticket'] as String},
      );
      final socket = WebSocketChannel.connect(ws);
      _socket = socket;
      final ready = Completer<void>();
      _subscription = socket.stream.listen(
        (message) {
          if (!current()) return;
          try {
            final event = jsonDecode(message as String) as Map<String, dynamic>;
            if (event['op'] == 'ready' && !ready.isCompleted) ready.complete();
            if ([
              'voice_force_disconnect',
              'voice_force_move',
              'voice_afk_kick',
              'voice_replaced',
              'voice_passphrase_rotated',
            ].contains(event['op'])) {
              failure = 'VOICE_SESSION_ENDED';
              unawaited(leave());
            }
            if (event['op'] == 'voice_state_update') {
              final data = event['d'];
              if (data is Map &&
                  data['user_id'] == owner &&
                  data['is_server_muted'] == true) {
                unawaited(setMicrophone(false));
              }
            }
          } catch (_) {
            failure = 'INVALID_WS_EVENT';
            unawaited(leave());
          }
        },
        onError: (Object error) {
          if (!ready.isCompleted) {
            ready.completeError(const ApiFailure('WS_CONNECTION_FAILED'));
          }
          if (current()) {
            failure = 'WS_CONNECTION_FAILED';
            unawaited(leave());
          }
        },
        onDone: () {
          if (!ready.isCompleted) {
            ready.completeError(const ApiFailure('WS_CONNECTION_CLOSED'));
          }
          if (current()) {
            failure = 'WS_CONNECTION_CLOSED';
            unawaited(leave());
          }
        },
      );
      await ready.future.timeout(const Duration(seconds: 15));
      if (!current()) return;
      _heartbeat = Timer.periodic(const Duration(seconds: 15), (_) {
        if (current()) {
          socket.sink.add(jsonEncode({'op': 'heartbeat'}));
        } else {
          unawaited(leave());
        }
      });
      final path = '/api/servers/${Uri.encodeComponent(serverId)}/voice/token';
      final credentials = await api.request(
        'POST',
        path,
        body: {'channel_id': channelId},
      ) as Map<String, dynamic>;
      if (!current()) return;
      validateMediaToken(credentials, owner);
      final baseProvider = await BaseKeyProvider.create(
        keyRingSize: 256,
        discardFrameWhenCryptorNotReady: true,
      );
      final provider = IndexedKeyProvider(
        baseProvider,
        credentials['e2ee_key_index'] as int,
      );
      if (!current()) {
        await provider.keyProvider.dispose();
        return;
      }
      _keyProvider = provider;
      await provider.setSharedKey(
        credentials['e2ee_passphrase'] as String,
        keyIndex: credentials['e2ee_key_index'] as int,
      );
      if (!current()) {
        return;
      }
      final activeRoom = Room(
        roomOptions: RoomOptions(
          adaptiveStream: true,
          dynacast: true,
          encryption: E2EEOptions(keyProvider: provider),
        ),
      );
      if (!current()) {
        await activeRoom.dispose();
        return;
      }
      room = activeRoom;
      _events = activeRoom.createListener()
        ..on<RoomDisconnectedEvent>((event) {
          if (current()) {
            failure = 'ROOM_DISCONNECTED';
            unawaited(leave());
          }
        })
        ..on<TrackSubscribedEvent>((event) => notifyListeners())
        ..on<TrackUnsubscribedEvent>((event) => notifyListeners())
        ..on<LocalTrackPublishedEvent>((event) => notifyListeners())
        ..on<LocalTrackUnpublishedEvent>((event) => notifyListeners());
      await activeRoom.connect(
        credentials['url'] as String,
        credentials['token'] as String,
      );
      await activeRoom.setE2EEEnabled(true);
      if (!current()) return;
      socket.sink.add(
        jsonEncode({
          'op': 'voice_join',
          'd': {
            'channel_id': channelId,
            'is_muted': true,
            'is_deafened': false,
          },
        }),
      );
      // Fail closed on authoritative key/context change; never publish under a stale key.
      bool checking = false;
      _keyCheck = Timer.periodic(const Duration(seconds: 15), (_) async {
        if (!current() || checking) return;
        checking = true;
        try {
          final next = await api.request(
            'POST',
            path,
            body: {'channel_id': channelId},
          ) as Map<String, dynamic>;
          if (!current()) return;
          validateMediaToken(next, owner);
          if (next['e2ee_key_context'] != credentials['e2ee_key_context'] ||
              next['e2ee_key_epoch'] != credentials['e2ee_key_epoch'] ||
              next['e2ee_passphrase'] != credentials['e2ee_passphrase']) {
            failure = 'MEDIA_KEY_CHANGED_REJOIN_REQUIRED';
            await leave();
          }
        } catch (_) {
          if (current()) {
            failure = 'MEDIA_KEY_CHECK_FAILED';
            await leave();
          }
        } finally {
          checking = false;
        }
      });
    } catch (_) {
      if (current()) {
        failure = 'VOICE_CONNECTION_FAILED';
        await leave();
      }
      rethrow;
    } finally {
      if (operation == _operation) {
        connecting = false;
        notifyListeners();
      }
    }
  }

  Future<void> setMicrophone(bool enabled) async {
    final active = room;
    final operation = _operation;
    if (active == null || connecting) return;
    await active.localParticipant?.setMicrophoneEnabled(enabled);
    if (operation != _operation) {
      await active.localParticipant?.setMicrophoneEnabled(false);
      return;
    }
    microphone = enabled;
    _socket?.sink.add(
      jsonEncode({
        'op': 'voice_state_update_request',
        'd': {
          'is_muted': !enabled,
          'is_deafened': false,
          'is_streaming': screen,
        },
      }),
    );
    notifyListeners();
  }

  Future<void> setCamera(bool enabled) async {
    final active = room;
    final operation = _operation;
    if (active == null || connecting) return;
    await active.localParticipant?.setCameraEnabled(enabled);
    if (operation != _operation) {
      await active.localParticipant?.setCameraEnabled(false);
      return;
    }
    camera = enabled;
    notifyListeners();
  }

  Future<void> setScreen(bool enabled, {String? sourceId}) async {
    final active = room;
    final operation = _operation;
    if (active == null || connecting) return;
    await active.localParticipant?.setScreenShareEnabled(
      enabled,
      captureScreenAudio: kIsWeb,
      screenShareCaptureOptions: ScreenShareCaptureOptions(
        sourceId: sourceId,
        captureScreenAudio: kIsWeb,
        selfBrowserSurface: 'exclude',
      ),
    );
    if (operation != _operation) {
      await active.localParticipant?.setScreenShareEnabled(false);
      return;
    }
    screen = enabled;
    _socket?.sink.add(
      jsonEncode({
        'op': 'voice_state_update_request',
        'd': {'is_streaming': enabled},
      }),
    );
    notifyListeners();
  }

  Future<void> selectDevice(MediaDevice device) async {
    final active = room;
    final operation = _operation;
    if (active == null || connecting) return;
    switch (device.kind) {
      case 'audioinput':
        await active.setAudioInputDevice(device);
      case 'audiooutput':
        await active.setAudioOutputDevice(device);
      case 'videoinput':
        await active.setVideoInputDevice(device);
      default:
        throw const ApiFailure('UNSUPPORTED_MEDIA_DEVICE');
    }
    if (operation != _operation) {
      for (final publication
          in active.localParticipant?.trackPublications.values ??
              <LocalTrackPublication>[]) {
        await publication.track?.stop();
      }
    }
  }

  Future<void> leave() async {
    ++_operation;
    _heartbeat?.cancel();
    _heartbeat = null;
    _keyCheck?.cancel();
    _keyCheck = null;
    final socket = _socket;
    _socket = null;
    final events = _events;
    _events = null;
    final subscription = _subscription;
    _subscription = null;
    final active = room;
    room = null;
    final provider = _keyProvider;
    _keyProvider = null;
    // Start capture shutdown before awaiting network/socket teardown.
    final stopping = <Future<void>>[];
    if (active != null) {
      for (final publication
          in active.localParticipant?.trackPublications.values ??
              <LocalTrackPublication>[]) {
        final track = publication.track;
        if (track != null) stopping.add(track.stop());
      }
    }
    connecting = false;
    microphone = false;
    camera = false;
    screen = false;
    notifyListeners();
    if (socket != null) {
      try {
        socket.sink.add(jsonEncode({'op': 'voice_leave'}));
      } catch (_) {}
    }
    await subscription?.cancel();
    await socket?.sink.close();
    await events?.dispose();
    await Future.wait(stopping);
    if (active != null) {
      await active.disconnect();
      await active.dispose();
    }
    if (provider != null) {
      await provider.keyProvider.dispose();
      final material = provider.sharedKey;
      material?.fillRange(0, material.length, 0);
    }
  }
}
