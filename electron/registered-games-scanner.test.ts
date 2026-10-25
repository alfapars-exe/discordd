import assert from "node:assert/strict";
import test from "node:test";
import childProcess, { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { scanWindowsExecutables, validateProcessImageNames } from "./registered-games";

test("process names retain legal apostrophes/spaces/Unicode and deduplicate case without mutating input", () => {
  const input = ["Game.EXE", "game.exe", "Friend's game.exe", "Çağrı.exe"];
  assert.deepEqual(validateProcessImageNames(input), ["Game.EXE", "Friend's game.exe", "Çağrı.exe"]);
  assert.equal(input.length, 4);
});

test("process filter rejects paths, wildcard queries, quote injection and controls", () => {
  for (const value of [null, undefined, "game.exe", {}, [1], [null], [""], ["C:\\Games\\game.exe"], ["C:game.exe"], ["../game.exe"],
    ["game.exe/other.exe"], ["*.exe"], ["g?me.exe"], ['x.exe" OR ProcessId > 0 OR Name = "x.exe'], ['bad"name.exe'],
    ["bad|name.exe"], ["bad<name.exe"], ["bad>name.exe"], ["bad\nname.exe"], ["bad\u0000name.exe"], ["bad\u0085name.exe"], ["game.exe "], ["game.exe."]]) {
    assert.throws(() => validateProcessImageNames(value), TypeError);
  }
});

test("process filters cap raw input count and executable basename length", () => {
  assert.equal(validateProcessImageNames(Array.from({ length: 32 }, (_, i) => `game${i}.exe`)).length, 32);
  assert.throws(() => validateProcessImageNames(Array(33).fill("duplicate.exe")), TypeError);
  assert.equal(validateProcessImageNames(["a".repeat(251) + ".exe"])[0].length, 255);
  assert.throws(() => validateProcessImageNames(["a".repeat(252) + ".exe"]), TypeError);
});

test("empty or rejected image names never start a PowerShell process", async t => {
  const mock = t.mock.method(childProcess, "spawn", () => { throw new Error("must not spawn"); });
  assert.deepEqual(await scanWindowsExecutables([]), []);
  await assert.rejects(scanWindowsExecutables(['injected".exe']), TypeError);
  assert.equal(mock.mock.callCount(), 0);
});

function fakeProcess(reply: string) {
  const output = new PassThrough();
  let payload = "", killed = false;
  const input = new Writable({ write(chunk, _encoding, callback) { payload += String(chunk); callback(); } });
  const process = Object.assign(new EventEmitter(), { stdout: output, stdin: input, kill: () => { killed = true; return true; } });
  input.on("finish", () => { output.write(reply); process.emit("close", 0); });
  return { child: process as unknown as ChildProcess, payload: () => payload, killed: () => killed };
}

test("validated names enter only stdin while fixed command uses provider and post-query allowlists", async t => {
  const process = fakeProcess(JSON.stringify([{ name: "Friend's game.exe", executablePath: null }]));
  let args: unknown[] = [];
  t.mock.method(childProcess, "spawn", (...values: unknown[]) => { args = values; return process.child; });
  assert.deepEqual(await scanWindowsExecutables(["Friend's game.exe", "FRIEND'S GAME.EXE"]), [{ name: "friend's game.exe", executablePath: null }]);
  const commandArgs = args[1] as string[];
  const command = commandArgs[commandArgs.length - 1];
  assert.ok(command.includes("-Filter $filter"));
  assert.ok(command.includes("'Name = \"'"));
  assert.ok(command.includes("$lookup.Contains"));
  assert.ok(!command.includes("Friend's game.exe"));
  assert.deepEqual(JSON.parse(Buffer.from(process.payload(), "base64").toString("utf8")), ["Friend's game.exe"]);
  assert.equal((args[2] as { windowsHide: boolean }).windowsHide, true);
  assert.equal(process.killed(), false);
});

test("provider rows outside the requested-name allowlist still fail closed", async t => {
  const process = fakeProcess(JSON.stringify([{ name: "unrequested.exe", executablePath: null }]));
  t.mock.method(childProcess, "spawn", () => process.child);
  await assert.rejects(scanWindowsExecutables(["requested.exe"]), /invalid data/);
});

test("provider-side filtering retains the 128KiB output bound", async t => {
  const process = fakeProcess(" ".repeat(128 * 1024 + 1));
  t.mock.method(childProcess, "spawn", () => process.child);
  await assert.rejects(scanWindowsExecutables(["requested.exe"]), /exceeded its limit/);
  assert.equal(process.killed(), true);
});
