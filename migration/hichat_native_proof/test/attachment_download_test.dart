import 'package:flutter_test/flutter_test.dart';
import 'package:hichat_native_proof/app/api.dart';
import 'package:hichat_native_proof/app/attachment_download.dart';
import 'package:http/http.dart' as http;

class InterruptedTransport extends http.BaseClient {
  final requests = <String>[];
  bool invalidRange = false;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    expect(request.url.host, 'example.com');
    expect(request.followRedirects, isFalse);
    expect(request.headers['Authorization'], 'Bearer token');
    requests.add(request.headers['Range']!);
    final start = requests.length == 1 ? 0 : 7;
    return http.StreamedResponse(
      Stream.value(List<int>.generate(start == 0 ? 7 : 13, (i) => i + start)),
      206,
      contentLength: 20 - start,
      headers: {
        'content-range': invalidRange ? 'bytes 0-19/99' : 'bytes $start-19/20',
      },
    );
  }
}

void main() {
  test(
    'continues at the last received ciphertext byte after truncation',
    () async {
      final transport = InterruptedTransport();
      final api = HiChatApi('https://example.com', client: transport)
        ..session = const Session('token', 'refresh', 'owner', 'Owner');
      final download = AttachmentDownload('/api/uploads/encrypted_0.bin', 20);
      await expectLater(download.read(api), throwsA(isA<ApiFailure>()));
      expect(await download.read(api), List.generate(20, (i) => i));
      expect(transport.requests, ['bytes=0-19', 'bytes=7-19']);
      api.close();
    },
  );

  test('rejects unbound ranges and traversal before exposing bytes', () async {
    final transport = InterruptedTransport()..invalidRange = true;
    final api = HiChatApi('https://example.com', client: transport)
      ..session = const Session('token', 'refresh', 'owner', 'Owner');
    await expectLater(
      AttachmentDownload('/api/uploads/%2e%2e', 20).read(api),
      throwsA(isA<ApiFailure>()),
    );
    expect(transport.requests, isEmpty);
    await expectLater(
      AttachmentDownload('/api/uploads/encrypted_0.bin', 20).read(api),
      throwsA(isA<ApiFailure>()),
    );
    expect(transport.requests, hasLength(1));
    expect(attachmentSaveName('../invoice.html'), endsWith('.download'));
    expect(attachmentSaveName('CON.txt'), 'HiChat-CON.txt');
    api.close();
  });
}
