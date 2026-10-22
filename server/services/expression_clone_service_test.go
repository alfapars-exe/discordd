// ExpressionCloneService over the REAL EmojiService / StickerService, mock
// repos and a temp upload dir: the copy must be byte-identical, get a new
// id/URL, be licence-locked and land in the target server.
package services

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
)

const (
	cloneSrcServer    = "src-srv"
	cloneTargetServer = "dst-srv"
	cloneMember       = "alice" // member of both servers
	cloneOutsider     = "mallory"
)

type cloneFixture struct {
	dir         string
	emojiRepo   *testutil.MockEmojiRepo
	stickerRepo *testutil.MockStickerRepo
	events      []struct {
		server string
		ev     ws.Event
	}
	svc ExpressionCloneService
}

func newCloneFixture(t *testing.T) *cloneFixture {
	t.Helper()
	f := &cloneFixture{dir: t.TempDir(), emojiRepo: &testutil.MockEmojiRepo{}, stickerRepo: &testutil.MockStickerRepo{}}
	hub := &testutil.MockBroadcaster{BroadcastToServerFn: func(serverID string, e ws.Event) {
		f.events = append(f.events, struct {
			server string
			ev     ws.Event
		}{serverID, e})
	}}
	members := &testutil.MockServerRepo{IsMemberFn: func(_ context.Context, _, userID string) (bool, error) {
		return userID == cloneMember, nil
	}}
	emojiSvc := NewEmojiService(f.emojiRepo, members, hub, f.dir)
	stickerSvc := NewStickerService(f.stickerRepo, hub, f.dir)
	f.svc = NewExpressionCloneService(f.emojiRepo, emojiSvc, f.stickerRepo, stickerSvc, members, f.dir)
	return f
}

// writeFile stores data under uploadDir/subdir/name.
func (f *cloneFixture) writeFile(t *testing.T, subdir, name string, data []byte) {
	t.Helper()
	dir := filepath.Join(f.dir, subdir)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func (f *cloneFixture) countFiles(t *testing.T, subdir string) int {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(f.dir, subdir))
	if errors.Is(err, os.ErrNotExist) {
		return 0
	}
	if err != nil {
		t.Fatal(err)
	}
	return len(entries)
}

const srcEmojiID = "aaaaaaaaaaaaaaaa"

// putSourceEmoji seeds a copyable emoji in the source server with its file(s).
func (f *cloneFixture) putSourceEmoji(t *testing.T, copyable, animated bool) models.ServerEmoji {
	t.Helper()
	creator := "carol"
	e := models.ServerEmoji{
		ID: srcEmojiID, ServerID: cloneSrcServer, Name: "kedi", DisplayName: "Kedi",
		URL: "/api/uploads/emojis/" + srcEmojiID + ".png", Copyable: copyable, CreatedBy: &creator, Animated: animated,
	}
	f.writeFile(t, emojiSubdir, srcEmojiID+".png", testPNGBytes)
	if animated {
		u := "/api/uploads/emojis/" + srcEmojiID + ".gif"
		e.AnimatedURL = &u
		f.writeFile(t, emojiSubdir, srcEmojiID+".gif", testGIFBytes)
	}
	f.emojiRepo.Put(e)
	return e
}

func cloneReq(id string) *models.CloneExpressionRequest {
	return &models.CloneExpressionRequest{SourceID: id}
}

func TestCloneEmoji_Success(t *testing.T) {
	f := newCloneFixture(t)
	f.putSourceEmoji(t, true, true)

	got, err := f.svc.CloneEmoji(context.Background(), cloneTargetServer, cloneMember, cloneReq(srcEmojiID))
	if err != nil {
		t.Fatalf("CloneEmoji: %v", err)
	}
	if got.ID == srcEmojiID || got.ServerID != cloneTargetServer || got.Name != "kedi" || got.DisplayName != "Kedi" {
		t.Errorf("clone = %+v", got)
	}
	if got.Copyable || got.ClonedFrom == nil || *got.ClonedFrom != srcEmojiID ||
		got.CreatedBy == nil || *got.CreatedBy != cloneMember || !got.Animated {
		t.Errorf("clone licence/owner = %+v", got)
	}
	if got.URL != "/api/uploads/emojis/"+got.ID+".png" || got.AnimatedURL == nil || *got.AnimatedURL != "/api/uploads/emojis/"+got.ID+".gif" {
		t.Errorf("clone urls = %q, %v", got.URL, got.AnimatedURL)
	}
	png, _ := os.ReadFile(filepath.Join(f.dir, emojiSubdir, got.ID+".png"))
	gif, _ := os.ReadFile(filepath.Join(f.dir, emojiSubdir, got.ID+".gif"))
	if !bytes.Equal(png, testPNGBytes) || !bytes.Equal(gif, testGIFBytes) {
		t.Error("cloned files are not byte-identical copies of the source")
	}
	if len(f.events) != 1 || f.events[0].server != cloneTargetServer || f.events[0].ev.Op != ws.OpServerEmojiCreate {
		t.Errorf("events = %+v, want one server_emoji_create to the target", f.events)
	}
}

// TestCloneEmoji_NotMemberIsNotFound — a missing source and a source in a
// server the caller is not in must be indistinguishable (same error, same
// text).
func TestCloneEmoji_NotMemberIsNotFound(t *testing.T) {
	f := newCloneFixture(t)
	f.putSourceEmoji(t, true, false)
	ctx := context.Background()

	_, missing := f.svc.CloneEmoji(ctx, cloneTargetServer, cloneMember, cloneReq("ffffffffffffffff"))
	_, outsider := f.svc.CloneEmoji(ctx, cloneTargetServer, cloneOutsider, cloneReq(srcEmojiID))
	if !errors.Is(missing, models.ErrExpressionNotFound) || !errors.Is(outsider, models.ErrExpressionNotFound) {
		t.Fatalf("missing = %v, outsider = %v — want ErrExpressionNotFound for both", missing, outsider)
	}
	if missing.Error() != outsider.Error() {
		t.Errorf("error text differs: %q vs %q", missing.Error(), outsider.Error())
	}
}

func TestCloneEmoji_Gates(t *testing.T) {
	ctx := context.Background()

	t.Run("same server", func(t *testing.T) {
		f := newCloneFixture(t)
		f.putSourceEmoji(t, true, false)
		if _, err := f.svc.CloneEmoji(ctx, cloneSrcServer, cloneMember, cloneReq(srcEmojiID)); !errors.Is(err, models.ErrExpressionCloneSameServer) {
			t.Errorf("err = %v, want ErrExpressionCloneSameServer", err)
		}
	})
	t.Run("not copyable", func(t *testing.T) {
		f := newCloneFixture(t)
		f.putSourceEmoji(t, false, false)
		if _, err := f.svc.CloneEmoji(ctx, cloneTargetServer, cloneMember, cloneReq(srcEmojiID)); !errors.Is(err, models.ErrExpressionNotCopyable) {
			t.Errorf("err = %v, want ErrExpressionNotCopyable", err)
		}
	})
	t.Run("clone of a clone", func(t *testing.T) {
		f := newCloneFixture(t)
		f.putSourceEmoji(t, true, false)
		first, err := f.svc.CloneEmoji(ctx, cloneTargetServer, cloneMember, cloneReq(srcEmojiID))
		if err != nil {
			t.Fatalf("first clone: %v", err)
		}
		if _, err := f.svc.CloneEmoji(ctx, "third-srv", cloneMember, cloneReq(first.ID)); !errors.Is(err, models.ErrExpressionNotCopyable) {
			t.Errorf("err = %v, want ErrExpressionNotCopyable", err)
		}
	})
	t.Run("source file missing", func(t *testing.T) {
		f := newCloneFixture(t)
		f.putSourceEmoji(t, true, false)
		if err := os.Remove(filepath.Join(f.dir, emojiSubdir, srcEmojiID+".png")); err != nil {
			t.Fatal(err)
		}
		if _, err := f.svc.CloneEmoji(ctx, cloneTargetServer, cloneMember, cloneReq(srcEmojiID)); !errors.Is(err, models.ErrExpressionNotFound) {
			t.Errorf("err = %v, want ErrExpressionNotFound", err)
		}
		if f.emojiRepo.Len() != 1 {
			t.Error("a row was created without a source file")
		}
	})
	t.Run("target at cap leaves no files", func(t *testing.T) {
		f := newCloneFixture(t)
		f.putSourceEmoji(t, true, false)
		f.emojiRepo.CountByServerFn = func(context.Context, string) (int, int, error) { return 0, 0, nil } // let the precheck pass
		f.emojiRepo.CreateWithCapFn = func(context.Context, *models.ServerEmoji, int) error { return models.ErrExpressionLimitReached }
		if _, err := f.svc.CloneEmoji(ctx, cloneTargetServer, cloneMember, cloneReq(srcEmojiID)); !errors.Is(err, models.ErrExpressionLimitReached) {
			t.Errorf("err = %v, want ErrExpressionLimitReached", err)
		}
		if n := f.countFiles(t, emojiSubdir); n != 1 {
			t.Errorf("emoji dir holds %d files, want only the source", n)
		}
	})
	t.Run("name taken then renamed", func(t *testing.T) {
		f := newCloneFixture(t)
		f.putSourceEmoji(t, true, false)
		f.emojiRepo.Put(models.ServerEmoji{ID: "bbbbbbbbbbbbbbbb", ServerID: cloneTargetServer, Name: "kedi"})
		if _, err := f.svc.CloneEmoji(ctx, cloneTargetServer, cloneMember, cloneReq(srcEmojiID)); !errors.Is(err, models.ErrExpressionNameTaken) {
			t.Errorf("err = %v, want ErrExpressionNameTaken", err)
		}
		name := "kedi_kopya"
		got, err := f.svc.CloneEmoji(ctx, cloneTargetServer, cloneMember, &models.CloneExpressionRequest{SourceID: srcEmojiID, Name: &name})
		if err != nil || got.Name != "kedi_kopya" {
			t.Errorf("renamed clone = %+v, %v", got, err)
		}
	})
}

const srcStickerID = "abababababababab"

func (f *cloneFixture) putSourceSticker(t *testing.T, copyable, animated bool) {
	t.Helper()
	creator := "carol"
	s := models.ServerSticker{
		ID: srcStickerID, ServerID: cloneSrcServer, Name: "mutlu_kedi", DisplayName: "Mutlu Kedi",
		Description: "kedi", Tags: []string{"kedi", "mutlu"},
		URL: "/api/uploads/stickers/" + srcStickerID + ".png", Copyable: copyable, CreatedBy: &creator, Animated: animated,
	}
	f.writeFile(t, stickerSubdir, srcStickerID+".png", testPNGBytes)
	if animated {
		u := "/api/uploads/stickers/" + srcStickerID + ".gif"
		s.AnimatedURL = &u
		f.writeFile(t, stickerSubdir, srcStickerID+".gif", testGIFBytes)
	}
	f.stickerRepo.Put(s)
}

func TestCloneSticker_Success(t *testing.T) {
	f := newCloneFixture(t)
	f.putSourceSticker(t, true, true)

	got, err := f.svc.CloneSticker(context.Background(), cloneTargetServer, cloneMember, cloneReq(srcStickerID))
	if err != nil {
		t.Fatalf("CloneSticker: %v", err)
	}
	if got.ID == srcStickerID || got.ServerID != cloneTargetServer || got.Name != "mutlu_kedi" ||
		got.Description != "kedi" || len(got.Tags) != 2 || got.Copyable || got.ClonedFrom == nil ||
		*got.ClonedFrom != srcStickerID || got.CreatedBy == nil || *got.CreatedBy != cloneMember {
		t.Errorf("clone = %+v", got)
	}
	png, _ := os.ReadFile(filepath.Join(f.dir, stickerSubdir, got.ID+".png"))
	gif, _ := os.ReadFile(filepath.Join(f.dir, stickerSubdir, got.ID+".gif"))
	if !bytes.Equal(png, testPNGBytes) || !bytes.Equal(gif, testGIFBytes) {
		t.Error("cloned sticker files are not byte-identical copies")
	}
	if len(f.events) != 1 || f.events[0].server != cloneTargetServer || f.events[0].ev.Op != ws.OpServerStickerCreate {
		t.Errorf("events = %+v", f.events)
	}
}

func TestCloneSticker_Gates(t *testing.T) {
	ctx := context.Background()

	f := newCloneFixture(t)
	f.putSourceSticker(t, false, false)
	if _, err := f.svc.CloneSticker(ctx, cloneTargetServer, cloneMember, cloneReq(srcStickerID)); !errors.Is(err, models.ErrExpressionNotCopyable) {
		t.Errorf("not copyable: %v", err)
	}
	if _, err := f.svc.CloneSticker(ctx, cloneTargetServer, cloneOutsider, cloneReq(srcStickerID)); !errors.Is(err, models.ErrExpressionNotFound) {
		t.Errorf("outsider: %v", err)
	}
	if _, err := f.svc.CloneSticker(ctx, cloneSrcServer, cloneMember, cloneReq(srcStickerID)); !errors.Is(err, models.ErrExpressionCloneSameServer) {
		t.Errorf("same server: %v", err)
	}

	full := newCloneFixture(t)
	full.putSourceSticker(t, true, false)
	full.stickerRepo.CreateWithCapFn = func(context.Context, *models.ServerSticker, int) error { return models.ErrExpressionLimitReached }
	if _, err := full.svc.CloneSticker(ctx, cloneTargetServer, cloneMember, cloneReq(srcStickerID)); !errors.Is(err, models.ErrExpressionLimitReached) {
		t.Errorf("target full: %v", err)
	}
	if n := full.countFiles(t, stickerSubdir); n != 1 {
		t.Errorf("sticker dir holds %d files, want only the source", n)
	}
}
