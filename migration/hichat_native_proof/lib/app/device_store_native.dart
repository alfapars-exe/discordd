import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import '../src/rust/api/simple.dart' as rust;

class DeviceStore {
  final String scope;
  final File file;
  final RandomAccessFile _lease;
  bool _closed = false;
  DeviceStore._(this.scope, this.file, this._lease);
  static Future<DeviceStore> open(String scope) async {
    if (!Platform.isWindows) throw StateError('PLATFORM_KEYSTORE_REQUIRED');
    final root = Platform.environment['LOCALAPPDATA'];
    if (root == null) throw StateError('STORAGE_UNAVAILABLE');
    final id = await rust.deviceScopeId(scope: scope);
    final file = File('$root/HiChatMigrationProof/device-vault/$id.sealed');
    await file.parent.create(recursive: true);
    final lease = await File('${file.path}.lock').open(mode: FileMode.append);
    try {
      await lease.lock(FileLock.exclusive);
    } catch (_) {
      await lease.close();
      throw StateError('DEVICE_OWNER_BUSY');
    }
    return DeviceStore._(scope, file, lease);
  }

  Future<Map<String, dynamic>?> load() async {
    if (_closed) throw StateError('DEVICE_STORE_CLOSED');
    if (!await file.exists()) return null;
    if (await file.length() > 96 * 1024 * 1024) {
      throw StateError('VAULT_TOO_LARGE');
    }
    final plain = await rust.protectDeviceStore(
      data: await file.readAsBytes(),
      scope: scope,
      decode: true,
    );
    try {
      return jsonDecode(utf8.decode(plain)) as Map<String, dynamic>;
    } finally {
      plain.fillRange(0, plain.length, 0);
    }
  }

  Future<void> save(Map<String, dynamic> value) async {
    if (_closed) throw StateError('DEVICE_STORE_CLOSED');
    final plain = Uint8List.fromList(utf8.encode(jsonEncode(value)));
    late Uint8List sealed;
    try {
      sealed = await rust.protectDeviceStore(
        data: plain,
        scope: scope,
        decode: false,
      );
    } finally {
      plain.fillRange(0, plain.length, 0);
    }
    if (_closed) throw StateError('DEVICE_STORE_CLOSED');
    await rust.commitDeviceStore(path: file.path, data: sealed);
  }

  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    await _lease.unlock();
    await _lease.close();
  }
}
