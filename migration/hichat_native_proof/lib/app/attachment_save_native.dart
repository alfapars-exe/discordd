import 'dart:typed_data';

import 'package:file_selector/file_selector.dart';

Future<void> saveAttachment(
  Uint8List bytes,
  String name,
  bool Function() current,
) async {
  if (!current()) return;
  final location = await getSaveLocation(suggestedName: name);
  if (location == null || !current()) return;
  await XFile.fromData(
    bytes,
    name: name,
    mimeType: 'application/octet-stream',
  ).saveTo(location.path);
}
