import 'package:flutter_test/flutter_test.dart';
import 'package:hichat_native_proof/main.dart';
import 'package:hichat_native_proof/src/rust/frb_generated.dart';
import 'package:hichat_native_proof/src/rust/api/simple.dart';
import 'package:integration_test/integration_test.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() async => await RustLib.init());
  testWidgets('Can call rust function', (WidgetTester tester) async {
    await tester.pumpWidget(const HiChatProof());
    expect(find.text('HiChat’e giriş'), findsOneWidget);
    expect(greet(name: '{"success":true,"data":[]}'), 'OK: []');
  });
  testWidgets('Rust preserves API failure codes', (tester) async {
    expect(
      greet(name: '{"success":false,"error":"localized","code":"FORBIDDEN"}'),
      'ERROR: FORBIDDEN',
    );
    expect(greet(name: 'invalid'), 'ERROR: invalid_api_response');
  });
}
