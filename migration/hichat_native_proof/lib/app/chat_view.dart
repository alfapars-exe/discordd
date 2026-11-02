import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:file_selector/file_selector.dart';

import 'chat.dart';

class ChatView extends StatefulWidget {
  final ChatController controller;
  const ChatView({super.key, required this.controller});
  @override
  State<ChatView> createState() => _ChatViewState();
}

class _ChatViewState extends State<ChatView> {
  final composer = TextEditingController(), recipient = TextEditingController();
  List<Map<String, dynamic>> files = [];
  ChatController get c => widget.controller;
  @override
  void initState() {
    super.initState();
    c.addListener(_changed);
    unawaited(c.initialize());
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    c.removeListener(_changed);
    composer.dispose();
    recipient.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final text = composer.text;
    await c.send(text, files: files);
    if (mounted && c.lastPreparedId != null && composer.text == text) {
      composer.clear();
      setState(() => files = []);
    }
  }

  Future<void> _pick() async {
    final owner = c;
    final selected = await openFiles();
    if (selected.isEmpty) return;
    if (!mounted || !c.current) return;
    var size = 0;
    final next = <Map<String, dynamic>>[];
    for (final file in selected) {
      final length = await file.length();
      size += length;
      if (length > 1024 * 1024 ||
          size > 2 * 1024 * 1024 ||
          selected.length > 10) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text(
                'Dosya başına 1 MiB, toplam 2 MiB ve en çok 10 dosya.',
              ),
            ),
          );
        }
        return;
      }
      final data = await file.readAsBytes();
      if (data.length != length) return;
      next.add({
        'name': file.name,
        'mime': file.mimeType ?? 'application/octet-stream',
        'data': base64Encode(data),
      });
    }
    if (mounted && identical(owner, c) && owner.current) {
      setState(() => files = next);
    }
  }

  Future<void> _review(Map<String, dynamic> initial) async {
    final owner = c;
    final review = await owner.reviewSession(initial['token'] as String);
    if (!mounted || !identical(owner, c) || !owner.current || review == null) {
      return;
    }
    var verified = false;
    final approved = await showDialog<bool>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, setDialog) => AlertDialog(
          title: const Text('Şifreleme oturumunu yeniden kur'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  'Bu cihazın kimlik izi: ${owner.ownIdentityFingerprint}\nKarşı kullanıcı: ${review['user']}\nCihaz: ${review['device']}\nKimlik izi: ${review['identityFingerprint']}\nMesaj izi: ${review['fingerprint']}',
                ),
                const Text(
                  'Eşzamanlı başlangıç veya cihaz sıfırlaması algılandı. Karşı cihazı güvenilir başka bir kanaldan doğrulayın. Eski ratchet silinmez; bekleyen şifreli gönderiler değişmez. Kimlik değişimi bu onayla aşılamaz.',
                ),
                CheckboxListTile(
                  value: verified,
                  onChanged: (value) =>
                      setDialog(() => verified = value == true),
                  title: const Text('Karşı cihazı doğruladım'),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Vazgeç'),
            ),
            FilledButton(
              onPressed: verified ? () => Navigator.pop(context, true) : null,
              child: const Text('Onayla'),
            ),
          ],
        ),
      ),
    );
    if (mounted && identical(owner, c) && owner.current && approved != null) {
      await c.confirmSession(review['token'] as String, approved);
    }
  }

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) => Column(
      children: [
        ConstrainedBox(
          constraints: BoxConstraints(maxHeight: constraints.maxHeight * 0.45),
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (c.error != null)
                  Padding(
                    padding: const EdgeInsets.all(8),
                    child: Text(
                      c.error!,
                      style: const TextStyle(color: Colors.orange),
                    ),
                  ),
                if (!c.active)
                  Padding(
                    padding: const EdgeInsets.all(8),
                    child: Column(
                      children: [
                        const Text(
                          'Mesajlaşmak için cihaz devrini tamamlayın veya bağımsız yeni bir cihaz oluşturun. Yeni cihaz eski şifreli geçmişi otomatik açmaz.',
                        ),
                        OutlinedButton(
                          onPressed: c.busy ? null : c.register,
                          child: const Text('Yeni şifreleme cihazı oluştur'),
                        ),
                      ],
                    ),
                  ),
                Padding(
                  padding: const EdgeInsets.all(8),
                  child: Row(
                    children: [
                      Expanded(
                        child: TextField(
                          controller: recipient,
                          decoration: const InputDecoration(
                            labelText: 'Yeni sohbet için kullanıcı kimliği',
                          ),
                        ),
                      ),
                      IconButton(
                        tooltip: 'Sohbet aç',
                        onPressed: c.busy
                            ? null
                            : () => c.create(recipient.text),
                        icon: const Icon(Icons.person_add),
                      ),
                    ],
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 8),
                  child: Row(
                    children: [
                      Expanded(
                        child: DropdownButton<String>(
                          isExpanded: true,
                          value: c.selected?['id'] as String?,
                          hint: const Text('Sohbet seç'),
                          items: c.channels
                              .map(
                                (ch) => DropdownMenuItem(
                                  value: ch['id'] as String,
                                  child: Text(
                                    '${ch['other_user']?['display_name'] ?? ch['other_user']?['username'] ?? ch['id']}',
                                  ),
                                ),
                              )
                              .toList(),
                          onChanged: (id) {
                            final found = c.channels
                                .where((r) => r['id'] == id)
                                .firstOrNull;
                            if (found != null) unawaited(c.select(found));
                          },
                        ),
                      ),
                      IconButton(
                        tooltip: 'Mesajları yenile',
                        onPressed: c.busy ? null : c.refresh,
                        icon: const Icon(Icons.refresh),
                      ),
                    ],
                  ),
                ),
                if (c.trustAlerts.isNotEmpty)
                  const Padding(
                    padding: EdgeInsets.all(8),
                    child: Text(
                      'Konuşmadaki bir hesaba yeni cihaz eklendi. Cihaz kimliklerini karşı tarafla doğrulayın.',
                      style: TextStyle(color: Colors.orange),
                    ),
                  ),
                if (c.pending.isNotEmpty)
                  ExpansionTile(
                    title: Text('${c.pending.length} bekleyen gönderim'),
                    children: [
                      for (final p in c.pending)
                        ListTile(
                          title: SelectableText(
                            (jsonDecode(p['plaintext'] as String)
                                    as Map)['content']
                                as String,
                          ),
                          subtitle: Text(
                            p['retryBlocked'] == true
                                ? 'Otomatik gönderim durduruldu. Hesap, cihaz veya izinleri kontrol edin.'
                                : p['state'] == 'prepared'
                                ? 'Gönderilmeye hazır.'
                                : p['delivery'] == 'idempotent-v1'
                                ? 'Sunucu onayı bekleniyor; aynı istek otomatik yeniden denenecek.'
                                : 'Sonuç belirsiz; yinelenmeyi önlemek için otomatik tekrarlanmaz.',
                          ),
                          trailing:
                              p['state'] == 'prepared' ||
                                  p['delivery'] == 'idempotent-v1'
                              ? TextButton(
                                  onPressed: c.busy
                                      ? null
                                      : () =>
                                            c.resumePrepared(p['id'] as String),
                                  child: const Text('Gönder'),
                                )
                              : null,
                        ),
                    ],
                  ),
                for (final review in c.sessionReviews.where(
                  (r) => r['channel'] == c.selected?['id'],
                ))
                  ListTile(
                    title: const Text('Şifreleme oturumu için onay gerekli'),
                    subtitle: Text('${review['device']}'),
                    trailing: TextButton(
                      onPressed: c.busy ? null : () => _review(review),
                      child: const Text('İncele'),
                    ),
                  ),
                if (c.hasMore)
                  TextButton(
                    onPressed: c.busy ? null : () => c.refresh(older: true),
                    child: const Text('Önceki mesajlar'),
                  ),
              ],
            ),
          ),
        ),
        Expanded(
          child: ListView.builder(
            itemCount: c.messages.length,
            itemBuilder: (context, i) {
              final m = c.messages[i];
              return ListTile(
                title: Semantics(
                  label:
                      m['displayContent'] as String? ??
                      'Bu cihazda mesaj açılamadı.',
                  excludeSemantics: true,
                  child: SelectableText(
                    m['displayContent'] as String? ??
                        'Bu cihazda mesaj açılamadı.',
                  ),
                ),
                subtitle: Text(
                  '${m['author']?['display_name'] ?? m['user_id']} • ${m['created_at']}\n${(m['fileKeys'] as List? ?? []).map((f) => f['filename']).join(', ')}',
                ),
              );
            },
          ),
        ),
        if (files.isNotEmpty)
          SizedBox(
            height: 48,
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                children: [
                  for (final file in files)
                    Chip(
                      label: SizedBox(
                        width: 160,
                        child: Text(
                          file['name'] as String,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      onDeleted: () => setState(() => files.remove(file)),
                    ),
                ],
              ),
            ),
          ),
        Padding(
          padding: const EdgeInsets.all(8),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              IconButton(
                tooltip: 'Dosya ekle',
                onPressed: c.busy || !c.active ? null : _pick,
                icon: const Icon(Icons.attach_file),
              ),
              Expanded(
                child: TextField(
                  key: const Key('chat-composer'),
                  controller: composer,
                  minLines: 1,
                  maxLines: constraints.maxHeight < 400 ? 2 : 5,
                  maxLength: 4000,
                  enabled: c.active,
                  decoration: const InputDecoration(
                    labelText: 'Şifreli mesaj',
                    border: OutlineInputBorder(),
                  ),
                ),
              ),
              IconButton(
                key: const Key('chat-send'),
                tooltip: 'Mesaj gönder',
                onPressed: c.busy || !c.active || c.selected == null
                    ? null
                    : _send,
                icon: const Icon(Icons.send),
              ),
            ],
          ),
        ),
      ],
    ),
  );
}
