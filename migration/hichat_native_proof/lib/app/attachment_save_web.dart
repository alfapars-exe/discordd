import 'dart:async';
import 'dart:js_interop';
import 'dart:typed_data';

import 'package:web/web.dart' as web;

Future<void> saveAttachment(
  Uint8List bytes,
  String name,
  bool Function() current,
) async {
  if (!current()) return;
  final blob = web.Blob(
    [bytes.toJS].toJS,
    web.BlobPropertyBag(type: 'application/octet-stream'),
  );
  final url = web.URL.createObjectURL(blob);
  try {
    web.HTMLAnchorElement()
      ..href = url
      ..download = name
      ..click();
  } finally {
    Timer(const Duration(seconds: 10), () => web.URL.revokeObjectURL(url));
  }
}
