import test from "node:test";
import assert from "node:assert/strict";
import { parseCS2SteamInvite, parseCS2SteamJoinRecipe, buildCS2SteamJoinURI } from "./cs2-join-contract";
// Synthetic IDs constructed from documented fields; no personal Steam IDs.
const id = (type: bigint, instance: bigint, account = 123n, universe = 1n) => ((universe << 56n) | (type << 52n) | (instance << 32n) | account).toString();
const lobby = id(8n, 1n << 18n), inviter = id(1n, 1n);
const uri = (lobbyId = lobby, inviterId = inviter) => `steam://joinlobby/730/${lobbyId}/${inviterId}`;
const recipe = () => ({ adapter: "cs2-steam", lobbyId: lobby, inviterId: inviter });
test("exact CS2 public lobby/individual recipe round-trips without Number precision loss", () => {
  const parsed = parseCS2SteamInvite(uri());
  assert.deepEqual(parsed, recipe()); assert.equal(buildCS2SteamJoinURI(parsed), uri()); assert.ok(Object.isFrozen(parsed));
  assert.ok(parseCS2SteamInvite(uri(id(8n, (1n << 18n) | (1n << 17n)))));
  const next = id(8n, 1n << 18n, 124n);
  assert.notEqual(parseCS2SteamInvite(uri(next))?.lobbyId, parsed?.lobbyId);
  assert.equal(parseCS2SteamInvite(uri(id(8n, (1n << 18n) | 0xfffn, 0xffffffffn), id(1n, 1n, 0xffffffffn)))?.inviterId, id(1n, 1n, 0xffffffffn));
});
test("canonical decimal uint64 only, never rounded numbers, signs, exponents or encodings", () => {
  for (const value of ["0", "00", "0" + lobby, "+" + lobby, "-" + lobby, "1e17", "18446744073709551616", "9".repeat(5000), lobby + "\n", "１２３", "%31" + lobby.slice(1)]) assert.equal(parseCS2SteamInvite(uri(value)), null);
  assert.equal(parseCS2SteamJoinRecipe({ ...recipe(), lobbyId: Number(lobby) }), null);
  assert.equal(parseCS2SteamJoinRecipe({ ...recipe(), inviterId: BigInt(inviter) }), null);
});
test("lobby requires public Chat lobby flag, live account and only documented lobby instance bits", () => {
  for (const value of [id(1n, 1n), id(7n, 0n), id(8n, 0n), id(8n, 1n << 19n), id(8n, 1n << 17n), id(8n, (1n << 18n) | 0x1000n), id(8n, 1n << 18n, 0n), id(8n, 1n << 18n, 1n, 0n), id(8n, 1n << 18n, 1n, 2n), id(8n, 1n << 18n, 1n, 255n)]) assert.equal(parseCS2SteamInvite(uri(value)), null);
});
test("inviter requires public individual/default instance/nonzero account, not server/clan/lobby", () => {
  for (const value of [id(8n, 1n << 18n), id(3n, 1n), id(7n, 0n), id(1n, 0n), id(1n, 2n), id(1n, 4n), id(1n, 1n, 0n), id(1n, 1n, 1n, 2n)]) assert.equal(parseCS2SteamInvite(uri(lobby, value)), null);
});
test("rejects alternate protocols, routes/apps, command arguments and all URL decorations", () => {
  const original = uri();
  for (const value of [original.replace("steam:", "https:"), original.replace("steam:", "STEAM:"), original.replace("joinlobby", "JoinLobby"), original.replace("730", "570"), original.replace("730", "0730"), original + "/", original + "?x=1", original + "#x", original + " --exec", original + "\n", " " + original, original + " ", original.replace("steam://", "steam://user:pass@"), original.replace("joinlobby/", "joinlobby%2F"), original.replace("steam://", "steam:\\"), "file:///steam.exe", "C:\\steam.exe --join", "steam://run/730", original + "/other"]) assert.equal(parseCS2SteamInvite(value), null);
});
test("recipe parser/builder copy strict data only and cannot carry arbitrary URLs, args or authority", () => {
  for (const value of [null, [], uri(), { ...recipe(), adapter: "other" }, { ...recipe(), url: uri() }, { ...recipe(), args: "-exec" }, { ...recipe(), executable: "steam.exe" }, { ...recipe(), lobbyId: "https://example.invalid" }, Object.assign(Object.create({ inherited: true }), recipe())]) { assert.equal(parseCS2SteamJoinRecipe(value), null); assert.equal(buildCS2SteamJoinURI(value), null); }
  const value = recipe(), copy = parseCS2SteamJoinRecipe(value); value.lobbyId = "0"; assert.equal(copy?.lobbyId, lobby);
  const throwing = Object.defineProperty(recipe(), "inviterId", { get() { throw new Error("untrusted getter"); } }); assert.equal(buildCS2SteamJoinURI(throwing), null);
});
