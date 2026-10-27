import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const base = "http://127.0.0.1:9090/api";
const runDir = resolve(process.env.E2E_RUN_DIR ?? "");
if (!/^run-\d+-\d+-[a-f0-9]{16}$/.test(runDir.split(/[\\/]/).at(-1) ?? "")) {
  throw new Error("invalid disposable run identity");
}
const runStat = lstatSync(runDir);
if (!runStat.isDirectory() || runStat.isSymbolicLink()) throw new Error("run directory is not a real directory");
const realRun = realpathSync(runDir);
const realRoot = realpathSync(dirname(runDir));
const runRelative = relative(realRoot, realRun);
if (!runRelative || runRelative === ".." || runRelative.startsWith(`..${sep}`)) throw new Error("run directory escaped E2E root");

const makeAccount = () => ({
  username: `e2e_${Date.now()}_${randomBytes(5).toString("hex")}`,
  password: `Aa1!${randomBytes(16).toString("hex")}`,
});
const owner = makeAccount();
const recipient = makeAccount();

async function request(path, token, method = "GET", body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Content-Type": "application/json",
      "X-HiChat-Client": "web",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let envelope;
  try {
    envelope = await response.json();
  } catch {
    throw new Error(`fixture API returned non-JSON (${response.status} ${path})`);
  }
  if (!response.ok || envelope.success !== true || envelope.data === undefined) {
    throw new Error(`fixture API failed (${response.status} ${path})`);
  }
  return envelope.data;
}

async function register(account, displayName) {
  return request("/auth/register", "", "POST", {
    ...account,
    display_name: displayName,
    email: `${account.username}@example.test`,
  });
}

const ownerAuth = await register(owner, "Synthetic E2E Owner");
const recipientAuth = await register(recipient, "Synthetic E2E Recipient");
const ownerToken = ownerAuth.access_token;
const recipientToken = recipientAuth.access_token;
const recipientId = recipientAuth.user?.id;
if (!ownerToken || !recipientToken || !recipientId) throw new Error("fixture auth response missing required fields");

const serverName = `E2E Notification ${Date.now()}`;
const server = await request("/servers", ownerToken, "POST", {
  name: serverName,
  host_type: "self_hosted",
  livekit_url: "https://example.invalid",
  livekit_key: "e2e-test-only-key",
  livekit_secret: "e2e-test-only-secret",
});
const grouped = await request(`/servers/${server.id}/channels`, ownerToken);
const channels = grouped.flatMap((group) => group.channels ?? []);
const general = channels.find((channel) => channel.name === "general" && channel.type === "text");
if (!general) throw new Error("fixture server has no seeded general text channel");

async function createChannel(name) {
  return request(`/servers/${server.id}/channels`, ownerToken, "POST", {
    name,
    type: "text",
    category_id: general.category_id ?? "",
    topic: "Disposable channel notification fixture",
  });
}

const muted = await createChannel("fixture-muted");
const privateChannel = await createChannel("fixture-private");
const roles = await request(`/servers/${server.id}/roles`, ownerToken);
const everyone = roles.find((role) => role.name.toLowerCase() === "everyone");
if (!everyone) throw new Error("fixture server has no everyone role");
await request(`/servers/${server.id}/channels/${privateChannel.id}/permissions/${everyone.id}`, ownerToken, "PUT", {
  allow: 0,
  deny: 6144,
});
const invite = await request(`/servers/${server.id}/invites`, ownerToken, "POST", {
  max_uses: 1,
  expires_in: 30,
  channel_id: general.id,
});
await request("/servers/join", recipientToken, "POST", { invite_code: invite.code });
await request(`/servers/${server.id}/channels/${muted.id}/mute`, recipientToken, "POST", { duration: "forever" });
await request("/users/me/preferences", recipientToken, "PATCH", {
  expected_user_id: recipientId,
  data: { notifications: { channelMessageNotifications: false } },
});

const secretPath = join(runDir, "synthetic-fixture.json");
writeFileSync(secretPath, "", { mode: 0o600, flag: "wx" });
const who = execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" });
const userSid = who.match(/S-1-[0-9-]+/i)?.[0];
if (!userSid) throw new Error("could not resolve current Windows user SID for fixture ACL");
execFileSync("icacls", [
  secretPath,
  "/inheritance:r",
  "/grant:r",
  `*${userSid}:(F)`,
], { stdio: "ignore" });

const fixture = {
  baseURL: "http://127.0.0.1:9090",
  runId: runDir.split(/[\\/]/).at(-1),
  owner,
  recipient,
  server: { id: server.id, name: serverName },
  channels: { general: general.id, muted: muted.id, private: privateChannel.id },
  initialRecipientPreference: "channelMessageNotifications=false",
};
writeFileSync(secretPath, JSON.stringify(fixture, null, 2), { mode: 0o600, flag: "w" });
console.log(JSON.stringify({
  baseURL: fixture.baseURL,
  runId: fixture.runId,
  server: fixture.server,
  channels: fixture.channels,
  secretFile: secretPath,
}));
