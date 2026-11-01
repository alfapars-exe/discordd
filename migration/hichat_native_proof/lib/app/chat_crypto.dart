abstract interface class ChatCrypto {
  Future<Map<String, dynamic>> status();
  Future<void> registerFreshDevice();
  Future<dynamic> chat(Map<String, dynamic> command);
}
