import { beforeEach, expect, it } from "vitest";
import { channelSendIntent, clearChannelSendIntents, completeChannelSendIntent, setDurableChannelSends, supportsDurableChannelSends } from "./channelSendIntent";
beforeEach(clearChannelSendIntents);
it("enables automatic replay only after the server advertises durable sends", () => {
 expect(supportsDurableChannelSends()).toBe(false);setDurableChannelSends(true);expect(supportsDurableChannelSends()).toBe(true);clearChannelSendIntents();expect(supportsDurableChannelSends()).toBe(false);
});
it("retains the identity and prepared ciphertext across a manual retry", () => {
 const file=new File(["data"],"one");const first=channelSendIntent("session/channel","hello",[file]);
 first.encrypted={ciphertext:"fixed ciphertext",device:"device",metadata:"fixed metadata"};
 const retry=channelSendIntent("session/channel","hello",[file]);expect(retry).toBe(first);expect(retry.encrypted?.ciphertext).toBe("fixed ciphertext");
 completeChannelSendIntent("session/channel",first);expect(channelSendIntent("session/channel","hello",[file]).id).not.toBe(first.id);
});
it("changes identity for edits, changed files and another account", () => {
 const first=channelSendIntent("one/channel","hello");expect(channelSendIntent("one/channel","edited").id).not.toBe(first.id);
 expect(channelSendIntent("two/channel","hello").id).not.toBe(first.id);
 const a=channelSendIntent("one/channel","hello",[new File(["a"],"same")]);const b=channelSendIntent("one/channel","hello",[new File(["b"],"same")]);expect(a.id).not.toBe(b.id);
});
