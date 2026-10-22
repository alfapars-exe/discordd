package services

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
)

type emojiSvcFixture struct {
	repo   *testutil.MockEmojiRepo
	events []ws.Event
	dir    string
	svc    EmojiService
}

func newEmojiSvcFixture(t *testing.T) *emojiSvcFixture {
	t.Helper()
	f := &emojiSvcFixture{repo: &testutil.MockEmojiRepo{}, dir: t.TempDir()}
	hub := &testutil.MockBroadcaster{BroadcastToServerFn: func(_ string, e ws.Event) { f.events = append(f.events, e) }}
	f.svc = NewEmojiService(f.repo, &testutil.MockServerRepo{}, hub, f.dir)
	return f
}

func (f *emojiSvcFixture) emojiFiles(t *testing.T) []string {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(f.dir, emojiSubdir))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		t.Fatalf("read emoji dir: %v", err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

func fillEmojis(f *emojiSvcFixture, serverID string, n int, animated bool) {
	for i := 0; i < n; i++ {
		f.repo.Put(models.ServerEmoji{
			ID: fmt.Sprintf("%s-%v-%03d", serverID, animated, i), ServerID: serverID,
			Name: fmt.Sprintf("e_%v_%03d", animated, i), Animated: animated,
		})
	}
}

var (
	testStaticPNG = []byte("\x89PNG-static")
	testAnimGIF   = []byte("GIF89a-anim")
)

func TestEmojiService_CreateWritesFilesAndBroadcasts(t *testing.T) {
	f := newEmojiSvcFixture(t)
	e, err := f.svc.Create(context.Background(), "srv", "creator", &models.CreateEmojiRequest{Name: "kedi", DisplayName: "Kedi"}, testStaticPNG, testAnimGIF)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if len(e.ID) != 16 {
		t.Errorf("id %q is not 16 hex", e.ID)
	}
	if e.URL != "/api/uploads/emojis/"+e.ID+".png" || e.AnimatedURL == nil || *e.AnimatedURL != "/api/uploads/emojis/"+e.ID+".gif" {
		t.Errorf("urls = %q / %v", e.URL, e.AnimatedURL)
	}
	if !e.Animated || e.CreatedBy == nil || *e.CreatedBy != "creator" {
		t.Errorf("animated=%v created_by=%v", e.Animated, e.CreatedBy)
	}
	got, err := os.ReadFile(filepath.Join(f.dir, emojiSubdir, e.ID+".png"))
	if err != nil || string(got) != string(testStaticPNG) {
		t.Errorf("static file = %q, %v", got, err)
	}
	if len(f.emojiFiles(t)) != 2 {
		t.Errorf("files = %v, want exactly the png + gif (no temp files left)", f.emojiFiles(t))
	}
	if len(f.events) != 1 || f.events[0].Op != ws.OpServerEmojiCreate {
		t.Fatalf("events = %+v, want one server_emoji_create", f.events)
	}
	if d, ok := f.events[0].Data.(models.ServerEmoji); !ok || d.ID != e.ID {
		t.Errorf("create payload = %#v", f.events[0].Data)
	}
}

// TestEmojiService_PerTypeCaps — a full static quota does not block an
// animated upload and vice versa.
func TestEmojiService_PerTypeCaps(t *testing.T) {
	f := newEmojiSvcFixture(t)
	fillEmojis(f, "srv", models.MaxStaticEmojisPerServer, false)
	ctx := context.Background()

	if _, err := f.svc.Create(ctx, "srv", "u", &models.CreateEmojiRequest{Name: "one_more", DisplayName: "x"}, testStaticPNG, nil); !errors.Is(err, models.ErrExpressionLimitReached) {
		t.Fatalf("static over cap: err = %v, want ErrExpressionLimitReached", err)
	}
	if files := f.emojiFiles(t); len(files) != 0 {
		t.Errorf("rejected upload left files behind: %v", files)
	}
	if err := f.svc.PrecheckCreate(ctx, "srv", &models.CreateEmojiRequest{Name: "fresh"}); err != nil {
		t.Errorf("precheck with only the static cap full: %v", err)
	}
	if _, err := f.svc.Create(ctx, "srv", "u", &models.CreateEmojiRequest{Name: "anim", DisplayName: "x"}, testStaticPNG, testAnimGIF); err != nil {
		t.Fatalf("animated with static cap full: %v", err)
	}

	fillEmojis(f, "srv", models.MaxAnimatedEmojisPerServer, true) // overwrites nothing: distinct ids
	if err := f.svc.PrecheckCreate(ctx, "srv", &models.CreateEmojiRequest{Name: "fresh"}); !errors.Is(err, models.ErrExpressionLimitReached) {
		t.Errorf("precheck with both caps full: err = %v", err)
	}
	// Another server is unaffected.
	if err := f.svc.PrecheckCreate(ctx, "other", &models.CreateEmojiRequest{Name: "fresh"}); err != nil {
		t.Errorf("other server precheck: %v", err)
	}
}

func TestEmojiService_NameTaken(t *testing.T) {
	f := newEmojiSvcFixture(t)
	f.repo.Put(models.ServerEmoji{ID: "aaaaaaaaaaaaaaaa", ServerID: "srv", Name: "kedi"})
	ctx := context.Background()
	if err := f.svc.PrecheckCreate(ctx, "srv", &models.CreateEmojiRequest{Name: "kedi"}); !errors.Is(err, models.ErrExpressionNameTaken) {
		t.Errorf("precheck: err = %v", err)
	}
	if _, err := f.svc.Create(ctx, "srv", "u", &models.CreateEmojiRequest{Name: "kedi", DisplayName: "Kedi"}, testStaticPNG, nil); !errors.Is(err, models.ErrExpressionNameTaken) {
		t.Errorf("create: err = %v", err)
	}
	if !errors.Is(models.ErrExpressionNameTaken, pkg.ErrAlreadyExists) {
		t.Error("name taken must map to 409")
	}
	f.repo.Put(models.ServerEmoji{ID: "bbbbbbbbbbbbbbbb", ServerID: "srv", Name: "kopek"})
	taken := "kedi"
	if _, err := f.svc.Update(ctx, "srv", "bbbbbbbbbbbbbbbb", "u", &models.UpdateEmojiRequest{Name: &taken}); !errors.Is(err, models.ErrExpressionNameTaken) {
		t.Errorf("rename onto a taken name: err = %v", err)
	}
}

// TestEmojiService_DBErrorRemovesFiles — a failed insert must not leave the
// already-written files on disk.
func TestEmojiService_DBErrorRemovesFiles(t *testing.T) {
	f := newEmojiSvcFixture(t)
	f.repo.CreateWithCapFn = func(context.Context, *models.ServerEmoji, int) error { return errors.New("db down") }
	if _, err := f.svc.Create(context.Background(), "srv", "u", &models.CreateEmojiRequest{Name: "kedi", DisplayName: "Kedi"}, testStaticPNG, testAnimGIF); err == nil {
		t.Fatal("Create succeeded despite the DB error")
	}
	if files := f.emojiFiles(t); len(files) != 0 {
		t.Errorf("files left after DB error: %v", files)
	}
	if len(f.events) != 0 {
		t.Errorf("broadcast despite failure: %+v", f.events)
	}
}

func TestEmojiService_CrossServerIs404(t *testing.T) {
	f := newEmojiSvcFixture(t)
	f.repo.Put(models.ServerEmoji{ID: "aaaaaaaaaaaaaaaa", ServerID: "srv-a", Name: "kedi"})
	ctx := context.Background()
	dn := "Yeni"
	if _, err := f.svc.Update(ctx, "srv-b", "aaaaaaaaaaaaaaaa", "u", &models.UpdateEmojiRequest{DisplayName: &dn}); !errors.Is(err, pkg.ErrNotFound) {
		t.Errorf("Update cross-server: err = %v, want ErrNotFound", err)
	}
	if err := f.svc.Delete(ctx, "srv-b", "aaaaaaaaaaaaaaaa"); !errors.Is(err, pkg.ErrNotFound) {
		t.Errorf("Delete cross-server: err = %v, want ErrNotFound", err)
	}
	if f.repo.Len() != 1 {
		t.Error("cross-server delete removed the row")
	}
}

func TestEmojiService_CopyableCreatorOnly(t *testing.T) {
	f := newEmojiSvcFixture(t)
	creator := "creator"
	f.repo.Put(models.ServerEmoji{ID: "aaaaaaaaaaaaaaaa", ServerID: "srv", Name: "kedi", CreatedBy: &creator})
	ctx := context.Background()
	on := true

	if _, err := f.svc.Update(ctx, "srv", "aaaaaaaaaaaaaaaa", "admin", &models.UpdateEmojiRequest{Copyable: &on}); !errors.Is(err, models.ErrExpressionLicenseCreatorOnly) {
		t.Fatalf("admin flips copyable: err = %v, want ErrExpressionLicenseCreatorOnly", err)
	}
	if !errors.Is(models.ErrExpressionLicenseCreatorOnly, pkg.ErrForbidden) {
		t.Error("licence error must map to 403")
	}
	// A non-creator may still rename, and resending the unchanged value is fine.
	off := false
	dn := "Kedi 2"
	if _, err := f.svc.Update(ctx, "srv", "aaaaaaaaaaaaaaaa", "admin", &models.UpdateEmojiRequest{DisplayName: &dn, Copyable: &off}); err != nil {
		t.Fatalf("admin rename with unchanged copyable: %v", err)
	}
	e, err := f.svc.Update(ctx, "srv", "aaaaaaaaaaaaaaaa", creator, &models.UpdateEmojiRequest{Copyable: &on})
	if err != nil || !e.Copyable {
		t.Fatalf("creator flips copyable: e=%+v err=%v", e, err)
	}
	last := f.events[len(f.events)-1]
	if d, ok := last.Data.(models.ServerEmoji); last.Op != ws.OpServerEmojiUpdate || !ok || !d.Copyable || d.DisplayName != "Kedi 2" {
		t.Errorf("update event = %+v", last)
	}
}

func TestEmojiService_CopyableOrphanCanOnlyBeSwitchedOff(t *testing.T) {
	f := newEmojiSvcFixture(t)
	f.repo.Put(models.ServerEmoji{ID: "aaaaaaaaaaaaaaaa", ServerID: "srv", Name: "on", Copyable: true})
	f.repo.Put(models.ServerEmoji{ID: "bbbbbbbbbbbbbbbb", ServerID: "srv", Name: "off"})
	ctx := context.Background()
	on, off := true, false

	if _, err := f.svc.Update(ctx, "srv", "bbbbbbbbbbbbbbbb", "admin", &models.UpdateEmojiRequest{Copyable: &on}); !errors.Is(err, models.ErrExpressionLicenseCreatorOnly) {
		t.Errorf("orphan switched on: err = %v, want 403", err)
	}
	if e, err := f.svc.Update(ctx, "srv", "aaaaaaaaaaaaaaaa", "admin", &models.UpdateEmojiRequest{Copyable: &off}); err != nil || e.Copyable {
		t.Errorf("orphan switched off: e=%+v err=%v", e, err)
	}
}

// TestEmojiService_DeleteRemovesFilesAfterRow — the files must still exist
// when the row delete runs, and be gone afterwards.
func TestEmojiService_DeleteRemovesFilesAfterRow(t *testing.T) {
	f := newEmojiSvcFixture(t)
	ctx := context.Background()
	e, err := f.svc.Create(ctx, "srv", "u", &models.CreateEmojiRequest{Name: "kedi", DisplayName: "Kedi"}, testStaticPNG, testAnimGIF)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	pngPath := filepath.Join(f.dir, emojiSubdir, e.ID+".png")
	var existedAtDelete bool
	inner := f.repo
	f.repo.DeleteFn = func(ctx context.Context, serverID, id string) error {
		_, statErr := os.Stat(pngPath)
		existedAtDelete = statErr == nil
		inner.DeleteFn = nil
		return inner.Delete(ctx, serverID, id)
	}

	if err := f.svc.Delete(ctx, "srv", e.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if !existedAtDelete {
		t.Error("files were removed before the DB row")
	}
	if files := f.emojiFiles(t); len(files) != 0 {
		t.Errorf("files left after delete: %v", files)
	}
	last := f.events[len(f.events)-1]
	d, ok := last.Data.(map[string]string)
	if last.Op != ws.OpServerEmojiDelete || !ok || d["id"] != e.ID || d["server_id"] != "srv" {
		t.Errorf("delete event = %+v", last)
	}
}

// TestEmojiService_CreateCloneForcesNotCopyable — a ClonedFrom request
// stores cloned_from and can never produce a copyable row.
func TestEmojiService_CreateCloneForcesNotCopyable(t *testing.T) {
	f := newEmojiSvcFixture(t)
	e, err := f.svc.Create(context.Background(), "srv", "u",
		&models.CreateEmojiRequest{Name: "klon", DisplayName: "Klon", Copyable: true, ClonedFrom: "cccccccccccccccc"}, testStaticPNG, nil)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if e.Copyable || e.ClonedFrom == nil || *e.ClonedFrom != "cccccccccccccccc" {
		t.Errorf("clone = %+v, want copyable false and cloned_from set", e)
	}
	if d, ok := f.events[0].Data.(models.ServerEmoji); !ok || d.ClonedFrom == nil {
		t.Errorf("create payload lost cloned_from: %#v", f.events[0].Data)
	}
}

// TestEmojiService_CloneLicenceLocked — not even the clone's creator may
// change its copyable flag; other edits still work.
func TestEmojiService_CloneLicenceLocked(t *testing.T) {
	f := newEmojiSvcFixture(t)
	creator, src := "creator", "cccccccccccccccc"
	f.repo.Put(models.ServerEmoji{ID: "aaaaaaaaaaaaaaaa", ServerID: "srv", Name: "klon", CreatedBy: &creator, ClonedFrom: &src})
	ctx := context.Background()
	on, off := true, false
	if _, err := f.svc.Update(ctx, "srv", "aaaaaaaaaaaaaaaa", creator, &models.UpdateEmojiRequest{Copyable: &on}); !errors.Is(err, models.ErrExpressionLicenseLocked) {
		t.Errorf("clone copyable: err = %v, want ErrExpressionLicenseLocked", err)
	}
	if !errors.Is(models.ErrExpressionLicenseLocked, pkg.ErrForbidden) {
		t.Error("licence lock must map to 403")
	}
	dn := "Yeni"
	if _, err := f.svc.Update(ctx, "srv", "aaaaaaaaaaaaaaaa", "admin", &models.UpdateEmojiRequest{DisplayName: &dn, Copyable: &off}); err != nil {
		t.Errorf("rename with unchanged copyable: %v", err)
	}
}
