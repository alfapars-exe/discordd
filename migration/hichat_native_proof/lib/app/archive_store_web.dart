import 'package:web/web.dart' as web;

String _scope(String origin, String owner) =>
    'hichat.migration.history.v1:${Uri.encodeComponent(origin)}:${Uri.encodeComponent(owner)}';
Future<void> saveArchive(
  String origin,
  String owner,
  String encryptedJson,
) async {
  web.window.localStorage.setItem(_scope(origin, owner), encryptedJson);
}

Future<String?> loadArchive(String origin, String owner) async =>
    web.window.localStorage.getItem(_scope(origin, owner));
