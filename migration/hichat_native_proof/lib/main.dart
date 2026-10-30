import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';

import 'src/rust/api/simple.dart';
import 'src/rust/frb_generated.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await RustLib.init();
  SemanticsBinding.instance.ensureSemantics();
  runApp(const HiChatProof());
}

class HiChatProof extends StatelessWidget {
  const HiChatProof({super.key});
  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'HiChat Migration Proof',
    theme: ThemeData.dark(useMaterial3: true),
    home: Scaffold(
      appBar: AppBar(title: const Text('HiChat • Teknik doğrulama')),
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Flutter → Rust → API sözleşmesi'),
            SelectableText(greet(name: '{"success":true,"data":[]}')),
            const SizedBox(height: 24),
            const Text('Giriş, E2EE ve medya kabulü henüz tamamlanmadı.'),
          ],
        ),
      ),
    ),
  );
}
