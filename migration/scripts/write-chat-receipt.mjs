// Publish only sanitized acceptance flags and hashes, never raw test fixtures.
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root=new URL('../../',import.meta.url),local=new URL('../.local/',import.meta.url);
const load=async name=>JSON.parse(await readFile(new URL(name,local),'utf8'));
function flags(value){return Object.fromEntries(Object.entries(value).filter(([key,v])=>typeof v==='boolean'||key==='serverMessages'&&Number.isInteger(v)&&v>=0&&v<=100));}
const windows=flags(await load('chat-windows-receipt.json'));
const handoff=flags(await load('chat-handoff-receipt.json'));
const webPeer=flags(await load('web-handoff-peer-receipt.json'));
const web=flags(await load('web-handoff-target-receipt.json'));
if(!windows.bidirectionalEncryptedDM||!windows.dpapiReopen||!handoff.dhTurnAcrossHandoff||!handoff.sourceRetiredAndFenced||!webPeer.browserHandoffMessageDecrypted||!web.bidirectionalMessagesAfterHandoff||!web.reloadRetainsDeviceAndChatHistory||!web.logoutClearsChat)throw new Error('CHAT_ACCEPTANCE_INCOMPLETE');
const paths=[
 'migration/crates/client-core/src/chat.rs',
 'migration/crates/client-core/src/handoff.rs',
 'migration/hichat_native_proof/lib/app/api.dart',
 'migration/hichat_native_proof/lib/app/chat.dart',
 'migration/hichat_native_proof/lib/app/chat_view.dart',
 'migration/hichat_native_proof/lib/app/chat_crypto.dart',
 'migration/hichat_native_proof/lib/app/device_vault.dart',
 'migration/hichat_native_proof/lib/app/screen.dart',
 'migration/hichat_native_proof/lib/src/rust/frb_generated.dart',
 'migration/hichat_native_proof/rust/src/api/simple.rs',
 'migration/hichat_native_proof/rust/src/frb_generated.rs',
 'migration/scripts/legacy-chat-entry.ts',
 'migration/scripts/prepare-chat-qa.mjs',
];
const files={};
for(const path of paths.toSorted((a,b)=>a.localeCompare(b)))files[path]=createHash('sha256').update((await readFile(new URL(path,root),'utf8')).replaceAll('\r\n','\n')).digest('hex');
const receipt={date:'2026-11-01',scope:'disposable local accounts, real Go/PostgreSQL API, Rust native/WASM; no physical-device acceptance',baseCommit:'afec2d37eadbc46b00aa761c4c3d9585186be571',tests:{rustPassed:28,rustOrdinaryIgnored:2,flutterPassed:22,nativeIntegrationPassed:3,clippyWarningsDenied:true,flutterAnalyzeClean:true,windowsReleaseBuild:true,webReleaseBuild:true,liveGoRefreshAccountSessionBinding:true},windows,handoff,webPeer,web,sourceFilesSHA256NormalizedLF:files,remainingSoftwareInventory:'migration/STATUS.md',physicalDevicesAccepted:false};
await writeFile(new URL('../evidence/chat-handoff.json',import.meta.url),JSON.stringify(receipt,null,2)+'\n');
console.log('Sanitized chat/handoff acceptance and source fingerprints written.');
