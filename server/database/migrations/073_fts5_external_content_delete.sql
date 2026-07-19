-- 073: Repair the FTS5 sync triggers — external-content tables need the
-- special 'delete' command, not a plain DELETE.
--
-- THIS IS A REPAIR, NOT JUST A SCHEMA CHANGE. Databases that already ran with
-- the broken triggers carry a stale (and possibly structurally damaged) index,
-- so both indexes are rebuilt from their content tables here rather than
-- carrying the damage forward.
--
-- messages_fts / dm_messages_fts are declared content='messages' /
-- content='dm_messages' (migration 057) — EXTERNAL CONTENT tables. FTS5 does
-- not store the text for those, so a plain
--
--     DELETE FROM messages_fts WHERE rowid = OLD.rowid;
--
-- makes FTS5 re-read the content table to recompute which tokens to remove.
-- That is wrong in BOTH trigger positions:
--
--   * AFTER UPDATE OF content — the content row already holds the NEW text, so
--     the NEW tokens get removed and the OLD ones stay stranded in the index.
--     Observed: a message edited to redact something stays findable by its old
--     text, and the first content edit on a freshly migrated database fails
--     outright with SQLITE_CORRUPT_VTAB, "database disk image is malformed
--     (267)", because the bogus delete drives the doclist accounting negative.
--
--   * AFTER DELETE — the content row is already GONE, so there is nothing left
--     to re-read and NO tokens are removed at all. This was previously assumed
--     harmless for exactly that reason. It is not: "the row is gone" is
--     precisely why a plain DELETE cannot recompute the tokens. Measured on a
--     migrated database, the index entry survives the delete, and since SQLite
--     hands the freed rowid to the next insert, the deleted message's terms
--     attach themselves to whichever message lands on that rowid next —
--     searching a deleted message's text returns an unrelated newer message.
--
-- The documented form passes the old text explicitly, so FTS5 never has to
-- consult the content table:
--
--     INSERT INTO messages_fts(messages_fts, rowid, content)
--         VALUES('delete', OLD.rowid, OLD.content);
--
-- GUARDS. The index holds exactly the plaintext rows — the predicate the _ai
-- triggers index on:
--
--     content IS NOT NULL AND encryption_version = 0
--
-- (E2EE rows keep their text in `ciphertext` and are deliberately unindexed;
-- file-only messages have encryption_version = 0 with content NULL.) The
-- 'delete' command must be issued only for rows matching that same predicate:
-- unlike the old plain DELETE, issuing it for a row that was never indexed
-- would drive the doclist accounting negative — the very corruption being
-- fixed. So the _ad triggers gain the NULL-content guard the _ai triggers
-- always had, and the _au triggers apply it per-statement (a file-only message
-- edited to add text must still become searchable, so the guard cannot move up
-- into the trigger's WHEN clause).

-- ─── Drop the broken triggers ───
DROP TRIGGER IF EXISTS messages_ai;
DROP TRIGGER IF EXISTS messages_au;
DROP TRIGGER IF EXISTS messages_ad;
DROP TRIGGER IF EXISTS dm_messages_ai;
DROP TRIGGER IF EXISTS dm_messages_au;
DROP TRIGGER IF EXISTS dm_messages_ad;

-- ─── Rebuild the channel-message index ───
--
-- Expressed as drop + recreate + repopulate rather than the FTS5 'rebuild'
-- command on purpose. 'rebuild' re-reads the WHOLE content table, which would
-- also index every E2EE / file-only row (content NULL) as a zero-token
-- document — measured: docsize goes from 1 to 2 on a table holding one
-- plaintext and one E2EE message. Those entries match nothing, but no trigger
-- maintains them (the guards above skip NULL-content rows), so they would
-- accumulate unreclaimably and leave the index holding rows the triggers
-- cannot keep in sync — the same class of defect this migration repairs.
-- Repopulating under the trigger predicate keeps index and triggers in exact
-- agreement, and is what migration 057 itself did.
DROP TABLE IF EXISTS messages_fts;

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content,
    content='messages',
    content_rowid='rowid',
    tokenize='trigram'
);

INSERT OR IGNORE INTO messages_fts(rowid, content)
    SELECT rowid, content FROM messages
    WHERE content IS NOT NULL AND encryption_version = 0;

-- ─── Rebuild the DM-message index ───
DROP TABLE IF EXISTS dm_messages_fts;

CREATE VIRTUAL TABLE IF NOT EXISTS dm_messages_fts USING fts5(
    content,
    content='dm_messages',
    content_rowid='rowid',
    tokenize='trigram'
);

INSERT OR IGNORE INTO dm_messages_fts(rowid, content)
    SELECT rowid, content FROM dm_messages
    WHERE content IS NOT NULL AND encryption_version = 0;

-- ─── Recreate the triggers with the external-content delete form ───

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages
WHEN NEW.content IS NOT NULL AND NEW.encryption_version = 0
BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF content ON messages
WHEN OLD.encryption_version = 0
BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content)
    SELECT 'delete', OLD.rowid, OLD.content WHERE OLD.content IS NOT NULL;
    INSERT INTO messages_fts(rowid, content)
    SELECT NEW.rowid, NEW.content WHERE NEW.content IS NOT NULL AND NEW.encryption_version = 0;
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages
WHEN OLD.content IS NOT NULL AND OLD.encryption_version = 0
BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content)
    VALUES ('delete', OLD.rowid, OLD.content);
END;

CREATE TRIGGER IF NOT EXISTS dm_messages_ai AFTER INSERT ON dm_messages
WHEN NEW.content IS NOT NULL AND NEW.encryption_version = 0
BEGIN
    INSERT INTO dm_messages_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
END;

CREATE TRIGGER IF NOT EXISTS dm_messages_au AFTER UPDATE OF content ON dm_messages
WHEN OLD.encryption_version = 0
BEGIN
    INSERT INTO dm_messages_fts(dm_messages_fts, rowid, content)
    SELECT 'delete', OLD.rowid, OLD.content WHERE OLD.content IS NOT NULL;
    INSERT INTO dm_messages_fts(rowid, content)
    SELECT NEW.rowid, NEW.content WHERE NEW.content IS NOT NULL AND NEW.encryption_version = 0;
END;

CREATE TRIGGER IF NOT EXISTS dm_messages_ad AFTER DELETE ON dm_messages
WHEN OLD.content IS NOT NULL AND OLD.encryption_version = 0
BEGIN
    INSERT INTO dm_messages_fts(dm_messages_fts, rowid, content)
    VALUES ('delete', OLD.rowid, OLD.content);
END;
