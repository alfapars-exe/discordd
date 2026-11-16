import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { reconcileFanoutHistory } from "./fanout-history.mjs";
const hash = value => createHash("sha256").update(value).digest("hex");
const profile = {probeId:"probe",channelId:"channel",userIds:["alice","bob"],messagesPerSender:2};
function fixture({ timestamps, ids } = {}) {
 const canonical = profile.userIds.flatMap(user=>[1,2].map(sequence=>[user,sequence,`${user}-${sequence}`]));
 if (ids) canonical.forEach((row,index)=>{row[2]=ids[index];});
 const messages = canonical.map(([user,sequence,id],index)=>({id,user_id:user,channel_id:"channel",source_sequence:0,created_at:timestamps?.[index]??`2026-11-16T08:00:0${index}Z`,
  content:JSON.stringify({probe:"probe",sender:user,sequence})}));
 const pages=[{messages:messages.slice(2),has_more:true,has_more_after:false},{messages:messages.slice(0,2),has_more:false,has_more_after:false}];
 const receipts=profile.userIds.map(receiver=>({receiver,digest:hash(JSON.stringify(canonical)),summary:{complete:true},acknowledged:canonical.filter(row=>row[0]===receiver).map(row=>row.slice(1))}));
 return {pages,receipts};
}
test("walks older REST pages in ascending created-at/ID order and reconciles all receivers", async()=>{
 const {pages,receipts}=fixture(),calls=[];
 const result=await reconcileFanoutHistory(profile,async cursor=>{calls.push(cursor);return pages.shift();},receipts,hash,2);
 assert.equal(result.persisted,4);assert.equal(result.historyPages,2);
 assert.deepEqual(calls,[{before:"",limit:2},{before:"bob-1",limit:2}]);
});
for(const [name,mutate,error] of [
 ["missing history",f=>f.pages.pop(),/invalid_history_page/],
 ["repeated page",f=>{f.pages[1]=f.pages[0];},/history_page_not_older/],
 ["duplicate message ID",f=>{f.pages[1].messages[0].id=f.pages[0].messages[0].id;},/invalid_history_message/],
 ["reversed REST page order",f=>{f.pages[0].messages.reverse();},/history_order_not_ascending/],
 ["empty continuing page",f=>{f.pages[0].messages=[];},/unexpected_history_continuation/],
 ["extra continuation",f=>{f.pages[1].has_more=true;},/unexpected_history_continuation/],
 ["wrong probe",f=>{f.pages[0].messages[0].content='{}';},/invalid_history_message/],
 ["missing receiver",f=>{f.receipts.pop();},/invalid_receiver_set/],
 ["duplicate receiver",f=>{f.receipts[1]=f.receipts[0];},/invalid_receiver_set/],
 ["wrong receiver digest",f=>{f.receipts[0].digest="incorrect";},/receiver_history_mismatch/],
 ["wrong HTTP acknowledgement ID",f=>{f.receipts[0].acknowledged[0][1]="wrong";},/acknowledgement_history_mismatch/],
 ["duplicate HTTP acknowledgement slot",f=>{f.receipts[0].acknowledged[1]=f.receipts[0].acknowledged[0];},/acknowledgement_history_mismatch/],
]) test(`rejects ${name}`,async()=>{
 const f=fixture();mutate(f);
 await assert.rejects(reconcileFanoutHistory(profile,async()=>f.pages.shift(),f.receipts,hash,2),error);
});

for (const [name, options] of [
 ["equal timestamps ordered by ID", {timestamps:Array(4).fill("2026-11-16T08:00:00Z")}],
 ["nanosecond precision and equivalent timezone offsets", {
  timestamps:["2026-11-16T10:00:00.000000001+02:00","2026-11-16T10:00:00.000000001+02:00",
   "2026-11-16T08:00:00.000000002Z","2026-11-16T08:00:00.000000002Z"],
  ids:["z-alice-1","z-alice-2","a-bob-1","a-bob-2"],
 }],
]) test(`preserves ${name} across page boundaries`, async()=>{
 const f=fixture(options),calls=[];
 const expectedCursor=f.pages[0].messages[0].id;
 const result=await reconcileFanoutHistory(profile,async cursor=>{calls.push(cursor);return f.pages.shift();},f.receipts,hash,2);
 assert.equal(result.persisted,4);
 assert.equal(calls[1].before,expectedCursor);
});

for (const timestamp of [undefined,"invalid","2026-02-30T08:00:00Z","2026-11-16T24:00:00Z",
 "2026-11-16T08:00:00","2026-11-16T08:00:00.1234567890Z"]) {
 test(`rejects malformed history timestamp ${timestamp}`,async()=>{
  const f=fixture();f.pages[0].messages[0].created_at=timestamp;
  await assert.rejects(reconcileFanoutHistory(profile,async()=>f.pages.shift(),f.receipts,hash,2),/invalid_history_order_key/);
 });
}

test("rejects a page crossing its oldest-message cursor",async()=>{
 const f=fixture();f.pages[1].messages[1].created_at="2026-11-16T09:00:00Z";
 await assert.rejects(reconcileFanoutHistory(profile,async()=>f.pages.shift(),f.receipts,hash,2),/history_page_not_older/);
});
