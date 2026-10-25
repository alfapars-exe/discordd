import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearTokens } from "../api/client";
import { useAuthStore } from "../stores/authStore";
import { invalidateMediaLabels, receiveMediaLabelChange, subscribeMediaLabelChanges } from "./mediaLabelSync";
const reference = {source_kind:"dm" as const,channel_id:"private",message_id:"message",revision:"original",fingerprint:"a".repeat(64)};
const cleanups: (() => void)[] = [];
beforeEach(() => useAuthStore.setState({user:{id:"owner"} as never}));
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
it("invalidates only the owner's matching mounted references and unsubscribes", () => {
  const current=vi.fn(), other=vi.fn();
  const unsubscribe=subscribeMediaLabelChanges("owner",reference,current);
  cleanups.push(unsubscribe,subscribeMediaLabelChanges("owner",{...reference,channel_id:"elsewhere"},other));
  receiveMediaLabelChange({...reference,user_id:"foreign"});
  expect(current).not.toHaveBeenCalled();
  receiveMediaLabelChange({...reference,user_id:"owner"});
  expect(current).toHaveBeenCalledOnce();
  expect(other).not.toHaveBeenCalled();
  unsubscribe();
  invalidateMediaLabels("owner");
  expect(current).toHaveBeenCalledOnce();
  expect(other).toHaveBeenCalledOnce();
});
it("does not reuse an old subscription after same-account reauthentication", () => {
  const current=vi.fn();
  cleanups.push(subscribeMediaLabelChanges("owner",reference,current));
  clearTokens();
  invalidateMediaLabels("owner",reference);
  expect(current).not.toHaveBeenCalled();
});
it("rejects malformed socket references and refreshes mounted references on reconnect", () => {
  const current=vi.fn();
  cleanups.push(subscribeMediaLabelChanges("owner",reference,current));
  for(const input of [null,{}, {...reference,user_id:"owner",source_kind:"unknown"},{...reference,user_id:"owner",fingerprint:"bad"},{...reference,user_id:"owner",message_id:"x".repeat(129)}]) receiveMediaLabelChange(input);
  expect(current).not.toHaveBeenCalled();
  invalidateMediaLabels("owner");
  expect(current).toHaveBeenCalledOnce();
});
