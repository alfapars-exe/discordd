// Verified transition-kernel receipt; no active-device or UI acceptance claim.
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const root=new URL('../',import.meta.url),fixtures={};
for(const name of ['ratchet','x3dh','sender-key'])fixtures[name]=JSON.parse(await readFile(new URL(`crates/protocol/fixtures/${name}.json`,root),'utf8'));
assert.equal(fixtures.ratchet.cases.length,11);assert.equal(fixtures.x3dh.cases.length,8);assert.equal(fixtures['sender-key'].cases.length,6);
const tests=await readFile(new URL('.local/crypto-tests.log',root),'utf8');assert(tests.includes('14 passed; 0 failed; 2 ignored')&&tests.includes('2 passed; 0 failed; 0 ignored'));
const pinned=await readFile(new URL('.local/crypto-pinned-tests.log',root),'utf8');assert(pinned.includes('14 passed; 0 failed; 2 ignored'));
const hashes={};
for(const file of ['crates/client-core/src/ratchet.rs','crates/client-core/src/x3dh.rs','crates/client-core/src/sender_key.rs','crates/client-core/src/lib.rs','Cargo.lock','hichat_native_proof/rust/Cargo.lock','scripts/ratchet-fixture.mjs',...Object.keys(fixtures).map(n=>`crates/protocol/fixtures/${n}.json`)])hashes[file]=createHash('sha256').update(await readFile(new URL(file,root))).digest('hex');
const receipt={localDate:'2026-10-31',scope:'pure crypto transition kernels; incomplete migration',requestComplete:false,activeDeviceHandoffEnabled:false,networkSendsEnabled:false,productionDataUsed:false,physicalDeviceAcceptance:false,ordinaryRustTests:16,pinnedNativeCoreTests:14,ignoredWin32Tests:2,clippy:'passed',portableWasmCheck:'passed',fixtureCases:{ratchet:11,x3dh:8,senderKey:6},captureProbe:{localPreviewWidth:0,localPreviewHeight:0,videoFramesEncoded:0,videoPacketsSent:0,audioPacketsSent:69,status:'capture produces no video; not fixed'},remaining:['atomic target storage and pending-send commit','source freeze, retirement and ownership transfer','trust and device orchestration','native outbound video capture','actual game, system audio exclusion and physical devices'],sourceSha256:hashes};
await writeFile(new URL('evidence/crypto-kernels.json',root),JSON.stringify(receipt,null,2)+'\n');
console.log('Kernel receipt written; remaining migration work is explicit');
