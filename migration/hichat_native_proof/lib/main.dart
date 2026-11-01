import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';

import 'src/rust/frb_generated.dart';
import 'app/screen.dart';

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
    title: 'HiChat Rust/Flutter Önizleme 1.0.4',
    theme: ThemeData.dark(useMaterial3: true),
    home: const HiChatScreen(),
  );
}
