import {beforeEach,expect,it,vi} from "vitest";
import {findReminderAttempt,forgetReminderAttempt,reminderAttempt} from "./reminderAttempts";
beforeEach(()=>localStorage.removeItem("hichat.reminder-attempts.v1"));
it("retains exact retries across module reload without storing source data",async()=>{
  const first=await reminderAttempt("server-owner","private-channel-message-due");
  vi.resetModules();const reopened=await import("./reminderAttempts");
  expect(await reopened.reminderAttempt("server-owner","private-channel-message-due")).toBe(first);
  const raw=localStorage.getItem("hichat.reminder-attempts.v1")!;
  expect(raw).not.toContain("private-channel");expect(raw).not.toContain("server-owner");
  expect(await reminderAttempt("another-owner","private-channel-message-due")).not.toBe(first);
  expect(await reminderAttempt("server-owner","different-due")).not.toBe(first);
});
it("forgets only the confirmed attempt and rotates its next identity",async()=>{
  const id=await reminderAttempt("owner","payload");
  await forgetReminderAttempt("owner","payload","different-id");
  expect(await reminderAttempt("owner","payload")).toBe(id);
  await forgetReminderAttempt("owner","payload",id);
  expect(await reminderAttempt("owner","payload")).not.toBe(id);
});
it("does not overwrite corrupt unresolved records",async()=>{
  localStorage.setItem("hichat.reminder-attempts.v1","broken");
  await expect(reminderAttempt("owner","payload")).rejects.toThrow();
  expect(localStorage.getItem("hichat.reminder-attempts.v1")).toBe("broken");
});
it("looks up an unresolved request without allocating a new identity",async()=>{
  expect(await findReminderAttempt("owner","payload")).toBeUndefined();
  expect(localStorage.getItem("hichat.reminder-attempts.v1")).toBeNull();
  const id=await reminderAttempt("owner","payload");
  expect(await findReminderAttempt("owner","payload")).toBe(id);
});
it("deduplicates concurrent exact attempts in the same context",async()=>{
  const ids=await Promise.all(Array.from({length:8},()=>reminderAttempt("owner","payload")));
  expect(new Set(ids).size).toBe(1);
  expect(JSON.parse(localStorage.getItem("hichat.reminder-attempts.v1")!)).toHaveLength(1);
});
it("never discards unresolved requests to allocate beyond the capacity",async()=>{
  for(let index=0;index<128;index++)await reminderAttempt("owner",String(index));
  const before=localStorage.getItem("hichat.reminder-attempts.v1");
  await expect(reminderAttempt("owner","overflow")).rejects.toThrow("reminder_attempt_storage_full");
  expect(localStorage.getItem("hichat.reminder-attempts.v1")).toBe(before);
  expect(await reminderAttempt("owner","0")).toBe(await findReminderAttempt("owner","0"));
});
