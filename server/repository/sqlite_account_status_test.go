package repository

import (
	"context"
	"errors"
	"fmt"
	"github.com/argeinfina/hichat/pkg"
	"testing"
)

func TestSQLiteAccountStatusModerationSnapshot(t *testing.T) {
	db := newTestDB(t)
	seedBanWorld(t, db)
	ctx := context.Background()
	r := NewSQLiteAccountStatusRepo(wrapForRepo(db))
	execSeed(t, db, []seedStmt{
		{q: `INSERT INTO bans(server_id,user_id,username,reason,banned_by) VALUES(?,?,'target','actual ban reason',?)`, args: []any{banServer, banTarget, banOwner}},
		{q: `INSERT INTO member_timeouts(server_id,user_id,expires_at,applied_by,reason) VALUES(?,?,` + fixtureRelativeTimestamp("+1 hour") + `,?,'actual timeout')`, args: []any{banServer, banTarget, banOwner}},
	})
	status, err := r.Get(ctx, banTarget, 0)
	if err != nil {
		t.Fatal(err)
	}
	if status.PlatformBanned || len(status.Restrictions) != 2 || status.CheckedAt == 0 {
		t.Fatalf("snapshot %+v", status)
	}
	if status.Restrictions[0].Kind != "ban" || status.Restrictions[0].Reason != "actual ban reason" || status.Restrictions[0].ExpiresAt != nil {
		t.Fatal("permanent ban misrepresented")
	}
	if status.Restrictions[1].Kind != "timeout" || status.Restrictions[1].ExpiresAt == nil {
		t.Fatal("timeout missing expiry")
	}
	other, err := r.Get(ctx, banOwner, 0)
	if err != nil || len(other.Restrictions) != 0 {
		t.Fatal("cross-account restriction exposure", err)
	}
	if _, err := r.Get(ctx, "absent", 0); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatal("unknown owner got healthy state", err)
	}
	if _, err := db.Conn.Exec(`UPDATE users SET is_platform_banned=1,platform_ban_reason='platform reason' WHERE id=?`, banTarget); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.Exec(`UPDATE bans SET expires_at=` + fixtureRelativeTimestamp("-1 second") + `; UPDATE member_timeouts SET expires_at=` + fixtureRelativeTimestamp("-1 second") + ``); err != nil {
		t.Fatal(err)
	}
	status, err = r.Get(ctx, banTarget, 0)
	if err != nil || !status.PlatformBanned || status.PlatformReason != "platform reason" || len(status.Restrictions) != 0 {
		t.Fatalf("fresh state %+v %v", status, err)
	}
	if _, err := db.Conn.Exec(`UPDATE users SET is_platform_banned=0 WHERE id=?`, banTarget); err != nil {
		t.Fatal(err)
	}
	status, err = r.Get(ctx, banTarget, 0)
	if err != nil || status.PlatformReason != "" {
		t.Fatal("old platform reason exposed after unban", err)
	}
}

func TestSQLiteAccountStatusPagination(t *testing.T) {
	db := newTestDB(t)
	seedBanWorld(t, db)
	ctx := context.Background()
	r := NewSQLiteAccountStatusRepo(wrapForRepo(db))
	for i := 0; i < 51; i++ {
		id := fmt.Sprintf("restriction-%03d", i)
		execSeed(t, db, []seedStmt{
			{q: `INSERT INTO servers(id,name,owner_id) VALUES(?,?,?)`, args: []any{id, id, banOwner}},
			{q: `INSERT INTO bans(server_id,user_id,username,reason,banned_by) VALUES(?,?,'target','reason',?)`, args: []any{id, banTarget, banOwner}},
		})
	}
	first, err := r.Get(ctx, banTarget, 0)
	if err != nil || len(first.Restrictions) != 50 || first.NextOffset == nil || *first.NextOffset != 50 {
		t.Fatalf("first %+v %v", first, err)
	}
	second, err := r.Get(ctx, banTarget, 50)
	if err != nil || len(second.Restrictions) != 1 || second.NextOffset != nil {
		t.Fatalf("second %+v %v", second, err)
	}
	if first.Restrictions[49].ServerID == second.Restrictions[0].ServerID {
		t.Fatal("duplicate page item")
	}
	if _, err := r.Get(ctx, banTarget, -1); !errors.Is(err, pkg.ErrBadRequest) {
		t.Fatal("invalid page accepted")
	}
}
