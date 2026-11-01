import 'dart:convert';

import 'package:flutter/material.dart';

import 'device_vault.dart';

class DeviceHandoffView extends StatefulWidget {
  final Future<DeviceVault> Function() open;
  const DeviceHandoffView({super.key, required this.open});
  @override
  State<DeviceHandoffView> createState() => _DeviceHandoffViewState();
}

class _DeviceHandoffViewState extends State<DeviceHandoffView> {
  final capsule = TextEditingController();
  Map<String, dynamic>? state;
  String? error;
  bool busy = false;
  @override
  void initState() {
    super.initState();
    load();
  }

  Future<void> load() async {
    try {
      final vault = await widget.open();
      final value = await vault.status();
      if (mounted) setState(() => state = value);
    } catch (_) {
      if (mounted) {
        setState(
          () => error = 'Cihaz deposu açılamadı. Başka pencere bu cihazın sahibi olabilir.',
        );
      }
    }
  }

  @override
  void dispose() {
    capsule.dispose();
    super.dispose();
  }

  Future<void> import() async {
    if (busy) return;
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final vault = await widget.open();
      await vault.importCapsule(capsule.text);
      capsule.clear();
      await load();
    } catch (e) {
      if (mounted) {
        setState(
          () => error =
              'Devir doğrulanamadı (${_failure(e)}). Hedef kodunu, hesabı ve kayıtlı cihaz kimliğini kontrol edin.',
        );
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  // Only static error codes reach the UI; never dump a capsule or key material.
  String _failure(Object e) {
    const codes = [
      'invalid_prekey_signature',
      'registered_device_mismatch',
      'transfer_scope_mismatch',
      'capsule_authentication_failed',
      'invalid_session',
      'invalid_prekey',
      'invalid_identity',
      'invalid_signing_identity',
      'source_retirement_required',
      'invalid_capsule_contents',
      'invalid_snapshot',
      'invalid_sender_key',
      'DEVICE_OWNER_BUSY',
      'STALE_DEVICE_REVISION',
      'SESSION_CHANGED',
    ];
    final text = e.toString();
    return codes.firstWhere(text.contains, orElse: () => 'TRANSFER_FAILED');
  }

  @override
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.all(20),
    children: [
      const Text('Aktif cihaz devri', style: TextStyle(fontSize: 24)),
      if (error != null)
        Text(error!, style: const TextStyle(color: Colors.orange)),
      if (state != null) ...[
        if (state!['phase'] == 'active') ...[
          const Text(
            'Cihaz devri kalıcı olarak kaydedildi. Bu istemci, cihazın tek yazarıdır.',
          ),
          SelectableText('Cihaz: ${state!['deviceId']}'),
        ] else ...[
          const Text(
            'Bu kodu eski istemcinin Güvenlik → Cihaz devri bölümüne yapıştırın. Oluşan devir dosyasının içeriğini aşağıya girin.',
          ),
          Semantics(
            label: 'Hedef devir kodu: ${jsonEncode(state!['intent'])}',
            child: SelectableText(
              jsonEncode(state!['intent']),
              key: const Key('device-intent'),
            ),
          ),
          TextField(
            key: const Key('device-capsule'),
            controller: capsule,
            enabled: !busy,
            maxLines: 8,
            decoration: const InputDecoration(
              labelText: 'Şifreli devir dosyası içeriği',
            ),
          ),
          FilledButton(
            onPressed: busy ? null : import,
            child: Text(
              busy ? 'Doğrulanıyor…' : 'Devri doğrula ve etkinleştir',
            ),
          ),
        ],
      ],
    ],
  );
}
