import 'dart:io';

String _scope(String origin, String owner) =>
    Uri.encodeComponent('$origin|$owner');
File _file(String origin, String owner) {
  final root =
      Platform.environment['LOCALAPPDATA'] ?? Platform.environment['HOME'];
  if (root == null) throw StateError('Storage unavailable');
  return File(
    '$root/HiChatMigrationProof/history-${_scope(origin, owner)}.json',
  );
}

Future<void> saveArchive(
  String origin,
  String owner,
  String encryptedJson,
) async {
  final file = _file(origin, owner);
  await file.parent.create(recursive: true);
  final temporary = File('${file.path}.tmp');
  await temporary.writeAsString(encryptedJson, flush: true);
  await temporary.rename(file.path);
}

Future<String?> loadArchive(String origin, String owner) async {
  final file = _file(origin, owner);
  if (!await file.exists()) return null;
  if (await file.length() > 48 * 1024 * 1024) {
    throw StateError('Archive too large');
  }
  return file.readAsString();
}
