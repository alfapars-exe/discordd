import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'api.dart';
import 'device_store.dart';

const maxAttachmentBytes = 25 * 1024 * 1024 - 16;

class AttachmentDownload {
  final String path;
  final int size;
  final _bytes = BytesBuilder(copy: false);
  bool _reading = false;

  AttachmentDownload(this.path, this.size);

  Future<Uint8List> read(HiChatApi api, {String? digest}) async {
    if (_reading || size < 16 || size > maxAttachmentBytes + 16) {
      throw const ApiFailure('INVALID_ATTACHMENT_SIZE');
    }
    _reading = true;
    final scope = api.generation;
    final identity = jsonEncode([path, size, digest]);
    DeviceStore? store;
    var persisted = 0;
    try {
      if (digest != null && RegExp(r'^[a-f0-9]{64}$').hasMatch(digest)) {
        store = await _openCheckpoint(api);
        if (store != null && _bytes.isEmpty) {
          await _restore(store, identity);
          persisted = _bytes.length;
        }
      }
      while (_bytes.length < size) {
        if (!api.isCurrent(scope)) throw const ApiFailure('SESSION_CHANGED');
        final start = _bytes.length;
        final end = (start + 1024 * 1024 - 1).clamp(start, size - 1);
        final response = await api.attachmentRange(path, start, end);
        final expected = end - start + 1;
        if (response.statusCode != 206 ||
            response.headers['content-range'] != 'bytes $start-$end/$size' ||
            response.contentLength != expected) {
          await response.stream.listen(null).cancel();
          throw const ApiFailure('INVALID_ATTACHMENT_RANGE');
        }
        await for (final chunk in response.stream.timeout(
          const Duration(seconds: 20),
        )) {
          if (!api.isCurrent(scope)) throw const ApiFailure('SESSION_CHANGED');
          if (_bytes.length + chunk.length > end + 1) {
            _bytes.clear();
            throw const ApiFailure('INVALID_ATTACHMENT_RANGE');
          }
          _bytes.add(chunk);
        }
        if (_bytes.length != end + 1) {
          throw const ApiFailure('ATTACHMENT_INTERRUPTED');
        }
        if (_bytes.length < size &&
            _bytes.length - persisted >= 4 * 1024 * 1024) {
          await _save(store, identity);
          persisted = _bytes.length;
        }
      }
      await _save(store, identity, clear: true);
      if (!api.isCurrent(scope)) throw const ApiFailure('SESSION_CHANGED');
      return _bytes.takeBytes();
    } catch (_) {
      if (api.isCurrent(scope) && _bytes.length > 0 && _bytes.length < size) {
        await _save(store, identity);
      }
      rethrow;
    } finally {
      if (!api.isCurrent(scope)) _bytes.clear();
      try {
        await store?.close();
      } catch (_) {
        // A lease release failure does not invalidate the downloaded bytes.
      } finally {
        _reading = false;
      }
    }
  }

  static Future<DeviceStore?> _openCheckpoint(HiChatApi api) async {
    final user = api.session?.userId;
    if (user == null) return null;
    try {
      return await DeviceStore.open(
        jsonEncode(['attachment-download-v1', api.origin.toString(), user]),
      );
    } catch (_) {
      // Concurrent owners and unavailable storage still allow an in-memory retry.
      return null;
    }
  }

  Future<void> _restore(DeviceStore store, String identity) async {
    try {
      final saved = await store.load();
      final data = saved?['ciphertext'];
      if (saved?['identity'] != identity ||
          data is! String ||
          data.length > ((size + 2) ~/ 3) * 4) {
        return;
      }
      final partial = base64Decode(data);
      if (partial.isNotEmpty && partial.length < size) _bytes.add(partial);
    } catch (_) {
      // A missing or unreadable checkpoint is safe to restart at byte zero.
    }
  }

  Future<void> _save(
    DeviceStore? store,
    String identity, {
    bool clear = false,
  }) async {
    if (store == null) return;
    try {
      await store.save(
        clear
            ? {}
            : {
                'identity': identity,
                'ciphertext': base64Encode(_bytes.toBytes()),
              },
      );
    } catch (_) {
      // The current transfer can continue if local persistence fails.
    }
  }
}

String attachmentSaveName(String name) {
  final cleaned = name
      .replaceAll(RegExp(r'[^\p{L}\p{N} ._-]', unicode: true), '_')
      .replaceAll(RegExp(r'^[. ]+|[. ]+$'), '');
  final short = String.fromCharCodes(cleaned.runes.take(100));
  final safe = short.isEmpty ? 'attachment' : 'HiChat-$short';
  const allowed = [
    'txt',
    'png',
    'jpg',
    'jpeg',
    'gif',
    'webp',
    'mp3',
    'mp4',
    'wav',
  ];
  return allowed.contains(safe.split('.').last.toLowerCase())
      ? safe
      : '$safe.download';
}
