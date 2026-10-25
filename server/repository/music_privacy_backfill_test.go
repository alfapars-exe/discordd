package repository

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/pkg"
)

func musicPrivacyBackfillFixture(t *testing.T) *database.DB {
	t.Helper()
	db := newTestDB(t)
	execSeed(t, db, []seedStmt{
		{q: `INSERT INTO users(id,username,password_hash) VALUES('retired-owner','retiredowner','hash'),('live-owner','liveowner','hash')`},
		{q: `INSERT INTO servers(id,name,owner_id) VALUES('backfill-server','Backfill','live-owner')`},
		{q: `INSERT INTO channels(id,name,type,server_id) VALUES('backfill-a','A','voice','backfill-server'),('backfill-b','B','voice','backfill-server')`},
		{q: `INSERT INTO music_control_heads(channel_id,server_id,session_id,revision) VALUES('backfill-a','backfill-server','original-session',7),('backfill-b','backfill-server','second-session',11)`},
		{q: `INSERT INTO music_sessions(channel_id,server_id,queue_json,repeat_mode,revision) VALUES('backfill-a','backfill-server',?,'all',7),('backfill-b','backfill-server',?,'off',11)`, args: []any{`[{"queue_item_id":"first","requested_by_user_id":"retired-owner","requested_by_name":"Private Name","future":{"precise":900719925474099312345,"nested":[true,null]}},{"queue_item_id":"other","requested_by_user_id":"live-owner","requested_by_name":"Private Name"},{"queue_item_id":"duplicate","requested_by_user_id":"retired-owner","requested_by_name":"Private Name","url":"https://youtu.be/example"}]`, `[{"queue_item_id":"second","requested_by_user_id":"retired-owner","requested_by_name":"Private Name"}]`}},
		{q: `INSERT INTO music_operation_receipts(channel_id,actor_id,request_id,session_id,request_hash,expected_revision,result_json) VALUES('backfill-a','retired-owner','retired-a','original-session','hash-a',6,'{"added_tracks":[{"requested_by_name":"Private Name"}]}'),('backfill-b','retired-owner','retired-b','second-session','hash-b',10,'{}'),('backfill-a','live-owner','live-request','original-session','hash-live',6,'{"keep":true}')`},
		{q: `INSERT INTO data_exports(id,user_id,status,payload,expires_at) VALUES('export-retired','retired-owner','ready','{"email":"private@example.invalid"}',?),('export-live','live-owner','ready','{"keep":true}',?)`, args: []any{time.Now().UTC().Add(time.Hour), time.Now().UTC().Add(time.Hour)}},
		{q: `UPDATE users SET deleted_at=? WHERE id='retired-owner'`, args: []any{time.Now().Unix()}},
	})
	return db
}
func TestMusicPrivacyBackfillDryRunReviewApplyKeysetsAndIdempotence(t *testing.T) {
	db := musicPrivacyBackfillFixture(t)
	ctx := context.Background()
	repo := wrapForRepo(db)
	var original, updated string
	var revision int
	if err := db.Conn.QueryRow(`SELECT queue_json,updated_at,revision FROM music_sessions WHERE channel_id='backfill-a'`).Scan(&original, &updated, &revision); err != nil {
		t.Fatal(err)
	}
	plan, err := BackfillMusicPrivacyBatch(ctx, repo, MusicPrivacyCursor{}, 1, "")
	if err != nil {
		t.Fatal(err)
	}
	if plan.Applied || plan.Done || plan.QueuesScanned != 1 || plan.QueuesChanged != 1 || plan.ReceiptsRemoved != 1 || plan.ExportsRemoved != 1 || len(plan.SourceHash) != 64 {
		t.Fatalf("wrong dry run: %#v", plan)
	}
	var stillOriginal string
	if err := db.Conn.QueryRow(`SELECT queue_json FROM music_sessions WHERE channel_id='backfill-a'`).Scan(&stillOriginal); err != nil {
		t.Fatal(err)
	}
	if original != stillOriginal {
		t.Fatal("dry run mutated queue")
	}
	for _, q := range []string{`SELECT COUNT(*) FROM music_operation_receipts WHERE actor_id='retired-owner'`, `SELECT COUNT(*) FROM data_exports WHERE user_id='retired-owner'`} {
		var n int
		if err := db.Conn.QueryRow(q).Scan(&n); err != nil || n == 0 {
			t.Fatal("dry run removed personal records")
		}
	}
	encoded, _ := json.Marshal(plan)
	for _, private := range []string{"Private Name", "private@example.invalid", "hash-a", "youtu.be"} {
		if strings.Contains(string(encoded), private) {
			t.Fatalf("report leaked %s", private)
		}
	}
	result, err := BackfillMusicPrivacyBatch(ctx, repo, plan.Cursor, plan.Limit, plan.SourceHash)
	if err != nil || !result.Applied {
		t.Fatalf("apply: %#v %v", result, err)
	}
	var after, afterUpdated, repeat string
	var head, queueRevision int
	if err := db.Conn.QueryRow(`SELECT queue_json,updated_at,repeat_mode,revision FROM music_sessions WHERE channel_id='backfill-a'`).Scan(&after, &afterUpdated, &repeat, &queueRevision); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(after, "900719925474099312345") || !strings.Contains(after, `"nested":[true,null]`) {
		t.Fatal("unknown fields or large exact number lost")
	}
	expected, _, err := stripMusicRequesterJSON(original, "retired-owner")
	if err != nil {
		t.Fatal(err)
	}
	equal, err := equalMusicQueueJSON([]byte(after), []byte(expected))
	if err != nil || !equal {
		t.Fatal("queue media/order/identity changed")
	}
	if afterUpdated != updated || queueRevision != revision || repeat != "all" {
		t.Fatal("backfill changed queue control semantics")
	}
	if err := db.Conn.QueryRow(`SELECT revision FROM music_control_heads WHERE channel_id='backfill-a' AND session_id='original-session'`).Scan(&head); err != nil || head != 7 {
		t.Fatal("head changed")
	}
	next, err := BackfillMusicPrivacyBatch(ctx, repo, plan.NextCursor, 1, "")
	if err != nil {
		t.Fatal(err)
	}
	if !next.Done || next.QueuesChanged != 1 || next.ReceiptsRemoved != 1 || next.ExportsRemoved != 0 {
		t.Fatalf("keyset missed rows: %#v", next)
	}
	if _, err := BackfillMusicPrivacyBatch(ctx, repo, next.Cursor, next.Limit, next.SourceHash); err != nil {
		t.Fatal(err)
	}
	clean, err := BackfillMusicPrivacyBatch(ctx, repo, MusicPrivacyCursor{}, 100, "")
	if err != nil {
		t.Fatal(err)
	}
	if !clean.Done || clean.QueuesChanged != 0 || clean.ReceiptsRemoved != 0 || clean.ExportsRemoved != 0 {
		t.Fatalf("not idempotent: %#v", clean)
	}
	for _, q := range []string{`SELECT COUNT(*) FROM music_operation_receipts WHERE actor_id='live-owner'`, `SELECT COUNT(*) FROM data_exports WHERE user_id='live-owner'`} {
		var n int
		if err := db.Conn.QueryRow(q).Scan(&n); err != nil || n != 1 {
			t.Fatal("live user's data removed")
		}
	}
}
func TestMusicPrivacyBackfillRejectsChangedPlanAndMalformedBatchWithoutPartialWrites(t *testing.T) {
	db := musicPrivacyBackfillFixture(t)
	ctx := context.Background()
	repo := wrapForRepo(db)
	plan, err := BackfillMusicPrivacyBatch(ctx, repo, MusicPrivacyCursor{}, 100, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.Exec(`UPDATE music_sessions SET revision=revision+1 WHERE channel_id='backfill-a'`); err != nil {
		t.Fatal(err)
	}
	if _, err := BackfillMusicPrivacyBatch(ctx, repo, plan.Cursor, plan.Limit, plan.SourceHash); !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("stale plan applied: %v", err)
	}
	var first string
	if err := db.Conn.QueryRow(`SELECT queue_json FROM music_sessions WHERE channel_id='backfill-a'`).Scan(&first); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.Exec(`UPDATE music_sessions SET queue_json='[{broken]' WHERE channel_id='backfill-b'`); err != nil {
		t.Fatal(err)
	}
	if _, err := BackfillMusicPrivacyBatch(ctx, repo, MusicPrivacyCursor{}, 100, strings.Repeat("a", 64)); err == nil {
		t.Fatal("malformed batch accepted")
	}
	var after string
	if err := db.Conn.QueryRow(`SELECT queue_json FROM music_sessions WHERE channel_id='backfill-a'`).Scan(&after); err != nil || after != first {
		t.Fatal("malformed batch partially rewrote queue")
	}
	for _, q := range []string{`SELECT COUNT(*) FROM music_operation_receipts WHERE actor_id='retired-owner'`, `SELECT COUNT(*) FROM data_exports WHERE user_id='retired-owner'`} {
		var n int
		if err := db.Conn.QueryRow(q).Scan(&n); err != nil || n == 0 {
			t.Fatal("failed apply removed personal records")
		}
	}
}
func TestMusicPrivacyBackfillBoundsAndRetirementChangeInvalidatePlan(t *testing.T) {
	db := musicPrivacyBackfillFixture(t)
	ctx := context.Background()
	repo := wrapForRepo(db)
	for _, limit := range []int{0, 101} {
		if _, err := BackfillMusicPrivacyBatch(ctx, repo, MusicPrivacyCursor{}, limit, ""); !errors.Is(err, pkg.ErrBadRequest) {
			t.Fatal("invalid bound accepted")
		}
	}
	if _, err := BackfillMusicPrivacyBatch(ctx, repo, MusicPrivacyCursor{}, 1, "bad"); !errors.Is(err, pkg.ErrBadRequest) {
		t.Fatal("invalid review digest accepted")
	}
	plan, err := BackfillMusicPrivacyBatch(ctx, repo, MusicPrivacyCursor{}, 100, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.Exec(`UPDATE users SET deleted_at=? WHERE id='live-owner'`, time.Now().Unix()); err != nil {
		t.Fatal(err)
	}
	if _, err := BackfillMusicPrivacyBatch(ctx, repo, plan.Cursor, plan.Limit, plan.SourceHash); !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("identity changed without conflict: %v", err)
	}
}

func TestMusicPrivacyBackfillRollbackAndSharedIdentityLock(t *testing.T) {
	t.Run("rollback_after_first_queue_update", func(t *testing.T) {
		db := musicPrivacyBackfillFixture(t)
		ctx := context.Background()
		repo := wrapForRepo(db)
		plan, err := BackfillMusicPrivacyBatch(ctx, repo, MusicPrivacyCursor{}, 100, "")
		if err != nil {
			t.Fatal(err)
		}
		if database.IsPostgres(db.Conn) {
			if _, err := db.Conn.Exec(`CREATE FUNCTION fail_backfill_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.channel_id='backfill-b' THEN RAISE EXCEPTION 'injected backfill failure'; END IF; RETURN NEW; END $$`); err != nil {
				t.Fatal(err)
			}
			if _, err := db.Conn.Exec(`CREATE TRIGGER fail_backfill_fixture BEFORE UPDATE ON music_sessions FOR EACH ROW EXECUTE FUNCTION fail_backfill_fixture()`); err != nil {
				t.Fatal(err)
			}
		} else {
			if _, err := db.Conn.Exec(`CREATE TRIGGER fail_backfill_fixture BEFORE UPDATE ON music_sessions WHEN NEW.channel_id='backfill-b' BEGIN SELECT RAISE(ABORT,'injected backfill failure'); END`); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := BackfillMusicPrivacyBatch(ctx, repo, plan.Cursor, plan.Limit, plan.SourceHash); err == nil {
			t.Fatal("injected failure ignored")
		}
		var raw string
		if err := db.Conn.QueryRow(`SELECT queue_json FROM music_sessions WHERE channel_id='backfill-a'`).Scan(&raw); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(raw, "Deleted User") {
			t.Fatal("earlier row update escaped rollback")
		}
		var n int
		if err := db.Conn.QueryRow(`SELECT COUNT(*) FROM data_exports WHERE user_id='retired-owner'`).Scan(&n); err != nil || n != 1 {
			t.Fatal("rollback removed export")
		}
	})
	t.Run("shares_retirement_writer_boundary", func(t *testing.T) {
		db := musicPrivacyBackfillFixture(t)
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		plan, err := BackfillMusicPrivacyBatch(ctx, wrapForRepo(db), MusicPrivacyCursor{}, 100, "")
		if err != nil {
			t.Fatal(err)
		}
		gate, err := db.Conn.BeginTx(ctx, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer gate.Rollback()
		if err := lockMusicIdentityTx(ctx, gate, database.IsPostgres(db.Conn)); err != nil {
			t.Fatal(err)
		}
		started := make(chan struct{})
		done := make(chan error, 1)
		go func() {
			close(started)
			_, err := BackfillMusicPrivacyBatch(ctx, wrapForRepo(db), plan.Cursor, plan.Limit, plan.SourceHash)
			done <- err
		}()
		<-started
		select {
		case err := <-done:
			t.Fatalf("backfill acknowledged before identity lock resolved: %v", err)
		case <-time.After(75 * time.Millisecond):
		}
		if err := gate.Commit(); err != nil {
			t.Fatal(err)
		}
		select {
		case err := <-done:
			if err != nil {
				t.Fatal(err)
			}
		case <-ctx.Done():
			t.Fatal("backfill did not settle after lock release")
		}
	})
}

func TestMusicPrivacyBackfillNullableExportPayload(t *testing.T) {
	db := musicPrivacyBackfillFixture(t)
	if _, err := db.Conn.Exec(`UPDATE data_exports SET payload=NULL WHERE user_id='retired-owner'`); err != nil {
		t.Fatal(err)
	}
	plan, err := BackfillMusicPrivacyBatch(context.Background(), wrapForRepo(db), MusicPrivacyCursor{}, 100, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := BackfillMusicPrivacyBatch(context.Background(), wrapForRepo(db), plan.Cursor, plan.Limit, plan.SourceHash); err != nil {
		t.Fatal(err)
	}
}
