package services

import (
	"context"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/testutil"
)

// Same shape as models/steering_chars_wiring_test.go, one package over:
// badge and soundboard names are validated inline in the service layer
// rather than in a models.Validate() method, so their wiring lives here.
const spoofedIdentityName = "admin\u202E"

type stubBadgeRepo struct{}

func (stubBadgeRepo) Create(context.Context, *models.Badge) error { return nil }
func (stubBadgeRepo) GetByID(context.Context, string) (*models.Badge, error) {
	return &models.Badge{ID: "b1", Name: "existing"}, nil
}
func (stubBadgeRepo) ListAll(context.Context) ([]models.Badge, error) { return nil, nil }
func (stubBadgeRepo) Update(context.Context, *models.Badge) error     { return nil }
func (stubBadgeRepo) Delete(context.Context, string) error            { return nil }
func (stubBadgeRepo) Assign(context.Context, *models.UserBadge) error { return nil }
func (stubBadgeRepo) Unassign(context.Context, string, string) error  { return nil }
func (stubBadgeRepo) GetUserBadges(context.Context, string) ([]models.UserBadge, error) {
	return nil, nil
}
func (stubBadgeRepo) GetUserBadgesBatch(context.Context, []string) (map[string][]models.UserBadge, error) {
	return nil, nil
}
func (stubBadgeRepo) CountUserBadges(context.Context, string) (int, error) { return 0, nil }

func TestBadgeService_RejectsSteeringCharsInName(t *testing.T) {
	svc := NewBadgeService(stubBadgeRepo{}, &testutil.MockEventPublisher{})

	// Admin authorization for badge mutations is now enforced by the HTTP
	// route's authAdmin middleware chain (init_routes_global.go), not by
	// the service layer, so any caller ID exercises the name-validation
	// path under test here.
	const callerID = "steering-chars-test-caller"

	t.Run("create", func(t *testing.T) {
		req := &models.CreateBadgeRequest{Name: spoofedIdentityName, IconType: "builtin", Color1: "#fff"}
		if _, err := svc.CreateBadge(context.Background(), callerID, req); err == nil {
			t.Fatal("spoofed badge name should be rejected")
		}
	})

	t.Run("update", func(t *testing.T) {
		req := &models.CreateBadgeRequest{Name: spoofedIdentityName, IconType: "builtin", Color1: "#fff"}
		if _, err := svc.UpdateBadge(context.Background(), callerID, "b1", req); err == nil {
			t.Fatal("spoofed badge name should be rejected")
		}
	})
}

func TestSoundboardService_RejectsSteeringCharsInName(t *testing.T) {
	t.Run("create", func(t *testing.T) {
		// Must be a real, accepted audio upload (audio/ogg + OGG magic bytes).
		// An earlier version of this test used a PNG here, which
		// validateSoundUpload rejects on its own ("file contents are not
		// audio") regardless of the name -- that made the assertion pass
		// whether or not the steering-char check on req.Name existed at all.
		// Mutation testing caught it: removing the name check left this
		// subtest green. A vacuous assertion is worse than no assertion,
		// since it reads as coverage that isn't there.
		repo := &testutil.MockSoundboardRepo{}
		svc := newTestSoundboardService(repo, t.TempDir())
		file, fh := buildUpload(t, "sound.ogg", "audio/ogg", oggMagic)
		defer func() { _ = file.Close() }()

		emoji := "🔊"
		req := &models.CreateSoundboardSoundRequest{Name: spoofedIdentityName, Emoji: &emoji}
		_, err := svc.Create(context.Background(), "srv1", "user1", req, file, fh, 1000)
		if err == nil {
			t.Fatal("spoofed soundboard name should be rejected")
		}
		if strings.Contains(err.Error(), "audio") {
			t.Fatalf("rejected for the wrong reason (upload/MIME, not name): %v", err)
		}
	})

	t.Run("update", func(t *testing.T) {
		repo := &testutil.MockSoundboardRepo{
			GetByIDFn: func(_ context.Context, _ string) (*models.SoundboardSound, error) {
				return &models.SoundboardSound{ID: "s1", ServerID: "srv1"}, nil
			},
		}
		svc := newTestSoundboardService(repo, t.TempDir())

		name := spoofedIdentityName
		_, err := svc.Update(context.Background(), "srv1", "s1", &models.UpdateSoundboardSoundRequest{Name: &name})
		if err == nil {
			t.Fatal("spoofed soundboard name should be rejected")
		}
	})
}
