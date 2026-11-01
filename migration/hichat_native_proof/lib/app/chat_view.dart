import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';

import 'chat.dart';

class ChatView extends StatefulWidget {
  final ChatController controller;
  const ChatView({super.key, required this.controller});
  @override
  State<ChatView> createState() => _ChatViewState();
}

class _ChatViewState extends State<ChatView> {
  final composer = TextEditingController(), recipient = TextEditingController();
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
    await c.send(text);
    if (mounted && c.lastPreparedId != null && composer.text == text) {
      composer.clear();
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
                            p['state'] == 'prepared'
                                ? 'Gönderilmeye hazır.'
                                : p['delivery'] == 'idempotent-v1'
                                ? 'Sunucu onayı alınamadı; aynı istek güvenle yeniden denenebilir.'
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
                  '${m['author']?['display_name'] ?? m['user_id']} • ${m['created_at']}',
                ),
              );
            },
          ),
        ),
        Padding(
          padding: const EdgeInsets.all(8),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
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
