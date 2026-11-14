package services

import (
	"context"
	"errors"
	"fmt"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/testutil"
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

func TestMemberProjectionBulkFailureStopsEnrichment(t *testing.T) {
	for _, stage := range []string{"profiles", "roles"} {
		t.Run(stage, func(t *testing.T) {
			h := newMemberHarness()
			failure := errors.New("controlled bulk projection failure")
			h.userRepo.ListServerMemberProfilesFn = func(context.Context, string) ([]models.User, error) {
				if stage == "profiles" {
					return nil, failure
				}
				return []models.User{{ID: "member"}}, nil
			}
			h.roleRepo.GetRolesForUsersFn = func(context.Context, string, []string) (map[string][]models.Role, error) {
				if stage != "roles" {
					t.Fatal("roles queried after profile failure")
				}
				return nil, failure
			}
			h.userRepo.GetByIDFn = func(context.Context, string) (*models.User, error) {
				t.Fatal("unexpected per-user fallback")
				return nil, nil
			}
			h.serverRepo.GetNicknamesForServerFn = func(context.Context, string) (map[string]string, error) {
				t.Fatal("nickname enrichment after failure")
				return nil, nil
			}
			h.timeoutRepo.ListActiveFn = func(context.Context, string) ([]models.MemberTimeout, error) {
				t.Fatal("timeout enrichment after failure")
				return nil, nil
			}
			rows, err := h.svc.GetAll(context.Background(), "scope")
			if !errors.Is(err, failure) || rows != nil {
				t.Fatal("bulk error became successful partial membership")
			}
		})
	}
}

func TestGroupHistoryProfileFailureHasNoPerUserFallback(t *testing.T) {
	failure := errors.New("controlled group profile failure")
	users := &testutil.MockUserRepo{
		PublicUsersByIDFn: func(context.Context, []string) (map[string]*models.PublicUser, error) { return nil, failure },
		GetByIDFn: func(context.Context, string) (*models.User, error) {
			t.Fatal("unexpected per-user fallback")
			return nil, nil
		},
	}
	svc := &groupDMService{groups: &groupAroundFixture{}, users: users}
	if err := svc.enrichMessageHistory(context.Background(), []models.GroupDMMessage{{UserID: "author"}}); !errors.Is(err, failure) {
		t.Fatal("group history masked profile failure")
	}
}
