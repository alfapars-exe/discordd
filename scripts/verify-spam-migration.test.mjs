import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migration = readFileSync(new URL("../server/database/migrations/116_spam_inbox.sql", import.meta.url), "utf8");
const repository = readFileSync(new URL("../server/repository/sqlite_spam.go", import.meta.url), "utf8");
const recordSQL = repository.match(/ExecContext\(ctx, `(INSERT INTO spam_inbox[\s\S]*?)`/u)?.[1];
assert.ok(recordSQL, "repository insert SQL must be exercised directly");
function database() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE users(id TEXT PRIMARY KEY, deleted_at INTEGER); INSERT INTO users(id) VALUES('one'),('two');");
  return db;
}

test("spam migration rolls back atomically without changing source identities", () => {
  const db = database();
  try {
    db.exec("BEGIN"); db.exec(migration); db.exec("ROLLBACK");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='spam_inbox'").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users").get().n, 2);
    db.exec(migration);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='spam_inbox'").get().n, 1);
  } finally { db.close(); }
});

test("actual migration enforces quota, preserves decisions and rejects deleted owners", () => {
  const db = database();
  try {
    db.exec(migration);
    const record = db.prepare(recordSQL);
    const args = (id, revision = "original", user = "one") => [user, "dm", "private", id, revision, '["credential-link"]'];
    db.exec("BEGIN");
    for (let index = 0; index < 5000; index++) record.run(...args(String(index)));
    db.exec("COMMIT");
    assert.throws(() => record.run(...args("overflow")), /spam_inbox_limit/u);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM spam_inbox WHERE user_id='one'").get().n, 5000);
    db.exec("UPDATE spam_inbox SET status='restored' WHERE user_id='one' AND message_id='0'");
    record.run(...args("0"));
    assert.equal(db.prepare("SELECT status FROM spam_inbox WHERE user_id='one' AND message_id='0'").get().status, "restored");
    record.run(...args("0", "2026-10-24T12:00:00Z"));
    assert.equal(db.prepare("SELECT status FROM spam_inbox WHERE user_id='one' AND message_id='0'").get().status, "quarantined");
    record.run(...args("independent", "original", "two"));
    db.exec("UPDATE users SET deleted_at=1 WHERE id='two'");
    assert.throws(() => record.run(...args("after-delete", "original", "two")), /deleted account/u);
    assert.throws(() => db.exec("UPDATE spam_inbox SET status='restored' WHERE user_id='two'"), /deleted account/u);
  } finally { db.close(); }
});
