import 'dart:async';

import 'package:flutter/foundation.dart';

import '../src/rust/api/simple.dart' as rust;
import 'media.dart';
import 'p2p.dart';

/// Only the locally selected game's foreground window receives the native HUD.
class GameOverlay extends ChangeNotifier {
  final VoiceController voice;
  final P2PController p2p;
  String? target;
  String? failure;
  Future<void> _pending = Future.value();
  GameOverlay(this.voice, this.p2p) {
    voice.addListener(_update);
    p2p.addListener(_update);
  }
  bool get supported =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.windows;
  Future<void> select(String? window) async {
    target = window;
    failure = null;
    _update();
    await _pending;
    notifyListeners();
  }

  void _update() {
    if (!supported) return;
    final window = target;
    final inRoom = voice.room != null;
    final active = inRoom || p2p.active;
    final mic = inRoom ? voice.microphone : !p2p.muted;
    final count = inRoom ? voice.room!.remoteParticipants.length + 1 : 2;
    final text =
        'HiChat | $count kişi | Mikrofon ${mic ? "açık" : "kapalı"}${voice.screen ? " | Ekran yayında" : ""}';
    // Preserve command order: a late enabled update cannot undo logout/disable.
    _pending = _pending
        .then(
          (_) => rust.updateOverlay(
            target: window ?? '',
            text: text,
            enabled: active && window != null,
          ),
        )
        .catchError((Object _) async {
          failure = 'Oyun katmanı açılamadı.';
          target = null;
          try {
            await rust.updateOverlay(target: '', text: '', enabled: false);
          } catch (_) {
            /* A terminated native worker has no visible window. */
          }
          notifyListeners();
        });
  }

  Future<void> shutdown() async {
    voice.removeListener(_update);
    p2p.removeListener(_update);
    await select(null);
  }
}
