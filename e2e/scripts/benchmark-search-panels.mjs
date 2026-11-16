import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { setInterval as sampleInterval } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { build } from "../../client/node_modules/vite/dist/node/index.js";
import react from "../../client/node_modules/@vitejs/plugin-react/dist/index.js";
import { searchSourceBaseline } from "./search-source-baseline.mjs";
import { controlledPanelCryptoImport } from "./panel-controlled-imports.mjs";

const root=fileURLToPath(new URL("../../client/",import.meta.url));
const repo=fileURLToPath(new URL("../../",import.meta.url));
const quick=process.argv.includes("--quick"),failureOnly=process.argv.includes("--failure-only");
const resetOnly=process.argv.includes("--reset-windows-only");
const pendingOnly=process.argv.includes("--pending-frontier-only");
const serveOnly=process.argv.includes("--serve-only");
if(serveOnly&&!process.argv.includes("--after-only"))throw Error("Serve-only requires --after-only");
const assertPendingBudget=process.argv.includes("--assert-pending-panel-budget");
if(assertPendingBudget&&!pendingOnly)throw Error("Pending panel budget requires --pending-frontier-only");
const assertActivePendingBudget=process.argv.includes("--assert-active-pending-panel-budget");
if(assertActivePendingBudget&&!pendingOnly)throw Error("Active pending budget requires --pending-frontier-only");
const pendingEvents=assertActivePendingBudget?[1000,5000,10000,50000]:[1000,5000,10000];
const activePendingFailures=[];
const variants=process.argv.includes("--after-only")?["after"]:["before","after"];
const repetitions=quick?1:9,assets=new Map();
if(pendingOnly&&(!process.argv.includes("--after-only")||failureOnly||resetOnly))throw Error("Pending frontier probe requires --after-only and no other probe mode");
const sourceBaselineArg=process.argv.find(arg=>arg.startsWith("--source-baseline="));
const sourceBaseline=sourceBaselineArg?.slice("--source-baseline=".length);
if(sourceBaselineArg!==undefined){
 assert.match(sourceBaseline??"",/^[0-9a-f]{40}$/, "Source baseline requires an immutable full commit SHA");
 assert.ok(!process.argv.includes("--after-only")&&!pendingOnly&&!failureOnly&&!resetOnly,"Source comparison requires both normal benchmark variants");
}
const baseline=sourceBaseline??"eb0a31cc40b244c3beb9b74a78e50d83dea83f19";
const overridePaths=["client/src/components/chat/SearchPanel.tsx","client/src/components/dm/DMSearchPanel.tsx","client/src/crypto/cachedSearchPage.ts",
 ...(sourceBaseline?["client/src/crypto/keyStorage.ts","client/src/crypto/cachedSearchSnapshot.ts"]:[])];
const gitExecutable=(process.platform==="win32"?["C:/Program Files/Git/cmd/git.exe"]:["/usr/bin/git","/usr/local/bin/git"]).find(existsSync);
assert.ok(gitExecutable,"Benchmark requires Git installed at a fixed supported path");
const historicalSource=sourceBaseline?searchSourceBaseline(gitExecutable,repo,baseline,overridePaths):null;
const sourceHead=execFileSync(gitExecutable,["rev-parse","HEAD"],{cwd:repo,encoding:"utf8"}).trim();
const usedHistoricalPaths=new Set();
const stores=`import {create} from "zustand";
 export const useServerStore=create(()=>({activeServerId:"server",activeServer:{id:"server",e2ee_enabled:true}}));
 export const useMessageStore=create(()=>({messagesByChannel:{},lastDeleted:null}));
 export const useDMStore=create(()=>({channels:[{id:"target",e2ee_enabled:true}],messagesByChannel:{},lastDeletedDM:null,setScrollToMessageId:()=>{},searchMessages:async()=>{throw Error("Unexpected REST search");}}));
 export const useE2EEStore=create(()=>({initStatus:"ready",localDeviceId:"benchmark-device"}));
 export const useSettingsStore=create(()=>({avatarAnimation:"never"}));`;
const hooks=`export const useSpamVisibility=()=>({pending:false,hidden:false});export const useIgnoredMessage=()=>({ignored:false});export const useReducedMotion=()=>false;export const useOpenAtMessage=()=>({openAtDMMessage:async()=>false});`;
const translations=`export const useTranslation=()=>({t:(key,options)=>key==="searchResultCount"?String(options?.count):key,i18n:{language:"en"}});`;
const entry=`import React from "react";import {createRoot}from "react-dom/client";import{flushSync}from "react-dom";
 import Channel from "/src/components/chat/SearchPanel.tsx";import DM from "/src/components/dm/DMSearchPanel.tsx";
 import{useMessageStore,useDMStore}from "virtual:panel-stores";
 import{publishAuthOwnerChange}from "/src/api/authSessionEvents.ts";
 import{openScopedKeyDatabase,getAccountDatabaseName,clearAllE2EEData}from "/src/crypto/keyStorage.ts";
 import{SERVER_URL}from "/src/utils/constants.ts";import{openDB}from "idb";
 const root=createRoot(document.getElementById("root"));publishAuthOwnerChange("panel-benchmark");
 async function drain(){const name=(await getAccountDatabaseName("panel-benchmark",SERVER_URL))+".search.v1";
 if(!(await indexedDB.databases()).some(db=>db.name===name))return;
 const db=await openDB(name,1);try{const end=Date.now()+30000;while(await db.count("refs")||await db.count("snapshots")){if(Date.now()>end)throw Error("Index disposal did not drain");await new Promise(resolve=>setTimeout(resolve,1));}}finally{db.close();}}
 globalThis.panelBench={react:React.version,
 async reset(){await clearAllE2EEData();},
 async unmount(){flushSync(()=>root.render(null));await drain();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));},
 async mount(kind,fail=false){globalThis.__panelFailNext=fail;flushSync(()=>root.render(React.createElement(kind==="dm"?DM:Channel,{channelId:"target",onClose:()=>{}})));},
 holdIndex(){globalThis.__panelIndexHandoffReady=false;globalThis.__panelIndexGate=new Promise(resolve=>{globalThis.__panelReleaseIndex=resolve;});},
 releaseIndex(){globalThis.__panelReleasedAt=performance.now();globalThis.__panelReleaseIndex?.();Reflect.deleteProperty(globalThis,"__panelIndexGate");Reflect.deleteProperty(globalThis,"__panelReleaseIndex");},
 async seed(kind,size){const db=await openScopedKeyDatabase("panel-benchmark",SERVER_URL),tx=db.transaction("messageCache","readwrite");await tx.store.clear();let matches=0;
 for(let i=0;i<size;i++){const target=i%5!==0,match=i%3===0;if(target&&match)matches++;const id=String(i).padStart(5,"0");void tx.store.put({messageId:id,channelId:kind==="channel"?(target?"target":"other"):"",dmChannelId:kind==="dm"?(target?"target":"other"):null,timestamp:kind==="dm"?size-i:i,sourceSequence:String(9007199254740992n+BigInt(i)),content:match?"Été "+id:"other"});}await tx.done;return matches;},
 async deletes(kind,start,end){const store=kind==="dm"?useDMStore:useMessageStore;for(let i=start;i<end;i++)store.setState(kind==="dm"?{lastDeletedDM:{id:"missing-"+i,dm_channel_id:"target"}}:{lastDeleted:{id:"missing-"+i,channel_id:"target"}});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));}
 };`;
for(const variant of variants){
 const overrides=new Map(),usedOverrides=new Set();
 if(variant==="before")for(const [path,content] of historicalSource?.overrides??overridePaths.map(path=>[path,execFileSync(gitExecutable,["show",baseline+":"+path],{cwd:repo,encoding:"utf8"})]))
  overrides.set(fileURLToPath(new URL("../../"+path,import.meta.url)).replaceAll("\\","/"),content);
 const plugin={name:"controlled-panel-providers",enforce:"pre",resolveId(source,importer){
  if(source==="virtual:panel-entry")return "\0panel-entry.js";
  if(source==="virtual:panel-stores"||/\/stores\/(serverStore|messageStore|dmStore|e2eeStore|settingsStore)$/.test(source))return "\0panel-stores.js";
  if(/\/hooks\/(useSpamVisibility|useIgnoredMessage|useReducedMotion|useOpenAtMessage)$/.test(source))return "\0panel-hooks.js";
  if(source==="react-i18next")return "\0panel-i18n.js";
  if(source.endsWith("/api/search"))return "\0panel-api.js";
  const cryptoImport=controlledPanelCryptoImport(source,importer,root);
  if(cryptoImport==="index")return "\0panel-index.js";
  if(cryptoImport==="cache")return "\0panel-cache.js";
 },load(id){
  const normalized=id.replaceAll("\\","/").split("?")[0];
  const repoRoot=repo.replaceAll("\\","/");
  const relative=normalized.startsWith(repoRoot)?normalized.slice(repoRoot.length):null;
  if(variant==="before"&&relative)historicalSource?.assertHistoricalPath(relative);
  const original=overrides.get(normalized);if(original!==undefined){usedOverrides.add(normalized);if(relative)usedHistoricalPaths.add(relative);return original;}
  if(id==="\0panel-entry.js")return entry;
  if(id==="\0panel-stores.js")return stores;
  if(id==="\0panel-hooks.js")return hooks;
  if(id==="\0panel-i18n.js")return translations;
  if(id==="\0panel-api.js")return 'export async function searchMessages(){throw Error("Unexpected REST search");}';
  if(id==="\0panel-index.js")return 'export*from "/src/crypto/cachedSearchSnapshot.ts";import{createCachedSearchSnapshot as real}from "/src/crypto/cachedSearchSnapshot.ts";export async function createCachedSearchSnapshot(...args){if(globalThis.__panelFailNext){globalThis.__panelFailNext=false;throw Error("Injected index failure");}const gate=globalThis.__panelIndexGate;if(!gate)return real(...args);const snapshot=await real(...args);globalThis.__panelIndexHandoffReady=true;await gate;return snapshot;}';
  if(id==="\0panel-cache.js")return 'export*from "/src/crypto/keyStorage.ts";import{searchCachedMessageRefs as channel,searchCachedDMMessageRefs as dm}from "/src/crypto/keyStorage.ts";function check(){if(globalThis.__panelFailNext){globalThis.__panelFailNext=false;throw Error("Injected scan failure");}}export async function searchCachedMessageRefs(...args){check();return channel(...args);}export async function searchCachedDMMessageRefs(...args){check();return dm(...args);}';
 }};
 const result=await build({root,configFile:false,logLevel:"error",base:"/"+variant+"/",plugins:[plugin,react()],define:{"process.env.NODE_ENV":JSON.stringify("production")},build:{write:false,minify:true,rollupOptions:{input:"virtual:panel-entry",output:{entryFileNames:"benchmark.js"}}}});
 if(variant==="before")for(const path of overridePaths)assert.ok(usedHistoricalPaths.has(path),`Required historical source override was not applied: ${path}`);
 for(const output of (Array.isArray(result)?result[0]:result).output)assets.set(variant+"/"+output.fileName,output.type==="chunk"?output.code:output.source);
}
const entryPages=new Map(variants.map(variant=>[variant+"/",'<div id="root"></div><script type="module" src="/'+variant+'/benchmark.js"></script>']));
const server=createServer((req,res)=>{const path=new URL(req.url,"http://localhost").pathname.slice(1),entryPage=entryPages.get(path);if(entryPage!==undefined){res.setHeader("Content-Type","text/html");res.end(entryPage);return;}
 const body=assets.get(path);if(body===undefined){res.statusCode=404;res.end();return;}res.setHeader("Content-Type",path.endsWith(".js")?"text/javascript":"application/octet-stream");res.end(body);});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
if(serveOnly){
 console.log(JSON.stringify({mode:"controlled-panel-server",pid:process.pid,url:`http://127.0.0.1:${server.address().port}/after/`,sourceHead}));
 await new Promise(resolve=>process.once("SIGINT",resolve));
 await new Promise(resolve=>server.close(resolve));
 process.exit(0);
}
const {chromium}=await import("playwright");
const browser=await chromium.launch();
function compareSourcePaths(left, right) {
 if (left < right) return -1;
 if (left > right) return 1;
 return 0;
}
const median=(rows,key)=>rows.map(row=>row[key]).sort((a,b)=>a-b)[Math.floor(rows.length/2)];
async function waitForPendingPanel(page, { variant, kind, errors }) {
 try {
  await page.waitForFunction(()=>document.querySelectorAll(".search-result-content").length===25,undefined,{timeout:120000});
 } catch (error) {
  const state = await page.evaluate(() => ({
   handoffReady: globalThis.__panelIndexHandoffReady,
   results: document.querySelectorAll(".search-result-content").length,
   count: document.querySelector(".search-count")?.textContent,
   panelText: document.querySelector(".search-panel")?.textContent?.slice(0,1000),
   releasedAt: globalThis.__panelReleasedAt,
  })).catch(failure => ({ diagnosticFailure: failure.message }));
  console.error(JSON.stringify({ mode:"pending-frontier-timeout", variant, kind, errors, state }));
  throw error;
 }
}
async function measureUI(page,event,expected,action){
 await page.evaluate(({event,expected})=>{
  Reflect.deleteProperty(globalThis,"__panelDuration");let start;
  document.addEventListener(event,()=>{start=performance.now();},{capture:true,once:true});
  const observer=new MutationObserver(()=>{
   if(start!==undefined&&JSON.stringify([...document.querySelectorAll(".search-result-content")].map(el=>el.textContent))===JSON.stringify(expected)){
    globalThis.__panelDuration=performance.now()-start;observer.disconnect();
   }
  });observer.observe(document.querySelector(".search-panel"),{subtree:true,childList:true,characterData:true});
 },{event,expected});
 await action();await page.waitForFunction(()=>typeof globalThis.__panelDuration==="number");
 return page.evaluate(()=>globalThis.__panelDuration);
}
try{
 console.log("Runtime",process.version,process.platform,"Chromium",browser.version(),"baseline",baseline);
 for(const variant of variants){const context=await browser.newContext(),page=await context.newPage(),cdp=await context.newCDPSession(page);const errors=[];page.on("pageerror",error=>errors.push(error.message));
 try{await page.goto(`http://127.0.0.1:${server.address().port}/${variant}/`);await page.waitForFunction(()=>Boolean(globalThis.panelBench));console.log(JSON.stringify({variant,react:await page.evaluate(()=>globalThis.panelBench.react),productionBuild:true,sourceHead,historicalOverrides:variant==="before"?usedHistoricalPaths.size:0,historicalSources:variant==="before"?[...usedHistoricalPaths].sort(compareSourcePaths):[]}));
 for(const kind of ["channel","dm"]){
 if(pendingOnly){
  const matches=await page.evaluate(async kind=>{const matches=await globalThis.panelBench.seed(kind,1000);globalThis.panelBench.holdIndex();await globalThis.panelBench.mount(kind);return matches;},kind);
  const growth=[];
  try{
   await page.getByRole("textbox").fill("ÉTÉ");
   await page.waitForFunction(()=>globalThis.__panelIndexHandoffReady===true);
   await page.evaluate(kind=>globalThis.panelBench.deletes(kind,0,10),kind);
   await cdp.send("HeapProfiler.collectGarbage");const base=await cdp.send("Runtime.getHeapUsage");
   let start=10;
   for(const end of pendingEvents){
    await page.evaluate(({kind,start,end})=>globalThis.panelBench.deletes(kind,start,end),{kind,start,end});
    await cdp.send("HeapProfiler.collectGarbage");const heap=await cdp.send("Runtime.getHeapUsage");
    growth.push({events:end,retainedGrowthBytes:heap.usedSize-base.usedSize});start=end;
   }
  }finally{await page.evaluate(()=>globalThis.panelBench.releaseIndex());}
  await waitForPendingPanel(page, { variant, kind, errors });
  const releaseToObservedResultsMs=await page.evaluate(()=>performance.now()-globalThis.__panelReleasedAt);
  await cdp.send("HeapProfiler.collectGarbage");const settledHeap=await cdp.send("Runtime.getHeapUsage");
  assert.equal(await page.locator(".search-count").textContent(),String(matches));
  const expected=[];for(let i=999;i>=0;i--)if(i%5!==0&&i%3===0)expected.push("Été "+String(i).padStart(5,"0"));
  assert.deepEqual(await page.locator(".search-result-content").allTextContents(),expected.slice(0,25));
  await page.evaluate(()=>globalThis.panelBench.unmount());
  await cdp.send("HeapProfiler.collectGarbage");const disposedHeap=await cdp.send("Runtime.getHeapUsage");
  console.log(JSON.stringify({variant,kind,pendingSearchFrontier:growth,releaseToObservedResultsMs,settledHeapBytes:settledHeap.usedSize,disposedHeapBytes:disposedHeap.usedSize,matches,correctPage:true,indexDisposalDrained:true,scope:`Single diagnostic run of actual production React panel/native IndexedDB;ready snapshot handoff deliberately gated before adoption;${pendingEvents.at(-1)}distinct missing-ID store events;post-GC JS heap deltas while gated;release-to-observed DOM includes Playwright polling,excludes later assertions/disposal;controlled providers,not full WS/cache writer pipeline or a physical memory bound.`}));
  if(assertActivePendingBudget&&growth.at(-1).retainedGrowthBytes>=512*1024)activePendingFailures.push({kind,retainedGrowthBytes:growth.at(-1).retainedGrowthBytes});
  if(assertPendingBudget)assert.ok(settledHeap.usedSize-disposedHeap.usedSize<512*1024,"Settled search panel retains more than512KiB above its disposed baseline after10000missing deletions");
  continue;
 }
 if(resetOnly){
  assert.equal(variant,"after","Cross-window reset probe requires --after-only");
  await page.evaluate(({kind})=>globalThis.panelBench.seed(kind,1000),{kind});
  await page.evaluate(kind=>globalThis.panelBench.mount(kind),kind);
  await page.getByRole("textbox").fill("ÉTÉ");
  await page.waitForFunction(()=>document.querySelectorAll(".search-result-item").length===25);
  const sender=await context.newPage();
  sender.on("pageerror",error=>errors.push(error.message));
  try{
   await sender.goto(`http://127.0.0.1:${server.address().port}/${variant}/`);
   await sender.waitForFunction(()=>Boolean(globalThis.panelBench));
   await sender.evaluate(()=>globalThis.panelBench.reset());
   await page.waitForFunction(()=>document.querySelector("input")?.value===""&&document.querySelectorAll(".search-result-item").length===0);
   assert.equal(await page.locator(".search-result-content").count(),0);
   await page.evaluate(()=>globalThis.panelBench.unmount());
   console.log(JSON.stringify({variant,kind,crossWindowReset:true,visibleResults:0,inputCleared:true,indexDisposalDrained:true,scope:"Actual production React panel with real source/derived IndexedDB and BroadcastChannel; controlled stores/i18n/navigation,not packaged-platform acceptance."}));
  }finally{await sender.close();}
  continue;
 }
 if(!failureOnly)for(const size of quick?[1000]:[1000,10000,50000]){
  const matches=await page.evaluate(({kind,size})=>globalThis.panelBench.seed(kind,size),{kind,size});
  const expected=[];for(let i=size-1;i>=0;i--)if(i%5!==0&&i%3===0)expected.push("Été "+String(i).padStart(5,"0"));
  const samples=[];
  for(let repetition=0;repetition<=repetitions;repetition++){
   await page.evaluate(()=>globalThis.panelBench.unmount());await cdp.send("HeapProfiler.collectGarbage");const baselineHeap=await cdp.send("Runtime.getHeapUsage");
   let peak=baselineHeap.usedSize,samplingError;
   const sampling=new AbortController();
   const sampler=(async()=>{for await(const tick of sampleInterval(25,undefined,{signal:sampling.signal})){void tick;const heap=await cdp.send("Runtime.getHeapUsage");peak=Math.max(peak,heap.usedSize);}})().catch(error=>{if(error.name!=="AbortError")samplingError=error;});
   let firstMs,nextMs,previousMs;
   try{await page.evaluate(kind=>globalThis.panelBench.mount(kind),kind);
    firstMs=await measureUI(page,"input",expected.slice(0,25),()=>page.getByRole("textbox").fill("ÉTÉ"));
    assert.equal(await page.locator(".search-count").textContent(),String(matches));
    nextMs=await measureUI(page,"click",expected.slice(25,50),()=>page.getByRole("button",{name:"searchNext",exact:true}).click());
    previousMs=await measureUI(page,"click",expected.slice(0,25),()=>page.getByRole("button",{name:"searchPrev",exact:true}).click());
    assert.equal(await page.locator(".search-result-item").count(),25);
   }finally{sampling.abort();await sampler;}
   if(samplingError)throw samplingError;
   await cdp.send("HeapProfiler.collectGarbage");const retained=await cdp.send("Runtime.getHeapUsage");
   if(repetition)samples.push({firstMs,nextMs,previousMs,retainedBytes:retained.usedSize-baselineHeap.usedSize,sampledPeakBytes:peak-baselineHeap.usedSize});
  }
  await page.evaluate(()=>globalThis.panelBench.unmount());
  console.log(JSON.stringify({variant,kind,size,matches,repetitions,firstMedianMs:median(samples,"firstMs"),nextMedianMs:median(samples,"nextMs"),previousMedianMs:median(samples,"previousMs"),retainedMedianBytes:median(samples,"retainedBytes"),sampledPeakMedianBytes:median(samples,"sampledPeakBytes"),sampledPeakMaximumBytes:Math.max(...samples.map(row=>row.sampledPeakBytes)),samples,scope:"Actual production React panels + real IndexedDB, controlled stores/i18n/spam/navigation.25ms sampled peak is not an exact upper bound; excludes whole-app state/native disk. Durations use input/click capture to committed matching DOM,exclude Playwright actionability; first includes300ms debounce."}));
 }
 // No active scan/index remains after a failed search. Missing live deletions
 // must not leave a query-sized frontier or queued React updates behind.
 await page.evaluate(()=>globalThis.panelBench.unmount());await page.evaluate(kind=>globalThis.panelBench.mount(kind,true),kind);
 await page.getByRole("textbox").fill("failed search");
 const expectsSearchFailure=variant==="after"||sourceBaseline!==undefined;
 await page.waitForFunction(expected=>document.querySelector(".search-empty")?.textContent===expected,expectsSearchFailure?"searchFailed":"noSearchResults");
 if(expectsSearchFailure)assert.equal(await page.getByRole("alert").textContent(),"searchFailed");
 await page.evaluate(kind=>globalThis.panelBench.deletes(kind,0,10),kind);await cdp.send("HeapProfiler.collectGarbage");const idle=await cdp.send("Runtime.getHeapUsage"),growth=[];
 let start=10;for(const end of [1000,5000,10000]){await page.evaluate(({kind,start,end})=>globalThis.panelBench.deletes(kind,start,end),{kind,start,end});await cdp.send("HeapProfiler.collectGarbage");const heap=await cdp.send("Runtime.getHeapUsage");growth.push({events:end,retainedGrowthBytes:heap.usedSize-idle.usedSize});start=end;}
 console.log(JSON.stringify({variant,kind,failedSearchFrontier:growth}));if(process.argv.includes("--assert-idle-budget")&&variant==="after")assert.ok(growth.at(-1).retainedGrowthBytes<256*1024,"Failed idle search retained more than256KiB after10000 missing deletions");await page.evaluate(()=>globalThis.panelBench.unmount());
 }
 assert.deepEqual(errors,[]);
 }finally{await context.close();}}
 assert.deepEqual(activePendingFailures,[],"Active pending panel retains more than512KiB after50000 distinct deletions");
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
