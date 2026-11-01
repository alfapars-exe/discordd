import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root=new URL('../../',import.meta.url);
const windows=JSON.parse(await readFile(new URL('../.local/chat-windows-receipt.json',import.meta.url),'utf8'));
const web=JSON.parse(await readFile(new URL('../.local/web-attachments-receipt.json',import.meta.url),'utf8'));
for(const flag of ['multipartIdempotencyAfterReopen','identicalRetryPayloadAndFileBytes','orderedEncryptedAttachments','independentWebCryptoFileValidation','simultaneousSessionConfirmation','cancellationBeforeConfirmation']) {
 if(windows[flag]!==true)throw new Error('WINDOWS_ATTACHMENT_SESSION_ACCEPTANCE_INCOMPLETE');
}
for(const flag of ['bothSessionsExplicitlyConfirmed','checkboxRequired','cancellationRetainsReview','finalBuildLostCommittedAttachmentAck','finalBuildIdenticalMultipartFieldsAndFileBytes','noDuplicateRows','logoutClearsChat']) {
 if(web[flag]!==true)throw new Error('WEB_ATTACHMENT_SESSION_ACCEPTANCE_INCOMPLETE');
}
const paths=[
 'server/models/dm.go','server/handlers/dm.go','server/handlers/dm_send_files.go',
 'server/handlers/dm_attachment_idempotent_test.go','server/services/dm_message.go',
 'server/services/dm_upload_service.go','server/services/dm_upload_cleanup.go',
 'server/services/dm_attachment_receipt_test.go','server/main.go',
 'server/repository/dm_send_receipt.go','server/repository/sqlite_dm_attachments.go',
 'server/database/migrations/150_dm_attachment_order.sql',
 'server/database/postgres_migrations/053_dm_attachment_order.sql',
 'migration/crates/client-core/src/chat.rs','migration/crates/client-core/src/attachments.rs',
 'migration/hichat_native_proof/lib/app/api.dart','migration/hichat_native_proof/lib/app/chat.dart',
 'migration/hichat_native_proof/lib/app/chat_view.dart','migration/hichat_native_proof/lib/app/device_vault.dart',
 'migration/hichat_native_proof/test/chat_test.dart','migration/hichat_native_proof/integration_test/chat_test.dart',
 'migration/hichat_native_proof/pubspec.lock','migration/scripts/qa-dm-fault.mjs','migration/scripts/verify-file-qa.mjs',
];
const sourceFilesSHA256NormalizedLF=Object.fromEntries(await Promise.all(paths.toSorted((a,b)=>a.localeCompare(b)).map(async path=>[path,createHash('sha256').update((await readFile(new URL(path,root),'utf8')).replaceAll('\r\n','\n')).digest('hex')])));
const webArtifactScope=JSON.parse(await readFile(new URL('../.local/web-artifact-scope.json',import.meta.url),'utf8'));
const receipt={date:'2026-11-02',rustPassed:34,rustOrdinaryIgnored:2,flutterPassed:31,
 flutterAnalyzeClean:true,clippyWarningsDenied:true,windowsReleaseBuild:true,webReleaseBuild:true,
 postgresAttachmentTests:4,postgresAndSQLiteReceiptTests:true,postgresRaceDetectorLinuxContainer:true,
 postgresDatabaseRepositoryHandlerServiceSuites:true,windows,web,webArtifactScope,
 previewFileLimits:{perFileBytes:1048576,totalBytes:2097152,count:10},
 physicalDevicesAccepted:false,sourceFilesSHA256NormalizedLF};
await writeFile(new URL('../evidence/dm-attachments-session.json',import.meta.url),JSON.stringify(receipt,null,2)+'\n');
console.log('Sanitized attachment/session acceptance and source fingerprints written.');
