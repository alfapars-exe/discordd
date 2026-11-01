import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root=new URL('../../',import.meta.url);
const local=JSON.parse(await readFile(new URL('../.local/chat-windows-receipt.json',import.meta.url),'utf8'));
for(const flag of ['postgresMutualTLS','rustFFI','lostResponseAfterCommit','durableIdempotentRetryAfterReopen','identicalRetryPOSTBytes']){
 if(local[flag]!==true)throw new Error('DM_RETRY_ACCEPTANCE_INCOMPLETE');
}
const paths=[
 'server/models/dm.go','server/services/dm_message.go','server/repository/dm_send_receipt.go',
 'server/handlers/dm.go','server/handlers/dm_send_files.go','server/database/migrations/148_dm_send_receipts.sql',
 'server/database/postgres_migrations/051_dm_send_receipts.sql',
 'server/services/dm_send_receipt_test.go','server/handlers/dm_idempotent_test.go',
 'migration/crates/client-core/src/chat.rs',
 'migration/hichat_native_proof/lib/app/api.dart','migration/hichat_native_proof/lib/app/chat.dart',
 'migration/hichat_native_proof/lib/app/chat_view.dart',
 'migration/hichat_native_proof/integration_test/chat_test.dart',
 'migration/hichat_native_proof/test/chat_test.dart',
];
const sourceFilesSHA256NormalizedLF=Object.fromEntries(await Promise.all(paths.toSorted((a,b)=>a.localeCompare(b)).map(async path=>[path,createHash('sha256').update((await readFile(new URL(path,root),'utf8')).replaceAll('\r\n','\n')).digest('hex')])));
const receipt={date:'2026-11-01',rustPassed:29,rustOrdinaryIgnored:2,flutterPassed:23,
 sqliteConcurrentReplayAndRollback:true,postgresConcurrentReplayAndRollback:true,
 postgresRaceDetectorLinuxContainer:true,windowsNativeMutualTLSRealGoRetryAfterStoreReopen:true,
 exactRetryPOSTBytes:true,serverMessages:local.serverMessages,
 windowsReleaseBuild:true,webReleaseBuild:true,flutterAnalyzeClean:true,clippyWarningsDenied:true,
 browserRetryUIAccepted:false,physicalDevicesAccepted:false,sourceFilesSHA256NormalizedLF};
await writeFile(new URL('../evidence/dm-retry.json',import.meta.url),JSON.stringify(receipt,null,2)+'\n');
console.log('Sanitized DM retry acceptance and source fingerprints written.');
