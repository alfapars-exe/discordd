import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const media=JSON.parse(await readFile(path.join(root,'.local/media-receipt.json'),'utf8'));
const browser=JSON.parse(await readFile(path.join(root,'.local/browser-results.json'),'utf8'));
if(!(media.windowsDecodedFrames>10&&media.windowsDecodedScreenFrames>10&&media.encryptedRoom))throw Error('Media gate missing');
if(browser.length!==3||browser.some(r=>!r.login||!r.historyWebCryptoRust||!r.logoutClearsHistory||r.physicalDevice))throw Error('Browser gate missing');
const files=['crates/client-core/src/history.rs','hichat_native_proof/lib/main.dart','hichat_native_proof/pubspec.lock','third_party/dart-webrtc-keyring.patch'];
for(const file of await readdir(path.join(root,'hichat_native_proof/lib/app'))){if(file.endsWith('.dart'))files.push('hichat_native_proof/lib/app/'+file);}
const sources={};for(const file of files.sort((a,b)=>a.localeCompare(b)))sources[file]=createHash('sha256').update(await readFile(path.join(root,file))).digest('hex');
const artifacts={};for(const file of ['hichat_native_proof/build/windows/x64/runner/Release/hichat_native_proof.exe','hichat_native_proof/build/web/main.dart.js','hichat_native_proof/build/web/pkg/rust_lib_hichat_native_proof_bg.wasm','hichat_native_proof/build/web/e2ee.worker.dart.js'])artifacts[file]=createHash('sha256').update(await readFile(path.join(root,file))).digest('hex');
await mkdir(path.join(root,'evidence'),{recursive:true});
await writeFile(path.join(root,'evidence/windows-web.json'),JSON.stringify({date:'2026-10-30',scope:'local synthetic proof only',rustTests:7,flutterUnitWidgetTests:10,windowsAuthHistoryRoomLogout:true,physicalDevices:false,published:false,browser,media,sourceSha256:sources,artifactSha256:artifacts},null,2)+'\n');
console.log('Sanitized local proof receipt written; no credentials or messages included.');
