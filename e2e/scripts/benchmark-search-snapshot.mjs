import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "../../client/node_modules/vite/dist/node/index.js";

const root=fileURLToPath(new URL("../../client/",import.meta.url));
const server=await createServer({root,configFile:false,logLevel:"error",server:{host:"127.0.0.1",port:0}});
await server.listen();
try {
 const browser=await chromium.launch();
 try {
  const context=await browser.newContext(),page=await context.newPage(),cdp=await context.newCDPSession(page);
  await page.context().route("**/benchmark.html",route=>route.fulfill({contentType:"text/html",body:"<title>Search snapshot benchmark</title>"}));
  await page.goto(new URL("benchmark.html",server.resolvedUrls.local[0]).href);
  console.log("Runtime",process.version,process.platform,"Chromium",browser.version());
  for(const kind of ["channel","dm"])for(const size of [1000,10000,50000]){
   const matches=await page.evaluate(async({kind,size})=>{
    const {publishAuthOwnerChange}=await import("/src/api/authSessionEvents.ts");
    const {openScopedKeyDatabase}=await import("/src/crypto/keyStorage.ts");
    const {SERVER_URL}=await import("/src/utils/constants.ts");
    await import("/src/crypto/cachedSearchSnapshot.ts");
    publishAuthOwnerChange("snapshot-benchmark");
    const db=await openScopedKeyDatabase("snapshot-benchmark",SERVER_URL),tx=db.transaction("messageCache","readwrite");
    await tx.store.clear();let count=0;
    for(let i=0;i<size;i++){
     const target=i%5!==0,match=i%3===0;if(target&&match)count++;
     void tx.store.put({messageId:String(i).padStart(5,"0"),channelId:kind==="channel"?(target?"target":"other"):"",dmChannelId:kind==="dm"?(target?"target":"other"):null,
      content:match?"Été":"other",timestamp:kind==="dm"?size-i:i,sourceSequence:String(9007199254740992n+BigInt(i))});
    }
    await tx.done;return count;
   },{kind,size});
   const samples=[];
   for(let repetition=0;repetition<10;repetition++){
    await cdp.send("HeapProfiler.collectGarbage");const baseline=await cdp.send("Runtime.getHeapUsage");
    const result=await page.evaluate(async({kind,size})=>{
     const {createCachedSearchSnapshot}=await import("/src/crypto/cachedSearchSnapshot.ts");
     const {getCachedDecryptedMessage}=await import("/src/crypto/keyStorage.ts");
     const expected=[];for(let i=size-1;i>=0;i--)if(i%5!==0&&i%3===0)expected.push(String(i).padStart(5,"0"));
     const start=performance.now(),snapshot=await createCachedSearchSnapshot(kind,"target","ÉTÉ"),buildMs=performance.now()-start;
     Reflect.set(globalThis,"__searchSnapshotBenchmark",snapshot);
     const firstStart=performance.now(),first=await snapshot.page(0,25),firstPageMs=performance.now()-firstStart;
     const nextStart=performance.now(),next=await snapshot.page(25,25),nextPageMs=performance.now()-nextStart;
     const previousStart=performance.now(),previous=await snapshot.page(0,25),previousPageMs=performance.now()-previousStart;
     const last=await snapshot.page(1e9,25),lastOffset=Math.floor((expected.length-1)/25)*25;
     for(const [actual,wanted] of [[first.ids,expected.slice(0,25)],[next.ids,expected.slice(25,50)],[previous.ids,expected.slice(0,25)],[last.ids,expected.slice(lastOffset)]]){
      if(JSON.stringify(actual)!==JSON.stringify(wanted))throw new Error("Incorrect ordered snapshot page");
     }
     if(first.total!==expected.length||last.offset!==lastOffset)throw new Error("Incorrect snapshot count/clamp");
     const rows=await Promise.all(next.ids.map(getCachedDecryptedMessage));
     if(rows.some(row=>row?.content!=="Été"))throw new Error("Incorrect hydrated plaintext");
     const removed=await snapshot.remove(expected[0]);
     if(!removed.removed||removed.position!==0||removed.total!==expected.length-1)throw new Error("Incorrect deletion position/count");
     const after=await snapshot.page(0,25);
     if(JSON.stringify(after.ids)!==JSON.stringify(expected.slice(1,26)))throw new Error("Deletion reordered survivors");
     return {buildMs,firstPageMs,nextPageMs,previousPageMs,total:first.total,maxPageIds:Math.max(first.ids.length,next.ids.length,previous.ids.length,last.ids.length,after.ids.length)};
    },{kind,size});
    assert.equal(result.total,matches);assert.ok(result.maxPageIds<=25);
    await cdp.send("HeapProfiler.collectGarbage");const retained=await cdp.send("Runtime.getHeapUsage");
    await page.evaluate(async()=>{await Reflect.get(globalThis,"__searchSnapshotBenchmark").dispose();Reflect.deleteProperty(globalThis,"__searchSnapshotBenchmark");});
    if(repetition)samples.push({...result,retainedDeltaBytes:retained.usedSize-baseline.usedSize});
   }
   const median=key=>samples.map(sample=>sample[key]).sort((a,b)=>a-b)[4];
   console.log(JSON.stringify({kind,size,matches,repetitions:9,buildMedianMs:median("buildMs"),firstPageMedianMs:median("firstPageMs"),nextPageMedianMs:median("nextPageMs"),previousPageMedianMs:median("previousPageMs"),retainedDeltaMedianBytes:median("retainedDeltaBytes"),maxPageIds:Math.max(...samples.map(sample=>sample.maxPageIds)),scope:"Disk ordering snapshot API and25-ID windows, one warmup. Post-GC retained handle heap only; excludes transient peak, full panels and IndexedDB disk usage. Source cache writes wait during scan."}));
  }
  // A second JS realm shares IndexedDB but has no first-page handle registry.
  // Its reset must invalidate the first page through the durable source epoch.
  await page.evaluate(async()=>{
   const {createCachedSearchSnapshot}=await import("/src/crypto/cachedSearchSnapshot.ts");
   const {getCachedSearchResetGeneration}=await import("/src/crypto/cachedSearchEpoch.ts");
   Reflect.set(globalThis,"__crossTabSnapshot",await createCachedSearchSnapshot("dm","target","ÉTÉ"));
   Reflect.set(globalThis,"__crossTabResetGeneration",getCachedSearchResetGeneration());
  });
  const resetPage=await page.context().newPage();
  try {
   await resetPage.goto(new URL("benchmark.html",server.resolvedUrls.local[0]).href);
   await resetPage.evaluate(async()=>{
    const {publishAuthOwnerChange}=await import("/src/api/authSessionEvents.ts");
    const {clearAllE2EEData,getAllMetadata}=await import("/src/crypto/keyStorage.ts");
    const {CACHED_SEARCH_EPOCH_KEY}=await import("/src/crypto/cachedSearchEpoch.ts");
    publishAuthOwnerChange("snapshot-benchmark");await clearAllE2EEData();
    if((await getAllMetadata()).some(([key])=>key===CACHED_SEARCH_EPOCH_KEY))throw new Error("Reset fence became portable");
   });
   await page.waitForFunction(async()=>{
    const {getCachedSearchResetGeneration}=await import("/src/crypto/cachedSearchEpoch.ts");
    return getCachedSearchResetGeneration()>Reflect.get(globalThis,"__crossTabResetGeneration");
   });
   const reset=await page.evaluate(async()=>{
    const snapshot=Reflect.get(globalThis,"__crossTabSnapshot");let rejected=false;
    try{await snapshot.page(0,25);}catch{rejected=true;}
    await snapshot.dispose();Reflect.deleteProperty(globalThis,"__crossTabSnapshot");
    const {openDB}=await import("/node_modules/idb/build/index.js");
    const {getAccountDatabaseName}=await import("/src/crypto/keyDatabase.ts");
    const {SERVER_URL}=await import("/src/utils/constants.ts");
    const db=await openDB(`${await getAccountDatabaseName("snapshot-benchmark",SERVER_URL)}.search.v1`,1);
    try{return {rejected,refs:await db.count("refs"),snapshots:await db.count("snapshots")};}finally{db.close();}
   });
   assert.deepEqual(reset,{rejected:true,refs:0,snapshots:0});console.log(JSON.stringify({crossTabReset:reset}));
  }finally{await resetPage.close();}
 }finally{await browser.close();}
}finally{await server.close();}
