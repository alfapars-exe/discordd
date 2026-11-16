import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFanoutProfile, createFanoutSession } from "./fanout-profile.mjs";

const env = () => ({FANOUT_SERVER_ID:"server",FANOUT_CHANNEL_ID:"channel",FANOUT_PROBE_ID:"probe",FANOUT_USER_IDS:'["alice","bob"]',FANOUT_MESSAGES_PER_SENDER:"2"});
const connection = () => ({baseURL:"http://127.0.0.1:9090",vus:2,userCount:2,holdSeconds:75,rampUp:"10s"});
test("connection-only profiles do not enable message traffic", () => { assert.equal(readFanoutProfile({},connection()),null); });
for (const [name, patch, config] of [
 ["partial profile",{FANOUT_CHANNEL_ID:undefined},{}], ["missing sender list",{FANOUT_USER_IDS:""},{}],
 ["shared accounts",{}, {userCount:1}], ["remote target",{}, {baseURL:"https://example.test"}],
 ["before last connection",{FANOUT_START_DELAY_SECONDS:"1"},{}], ["no drain time",{FANOUT_START_DELAY_SECONDS:"74"},{}],
 ["excessive sender rate",{FANOUT_MESSAGE_INTERVAL_MS:"100"},{}],
]) test(`rejects ${name} before network activity`, () => { assert.throws(()=>readFanoutProfile({...env(),...patch},{...connection(),...config})); });
function scenario({missingPeer=false,wrongResponseActor=false}={}) {
 const profile=readFanoutProfile(env(),connection()),checks=[],logs=[],timers=[],requests=[];
 const metrics=Object.fromEntries(["sent","received","receivers","duplicates","invalid"].map(name=>[name,{value:0,add(n){this.value+=n;}}]));
 const check=(value,predicates)=>{const result=Object.entries(predicates).map(([name,predicate])=>({name,passed:!!predicate(value)}));checks.push(...result);return result.every(x=>x.passed);};
 let session;
 const http={post(url,body,options){requests.push({url,body:JSON.parse(body),options});const payload=JSON.parse(JSON.parse(body).content);const message={id:`alice-${payload.sequence}`,user_id:wrongResponseActor?"bob":"alice",channel_id:"channel",content:JSON.stringify(payload)};session.observe({op:"message_create",data:message});return{status:201,json:()=>({success:true,data:message})};}};
 session=createFanoutSession(profile,{vu:1,baseURL:connection().baseURL,accessToken:"fixture-only",http,check,metrics,hash:text=>createHash("sha256").update(text).digest("hex"),log:value=>logs.push(value)});
 session.start({setTimeout:(callback,delay)=>timers.push({callback,delay})});
 for(const timer of timers.sort((a,b)=>a.delay-b.delay))timer.callback();
 const count=missingPeer?1:2;
 for(let sequence=1;sequence<=count;sequence++)session.observe({op:"message_create",data:{id:`bob-${sequence}`,channel_id:"channel",user_id:"bob",content:JSON.stringify({probe:"probe",sender:"bob",sequence})}});
 const result=session.finish();return{checks,logs,metrics,timers,requests,result};
}
test("publishes paced messages and reconciles HTTP IDs with echoed WebSocket IDs",()=>{
 const h=scenario();assert.deepEqual(h.timers.map(x=>x.delay),[20000,22000]);assert.equal(h.requests.length,2);
 assert.equal(h.metrics.sent.value,2);assert.equal(h.metrics.received.value,4);assert.equal(h.metrics.receivers.value,1);
 assert.ok(h.checks.every(x=>x.passed));assert.equal(h.result.agrees,true);
 const receipt=JSON.parse(h.logs[0].slice("FANOUT_RECEIPT ".length));assert.match(receipt.digest,/^[a-f0-9]{64}$/);assert.equal(receipt.summary.complete,true);
});
test("missing peer delivery fails the measured receiver even when all sends succeed",()=>{
 const h=scenario({missingPeer:true});assert.equal(h.metrics.sent.value,2);assert.equal(h.metrics.receivers.value,0);
 assert.equal(h.result.summary.missing,1);assert.ok(h.checks.some(x=>!x.passed));
});
test("wrong authoritative actor in HTTP response fails instead of counting acceptance",()=>{
 const h=scenario({wrongResponseActor:true});assert.equal(h.metrics.sent.value,0);assert.equal(h.metrics.receivers.value,0);assert.ok(h.checks.some(x=>!x.passed));
});
