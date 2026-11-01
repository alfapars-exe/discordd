import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'api.dart';

/// Direct DTLS-SRTP media. The existing server owns call authorization/lifecycle.
/// This adapter intentionally negotiates the existing legacy microphone/camera
/// contract; it never interprets arbitrary stream labels as screen-share grants.
class P2PController extends ChangeNotifier {
  final HiChatApi api;
  final Future<MediaStream> Function(bool video)? capture;
  final void Function(Object)? diagnostics;
  P2PController(this.api, {this.capture, this.diagnostics}) {
    _auth = api.invalidations.listen((_) => unawaited(disconnect()));
  }
  StreamSubscription<void>? _auth;
  WebSocketChannel? _socket;
  StreamSubscription<dynamic>? _events;
  Timer? _heartbeat, _deadline;
  RTCPeerConnection? peer;
  MediaStream? local, remote;
  Map<String, dynamic>? call;
  String? failure;
  bool ready = false, active = false, muted = false;
  bool _remoteDescriptionApplied = false;
  int _generation = 0;
  final List<RTCIceCandidate> _ice = [];
  Future<void> _serial = Future.value();

  bool get incoming =>
      call != null && call!['receiver_id'] == api.session?.userId;
  void _send(String op, [Map<String, dynamic>? data]) {
    if (!ready) throw const ApiFailure('P2P_NOT_CONNECTED');
    _socket!.sink.add(jsonEncode({'op': op, 'd': ?data}));
  }

  Future<void> connect() async {
    await disconnect();
    final generation = ++_generation;
    final scope = api.generation;
    if (api.session == null) throw const ApiFailure('LOGIN_REQUIRED');
    final ticket = await api.request('POST', '/api/auth/ws-ticket') as Map;
    if (generation != _generation || !api.isCurrent(scope)) return;
    final socket = WebSocketChannel.connect(
      api.origin.replace(
        scheme: api.origin.scheme == 'https' ? 'wss' : 'ws',
        path: '/ws',
        queryParameters: {'ticket': ticket['ticket'] as String},
      ),
    );
    _socket = socket;
    _serial = Future.value();
    final connected = Completer<void>();
    void failed() {
      if (!connected.isCompleted) {
        connected.completeError(const ApiFailure('P2P_SOCKET_CLOSED'));
      }
      if (generation == _generation) {
        failure = 'P2P_SOCKET_CLOSED';
        unawaited(disconnect());
      }
    }

    _events = socket.stream.listen(
      (raw) {
        if (generation != _generation || !api.isCurrent(scope)) return;
        try {
          final event = jsonDecode(raw as String) as Map;
          if (event['op'] == 'ready') {
            ready = true;
            if (!connected.isCompleted) connected.complete();
            notifyListeners();
            return;
          }
          _serial = _serial
              .then((_) async {
                if (generation != _generation || !api.isCurrent(scope)) return;
                await _event(event);
              })
              .catchError((Object e) async {
                diagnostics?.call(e);
                if (generation == _generation) {
                  failure = 'P2P_MEDIA_FAILED';
                  try {
                    await end();
                  } catch (_) {
                    await disconnect();
                  }
                }
              });
        } catch (_) {
          failed();
        }
      },
      onDone: failed,
      onError: (Object _) => failed(),
    );
    try {
      await connected.future.timeout(const Duration(seconds: 15));
      if (generation != _generation) return;
      _heartbeat = Timer.periodic(const Duration(seconds: 15), (_) {
        if (api.isCurrent(scope)) {
          _send('heartbeat');
        } else {
          unawaited(disconnect());
        }
      });
    } catch (_) {
      await disconnect();
      rethrow;
    }
  }

  void dial(String receiver, {bool video = false}) {
    if (call != null ||
        receiver.trim().isEmpty ||
        receiver == api.session?.userId) {
      throw const ApiFailure('INVALID_CALL');
    }
    failure = null;
    _send('p2p_call_initiate', {
      'receiver_id': receiver.trim(),
      'call_type': video ? 'video' : 'voice',
    });
    _deadline?.cancel();
    _deadline = Timer(const Duration(seconds: 15), () {
      if (call == null && ready) {
        failure = 'P2P_CALL_NOT_STARTED';
        notifyListeners();
      }
    });
  }

  void accept() {
    if (!incoming || call == null) throw const ApiFailure('INVALID_CALL');
    _send('p2p_call_accept', {'call_id': call!['id']});
  }

  Future<void> decline() async {
    try {
      if (call != null && incoming && ready) {
        _send('p2p_call_decline', {'call_id': call!['id']});
      }
    } finally {
      await _clearCall();
    }
  }

  Future<void> end() async {
    try {
      if (call != null && ready) _send('p2p_call_end');
    } finally {
      await _clearCall();
    }
  }

  void setMuted(bool value) {
    for (final track in local?.getAudioTracks() ?? <MediaStreamTrack>[]) {
      track.enabled = !value;
    }
    muted = value;
    notifyListeners();
  }

  Future<void> _event(Map event) async {
    final data = event['d'];
    switch (event['op']) {
      case 'p2p_call_initiate':
        if (data is! Map || call != null) return;
        final owner = api.session?.userId;
        if (data['caller_id'] != owner && data['receiver_id'] != owner) return;
        call = Map<String, dynamic>.from(data);
        _deadline?.cancel();
        failure = null;
        notifyListeners();
      case 'p2p_call_accept':
        if (data is Map && data['call_id'] == call?['id'] && peer == null) {
          await _start();
        }
      case 'p2p_signal':
        if (data is Map && data['call_id'] == call?['id'] && active) {
          await _signal(data);
        }
      case 'p2p_call_decline':
      case 'p2p_call_end':
        if (data is Map && data['call_id'] == call?['id']) await _clearCall();
      case 'p2p_call_busy':
        failure = 'P2P_PEER_BUSY';
        notifyListeners();
    }
  }

  Future<void> _start() async {
    final generation = _generation;
    final currentCall = call;
    if (currentCall == null) return;
    bool current() => generation == _generation && identical(currentCall, call);
    final pc = await createPeerConnection({
      'iceServers': [
        {'urls': 'stun:stun.l.google.com:19302'},
        {'urls': 'stun:stun1.l.google.com:19302'},
      ],
    });
    if (!current()) {
      await pc.dispose();
      return;
    }
    peer = pc;
    pc.onIceCandidate = (candidate) {
      if (current() && candidate.candidate?.isNotEmpty == true) {
        _send('p2p_signal', {
          'call_id': currentCall['id'],
          'type': 'ice-candidate',
          'candidate': candidate.toMap(),
        });
      }
    };
    pc.onTrack = (event) {
      if (!current()) return;
      // Preserve the remote owner tag; local aggregates are muted by the SDK.
      if (event.streams.isEmpty) {
        failure = 'P2P_STREAM_REQUIRED';
        unawaited(end());
        return;
      }
      remote = event.streams.first;
      notifyListeners();
    };
    pc.onConnectionState = (state) {
      if (!current()) return;
      if (state == RTCPeerConnectionState.RTCPeerConnectionStateConnected) {
        _deadline?.cancel();
      }
      if (state == RTCPeerConnectionState.RTCPeerConnectionStateDisconnected) {
        _deadline?.cancel();
        _deadline = Timer(const Duration(seconds: 15), () {
          if (current()) {
            failure = 'P2P_CONNECTION_LOST';
            unawaited(end());
          }
        });
      }
      if (state == RTCPeerConnectionState.RTCPeerConnectionStateFailed ||
          state == RTCPeerConnectionState.RTCPeerConnectionStateClosed) {
        failure = 'P2P_CONNECTION_ENDED';
        unawaited(end());
      }
    };
    final video = currentCall['call_type'] == 'video';
    final stream =
        await (capture?.call(video) ??
            navigator.mediaDevices.getUserMedia({
              'audio': true,
              'video': video,
            }));
    if (!current()) {
      for (final track in stream.getTracks()) {
        await track.stop();
      }
      await stream.dispose();
      return;
    }
    local = stream;
    for (final track in stream.getTracks()) {
      await pc.addTrack(track, stream);
    }
    if (!current()) return;
    active = true;
    _deadline = Timer(const Duration(seconds: 45), () {
      if (current()) {
        failure = 'P2P_CONNECT_TIMEOUT';
        unawaited(end());
      }
    });
    if (!incoming) {
      final offer = await pc.createOffer();
      if (!current()) return;
      await pc.setLocalDescription(offer);
      if (current()) {
        _send('p2p_signal', {
          'call_id': currentCall['id'],
          'type': 'offer',
          'sdp': offer.sdp,
        });
      }
    }
    notifyListeners();
  }

  Future<void> _signal(Map data) async {
    final pc = peer;
    final currentCall = call;
    if (pc == null || currentCall == null) return;
    bool current() => identical(peer, pc) && identical(call, currentCall);
    if (data['type'] == 'ice-candidate') {
      final value = data['candidate'] as Map;
      final candidate = RTCIceCandidate(
        value['candidate'] as String?,
        value['sdpMid'] as String?,
        value['sdpMLineIndex'] as int?,
      );
      if (!_remoteDescriptionApplied) {
        if (_ice.length >= 256) throw const ApiFailure('TOO_MANY_CANDIDATES');
        _ice.add(candidate);
      } else if (current()) {
        await pc.addCandidate(candidate);
      }
      return;
    }
    final type = data['type'];
    if (type != 'offer' && type != 'answer') return;
    // Initial offer belongs to caller; no glare/renegotiation in this adapter.
    if ((type == 'offer') != incoming || _remoteDescriptionApplied) {
      return;
    }
    final sdp = data['sdp'] as String;
    if (sdp.length > 30000) throw const ApiFailure('INVALID_SDP');
    await pc.setRemoteDescription(RTCSessionDescription(sdp, type as String));
    if (!current()) return;
    _remoteDescriptionApplied = true;
    for (final candidate in _ice) {
      await pc.addCandidate(candidate);
    }
    _ice.clear();
    if (type == 'offer') {
      final answer = await pc.createAnswer();
      if (!current()) return;
      await pc.setLocalDescription(answer);
      if (current()) {
        _send('p2p_signal', {
          'call_id': currentCall['id'],
          'type': 'answer',
          'sdp': answer.sdp,
        });
      }
    }
  }

  Future<void> _clearCall() async {
    final pc = peer, own = local, other = remote;
    call = null;
    peer = null;
    local = null;
    remote = null;
    active = false;
    _remoteDescriptionApplied = false;
    muted = false;
    _ice.clear();
    _deadline?.cancel();
    // Detach callbacks before closing to avoid recursive termination.
    if (pc != null) {
      pc.onConnectionState = null;
      pc.onTrack = null;
      pc.onIceCandidate = null;
    }
    for (final stream in [own, other]) {
      if (stream == null) continue;
      for (final track in stream.getTracks()) {
        try {
          await track.stop();
        } catch (_) {
          failure = 'P2P_CLEANUP_FAILED';
        }
      }
      try {
        await stream.dispose();
      } catch (_) {
        failure = 'P2P_CLEANUP_FAILED';
      }
    }
    try {
      await pc?.close();
    } finally {
      await pc?.dispose();
    }
    notifyListeners();
  }

  Future<void> disconnect() async {
    try {
      if (ready && call != null) _send('p2p_call_end');
    } catch (_) {
      /* Capture must stop even after transport failure. */
    }
    ++_generation;
    ready = false;
    _heartbeat?.cancel();
    final events = _events, socket = _socket;
    _events = null;
    _socket = null;
    await _clearCall();
    await events?.cancel();
    await socket?.sink.close();
  }

  Future<void> shutdown() async {
    await _auth?.cancel();
    await disconnect();
  }
}
