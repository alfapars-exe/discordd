import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { reconcileFanoutHistory } from "./fanout-history.mjs";
const hash = value => createHash("sha256").update(value).digest("hex");
const profile = {probeId:"probe",channelId:"channel",userIds:["alice","bob"],messagesPerSender:2};
function fixture() {
 const canonical = profile.userIds.flatMap(user=>[1,2].map(sequence=>[user,sequence,`${user}-${sequence}`]));
 const messages = canonical.map(([user,sequence,id],index)=>({id,user_id:user,channel_id:"channel",source_sequence:0,created_at:`2026-11-16T08:00:0${index}Z`,
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
for(const [name,mutate] of [
 ["missing history",f=>f.pages.pop()],
 ["repeated page",f=>{f.pages[1]=f.pages[0];}],
 ["duplicate message ID",f=>{f.pages[1].messages[0].id=f.pages[0].messages[0].id;}],
 ["reversed REST page order",f=>{f.pages[0].messages.reverse();}],
 ["empty continuing page",f=>{f.pages[0].messages=[];}],
 ["extra continuation",f=>{f.pages[1].has_more=true;}],
 ["wrong probe",f=>{f.pages[0].messages[0].content='{}';}],
 ["missing receiver",f=>{f.receipts.pop();}],
 ["duplicate receiver",f=>{f.receipts[1]=f.receipts[0];}],
 ["wrong receiver digest",f=>{f.receipts[0].digest="incorrect";}],
 ["wrong HTTP acknowledgement ID",f=>{f.receipts[0].acknowledged[0][1]="wrong";}],
 ["duplicate HTTP acknowledgement slot",f=>{f.receipts[0].acknowledged[1]=f.receipts[0].acknowledged[0];}],
]) test(`rejects ${name}`,async()=>{
 const f=fixture();mutate(f);
 await assert.rejects(reconcileFanoutHistory(profile,async()=>f.pages.shift(),f.receipts,hash,2));
});
