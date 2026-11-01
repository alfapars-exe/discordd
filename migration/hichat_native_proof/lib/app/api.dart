import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'transport.dart';

class ApiFailure implements Exception {
  final String code;
  final int status;
  const ApiFailure(this.code, [this.status = 0]);
  @override
  String toString() => code;
}

class Session {
  final String accessToken, refreshToken, userId, displayName;
  const Session(
    this.accessToken,
    this.refreshToken,
    this.userId,
    this.displayName,
  );
  // Routing hint only; the server validates the signed token and refresh cookie.
  String get sessionId {
    try {
      final parts = accessToken.split('.');
      if (parts.length != 3 || parts[1].length > 16384) return '';
      final claims = jsonDecode(
        utf8.decode(base64Url.decode(base64Url.normalize(parts[1]))),
      );
      return claims is Map && claims['sid'] is String
          ? claims['sid'] as String
          : '';
    } on FormatException {
      return '';
    }
  }

  factory Session.fromJson(Map<String, dynamic> data) {
    final user = data['user'] as Map<String, dynamic>;
    final value = Session(
      data['access_token'] as String,
      data['refresh_token'] as String? ?? '',
      user['id'] as String,
      (user['display_name'] ?? user['username'] ?? '') as String,
    );
    if (value.accessToken.isEmpty || value.userId.isEmpty) {
      throw const ApiFailure('INVALID_SESSION');
    }
    return value;
  }
}

Uri normalizeOrigin(String value) {
  final uri = Uri.parse(value.trim());
  final local = ['localhost', '127.0.0.1', '::1'].contains(uri.host);
  if ((!local && uri.scheme != 'https') ||
      (local && !['http', 'https'].contains(uri.scheme)) ||
      uri.host.isEmpty ||
      uri.userInfo.isNotEmpty ||
      uri.hasQuery ||
      uri.hasFragment ||
      !['', '/', '/api', '/api/'].contains(uri.path)) {
    throw const ApiFailure('HTTPS_ORIGIN_REQUIRED');
  }
  return uri.replace(path: '', query: null, fragment: null);
}

/// Tokens stay in memory. No plaintext password/token persistence or redirects.
class HiChatApi {
  final http.Client transport;
  final Uri origin;
  Session? session;
  int generation = 0;
  Future<void>? _refreshing;
  final _invalidations = StreamController<void>.broadcast(sync: true);
  Stream<void> get invalidations => _invalidations.stream;
  void _invalidate() {
    session = null;
    generation++;
    if (!_invalidations.isClosed) _invalidations.add(null);
  }

  HiChatApi(String base, {http.Client? client})
    : origin = normalizeOrigin(base),
      transport = createTransport(normalizeOrigin(base), client: client);

  bool isCurrent(int scope) => generation == scope && session != null;

  Future<dynamic> _send(
    String method,
    String path, {
    Object? body,
    String? token,
    Map<String, String>? query,
  }) async {
    if (!path.startsWith('/api/') || path.startsWith('//')) {
      throw const ApiFailure('INVALID_PATH');
    }
    final request = http.Request(
      method,
      origin.replace(path: path, queryParameters: query),
    )..followRedirects = false;
    request.headers['Content-Type'] = 'application/json';
    request.headers['X-HiChat-Client'] = 'web';
    if (token != null) request.headers['Authorization'] = 'Bearer $token';
    if (body != null) request.body = jsonEncode(body);
    try {
      final response = await transport
          .send(request)
          .timeout(const Duration(seconds: 20));
      final bytes = <int>[];
      await for (final chunk in response.stream.timeout(
        const Duration(seconds: 20),
      )) {
        bytes.addAll(chunk);
        if (bytes.length > 48 * 1024 * 1024) {
          throw const ApiFailure('RESPONSE_TOO_LARGE');
        }
      }
      if (response.statusCode >= 300 && response.statusCode < 400) {
        throw const ApiFailure('REDIRECT_REFUSED');
      }
      late final Map<String, dynamic> envelope;
      try {
        envelope = jsonDecode(utf8.decode(bytes)) as Map<String, dynamic>;
      } on FormatException {
        if (response.statusCode >= 400) {
          throw ApiFailure('HTTP_${response.statusCode}', response.statusCode);
        }
        rethrow;
      }
      if (response.statusCode < 200 ||
          response.statusCode >= 300 ||
          envelope['success'] != true) {
        throw ApiFailure(
          envelope['code'] as String? ?? 'HTTP_${response.statusCode}',
          response.statusCode,
        );
      }
      return envelope['data'];
    } on ApiFailure {
      rethrow;
    } on TimeoutException {
      throw const ApiFailure('REQUEST_TIMEOUT');
    } on FormatException {
      throw const ApiFailure('INVALID_RESPONSE');
    } on http.ClientException {
      throw const ApiFailure('NETWORK_ERROR');
    }
  }

  Future<void> login(
    String username,
    String password, {
    String mfa = '',
  }) async {
    _invalidate();
    final scope = generation;
    final result = await _send(
      'POST',
      '/api/auth/login',
      body: {
        'username': username.trim(),
        'password': password,
        if (mfa.isNotEmpty) 'mfa_code': mfa.trim(),
      },
    );
    if (scope != generation) throw const ApiFailure('SESSION_CHANGED');
    session = Session.fromJson(result as Map<String, dynamic>);
  }

  Future<void> _refresh(int scope) async {
    final old = session;
    if (old == null || !isCurrent(scope)) {
      throw const ApiFailure('SESSION_CHANGED');
    }
    try {
      final data = await _send(
        'POST',
        '/api/auth/refresh',
        body: {
          'refresh_token': old.refreshToken,
          'expected_user_id': old.userId,
          if (old.sessionId.isNotEmpty) 'expected_session_id': old.sessionId,
        },
      ) as Map<String, dynamic>;
      if (!isCurrent(scope)) throw const ApiFailure('SESSION_CHANGED');
      if (data['user'] is! Map || data['user']['id'] != old.userId) {
        _invalidate();
        throw const ApiFailure('ACCOUNT_MISMATCH', 409);
      }
      final next = Session(
        data['access_token'] as String,
        data['refresh_token'] as String? ?? '',
        old.userId,
        old.displayName,
      );
      if (old.sessionId.isNotEmpty && next.sessionId != old.sessionId) {
        _invalidate();
        throw const ApiFailure('SESSION_MISMATCH', 409);
      }
      session = next;
    } on ApiFailure catch (error) {
      if (isCurrent(scope) &&
          (error.status == 401 ||
              error.status == 403 ||
              ['ACCOUNT_MISMATCH', 'SESSION_MISMATCH'].contains(error.code))) {
        _invalidate();
      }
      rethrow;
    }
  }

  Future<dynamic> request(
    String method,
    String path, {
    Object? body,
    Map<String, String>? query,
  }) async {
    final scope = generation;
    final current = session;
    if (current == null) throw const ApiFailure('LOGIN_REQUIRED');
    try {
      final data = await _send(
        method,
        path,
        body: body,
        token: current.accessToken,
        query: query,
      );
      if (!isCurrent(scope)) throw const ApiFailure('SESSION_CHANGED');
      return data;
    } on ApiFailure catch (error) {
      if (error.status != 401 || !isCurrent(scope)) rethrow;
      if (session?.accessToken == current.accessToken) {
        final pending = _refreshing ??= _refresh(scope);
        try {
          await pending;
        } finally {
          if (identical(_refreshing, pending)) _refreshing = null;
        }
      }
      if (!isCurrent(scope)) throw const ApiFailure('SESSION_CHANGED');
      final data = await _send(
        method,
        path,
        body: body,
        token: session!.accessToken,
        query: query,
      );
      if (!isCurrent(scope)) throw const ApiFailure('SESSION_CHANGED');
      return data;
    }
  }

  Future<void> logout() async {
    final old = session;
    _invalidate();
    _refreshing = null;
    if (old != null) {
      await _send(
        'POST',
        '/api/auth/logout',
        token: old.accessToken,
        body: {
          'refresh_token': old.refreshToken,
          'expected_user_id': old.userId,
        },
      );
    }
  }

  void close() {
    _invalidate();
    unawaited(_invalidations.close());
    transport.close();
  }
}
