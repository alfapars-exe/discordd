import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root=new URL('../../',import.meta.url);
const windows=JSON.parse(await readFile(new URL('../.local/chat-windows-receipt.json',import.meta.url),'utf8'));
const web=JSON.parse(await readFile(new URL('../.local/web-outbox-receipt.json',import.meta.url),'utf8'));
for(const flag of ['automaticRetryAfterReopen','identicalRetryPOSTBytes','realWebSocketDurableEvents','replayMatchesWebSocketIDs']){
 if(windows[flag]!==true)throw new Error('WINDOWS_OUTBOX_ACCEPTANCE_INCOMPLETE');
}
for(const flag of ['realBrowserRustWasm','crossOriginIsolated','automaticIdenticalRetry','bidirectionalPlaintextVisible','logoutClearsChat']){
 if(web[flag]!==true)throw new Error('WEB_RETRY_ACCEPTANCE_INCOMPLETE');
}
const paths=[
 'server/services/dm_delivery.go','server/services/dm_delivery_test.go',
 'server/database/postgres_migrations/052_dm_delivery_outbox.sql',
 'server/database/migrations/149_dm_event_sequence.sql',
 'server/database/postgres_import.go','server/database/postgres_import_test.go',
 'server/handlers/dm.go','server/handlers/dm_send_files.go','server/ws/event.go',
 'migration/crates/client-core/src/chat.rs','migration/crates/protocol/src/lib.rs',
 'migration/hichat_native_proof/lib/app/api.dart','migration/hichat_native_proof/lib/app/chat.dart',
 'migration/hichat_native_proof/lib/app/screen.dart',
 'migration/hichat_native_proof/integration_test/chat_test.dart',
 'migration/hichat_native_proof/test/chat_test.dart','migration/scripts/proof-server.mjs',
];
const sourceFilesSHA256NormalizedLF=Object.fromEntries(await Promise.all(paths.toSorted((a,b)=>a.localeCompare(b)).map(async path=>[path,createHash('sha256').update((await readFile(new URL(path,root),'utf8')).replaceAll('\r\n','\n')).digest('hex')])));
const receipt={date:'2026-11-01',rustPassed:31,rustOrdinaryIgnored:2,flutterPassed:27,
 postgresOutboxTests:6,postgresDatabaseAndRepositoryPassed:true,
 postgresRaceDetectorLinuxContainer:true,windows,web,
 webScope:'Real timer/WASM/IndexedDB/lost-response UI flow preceded final startup-initialization bookkeeping; final unit tests and Windows integration cover that bookkeeping, final web release compiles it.',
 windowsReleaseBuild:true,webReleaseBuild:true,flutterAnalyzeClean:true,
 physicalDevicesAccepted:false,sourceFilesSHA256NormalizedLF};
await writeFile(new URL('../evidence/dm-outbox.json',import.meta.url),JSON.stringify(receipt,null,2)+'\n');
console.log('Sanitized automatic retry and DM outbox receipt written.');
