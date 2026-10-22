package services

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/testutil"
)

type historyFixture struct {
	msgs  *testutil.MockMessageRepo
	perms *testutil.MockChannelPermResolver
	svc   MessageService
}

func newHistoryFixture() *historyFixture {
	f := &historyFixture{
		msgs:  &testutil.MockMessageRepo{},
		perms: &testutil.MockChannelPermResolver{},
	}
	chanRepo := &testutil.MockChannelRepo{
		GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
			return &models.Channel{ID: id, ServerID: "srv"}, nil
		},
	}
	f.perms.ResolveChannelPermissionsFn = func(_ context.Context, _, _ string) (models.Permission, error) {
		return models.PermViewChannel | models.PermReadMessages, nil
	}
	f.svc = newTestMessageService(
		f.msgs, &testutil.MockAttachmentRepo{}, chanRepo, &testutil.MockUserRepo{},
		&testutil.MockMentionRepo{}, &testutil.MockRoleMentionRepo{}, &testutil.MockRoleRepo{},
		&testutil.MockReactionRepo{}, &testutil.MockBroadcastAndOnline{}, f.perms,
	)
	return f
}

func fakeMessages(n int) []models.Message {
	out := make([]models.Message, n)
	for i := range out {
		out[i] = models.Message{ID: fmt.Sprintf("m%d", i), ChannelID: "ch1"}
	}
	return out
}

func TestMessageService_GetAround(t *testing.T) {
	f := newHistoryFixture()
	var gotLimit int
	f.msgs.GetByChannelIDAroundFn = func(_ context.Context, channelID, anchorID string, limit int) ([]models.Message, bool, bool, error) {
		gotLimit = limit
		if anchorID == "ghost" {
			return nil, false, false, fmt.Errorf("%w: anchor message not found", pkg.ErrNotFound)
		}
		return fakeMessages(5), true, false, nil
	}

	page, err := f.svc.GetAround(context.Background(), "srv", "ch1", "alice", "m2", 4)
	if err != nil {
		t.Fatalf("GetAround: %v", err)
	}
	if gotLimit != 4 {
		t.Errorf("repo limit = %d, want the clamped limit 4 (no +1: the repo sizes each half)", gotLimit)
	}
	if !page.HasMore || page.HasMoreAfter {
		t.Errorf("flags = (%v, %v), want (true, false) straight from the repo", page.HasMore, page.HasMoreAfter)
	}
	if len(page.Messages) != 5 {
		t.Fatalf("page size = %d, want 5", len(page.Messages))
	}
	// Hydration ran: nil slices became empty ones.
	if page.Messages[0].Attachments == nil || page.Messages[0].Mentions == nil || page.Messages[0].Reactions == nil || page.Messages[0].RoleMentions == nil {
		t.Error("window rows were not hydrated (nil slices would serialize as null)")
	}

	if _, err := f.svc.GetAround(context.Background(), "srv", "ch1", "alice", "ghost", 4); !errors.Is(err, pkg.ErrNotFound) {
		t.Errorf("unknown anchor err = %v, want ErrNotFound", err)
	}

	// Out-of-range limit falls back to 50.
	if _, err := f.svc.GetAround(context.Background(), "srv", "ch1", "alice", "m2", 0); err != nil {
		t.Fatalf("GetAround(limit 0): %v", err)
	}
	if gotLimit != 50 {
		t.Errorf("repo limit for limit=0 = %d, want 50", gotLimit)
	}
}

func TestMessageService_GetAfter(t *testing.T) {
	f := newHistoryFixture()
	var gotLimit int
	f.msgs.GetByChannelIDAfterFn = func(_ context.Context, _, _ string, limit int) ([]models.Message, error) {
		gotLimit = limit
		return fakeMessages(limit), nil // limit+1 rows → has_more_after
	}

	page, err := f.svc.GetAfter(context.Background(), "srv", "ch1", "alice", "m0", 3)
	if err != nil {
		t.Fatalf("GetAfter: %v", err)
	}
	if gotLimit != 4 {
		t.Errorf("repo limit = %d, want limit+1 = 4", gotLimit)
	}
	if !page.HasMoreAfter || page.HasMore {
		t.Errorf("flags = (has_more %v, has_more_after %v), want (false, true)", page.HasMore, page.HasMoreAfter)
	}
	if len(page.Messages) != 3 {
		t.Errorf("page size = %d, want 3 (trimmed)", len(page.Messages))
	}

	f.msgs.GetByChannelIDAfterFn = func(_ context.Context, _, _ string, _ int) ([]models.Message, error) {
		return nil, nil
	}
	page, err = f.svc.GetAfter(context.Background(), "srv", "ch1", "alice", "m0", 3)
	if err != nil {
		t.Fatalf("GetAfter(empty): %v", err)
	}
	if page.Messages == nil || len(page.Messages) != 0 || page.HasMoreAfter {
		t.Errorf("empty page = %+v, want [] with has_more_after=false", page)
	}
}

// TestMessageService_History_ReadGate — both forms share GetByChannelID's
// gate: no ViewChannel+ReadMessages → forbidden before the repo is touched.
func TestMessageService_History_ReadGate(t *testing.T) {
	f := newHistoryFixture()
	f.perms.ResolveChannelPermissionsFn = func(_ context.Context, _, _ string) (models.Permission, error) {
		return models.PermViewChannel, nil // can see, cannot read
	}
	f.msgs.GetByChannelIDAroundFn = func(_ context.Context, _, _ string, _ int) ([]models.Message, bool, bool, error) {
		t.Fatal("repo must not be queried when the read gate fails")
		return nil, false, false, nil
	}
	f.msgs.GetByChannelIDAfterFn = func(_ context.Context, _, _ string, _ int) ([]models.Message, error) {
		t.Fatal("repo must not be queried when the read gate fails")
		return nil, nil
	}
	if _, err := f.svc.GetAround(context.Background(), "srv", "ch1", "alice", "m1", 10); !errors.Is(err, pkg.ErrForbidden) {
		t.Errorf("GetAround err = %v, want ErrForbidden", err)
	}
	if _, err := f.svc.GetAfter(context.Background(), "srv", "ch1", "alice", "m1", 10); !errors.Is(err, pkg.ErrForbidden) {
		t.Errorf("GetAfter err = %v, want ErrForbidden", err)
	}
}

// ─── DM twins ───

func TestDMService_GetMessagesAroundAndAfter(t *testing.T) {
	f := newDMFixture()
	f.repo.GetChannelByIDFn = func(_ context.Context, id string) (*models.DMChannel, error) {
		return &models.DMChannel{ID: id, User1ID: "alice", User2ID: "bob"}, nil
	}
	f.repo.GetMessagesAroundFn = func(_ context.Context, _, anchorID string, limit int) ([]models.DMMessage, bool, bool, error) {
		if anchorID == "ghost" {
			return nil, false, false, fmt.Errorf("%w: anchor message not found", pkg.ErrNotFound)
		}
		return []models.DMMessage{{ID: "d1"}, {ID: "d2"}, {ID: "d3"}}, false, true, nil
	}
	f.repo.GetMessagesAfterFn = func(_ context.Context, _, _ string, limit int) ([]models.DMMessage, error) {
		out := make([]models.DMMessage, limit)
		for i := range out {
			out[i] = models.DMMessage{ID: fmt.Sprintf("d%d", i)}
		}
		return out, nil
	}

	page, err := f.svc.GetMessagesAround(context.Background(), "alice", "dm1", "d2", 4)
	if err != nil {
		t.Fatalf("GetMessagesAround: %v", err)
	}
	if len(page.Messages) != 3 || page.HasMore || !page.HasMoreAfter {
		t.Errorf("around page = %d rows, flags (%v, %v); want 3, (false, true)", len(page.Messages), page.HasMore, page.HasMoreAfter)
	}
	if page.Messages[0].Attachments == nil || page.Messages[0].Reactions == nil {
		t.Error("DM window rows were not enriched")
	}
	if _, err := f.svc.GetMessagesAround(context.Background(), "alice", "dm1", "ghost", 4); !errors.Is(err, pkg.ErrNotFound) {
		t.Errorf("unknown anchor err = %v, want ErrNotFound", err)
	}

	after, err := f.svc.GetMessagesAfter(context.Background(), "alice", "dm1", "d0", 2)
	if err != nil {
		t.Fatalf("GetMessagesAfter: %v", err)
	}
	if len(after.Messages) != 2 || !after.HasMoreAfter || after.HasMore {
		t.Errorf("after page = %d rows, flags (%v, %v); want 2, (false, true)", len(after.Messages), after.HasMore, after.HasMoreAfter)
	}

	// Non-member: forbidden before the repo is consulted.
	if _, err := f.svc.GetMessagesAround(context.Background(), "carol", "dm1", "d2", 4); !errors.Is(err, pkg.ErrForbidden) {
		t.Errorf("outsider GetMessagesAround err = %v, want ErrForbidden", err)
	}
	if _, err := f.svc.GetMessagesAfter(context.Background(), "carol", "dm1", "d0", 4); !errors.Is(err, pkg.ErrForbidden) {
		t.Errorf("outsider GetMessagesAfter err = %v, want ErrForbidden", err)
	}
}
