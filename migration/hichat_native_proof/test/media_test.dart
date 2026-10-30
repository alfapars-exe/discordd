import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:hichat_native_proof/app/api.dart';
import 'package:hichat_native_proof/app/media.dart';

void main() {
  Map<String, dynamic> valid() => {
    'token':
        'e30.${base64Url.encode(utf8.encode('{"sub":"u1"}')).replaceAll('=', '')}.signature',
    'url': 'wss://media.example.com',
    'e2ee_passphrase': 'test-key',
    'e2ee_key_index': 2,
    'e2ee_key_epoch': 258,
    'e2ee_key_context': 'room-instance',
  };
  test('validates token ownership and indexed encryption metadata', () {
    validateMediaToken(valid(), 'u1');
    expect(
      () => validateMediaToken(valid(), 'other'),
      throwsA(isA<ApiFailure>()),
    );
    for (final mutation in [
      {'e2ee_key_index': 1},
      {'e2ee_passphrase': ''},
      {'e2ee_key_context': ''},
      {'url': 'ws://media.example.com'},
    ]) {
      expect(
        () => validateMediaToken({...valid(), ...mutation}, 'u1'),
        throwsA(isA<ApiFailure>()),
      );
    }
  });
}
