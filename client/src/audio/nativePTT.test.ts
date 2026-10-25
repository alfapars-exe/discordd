import {afterEach,beforeEach,expect,it,vi}from "vitest";
import {bindNativePTT}from "./nativePTT";
import {publishAuthGenerationChange,publishAuthOwnerChange}from "../api/authSessionEvents";
import {beginShortcutCapture}from "../stores/shortcutCaptureStore";
vi.mock("../utils/constants",()=>({isElectron:()=>true}));
let listeners:Set<(signal:{leaseId:string;pressed:boolean})=>void>,acquire:ReturnType<typeof vi.fn>,release:ReturnType<typeof vi.fn>;
const emit=(id:string,pressed:boolean)=>{for(const listener of [...listeners])listener({leaseId:id,pressed});};
beforeEach(()=>{publishAuthOwnerChange("owner");publishAuthGenerationChange(1);listeners=new Set();acquire=vi.fn(async()=>"lease");release=vi.fn(async()=>{});window.electronAPI={acquirePTTLease:acquire,releasePTTLease:release,onPTTLeaseSignal:(cb:(signal:{leaseId:string;pressed:boolean})=>void)=>{listeners.add(cb);return()=>{listeners.delete(cb);};}} as unknown as Window["electronAPI"];});
afterEach(()=>{window.electronAPI=undefined;});
it("removes only its own listener and releases exact lease; retained callbacks cannot reopen",async()=>{
 const first=vi.fn(),second=vi.fn();const stop=bindNativePTT({kind:"group",source:"first",keyCode:"Space",current:()=>true,onPressed:first});acquire.mockResolvedValueOnce("next");const stopNext=bindNativePTT({kind:"p2p",source:"second",keyCode:"Space",current:()=>true,onPressed:second});await Promise.resolve();emit("lease",true);expect(first).toHaveBeenLastCalledWith(true);expect(second).not.toHaveBeenCalled();stop();expect(first).toHaveBeenLastCalledWith(false);expect(release).toHaveBeenCalledWith("lease");expect(listeners.size).toBe(1);emit("lease",true);emit("next",true);expect(second).toHaveBeenLastCalledWith(true);stopNext();expect(release).toHaveBeenLastCalledWith("next");
});
it("late acquisition is immediately returned after source disposal",async()=>{
 let resolve!:(id:string)=>void;acquire.mockImplementation(()=>new Promise<string>(r=>{resolve=r;}));const pressed=vi.fn();const stop=bindNativePTT({kind:"guild",source:"source",keyCode:"Space",current:()=>true,onPressed:pressed});stop();resolve("late");await Promise.resolve();expect(release).toHaveBeenCalledWith("late");expect(pressed).not.toHaveBeenCalled();expect(listeners.size).toBe(0);
});
it("auth retirement silences held PTT and shortcut capture releases exact ownership",async()=>{
 const pressed=vi.fn();bindNativePTT({kind:"group",source:"source",keyCode:"Space",current:()=>true,onPressed:pressed});await Promise.resolve();emit("lease",true);publishAuthGenerationChange(2);expect(pressed).toHaveBeenLastCalledWith(false);expect(listeners.size).toBe(0);
 bindNativePTT({kind:"guild",source:"other",keyCode:"Space",current:()=>true,onPressed:pressed});await Promise.resolve();emit("lease",true);const stopCapture=beginShortcutCapture();expect(pressed).toHaveBeenLastCalledWith(false);expect(listeners.size).toBe(0);stopCapture();
});
it("scope-denied signals fail closed and denied registration reports unavailable",async()=>{
 let current=true;const pressed=vi.fn();bindNativePTT({kind:"p2p",source:"source",keyCode:"Space",current:()=>current,onPressed:pressed});await Promise.resolve();current=false;emit("lease",true);expect(pressed).not.toHaveBeenCalled();acquire.mockResolvedValueOnce(null);const unavailable=vi.fn();bindNativePTT({kind:"group",source:"next",keyCode:"Space",current:()=>true,onPressed:pressed,onUnavailable:unavailable});await Promise.resolve();expect(unavailable).toHaveBeenCalledOnce();
});

it("focused typing and composition silence a held native key without disabling background PTT",async()=>{
 const pressed=vi.fn();vi.spyOn(document,"hasFocus").mockReturnValue(true);const stop=bindNativePTT({kind:"group",source:"source",keyCode:"Space",current:()=>true,onPressed:pressed});await Promise.resolve();emit("lease",true);expect(pressed).toHaveBeenLastCalledWith(true);
 const input=document.createElement("textarea");document.body.append(input);input.focus();expect(pressed).toHaveBeenLastCalledWith(false);emit("lease",false);emit("lease",true);expect(pressed).toHaveBeenLastCalledWith(false);input.remove();document.dispatchEvent(new Event("compositionstart"));emit("lease",false);emit("lease",true);expect(pressed).toHaveBeenLastCalledWith(false);document.dispatchEvent(new Event("compositionend"));vi.spyOn(document,"hasFocus").mockReturnValue(false);emit("lease",false);emit("lease",true);expect(pressed).toHaveBeenLastCalledWith(true);stop();vi.restoreAllMocks();
});
