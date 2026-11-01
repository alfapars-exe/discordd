import 'package:http/http.dart' as http;

http.Client createTransport(Uri origin, {http.Client? client}) =>
    MemoryCookieClient(origin, client ?? http.Client());

/// Only the existing auth cookie is retained, only in memory and for this origin.
class MemoryCookieClient extends http.BaseClient {
  final Uri origin;
  final http.Client inner;
  String? _refresh;
  MemoryCookieClient(this.origin, this.inner);
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    if (request.url.origin != origin.origin) {
      throw http.ClientException('Cross-origin request refused');
    }
    if (_refresh != null && request.url.path.startsWith('/api/auth/')) {
      request.headers['cookie'] = 'hichat_refresh=$_refresh';
    }
    final response = await inner.send(request);
    final cookies = response.headers['set-cookie'];
    if (cookies != null && request.url.path.startsWith('/api/auth/')) {
      final matches = RegExp(r'(?:^|,\s*)hichat_refresh=([^;,\s]*)')
          .allMatches(cookies);
      for (final match in matches) {
        final token = match.group(1)!;
        _refresh = token.isEmpty ? null : token;
      }
    }
    return response;
  }

  @override
  void close() {
    _refresh = null;
    inner.close();
  }
}
