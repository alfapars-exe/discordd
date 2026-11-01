import 'package:http/http.dart' as http;
import 'package:http/browser_client.dart';

http.Client createTransport(Uri origin, {http.Client? client}) =>
    client ?? (BrowserClient()..withCredentials = true);
