package repository

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

func TestGroupDMAdmissionRechecksMemberLimit(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()
	repo := NewSQLiteGroupDMRepo(wrapForRepo(db))
	members := make([]string, 9)
	for i := 0; i < 11; i++ {
		id := fmt.Sprintf("limit-user-%d", i)
		if _, err := db.Conn.Exec(`INSERT INTO users(id,username,password_hash) VALUES(?,?,'x')`, id, id); err != nil {
			t.Fatal(err)
		}
		if i < len(members) {
			members[i] = id
		}
	}
	g := &models.GroupDM{ID: "limit-group", OwnerID: members[0], Name: "Limit", KeyEpoch: 1, CallRoomKey: "limit-room"}
	if err := repo.Create(ctx, g, members); err != nil {
		t.Fatal(err)
	}
	// Both admission requests saw nine members before either committed.
	for range 2 {
		ids, err := repo.ListMemberIDs(ctx, g.ID)
		if err != nil || len(ids) != 9 {
			t.Fatalf("initial snapshot=%v err=%v", ids, err)
		}
	}
	if epoch, err := repo.AddMember(ctx, g.ID, "limit-user-9"); err != nil || epoch != 2 {
		t.Fatalf("tenth admission: epoch=%d err=%v", epoch, err)
	}
	if _, err := repo.AddMember(ctx, g.ID, "limit-user-10"); !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("eleventh admission: %v", err)
	}
	after, err := repo.GetByID(ctx, g.ID)
	if err != nil || after.KeyEpoch != 2 {
		t.Fatalf("rejected admission changed epoch: group=%+v err=%v", after, err)
	}
	ids, err := repo.ListMemberIDs(ctx, g.ID)
	if err != nil || len(ids) != 10 {
		t.Fatalf("members=%v err=%v", ids, err)
	}
	var reads int
	if err := db.Conn.QueryRow(`SELECT COUNT(*) FROM group_dm_reads WHERE group_id=? AND user_id=?`, g.ID, "limit-user-10").Scan(&reads); err != nil || reads != 0 {
		t.Fatalf("rejected admission left read state: count=%d err=%v", reads, err)
	}
	if _, err := repo.RemoveMember(ctx, g.ID, "limit-user-9"); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.AddMember(ctx, g.ID, "limit-user-10"); err != nil {
		t.Fatalf("free slot could not be reused: %v", err)
	}
}
