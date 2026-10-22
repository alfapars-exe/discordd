package services

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
)

type stickerSvcFixture struct {
	repo   *testutil.MockStickerRepo
	events []ws.Event
	dir    string
	svc    StickerService
}

func newStickerSvcFixture(t *testing.T) *stickerSvcFixture {
	t.Helper()
	f := &stickerSvcFixture{repo: &testutil.MockStickerRepo{}, dir: t.TempDir()}
	hub := &testutil.MockBroadcaster{BroadcastToServerFn: func(_ string, e ws.Event) { f.events = append(f.events, e) }}
	f.svc = NewStickerService(f.repo, hub, f.dir)
	return f
}

func (f *stickerSvcFixture) stickerFiles(t *testing.T) []string {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(f.dir, stickerSubdir))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		t.Fatalf("read sticker dir: %v", err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

func stickerReq(name string) *models.CreateStickerRequest {
	return &models.CreateStickerRequest{Name: name, DisplayName: name, Tags: []string{"kedi"}, Description: "d"}
}

func TestStickerService_CreateWritesFilesAndBroadcasts(t *testing.T) {
	f := newStickerSvcFixture(t)
	st, err := f.svc.Create(context.Background(), "srv", "creator", stickerReq("kedi"), testPNGBytes, testGIFBytes)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if len(st.ID) != 16 || st.URL != "/api/uploads/stickers/"+st.ID+".png" ||
		st.AnimatedURL == nil || *st.AnimatedURL != "/api/uploads/stickers/"+st.ID+".gif" {
		t.Errorf("id/urls = %q %q %v", st.ID, st.URL, st.AnimatedURL)
	}
	if !st.Animated || st.CreatedBy == nil || *st.CreatedBy != "creator" || st.ClonedFrom != nil ||
		!slices.Equal(st.Tags, []string{"kedi"}) || st.Description != "d" {
		t.Errorf("sticker = %+v", st)
	}
	if files := f.stickerFiles(t); len(files) != 2 {
		t.Errorf("files = %v, want exactly the png + gif", files)
	}
	if len(f.events) != 1 || f.events[0].Op != ws.OpServerStickerCreate {
		t.Fatalf("events = %+v, want one server_sticker_create", f.events)
	}
	if d, ok := f.events[0].Data.(models.ServerSticker); !ok || d.ID != st.ID {
		t.Errorf("create payload = %#v", f.events[0].Data)
	}
}

// TestStickerService_CapIsThirtyTotal — 30 stickers of any mix fill the cap;
// the 31st is refused before (precheck) and at (atomic insert) creation,
// and leaves no files.
func TestStickerService_CapIsThirtyTotal(t *testing.T) {
	f := newStickerSvcFixture(t)
	for i := 0; i < models.MaxStickersPerServer; i++ {
		f.repo.Put(models.ServerSticker{ID: fmt.Sprintf("srv-%03d", i), ServerID: "srv", Name: fmt.Sprintf("s_%03d", i), Animated: i%2 == 0})
	}
	ctx := context.Background()
	if err := f.svc.PrecheckCreate(ctx, "srv", stickerReq("fresh")); !errors.Is(err, models.ErrExpressionLimitReached) {
		t.Errorf("precheck at cap: %v", err)
	}
	if _, err := f.svc.Create(ctx, "srv", "u", stickerReq("fresh"), testPNGBytes, nil); !errors.Is(err, models.ErrExpressionLimitReached) {
		t.Errorf("create at cap: %v", err)
	}
	if files := f.stickerFiles(t); len(files) != 0 {
		t.Errorf("rejected upload left files: %v", files)
	}
	if err := f.svc.PrecheckCreate(ctx, "other", stickerReq("fresh")); err != nil {
		t.Errorf("other server precheck: %v", err)
	}
	if err := f.svc.PrecheckCreate(ctx, "srv", stickerReq("s_001")); err == nil {
		t.Error("precheck accepted a full server")
	}
}

func TestStickerService_NameTaken(t *testing.T) {
	f := newStickerSvcFixture(t)
	f.repo.Put(models.ServerSticker{ID: "aaaaaaaaaaaaaaaa", ServerID: "srv", Name: "kedi"})
	ctx := context.Background()
	if err := f.svc.PrecheckCreate(ctx, "srv", stickerReq("kedi")); !errors.Is(err, models.ErrExpressionNameTaken) {
		t.Errorf("precheck: %v", err)
	}
	if _, err := f.svc.Create(ctx, "srv", "u", stickerReq("kedi"), testPNGBytes, nil); !errors.Is(err, models.ErrExpressionNameTaken) {
		t.Errorf("create: %v", err)
	}
	if files := f.stickerFiles(t); len(files) != 0 {
		t.Errorf("name clash left files: %v", files)
	}
}

func TestStickerService_DBErrorRemovesFiles(t *testing.T) {
	f := newStickerSvcFixture(t)
	f.repo.CreateWithCapFn = func(context.Context, *models.ServerSticker, int) error { return errors.New("db down") }
	if _, err := f.svc.Create(context.Background(), "srv", "u", stickerReq("kedi"), testPNGBytes, testGIFBytes); err == nil {
		t.Fatal("Create succeeded despite the DB error")
	}
	if files := f.stickerFiles(t); len(files) != 0 {
		t.Errorf("files left after DB error: %v", files)
	}
	if len(f.events) != 0 {
		t.Errorf("broadcast despite failure: %+v", f.events)
	}
}

func TestStickerService_CrossServerIs404(t *testing.T) {
	f := newStickerSvcFixture(t)
	f.repo.Put(models.ServerSticker{ID: "aaaaaaaaaaaaaaaa", ServerID: "srv-a", Name: "kedi"})
	ctx := context.Background()
	dn := "Yeni"
	if _, err := f.svc.Update(ctx, "srv-b", "aaaaaaaaaaaaaaaa", "u", &models.UpdateStickerRequest{DisplayName: &dn}); !errors.Is(err, pkg.ErrNotFound) {
		t.Errorf("Update cross-server: %v", err)
	}
	if err := f.svc.Delete(ctx, "srv-b", "aaaaaaaaaaaaaaaa"); !errors.Is(err, pkg.ErrNotFound) {
		t.Errorf("Delete cross-server: %v", err)
	}
	if f.repo.Len() != 1 {
		t.Error("cross-server delete removed the row")
	}
}

func TestStickerService_CopyableRules(t *testing.T) {
	f := newStickerSvcFixture(t)
	creator := "creator"
	src := "cccccccccccccccc"
	f.repo.Put(models.ServerSticker{ID: "aaaaaaaaaaaaaaaa", ServerID: "srv", Name: "kedi", CreatedBy: &creator})
	f.repo.Put(models.ServerSticker{ID: "bbbbbbbbbbbbbbbb", ServerID: "srv", Name: "orphan", Copyable: true})
	f.repo.Put(models.ServerSticker{ID: "dddddddddddddddd", ServerID: "srv", Name: "klon", CreatedBy: &creator, ClonedFrom: &src})
	ctx := context.Background()
	on, off := true, false

	if _, err := f.svc.Update(ctx, "srv", "aaaaaaaaaaaaaaaa", "admin", &models.UpdateStickerRequest{Copyable: &on}); !errors.Is(err, models.ErrExpressionLicenseCreatorOnly) {
		t.Errorf("non-creator flips copyable: %v", err)
	}
	tags := []string{"yeni"}
	if st, err := f.svc.Update(ctx, "srv", "aaaaaaaaaaaaaaaa", "admin", &models.UpdateStickerRequest{Tags: &tags, Copyable: &off}); err != nil || !slices.Equal(st.Tags, tags) {
		t.Errorf("non-creator edits tags with unchanged copyable: %+v, %v", st, err)
	}
	if st, err := f.svc.Update(ctx, "srv", "aaaaaaaaaaaaaaaa", creator, &models.UpdateStickerRequest{Copyable: &on}); err != nil || !st.Copyable {
		t.Errorf("creator flips copyable: %+v, %v", st, err)
	}
	last := f.events[len(f.events)-1]
	if d, ok := last.Data.(models.ServerSticker); last.Op != ws.OpServerStickerUpdate || !ok || !d.Copyable {
		t.Errorf("update event = %+v", last)
	}
	// Orphan (creator deleted): only switching off is allowed.
	if st, err := f.svc.Update(ctx, "srv", "bbbbbbbbbbbbbbbb", "admin", &models.UpdateStickerRequest{Copyable: &off}); err != nil || st.Copyable {
		t.Errorf("orphan switched off: %+v, %v", st, err)
	}
	if _, err := f.svc.Update(ctx, "srv", "bbbbbbbbbbbbbbbb", "admin", &models.UpdateStickerRequest{Copyable: &on}); !errors.Is(err, models.ErrExpressionLicenseCreatorOnly) {
		t.Errorf("orphan switched on: %v", err)
	}
	// A clone is licence-locked even for its creator.
	if _, err := f.svc.Update(ctx, "srv", "dddddddddddddddd", creator, &models.UpdateStickerRequest{Copyable: &on}); !errors.Is(err, models.ErrExpressionLicenseLocked) {
		t.Errorf("clone copyable: %v, want ErrExpressionLicenseLocked", err)
	}
}

func TestStickerService_CreateCloneForcesNotCopyable(t *testing.T) {
	f := newStickerSvcFixture(t)
	req := stickerReq("klon")
	req.Copyable = true
	req.ClonedFrom = "cccccccccccccccc"
	st, err := f.svc.Create(context.Background(), "srv", "u", req, testPNGBytes, nil)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if st.Copyable || st.ClonedFrom == nil || *st.ClonedFrom != "cccccccccccccccc" {
		t.Errorf("clone = %+v, want copyable false and cloned_from set", st)
	}
}

func TestStickerService_DeleteRemovesFilesAfterRow(t *testing.T) {
	f := newStickerSvcFixture(t)
	ctx := context.Background()
	st, err := f.svc.Create(ctx, "srv", "u", stickerReq("kedi"), testPNGBytes, testGIFBytes)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	pngPath := filepath.Join(f.dir, stickerSubdir, st.ID+".png")
	var existedAtDelete bool
	inner := f.repo
	f.repo.DeleteFn = func(ctx context.Context, serverID, id string) error {
		_, statErr := os.Stat(pngPath)
		existedAtDelete = statErr == nil
		inner.DeleteFn = nil
		return inner.Delete(ctx, serverID, id)
	}
	if err := f.svc.Delete(ctx, "srv", st.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if !existedAtDelete {
		t.Error("files were removed before the DB row")
	}
	if files := f.stickerFiles(t); len(files) != 0 {
		t.Errorf("files left after delete: %v", files)
	}
	last := f.events[len(f.events)-1]
	d, ok := last.Data.(map[string]string)
	if last.Op != ws.OpServerStickerDelete || !ok || d["id"] != st.ID || d["server_id"] != "srv" {
		t.Errorf("delete event = %+v", last)
	}
}
