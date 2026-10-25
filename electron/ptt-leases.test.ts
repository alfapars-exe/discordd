import test from "node:test";
import assert from "node:assert/strict";
import {PTTLeases,validPTTRequest,type PTTSignal}from "./ptt-leases.js";
function fixture(){let id=0;const sent:Array<[number,PTTSignal]>=[],bound:Array<string|null>=[];const leases=new PTTLeases(key=>{if(key==="bad")return false;bound.push(key);return true;},(sender,signal)=>sent.push([sender,signal]),()=>String(++id));return{leases,sent,bound};}
test("exact sender and lease release; synthetic up precedes ownership transfer",()=>{
 const{leases,sent,bound}=fixture();const old=leases.acquire(1,{kind:"group",source:"old",keyCode:"Space"})!;leases.signal(true);
 const next=leases.acquire(1,{kind:"p2p",source:"new",keyCode:"Space"})!;
 assert.deepEqual(sent[sent.length-1],[1,{leaseId:old,pressed:false}]);leases.release(1,old);leases.release(2,next);leases.signal(true);
 assert.deepEqual(sent[sent.length-1],[1,{leaseId:next,pressed:true}]);assert.equal(bound.length,2);
 leases.release(1,next);assert.equal(bound[bound.length-1],null);assert.equal(leases.active,false);
});
test("lower priority, invalid key and stale sender cleanup cannot replace active guild",()=>{
 const{leases,bound}=fixture();const id=leases.acquire(1,{kind:"guild",source:"voice",keyCode:"Space"})!;
 assert.equal(leases.acquire(1,{kind:"group",source:"group",keyCode:"Space"}),null);
 assert.equal(leases.acquire(1,{kind:"guild",source:"other",keyCode:"bad"}),null);
 leases.retireSender(2);assert.equal(bound.length,1);leases.signal(true);leases.retireSender(1);assert.equal(leases.active,false);leases.release(1,id);
});
test("bounded request contract rejects malformed source/kind/key",()=>{
 assert.equal(validPTTRequest({kind:"group",source:"nonce",keyCode:"Space"}),true);
 for(const value of [null,{}, {kind:"admin",source:"x",keyCode:"Space"},{kind:"guild",source:"x".repeat(161),keyCode:"Space"},{kind:"group",source:"x",keyCode:"Ctrl+X"}])assert.equal(validPTTRequest(value),false);
});
