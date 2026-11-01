// Source/artifact-bound incremental receipt. Local fixture secrets are never copied.
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const local=new URL('../.local/',import.meta.url);
const p2p=JSON.parse(await readFile(new URL('p2p-receipt.json',local),'utf8'));
const native=JSON.parse(await readFile(new URL('native-p2p-receipt.json',local),'utf8'));
const audio=JSON.parse(await readFile(new URL('native-audio-receipt.json',local),'utf8'));
assert(p2p.peers.length===2&&p2p.peers.every(p=>p.videoFrames>10&&p.audioEnergy>0&&p.dtlsConnected));
assert(p2p.hangupClosedBothPeers&&p2p.ringingDidNotCapture);
assert(native.windowsFrames>10&&native.windowsAudioEnergy>0&&native.browser.audioEnergy>0&&native.browser.dtlsConnected);
assert(audio.audioEnergy>0&&audio.encryptedRoom);
const browserProfiles=JSON.parse(await readFile(new URL('browser-results.json',local),'utf8'));
assert(browserProfiles.length===3&&browserProfiles.every(p=>p.login&&p.historyWebCryptoRust&&p.logoutClearsHistory&&!p.physicalDevice));
const files=[
 'hichat_native_proof/pubspec.lock','hichat_native_proof/rust/Cargo.lock','Cargo.lock',
 'crates/client-core/src/overlay.rs','hichat_native_proof/lib/app/p2p.dart',
 'hichat_native_proof/lib/app/p2p_view.dart','hichat_native_proof/lib/app/game_overlay.dart',
 'hichat_native_proof/lib/app/media.dart','hichat_native_proof/lib/app/screen.dart',
 'hichat_native_proof/build/windows/x64/runner/Release/hichat_native_proof.exe',
 'hichat_native_proof/build/windows/x64/runner/Release/data/app.so',
 'hichat_native_proof/build/windows/x64/runner/Release/rust_lib_hichat_native_proof.dll',
 'hichat_native_proof/build/windows/x64/runner/Release/flutter_webrtc_plugin.dll',
 'hichat_native_proof/build/windows/x64/runner/Release/libwebrtc.dll',
 'hichat_native_proof/build/web/pkg/rust_lib_hichat_native_proof_bg.wasm',
 'hichat_native_proof/build/web/e2ee.worker.dart.js',
 'hichat_native_proof/build/web/main.dart.js',
];
const hashes={};for(const file of files)hashes[file]=createHash('sha256').update(await readFile(new URL('../'+file,import.meta.url))).digest('hex');
const result={localDate:'2026-10-31',scope:'incremental proof; incomplete requested scope',physicalDeviceAcceptance:false,activeDeviceRatchetHandoff:'not implemented',ordinaryRustTests:8,separateHiddenWin32Runtime:'passed; visible gameplay not tested',flutterTests:10,browserProfiles,nativeAudio:audio,browserP2P:p2p,nativeP2P:native,knownOpen:['native outbound window video decoded zero frames in browser','full-system own-process exclusion/feedback acceptance','legacy-client interop and P2P screen renegotiation','actual game/fullscreen/DPI/PTT acceptance','actual mobile browsers and other platforms'],hashes};
await writeFile(new URL('../evidence/windows-media.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
console.log('Sanitized incremental media receipt written; incomplete scope remains explicit');
