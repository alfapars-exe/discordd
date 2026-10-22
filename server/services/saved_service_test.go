package services

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/testutil"
)

type savedFixture struct {
	saved   *testutil.MockSavedRepo
	msgs    *testutil.MockMessageRepo
	chans   *testutil.MockChannelRepo
	dm      *testutil.MockDMRepo
	perms   *testutil.MockChannelPermResolver
	svc     SavedService
	created []*models.SavedMessage
}

// newSavedFixture — a readable channel message "m1" in channel "ch1", a DM
// message "d1" in channel "dm1" (alice, bob); perms grant read everywhere
// unless a test overrides.
func newSavedFixture() *savedFixture {
	f := &savedFixture{
		saved: &testutil.MockSavedRepo{},
		msgs:  &testutil.MockMessageRepo{},
		chans: &testutil.MockChannelRepo{},
		dm:    &testutil.MockDMRepo{},
		perms: &testutil.MockChannelPermResolver{},
	}
	f.msgs.GetByIDFn = func(_ context.Context, id string) (*models.Message, error) {
		if id != "m1" {
			return nil, pkg.ErrNotFound
		}
		return &models.Message{ID: "m1", ChannelID: "ch1"}, nil
	}
	f.chans.GetByIDFn = func(_ context.Context, id string) (*models.Channel, error) {
		return &models.Channel{ID: id, ServerID: "srv"}, nil
	}
	f.dm.GetMessageByIDFn = func(_ context.Context, id string) (*models.DMMessage, error) {
		if id != "d1" {
			return nil, pkg.ErrNotFound
		}
		return &models.DMMessage{ID: "d1", DMChannelID: "dm1"}, nil
	}
	f.dm.GetChannelByIDFn = func(_ context.Context, id string) (*models.DMChannel, error) {
		return &models.DMChannel{ID: id, User1ID: "alice", User2ID: "bob"}, nil
	}
	f.perms.ResolveChannelPermissionsFn = func(_ context.Context, _, _ string) (models.Permission, error) {
		return models.PermViewChannel | models.PermReadMessages, nil
	}
	f.saved.CreateFn = func(_ context.Context, s *models.SavedMessage) error {
		s.ID = "saved-new"
		f.created = append(f.created, s)
		return nil
	}
	f.saved.GetByIDFn = func(_ context.Context, userID, id string) (*models.SavedMessage, error) {
		return &models.SavedMessage{ID: id, UserID: userID}, nil
	}
	f.svc = NewSavedService(f.saved, f.msgs, f.chans, f.dm, f.perms)
	return f
}

func TestSavedService_Save_ChannelMessageAuthorization(t *testing.T) {
	t.Run("readable channel saves and returns created", func(t *testing.T) {
		f := newSavedFixture()
		saved, created, err := f.svc.Save(context.Background(), "alice", &models.CreateSavedMessageRequest{MessageID: "m1"})
		if err != nil {
			t.Fatalf("Save: %v", err)
		}
		if !created || saved == nil || saved.ID != "saved-new" {
			t.Errorf("Save = (%+v, %v), want a freshly created row", saved, created)
		}
		if len(f.created) != 1 || f.created[0].MessageID == nil || *f.created[0].MessageID != "m1" || f.created[0].DMMessageID != nil {
			t.Errorf("created row = %+v, want message_id=m1 only", f.created)
		}
	})

	t.Run("non-member channel is forbidden", func(t *testing.T) {
		f := newSavedFixture()
		f.perms.ResolveChannelPermissionsFn = func(_ context.Context, _, _ string) (models.Permission, error) {
			return 0, nil
		}
		_, _, err := f.svc.Save(context.Background(), "alice", &models.CreateSavedMessageRequest{MessageID: "m1"})
		if !errors.Is(err, pkg.ErrForbidden) {
			t.Fatalf("err = %v, want ErrForbidden", err)
		}
		if len(f.created) != 0 {
			t.Error("a forbidden save still wrote a row")
		}
	})

	t.Run("unknown message is not found", func(t *testing.T) {
		f := newSavedFixture()
		_, _, err := f.svc.Save(context.Background(), "alice", &models.CreateSavedMessageRequest{MessageID: "ghost"})
		if !errors.Is(err, pkg.ErrNotFound) {
			t.Fatalf("err = %v, want ErrNotFound", err)
		}
	})
}

func TestSavedService_Save_DMMessageAuthorization(t *testing.T) {
	f := newSavedFixture()
	if _, created, err := f.svc.Save(context.Background(), "bob", &models.CreateSavedMessageRequest{DMMessageID: "d1"}); err != nil || !created {
		t.Fatalf("member save = (created %v, %v), want created", created, err)
	}
	if len(f.created) != 1 || f.created[0].DMMessageID == nil || *f.created[0].DMMessageID != "d1" || f.created[0].MessageID != nil {
		t.Errorf("created row = %+v, want dm_message_id=d1 only", f.created)
	}

	_, _, err := f.svc.Save(context.Background(), "carol", &models.CreateSavedMessageRequest{DMMessageID: "d1"})
	if !errors.Is(err, pkg.ErrForbidden) {
		t.Errorf("foreign DM save err = %v, want ErrForbidden", err)
	}
	_, _, err = f.svc.Save(context.Background(), "bob", &models.CreateSavedMessageRequest{DMMessageID: "ghost"})
	if !errors.Is(err, pkg.ErrNotFound) {
		t.Errorf("unknown DM message err = %v, want ErrNotFound", err)
	}
}

func TestSavedService_Save_ValidationAndLimits(t *testing.T) {
	t.Run("exactly one reference", func(t *testing.T) {
		f := newSavedFixture()
		for _, req := range []*models.CreateSavedMessageRequest{{}, {MessageID: "m1", DMMessageID: "d1"}} {
			if _, _, err := f.svc.Save(context.Background(), "alice", req); !errors.Is(err, pkg.ErrBadRequest) {
				t.Errorf("Save(%+v) err = %v, want ErrBadRequest", req, err)
			}
		}
	})

	t.Run("idempotent repeat returns the existing row", func(t *testing.T) {
		f := newSavedFixture()
		f.saved.FindByRefFn = func(_ context.Context, userID, messageID, _ string) (*models.SavedMessage, error) {
			return &models.SavedMessage{ID: "existing", UserID: userID, MessageID: &messageID}, nil
		}
		saved, created, err := f.svc.Save(context.Background(), "alice", &models.CreateSavedMessageRequest{MessageID: "m1"})
		if err != nil {
			t.Fatalf("Save: %v", err)
		}
		if created || saved.ID != "existing" {
			t.Errorf("Save = (%+v, created %v), want the existing row, not created", saved, created)
		}
		if len(f.created) != 0 {
			t.Error("repeat save inserted a second row")
		}
	})

	t.Run("limit reached", func(t *testing.T) {
		f := newSavedFixture()
		f.saved.CountFn = func(_ context.Context, _ string) (int, error) { return models.SavedMessagesLimit, nil }
		_, _, err := f.svc.Save(context.Background(), "alice", &models.CreateSavedMessageRequest{MessageID: "m1"})
		if !errors.Is(err, pkg.ErrBadRequest) || !strings.Contains(err.Error(), "saved_limit_reached") {
			t.Errorf("err = %v, want ErrBadRequest saved_limit_reached", err)
		}
	})

	t.Run("note is normalised and validated", func(t *testing.T) {
		f := newSavedFixture()
		note := "  line one\r\nline two  "
		if _, _, err := f.svc.Save(context.Background(), "alice", &models.CreateSavedMessageRequest{MessageID: "m1", Note: &note}); err != nil {
			t.Fatalf("Save: %v", err)
		}
		if got := f.created[0].Note; got == nil || *got != "line one\nline two" {
			t.Errorf("stored note = %v, want CRLF-normalised, trimmed text", got)
		}

		f = newSavedFixture()
		blank := "   "
		if _, _, err := f.svc.Save(context.Background(), "alice", &models.CreateSavedMessageRequest{MessageID: "m1", Note: &blank}); err != nil {
			t.Fatalf("Save(blank note): %v", err)
		}
		if f.created[0].Note != nil {
			t.Errorf("blank note stored as %q, want nil", *f.created[0].Note)
		}

		bidi := "safe‮evil"
		if _, _, err := f.svc.Save(context.Background(), "alice", &models.CreateSavedMessageRequest{MessageID: "m1", Note: &bidi}); !errors.Is(err, pkg.ErrBadRequest) {
			t.Errorf("steering-char note err = %v, want ErrBadRequest", err)
		}
		long := strings.Repeat("x", models.NoteMaxRunes+1)
		if _, _, err := f.svc.Save(context.Background(), "alice", &models.CreateSavedMessageRequest{MessageID: "m1", Note: &long}); !errors.Is(err, pkg.ErrBadRequest) {
			t.Errorf("over-long note err = %v, want ErrBadRequest", err)
		}
	})

	t.Run("unique race falls back to the winner's row", func(t *testing.T) {
		f := newSavedFixture()
		calls := 0
		f.saved.FindByRefFn = func(_ context.Context, userID, messageID, _ string) (*models.SavedMessage, error) {
			calls++
			if calls == 1 {
				return nil, nil // nothing yet when we looked
			}
			return &models.SavedMessage{ID: "winner", UserID: userID, MessageID: &messageID}, nil
		}
		f.saved.CreateFn = func(_ context.Context, _ *models.SavedMessage) error {
			return errors.New("UNIQUE constraint failed: saved_messages.user_id, saved_messages.message_id")
		}
		saved, created, err := f.svc.Save(context.Background(), "alice", &models.CreateSavedMessageRequest{MessageID: "m1"})
		if err != nil || created || saved.ID != "winner" {
			t.Errorf("Save after race = (%+v, %v, %v), want the winner's row", saved, created, err)
		}
	})
}

// TestSavedService_List_RechecksChannelPermissions — rows whose channel the
// caller can no longer read come back as unavailable stubs (resolved once per
// distinct channel); readable rows stay hydrated; has_more / next_before are
// computed from the raw rows.
func TestSavedService_List_RechecksChannelPermissions(t *testing.T) {
	f := newSavedFixture()
	dmID := "d1"
	f.saved.ListFn = func(_ context.Context, _, _ string, limit int) ([]models.SavedMessage, error) {
		if limit != 3 {
			t.Errorf("repo limit = %d, want limit+1 = 3", limit)
		}
		return []models.SavedMessage{
			{ID: "s1", Message: &models.SavedChannelMessage{ID: "m1", ChannelID: "ok-chan"}},
			{ID: "s2", Message: &models.SavedChannelMessage{ID: "m2", ChannelID: "locked-chan"}},
			{ID: "s3", DMMessageID: &dmID, DMMessage: &models.SavedDMMessage{ID: "d1"}},
		}, nil
	}
	resolved := map[string]int{}
	f.perms.ResolveChannelPermissionsFn = func(_ context.Context, _, channelID string) (models.Permission, error) {
		resolved[channelID]++
		if channelID == "locked-chan" {
			return 0, nil
		}
		return models.PermViewChannel | models.PermReadMessages, nil
	}

	page, err := f.svc.List(context.Background(), "alice", "", 2)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if !page.HasMore {
		t.Error("has_more = false, want true (repo returned limit+1 rows)")
	}
	// limit 2 → raw page s1,s2; s2 is kept as a stub, never dropped.
	if got := savedPageIDs(page); len(got) != 2 || got[0] != "s1" || got[1] != "s2" {
		t.Fatalf("page = %v, want [s1 s2]", got)
	}
	if page.Saved[0].Unavailable || page.Saved[0].Message == nil {
		t.Errorf("readable row = %+v, want hydrated and available", page.Saved[0])
	}
	if !page.Saved[1].Unavailable || page.Saved[1].Message != nil || page.Saved[1].DMMessage != nil {
		t.Errorf("locked row = %+v, want the unavailable stub (no content)", page.Saved[1])
	}
	if page.NextBefore == nil || *page.NextBefore != "s2" {
		t.Errorf("next_before = %v, want s2 (last raw row)", page.NextBefore)
	}
	if resolved["ok-chan"] != 1 || resolved["locked-chan"] != 1 {
		t.Errorf("resolver calls = %v, want exactly one per distinct channel", resolved)
	}
}

// TestSavedService_List_AllUnreadablePageKeepsCursor — the pagination dead
// end the review flagged: even when every row of a page is unreadable or
// dangling, the page carries those rows as stubs plus a usable cursor.
func TestSavedService_List_AllUnreadablePageKeepsCursor(t *testing.T) {
	f := newSavedFixture()
	gone := "gone"
	f.saved.ListFn = func(_ context.Context, _, _ string, _ int) ([]models.SavedMessage, error) {
		return []models.SavedMessage{
			{ID: "s1", Message: &models.SavedChannelMessage{ID: "m1", ChannelID: "locked"}},
			{ID: "s2", MessageID: &gone, Unavailable: true}, // dangling, stubbed by the repo
			{ID: "s3", Message: &models.SavedChannelMessage{ID: "m3", ChannelID: "locked"}},
		}, nil
	}
	f.perms.ResolveChannelPermissionsFn = func(_ context.Context, _, _ string) (models.Permission, error) {
		return 0, nil
	}

	page, err := f.svc.List(context.Background(), "alice", "", 2)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(page.Saved) != 2 {
		t.Fatalf("page = %v, want 2 stubs", savedPageIDs(page))
	}
	for _, row := range page.Saved {
		if !row.Unavailable || row.Message != nil || row.DMMessage != nil {
			t.Errorf("row %s = %+v, want the unavailable stub", row.ID, row)
		}
	}
	if !page.HasMore || page.NextBefore == nil || *page.NextBefore != "s2" {
		t.Errorf("has_more=%v next_before=%v, want true / s2", page.HasMore, page.NextBefore)
	}

	// Last page: no more rows → next_before null.
	f.saved.ListFn = func(_ context.Context, _, _ string, _ int) ([]models.SavedMessage, error) {
		return []models.SavedMessage{{ID: "s3", Message: &models.SavedChannelMessage{ID: "m3", ChannelID: "locked"}}}, nil
	}
	page, err = f.svc.List(context.Background(), "alice", "s2", 2)
	if err != nil {
		t.Fatalf("List(last page): %v", err)
	}
	if page.HasMore || page.NextBefore != nil || len(page.Saved) != 1 {
		t.Errorf("last page = %v has_more=%v next_before=%v, want 1 row, false, nil", savedPageIDs(page), page.HasMore, page.NextBefore)
	}
}

// TestSavedService_UpdateNote_ReturnsStubWhenUnreadable — PATCH must not
// hand back the content of a message the caller lost access to.
func TestSavedService_UpdateNote_ReturnsStubWhenUnreadable(t *testing.T) {
	f := newSavedFixture()
	mid := "m1"
	f.saved.GetByIDFn = func(_ context.Context, userID, id string) (*models.SavedMessage, error) {
		content := "secret"
		return &models.SavedMessage{ID: id, UserID: userID, MessageID: &mid,
			Message: &models.SavedChannelMessage{ID: "m1", ChannelID: "ch1", Content: &content}}, nil
	}
	f.perms.ResolveChannelPermissionsFn = func(_ context.Context, _, _ string) (models.Permission, error) {
		return models.PermViewChannel, nil // can see, cannot read
	}
	note := "x"
	got, err := f.svc.UpdateNote(context.Background(), "alice", "mine", &note)
	if err != nil {
		t.Fatalf("UpdateNote: %v", err)
	}
	if !got.Unavailable || got.Message != nil {
		t.Errorf("UpdateNote returned %+v, want the unavailable stub", got)
	}

	f.perms.ResolveChannelPermissionsFn = func(_ context.Context, _, _ string) (models.Permission, error) {
		return models.PermViewChannel | models.PermReadMessages, nil
	}
	got, err = f.svc.UpdateNote(context.Background(), "alice", "mine", &note)
	if err != nil || got.Unavailable || got.Message == nil {
		t.Errorf("readable UpdateNote = (%+v, %v), want the hydrated row", got, err)
	}
}

func TestSavedService_List_ResolveFailureServesStubFailClosed(t *testing.T) {
	f := newSavedFixture()
	f.saved.ListFn = func(_ context.Context, _, _ string, _ int) ([]models.SavedMessage, error) {
		return []models.SavedMessage{{ID: "s1", Message: &models.SavedChannelMessage{ID: "m1", ChannelID: "ch1"}}}, nil
	}
	f.perms.ResolveChannelPermissionsFn = func(_ context.Context, _, _ string) (models.Permission, error) {
		return 0, errors.New("db down")
	}
	page, err := f.svc.List(context.Background(), "alice", "", 10)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(page.Saved) != 1 || !page.Saved[0].Unavailable || page.Saved[0].Message != nil {
		t.Errorf("page = %+v, want one unavailable stub when the permission resolve fails", page.Saved)
	}
}

func savedPageIDs(page *models.SavedMessagePage) []string {
	ids := make([]string, len(page.Saved))
	for i, s := range page.Saved {
		ids[i] = s.ID
	}
	return ids
}

func TestSavedService_UpdateNoteAndDelete_NotFound(t *testing.T) {
	f := newSavedFixture()
	f.saved.UpdateNoteFn = func(_ context.Context, userID, id string, note *string) (bool, error) {
		return id == "mine", nil
	}
	f.saved.DeleteFn = func(_ context.Context, userID, id string) (bool, error) {
		return id == "mine", nil
	}

	note := "x"
	if _, err := f.svc.UpdateNote(context.Background(), "alice", "theirs", &note); !errors.Is(err, pkg.ErrNotFound) {
		t.Errorf("UpdateNote(foreign) err = %v, want ErrNotFound", err)
	}
	if saved, err := f.svc.UpdateNote(context.Background(), "alice", "mine", &note); err != nil || saved.ID != "mine" {
		t.Errorf("UpdateNote(mine) = (%+v, %v)", saved, err)
	}
	empty := ""
	var clearedTo *string = &note
	f.saved.UpdateNoteFn = func(_ context.Context, _, _ string, n *string) (bool, error) {
		clearedTo = n
		return true, nil
	}
	if _, err := f.svc.UpdateNote(context.Background(), "alice", "mine", &empty); err != nil {
		t.Fatalf("UpdateNote(empty): %v", err)
	}
	if clearedTo != nil {
		t.Errorf("empty note stored as %q, want nil (NULL)", *clearedTo)
	}

	if err := f.svc.Delete(context.Background(), "alice", "theirs"); !errors.Is(err, pkg.ErrNotFound) {
		t.Errorf("Delete(foreign) err = %v, want ErrNotFound", err)
	}
	if err := f.svc.Delete(context.Background(), "alice", "mine"); err != nil {
		t.Errorf("Delete(mine) = %v", err)
	}
}
