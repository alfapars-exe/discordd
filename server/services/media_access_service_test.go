// Fail-closed authorization tests for MediaAccessService.Authorize.
//
// Before this file, the bottom of Authorize was `return MediaPublic, nil` —
// any fileURL that missed the channel-attachment and DM-attachment tables
// was served to anyone, including report/feedback evidence (A-22) and any
// orphaned file still sitting on disk after its owning row was gone (A-21).
// These tests pin the replacement decision order: channel -> DM -> report ->
// feedback -> positive public-asset check -> known-public path prefix ->
// fail-closed 404. See the MediaDecision doc comments in
// media_access_service.go for why the ordering matters (a caller must not be
// able to launder an orphaned private file into "public" by pointing their
// own avatar_url at it before ownership is checked).
package services

import (
	"context"
	"errors"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

// ─── Fakes ───
//
// media_access_service.go depends on narrow, unexported structural
// interfaces (ISP — see the type block at the top of that file). Being in
// the same package, these fakes satisfy them directly with no repository
// scaffolding.

type noopAttachments struct{}

func (noopAttachments) GetByFileURL(context.Context, string) (*models.Attachment, error) {
	return nil, pkg.ErrNotFound
}

type noopMessages struct{}

func (noopMessages) GetByID(context.Context, string) (*models.Message, error) {
	return nil, pkg.ErrNotFound
}

type noopDMs struct{}

func (noopDMs) GetAttachmentByFileURL(context.Context, string) (*models.DMAttachment, error) {
	return nil, pkg.ErrNotFound
}
func (noopDMs) GetMessageByID(context.Context, string) (*models.DMMessage, error) {
	return nil, pkg.ErrNotFound
}
func (noopDMs) GetChannelByID(context.Context, string) (*models.DMChannel, error) {
	return nil, pkg.ErrNotFound
}

type noopPermResolver struct{}

func (noopPermResolver) ResolveChannelPermissions(context.Context, string, string) (models.Permission, error) {
	return 0, nil
}
func (noopPermResolver) ResolveChannelPermissionsBulk(context.Context, string, []string) (map[string]models.Permission, error) {
	return nil, nil
}

type fakeReports struct {
	attByURL map[string]*models.ReportAttachment
	byID     map[string]*models.Report
	attErr   error // forces GetAttachmentByFileURL to fail with a non-ErrNotFound error
}

func (f *fakeReports) GetAttachmentByFileURL(_ context.Context, fileURL string) (*models.ReportAttachment, error) {
	if f.attErr != nil {
		return nil, f.attErr
	}
	if att, ok := f.attByURL[fileURL]; ok {
		return att, nil
	}
	return nil, pkg.ErrNotFound
}

func (f *fakeReports) GetByID(_ context.Context, id string) (*models.Report, error) {
	if r, ok := f.byID[id]; ok {
		return r, nil
	}
	return nil, pkg.ErrNotFound
}

type fakeFeedback struct {
	attByURL map[string]*models.FeedbackAttachment
	byID     map[string]*models.FeedbackTicketWithUser
}

func (f *fakeFeedback) GetAttachmentByFileURL(_ context.Context, fileURL string) (*models.FeedbackAttachment, error) {
	if att, ok := f.attByURL[fileURL]; ok {
		return att, nil
	}
	return nil, pkg.ErrNotFound
}

// GetTicketByID mirrors sqliteFeedbackRepo.GetTicketByID: production wraps
// sql.ErrNoRows directly rather than returning the pkg.ErrNotFound sentinel,
// so Authorize cannot distinguish "no such ticket" from any other lookup
// failure — both must fail closed to MediaNotFound. Returning a plain error
// (not pkg.ErrNotFound) here is deliberate, to prove Authorize doesn't rely
// on the sentinel for this lookup.
func (f *fakeFeedback) GetTicketByID(_ context.Context, id string) (*models.FeedbackTicketWithUser, error) {
	if t, ok := f.byID[id]; ok {
		return t, nil
	}
	return nil, errors.New("failed to get feedback ticket: sql: no rows in result set")
}

type fakeUsers struct {
	byID map[string]*models.User
}

func (f *fakeUsers) GetByID(_ context.Context, id string) (*models.User, error) {
	if u, ok := f.byID[id]; ok {
		return u, nil
	}
	return nil, pkg.ErrNotFound
}

type fakePublicAssets struct {
	public map[string]bool
	err    error
}

func (f *fakePublicAssets) IsPublicAsset(_ context.Context, fileURL string) (bool, error) {
	if f.err != nil {
		return false, f.err
	}
	return f.public[fileURL], nil
}

// ─── Fixtures ───

const (
	reportAttURL   = "/api/uploads/report-evidence.png"
	feedbackAttURL = "/api/uploads/feedback-evidence.png"
	publicAssetURL = "/api/uploads/avatar123.png"
	soundboardURL  = "/api/uploads/soundboard/aabbccddeeff0011_clip.mp3"
	badgesURL      = "/api/uploads/badges/aabbccddeeff0011_icon.png"
	orphanURL      = "/api/uploads/nothing-claims-this.png"

	reporterID    = "user-reporter"
	ticketOwnerID = "user-ticket-owner"
	adminID       = "user-admin"
	strangerID    = "user-stranger"
)

// resolveAs builds a resolveUser closure for an authenticated caller.
func resolveAs(userID string) func() (string, bool) {
	return func() (string, bool) { return userID, true }
}

// resolveAnon is the resolveUser closure for an unauthenticated caller.
func resolveAnon() (string, bool) { return "", false }

func newMediaAccessTestService() MediaAccessService {
	reports := &fakeReports{
		attByURL: map[string]*models.ReportAttachment{
			reportAttURL: {ID: "r-att-1", ReportID: "report-1", FileURL: reportAttURL},
		},
		byID: map[string]*models.Report{
			"report-1": {ID: "report-1", ReporterID: reporterID},
		},
	}
	feedback := &fakeFeedback{
		attByURL: map[string]*models.FeedbackAttachment{
			feedbackAttURL: {ID: "f-att-1", TicketID: "ticket-1", FileURL: feedbackAttURL},
		},
		byID: map[string]*models.FeedbackTicketWithUser{
			"ticket-1": {FeedbackTicket: models.FeedbackTicket{ID: "ticket-1", UserID: ticketOwnerID}},
		},
	}
	users := &fakeUsers{
		byID: map[string]*models.User{
			reporterID:    {ID: reporterID},
			ticketOwnerID: {ID: ticketOwnerID},
			adminID:       {ID: adminID, IsPlatformAdmin: true},
			strangerID:    {ID: strangerID},
		},
	}
	publicAssets := &fakePublicAssets{
		public: map[string]bool{publicAssetURL: true},
	}

	return NewMediaAccessService(
		noopAttachments{}, noopMessages{}, noopDMs{}, noopPermResolver{},
		reports, feedback, users, publicAssets,
	)
}

// ─── Report attachments (A-22) ───

func TestMediaAccessService_ReportAttachment(t *testing.T) {
	svc := newMediaAccessTestService()

	tests := []struct {
		name    string
		resolve func() (string, bool)
		want    MediaDecision
	}{
		{"reporter sees their own evidence", resolveAs(reporterID), MediaAllowed},
		{"platform admin sees any report's evidence", resolveAs(adminID), MediaAllowed},
		{"unrelated user is forbidden", resolveAs(strangerID), MediaForbidden},
		// The reported user isn't in the fixture's user table at all — mirrors
		// a caller GetByID can't resolve. Must still fail closed to Forbidden,
		// not fall through to a laxer decision.
		{"unresolvable user fails closed to forbidden", resolveAs("user-ghost"), MediaForbidden},
		{"anonymous caller must authenticate", resolveAnon, MediaRequiresAuth},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := svc.Authorize(context.Background(), reportAttURL, tc.resolve)
			if err != nil {
				t.Fatalf("Authorize returned error: %v", err)
			}
			if got != tc.want {
				t.Errorf("Authorize = %v, want %v", got, tc.want)
			}
		})
	}
}

// ─── Feedback attachments (A-22) ───

func TestMediaAccessService_FeedbackAttachment(t *testing.T) {
	svc := newMediaAccessTestService()

	tests := []struct {
		name    string
		resolve func() (string, bool)
		want    MediaDecision
	}{
		{"ticket owner sees their own evidence", resolveAs(ticketOwnerID), MediaAllowed},
		{"platform admin sees any ticket's evidence", resolveAs(adminID), MediaAllowed},
		{"unrelated user is forbidden", resolveAs(strangerID), MediaForbidden},
		{"anonymous caller must authenticate", resolveAnon, MediaRequiresAuth},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := svc.Authorize(context.Background(), feedbackAttURL, tc.resolve)
			if err != nil {
				t.Fatalf("Authorize returned error: %v", err)
			}
			if got != tc.want {
				t.Errorf("Authorize = %v, want %v", got, tc.want)
			}
		})
	}
}

// ─── Positive public-asset paths ───

func TestMediaAccessService_PositivePublicAssetPaths(t *testing.T) {
	svc := newMediaAccessTestService()

	tests := []struct {
		name    string
		fileURL string
	}{
		{"avatar/wallpaper/icon/banner via MediaAssetRepository.IsPublicAsset", publicAssetURL},
		{"soundboard sample path prefix", soundboardURL},
		{"badge icon path prefix", badgesURL},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			called := false
			resolve := func() (string, bool) { called = true; return "", false }

			got, err := svc.Authorize(context.Background(), tc.fileURL, resolve)
			if err != nil {
				t.Fatalf("Authorize returned error: %v", err)
			}
			if got != MediaPublic {
				t.Errorf("Authorize = %v, want MediaPublic", got)
			}
			// Public assets must load in unauthenticated <img> contexts —
			// resolveUser must stay unconsulted for them.
			if called {
				t.Errorf("resolveUser was invoked for a public asset")
			}
		})
	}
}

// ─── Fail-closed dip: nothing claims this path ───

func TestMediaAccessService_UnclaimedPathFailsClosed(t *testing.T) {
	svc := newMediaAccessTestService()

	t.Run("no ownership table and no public match -> 404, not public", func(t *testing.T) {
		got, err := svc.Authorize(context.Background(), orphanURL, resolveAnon)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != MediaNotFound {
			t.Errorf("Authorize = %v, want MediaNotFound", got)
		}
	})

	t.Run("resolveUser is never invoked for an unclaimed path", func(t *testing.T) {
		called := false
		resolve := func() (string, bool) { called = true; return "", false }
		if _, err := svc.Authorize(context.Background(), orphanURL, resolve); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if called {
			t.Errorf("resolveUser was invoked for a path with no ownership match")
		}
	})
}

// ─── Non-canonical path must not match the public-prefix check ───

// TestMediaAccessService_NonCanonicalSoundboardPathNotPublic pins the LOW
// finding from the 2026-08 media-access review: the soundboard/badges prefix
// branch has no attachment table to consult, so unlike every ownership
// lookup above it (an exact-string DB match, which a non-canonical fileURL
// simply misses), it must independently verify the path is canonical before
// treating it as public. "/api/uploads/soundboard/../gizli.png" starts with
// "soundboard/" once the "/api/uploads/" prefix is stripped, but
// path.Clean would fold it onto an unrelated file at read time — it must
// not resolve to MediaPublic.
func TestMediaAccessService_NonCanonicalSoundboardPathNotPublic(t *testing.T) {
	svc := newMediaAccessTestService()

	got, err := svc.Authorize(context.Background(), "/api/uploads/soundboard/../gizli.png", resolveAnon)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got == MediaPublic {
		t.Errorf("Authorize = MediaPublic for a non-canonical path, want anything else (fail closed)")
	}
}

// ─── Repo errors must surface, never fall through to MediaPublic ───

func TestMediaAccessService_LookupErrorsDoNotFallThrough(t *testing.T) {
	boom := errors.New("database is on fire")

	t.Run("report attachment lookup error surfaces", func(t *testing.T) {
		svc := NewMediaAccessService(
			noopAttachments{}, noopMessages{}, noopDMs{}, noopPermResolver{},
			&fakeReports{attErr: boom}, &fakeFeedback{}, &fakeUsers{}, &fakePublicAssets{},
		)
		got, err := svc.Authorize(context.Background(), reportAttURL, resolveAnon)
		if !errors.Is(err, boom) {
			t.Fatalf("Authorize error = %v, want boom (decision %v)", err, got)
		}
	})

	t.Run("public-asset lookup error surfaces", func(t *testing.T) {
		svc := NewMediaAccessService(
			noopAttachments{}, noopMessages{}, noopDMs{}, noopPermResolver{},
			&fakeReports{}, &fakeFeedback{}, &fakeUsers{}, &fakePublicAssets{err: boom},
		)
		got, err := svc.Authorize(context.Background(), orphanURL, resolveAnon)
		if !errors.Is(err, boom) {
			t.Fatalf("Authorize error = %v, want boom (decision %v)", err, got)
		}
	})
}
