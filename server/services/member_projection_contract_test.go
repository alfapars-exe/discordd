package services

import (
	"context"
	"fmt"
	"github.com/argeinfina/hichat/models"
	"testing"
)

// Count service-to-repository bulk operations, not physical SQL statements;
// repositories may split bounded parameter batches for large populations.
func TestMemberProjectionBulkCallsDoNotGrowPerMember(t *testing.T) {
	for _, size := range []int{0, 1, 1001} {
		t.Run(fmt.Sprint(size), func(t *testing.T) {
			h := newMemberHarness()
			profiles, roles, nicknames, timeouts := 0, 0, 0, 0
			h.userRepo.ListServerMemberProfilesFn = func(_ context.Context, server string) ([]models.User, error) {
				profiles++
				if server != "projection-server" {
					t.Fatal("profile scope changed")
				}
				rows := make([]models.User, size)
				for i := range rows {
					rows[i] = models.User{ID: fmt.Sprint(i), Username: fmt.Sprint(i)}
				}
				return rows, nil
			}
			h.userRepo.GetByIDFn = func(context.Context, string) (*models.User, error) {
				t.Fatal("per-user profile query")
				return nil, nil
			}
			h.roleRepo.GetRolesForUsersFn = func(_ context.Context, server string, ids []string) (map[string][]models.Role, error) {
				roles++
				if server != "projection-server" || len(ids) != size {
					t.Fatal("bulk role scope changed")
				}
				return map[string][]models.Role{}, nil
			}
			h.serverRepo.GetNicknamesForServerFn = func(_ context.Context, server string) (map[string]string, error) {
				nicknames++
				if server != "projection-server" {
					t.Fatal("nickname scope changed")
				}
				return map[string]string{"0": "nickname"}, nil
			}
			h.timeoutRepo.ListActiveFn = func(_ context.Context, server string) ([]models.MemberTimeout, error) {
				timeouts++
				if server != "projection-server" {
					t.Fatal("timeout scope changed")
				}
				return nil, nil
			}
			rows, err := h.svc.GetAll(context.Background(), "projection-server")
			if err != nil || len(rows) != size {
				t.Fatalf("member count=%d err=%v", len(rows), err)
			}
			if profiles != 1 || roles != 1 || nicknames != 1 || timeouts != 1 {
				t.Fatalf("bulk calls grew: %d/%d/%d/%d", profiles, roles, nicknames, timeouts)
			}
			if size > 0 && (rows[0].Nickname == nil || *rows[0].Nickname != "nickname") {
				t.Fatal("nickname projection lost")
			}
			for i, row := range rows {
				if row.ID != fmt.Sprint(i) {
					t.Fatal("projection order changed")
				}
			}
		})
	}
}
