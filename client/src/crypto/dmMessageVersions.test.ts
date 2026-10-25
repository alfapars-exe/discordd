import {beforeEach,expect,it} from "vitest";
import {captureDMHistoryVersion,captureDMReceipt,observeDMMessage} from "./dmMessageVersions";
import {useComposerDraftStore} from "../stores/composerDraftStore";
import type {DMMessage} from "../types/dm";
const message={id:"message",dm_channel_id:"channel"} as DMMessage;
beforeEach(()=>useComposerDraftStore.getState().reset());
it("invalidates earlier event work without crossing conversation identities",()=>{
  const first=observeDMMessage("channel","message");
  observeDMMessage("other","message");expect(first()).toBe(true);
  const next=observeDMMessage("channel","message");expect(first()).toBe(false);expect(next()).toBe(true);
});
it("rejects mutations after the history request and keeps deletion tombstones",()=>{
  const history=captureDMHistoryVersion("channel");expect(history.current(message)).toBe(true);
  observeDMMessage("channel","message");expect(history.current(message)).toBe(false);
  expect(captureDMHistoryVersion("channel").current(message)).toBe(true);
  observeDMMessage("channel","message",true);
  const afterDelete=captureDMHistoryVersion("channel");expect(afterDelete.current(message)).toBe(false);expect(afterDelete.deleted(message)).toBe(true);
  expect(observeDMMessage("channel","message")()).toBe(false);
  expect(afterDelete.deleted(message)).toBe(true);
});
it("invalidates work across composer/account generation reset",()=>{
  const event=observeDMMessage("channel","message"),history=captureDMHistoryVersion("channel");
  useComposerDraftStore.getState().reset();expect(event()).toBe(false);expect(history.current(message)).toBe(false);
  expect(captureDMHistoryVersion("channel").current(message)).toBe(true);
});
it("shares a matching WS echo token without invalidating its pending publication",()=>{
  const claim=captureDMReceipt("channel");
  const echo=observeDMMessage("channel","message",false,message);
  const receipt=claim(message);expect(receipt?.()).toBe(true);expect(echo()).toBe(true);
  observeDMMessage("channel","message",true);expect(receipt?.()).toBe(false);
});
it("rejects an HTTP receipt after a different live source or deletion was observed",()=>{
  const claim=captureDMReceipt("channel");
  observeDMMessage("channel","message",false,{...message,ciphertext:"new"});
  expect(claim({...message,ciphertext:"old"})).toBeNull();
  const afterEdit=captureDMReceipt("channel");observeDMMessage("channel","message",true);
  expect(afterEdit(message)).toBeNull();
});
it("invalidates an earlier receipt cache writer when a later HTTP result claims the message",()=>{
  const oldClaim=captureDMReceipt("channel");
  const old=oldClaim({...message,ciphertext:"old"});expect(old?.()).toBe(true);
  const newClaim=captureDMReceipt("channel");
  const next=newClaim({...message,ciphertext:"new"});expect(next?.()).toBe(true);expect(old?.()).toBe(false);
  expect(oldClaim({...message,ciphertext:"old"})).toBeNull();
});
it("rejects receipts after a generation reset or for a different conversation",()=>{
  const claim=captureDMReceipt("channel");expect(claim({...message,dm_channel_id:"other"})).toBeNull();
  useComposerDraftStore.getState().reset();expect(claim(message)).toBeNull();
});
