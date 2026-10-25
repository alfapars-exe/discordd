/** Pure groundwork only: parsing a Steam lobby link is not a launch or ownership check.
 * Valve app identity: https://store.steampowered.com/app/730/CounterStrike_2/
 * ID layout/types: ValveSoftware/GameNetworkingSockets/include/steam/steamclientpublic.h
 * Actual Steam-generated URI handling still requires two-client acceptance testing.
 */
export type CS2SteamJoinRecipe = Readonly<{
  adapter: "cs2-steam";
  lobbyId: string;
  inviterId: string;
}>;
const maxUint64 = (1n << 64n) - 1n;
const accountMask = (1n << 32n) - 1n;
const instanceMask = (1n << 20n) - 1n;
const lobbyInstanceFlag = 1n << 18n;
const matchmakingLobbyInstanceFlag = 1n << 17n;
const lobbyInstanceAllowed = lobbyInstanceFlag | matchmakingLobbyInstanceFlag | 0xfffn;
function steamID(raw: unknown, kind: "lobby" | "individual"): string | null {
  if (typeof raw !== "string" || raw.length > 20 || !/^[1-9][0-9]*$/.test(raw) || /[^0-9]/.test(raw)) return null;
  const value = BigInt(raw);
  if (value > maxUint64) return null;
  const universe = value >> 56n;
  const type = (value >> 52n) & 0xfn;
  const instance = (value >> 32n) & instanceMask;
  const account = value & accountMask;
  // This adapter targets public Steam, not beta/internal/dev universes.
  if (universe !== 1n || account === 0n) return null;
  if (kind === "individual") return type === 1n && instance === 1n ? raw : null;
  // Valve IsLobby requires the lobby flag; its optional MMS lobby flag is valid.
  // Clan and reserved instance flags remain outside this adapter.
  return type === 8n && (instance & lobbyInstanceFlag) !== 0n && (instance & ~lobbyInstanceAllowed) === 0n ? raw : null;
}
export function parseCS2SteamJoinRecipe(raw: unknown): CS2SteamJoinRecipe | null {
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const prototype = Object.getPrototypeOf(raw);
    if (prototype !== null && prototype !== Object.prototype) return null;
    const keys = Reflect.ownKeys(raw);
    if (keys.length !== 3 || !keys.every(key => typeof key === "string" && ["adapter", "lobbyId", "inviterId"].includes(key))) return null;
    const value = raw as Record<string, unknown>;
    const adapter = value.adapter, lobbyId = steamID(value.lobbyId, "lobby"), inviterId = steamID(value.inviterId, "individual");
    return adapter === "cs2-steam" && lobbyId && inviterId ? Object.freeze({ adapter, lobbyId, inviterId }) : null;
  } catch { return null; }
}
/** Exact grammar; no URL normalization, decoding, trimming or arbitrary endpoint. */
export function parseCS2SteamInvite(raw: unknown): CS2SteamJoinRecipe | null {
  if (typeof raw !== "string" || raw.length > 64 || /[^a-z0-9:/]/.test(raw)) return null;
  const match = /^steam:\/\/joinlobby\/730\/([1-9][0-9]{0,19})\/([1-9][0-9]{0,19})$/.exec(raw);
  return match && match[0] === raw ? parseCS2SteamJoinRecipe({ adapter: "cs2-steam", lobbyId: match[1], inviterId: match[2] }) : null;
}
/** Builds only a locally fixed recipe URI. It never invokes a shell or Steam. */
export function buildCS2SteamJoinURI(raw: unknown): string | null {
  const recipe = parseCS2SteamJoinRecipe(raw);
  return recipe ? `steam://joinlobby/730/${recipe.lobbyId}/${recipe.inviterId}` : null;
}
