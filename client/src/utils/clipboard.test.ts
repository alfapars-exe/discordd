import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { copyToClipboard } from "./constants";
const electronDescriptor = Object.getOwnPropertyDescriptor(window,"electronAPI");
const commandDescriptor = Object.getOwnPropertyDescriptor(document,"execCommand");
beforeEach(()=>{
  Object.defineProperty(window,"electronAPI",{configurable:true,value:undefined});
  vi.stubGlobal("navigator",{clipboard:undefined});
  document.body.innerHTML="";
});
afterEach(()=>{
  vi.unstubAllGlobals();
  if(electronDescriptor)Object.defineProperty(window,"electronAPI",electronDescriptor);else Reflect.deleteProperty(window,"electronAPI");
  if(commandDescriptor)Object.defineProperty(document,"execCommand",commandDescriptor);else Reflect.deleteProperty(document,"execCommand");
});
it("uses the browser clipboard without selecting a fallback textarea",async()=>{
  const writeText=vi.fn(async()=>{});
  vi.stubGlobal("navigator",{clipboard:{writeText}});
  await copyToClipboard("plaintext");
  expect(writeText).toHaveBeenCalledWith("plaintext");
  expect(document.querySelector("textarea")).toBeNull();
});
it("uses the native clipboard and propagates native failure",async()=>{
  const writeClipboard=vi.fn(async()=>{});
  Object.defineProperty(window,"electronAPI",{configurable:true,value:{writeClipboard}});
  await copyToClipboard("native");
  expect(writeClipboard).toHaveBeenCalledWith("native");
  writeClipboard.mockRejectedValueOnce(new Error("native denied"));
  await expect(copyToClipboard("native")).rejects.toThrow("native denied");
});
it("checks legacy copy success and restores the original composer selection",async()=>{
  vi.stubGlobal("navigator",{clipboard:{writeText:vi.fn(async()=>{throw new Error("denied")})}});
  Object.defineProperty(document,"execCommand",{configurable:true,value:vi.fn(()=>true)});
  const composer=document.createElement("textarea");document.body.append(composer);
  composer.value="draft content";composer.focus();composer.setSelectionRange(2,7);
  await copyToClipboard("message");
  expect(document.execCommand).toHaveBeenCalledWith("copy");
  expect(document.activeElement).toBe(composer);
  expect(composer.selectionStart).toBe(2);expect(composer.selectionEnd).toBe(7);
  expect(document.querySelectorAll("textarea")).toHaveLength(1);
});
it.each([false,"throw"])("rejects legacy failure %s and removes its plaintext textarea",async(result)=>{
  Object.defineProperty(document,"execCommand",{configurable:true,value:vi.fn(()=>{if(result==="throw")throw new Error("unavailable");return false;})});
  const button=document.createElement("button");document.body.append(button);button.focus();
  await expect(copyToClipboard("private body")).rejects.toThrow();
  expect(document.querySelector("textarea")).toBeNull();
  expect(document.activeElement).toBe(button);
});
it("rejects unsupported legacy copy without reporting success",async()=>{
  Object.defineProperty(document,"execCommand",{configurable:true,value:undefined});
  await expect(copyToClipboard("body")).rejects.toThrow("Clipboard copy unavailable");
  expect(document.querySelector("textarea")).toBeNull();
});
