import { webcrypto } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IndexedVoiceKeyProvider, isMediaKeyVersion, mediaTokenSubject } from "./voiceEncryptionKeys";
beforeEach(() => vi.stubGlobal("crypto", webcrypto));
describe("authoritative media key versions", () => {
 it("validates the byte slot against a safe full epoch without truncation", () => {
  for (const epoch of [0, 1, 255, 256, 512, Number.MAX_SAFE_INTEGER]) expect(isMediaKeyVersion(epoch % 256, epoch)).toBe(true);
  for (const pair of [[256,256],[1,256],[0,-1],[0,undefined],[0,Number.MAX_SAFE_INTEGER+1],[1.5,1.5]]) expect(isMediaKeyVersion(...pair as [unknown,unknown])).toBe(false);
 });
 it("uses 256 explicit slots and accepts wrap while rejecting stale or conflicting epochs", async () => {
  const provider = new IndexedVoiceKeyProvider("room-incarnation");
  expect(provider.getOptions().keyringSize).toBe(256);
  for (const epoch of [0, 1, 256, 512]) { expect(await provider.setIndexedKey(`key-${epoch}`, epoch % 256, epoch, () => true)).toBe(true); expect(provider.getLatestManuallySetKeyIndex()).toBe(epoch % 256); }
  await expect(provider.setIndexedKey("stale", 255, 511, () => true)).rejects.toThrow();
  await expect(provider.setIndexedKey("conflict", 0, 512, () => true)).rejects.toThrow();
  const replacement = new IndexedVoiceKeyProvider("new-incarnation");
  expect(await replacement.setIndexedKey("new-key", 0, 0, () => true)).toBe(true);
 });
 it("does not install stale async material and fences concurrent conflicting same-epoch requests", async () => {
  const provider = new IndexedVoiceKeyProvider();
  const old = provider.setIndexedKey("old", 0, 0, () => false);
  await expect(provider.setIndexedKey("different", 0, 0, () => true)).rejects.toThrow();
  expect(await old).toBe(false); expect(provider.getKeys()).toHaveLength(0);
 });
 it("derives the same AES128 PBKDF2 key as the Go music codec", async () => {
  const provider = new IndexedVoiceKeyProvider();
  await provider.setIndexedKey("hichat-cross-sdk-v1", 0, 0, () => true);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: new TextEncoder().encode("LKFrameEncryptionKey"), iterations: 100000, hash: "SHA-256" }, provider.getKeys()[0].key, 128);
  expect(Buffer.from(bits).toString("hex")).toBe("e12cedbef126327d289b0359b8839926");
 });
 it("parses only a nonempty JWT subject for the local ownership fence", () => {
  expect(mediaTokenSubject(`a.${btoa(JSON.stringify({sub:"owner"}))}.b`)).toBe("owner");
  expect(mediaTokenSubject("bad")).toBeNull(); expect(mediaTokenSubject(`a.${btoa('{}')}.b`)).toBeNull();
 });
});
