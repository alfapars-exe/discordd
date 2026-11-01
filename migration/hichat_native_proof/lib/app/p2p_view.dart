import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';

import 'p2p.dart';

class P2PView extends StatefulWidget {
  final P2PController controller;
  final Future<void> Function() beforeConnect;
  const P2PView({
    super.key,
    required this.controller,
    required this.beforeConnect,
  });
  @override
  State<P2PView> createState() => _P2PViewState();
}

class _P2PViewState extends State<P2PView> {
  final receiver = TextEditingController();
  final renderer = RTCVideoRenderer();
  bool initialized = false, busy = false;
  String? error;
  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_changed);
    unawaited(
      renderer.initialize().then((_) {
        if (!mounted) return;
        initialized = true;
        _changed();
      }),
    );
  }

  void _changed() {
    if (!mounted) return;
    if (initialized) renderer.srcObject = widget.controller.remote;
    setState(() {});
  }

  Future<void> run(FutureOr<void> Function() action) async {
    if (busy) return;
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await action();
    } catch (_) {
      if (mounted) error = 'Arama işlemi tamamlanamadı.';
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  void dispose() {
    widget.controller.removeListener(_changed);
    receiver.dispose();
    renderer.srcObject = null;
    unawaited(renderer.dispose());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        const Text('Doğrudan arama', style: TextStyle(fontSize: 24)),
        const Text(
          'WebRTC ile mikrofon ve kamera. Arama almak için bu bağlantıyı açık tutun.',
        ),
        if (!c.ready)
          FilledButton(
            onPressed: busy
                ? null
                : () => run(() async {
                    await widget.beforeConnect();
                    await c.connect();
                  }),
            child: const Text('Aramalara bağlan'),
          ),
        if (c.ready) ...[
          TextField(
            controller: receiver,
            decoration: const InputDecoration(
              labelText: 'Alıcı kullanıcı kimliği',
            ),
            enabled: c.call == null && !busy,
          ),
          Wrap(
            spacing: 8,
            children: [
              FilledButton(
                onPressed: busy || c.call != null
                    ? null
                    : () => run(() => c.dial(receiver.text)),
                child: const Text('Sesli ara'),
              ),
              FilledButton(
                onPressed: busy || c.call != null
                    ? null
                    : () => run(() => c.dial(receiver.text, video: true)),
                child: const Text('Görüntülü ara'),
              ),
              OutlinedButton(
                onPressed: busy ? null : () => run(c.disconnect),
                child: const Text('Arama bağlantısını kapat'),
              ),
            ],
          ),
        ],
        if (c.call != null) ...[
          Text(
            c.active
                ? 'Arama etkin'
                : (c.incoming ? 'Gelen arama' : 'Çalıyor…'),
          ),
          if (c.incoming && !c.active)
            Wrap(
              spacing: 8,
              children: [
                FilledButton(
                  onPressed: busy ? null : () => run(c.accept),
                  child: const Text('Yanıtla'),
                ),
                OutlinedButton(
                  onPressed: busy ? null : () => run(c.decline),
                  child: const Text('Reddet'),
                ),
              ],
            ),
          Wrap(
            spacing: 8,
            children: [
              OutlinedButton(
                onPressed: busy ? null : () => run(c.end),
                child: const Text('Aramayı bitir'),
              ),
              if (c.active)
                OutlinedButton(
                  onPressed: () => c.setMuted(!c.muted),
                  child: Text(c.muted ? 'Mikrofonu aç' : 'Mikrofonu sustur'),
                ),
            ],
          ),
        ],
        if (initialized && c.remote != null)
          SizedBox(height: 300, child: RTCVideoView(renderer)),
        if (error != null || c.failure != null)
          Text(
            error ?? c.failure!,
            style: const TextStyle(color: Colors.orange),
          ),
      ],
    );
  }
}
