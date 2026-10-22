package services

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
)

const (
	entSrv    = "srv1"
	entVoice  = "voice1"
	entText   = "text1"
	entOther  = "voice-other-server"
	entAlice  = "u-alice"
	entBob    = "u-bob"
	entCarol  = "u-carol"
	entPreset = `{"v":1,"theme":"chime","waveform":"triangle","pitch":3,"duration_ms":800}`
)

// entranceBroadcasts records BroadcastToUsers calls (goroutine-safe).
type entranceBroadcasts struct {
	mu     sync.Mutex
	events []struct {
		to    []string
		event ws.Event
	}
}

func (b *entranceBroadcasts) record(to []string, e ws.Event) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.events = append(b.events, struct {
		to    []string
		event ws.Event
	}{append([]string(nil), to...), e})
}

func (b *entranceBroadcasts) count() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.events)
}

type entranceFixture struct {
	svc       *entranceService
	repo      *testutil.MockEntranceRepo
	sent      *entranceBroadcasts
	uploadDir string
	members   map[string]bool // userID -> member of entSrv
	roles     map[string][]models.Role
	perms     models.Permission
	inChannel map[string]string // userID -> channelID
	now       time.Time
}

func newEntranceFixture(t *testing.T) *entranceFixture {
	t.Helper()
	f := &entranceFixture{
		repo:      &testutil.MockEntranceRepo{},
		sent:      &entranceBroadcasts{},
		uploadDir: t.TempDir(),
		members:   map[string]bool{entAlice: true, entBob: true, entCarol: true},
		roles:     map[string][]models.Role{},
		perms:     models.PermConnectVoice | models.PermUseEntranceSound,
		inChannel: map[string]string{entAlice: entVoice, entBob: entVoice},
		now:       time.Date(2026, 10, 22, 10, 0, 0, 0, time.UTC),
	}
	hub := &testutil.MockBroadcaster{BroadcastToUsersFn: f.sent.record}
	members := &testutil.MockServerRepo{IsMemberFn: func(_ context.Context, serverID, userID string) (bool, error) {
		return serverID == entSrv && f.members[userID], nil
	}}
	roles := &testutil.MockRoleRepo{GetByUserIDAndServerFn: func(_ context.Context, userID, _ string) ([]models.Role, error) {
		return f.roles[userID], nil
	}}
	channels := &testutil.MockChannelRepo{GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
		switch id {
		case entVoice:
			return &models.Channel{ID: id, ServerID: entSrv, Type: models.ChannelTypeVoice}, nil
		case entText:
			return &models.Channel{ID: id, ServerID: entSrv, Type: models.ChannelTypeText}, nil
		case entOther:
			return &models.Channel{ID: id, ServerID: "srv2", Type: models.ChannelTypeVoice}, nil
		}
		return nil, pkg.ErrNotFound
	}}
	perms := &testutil.MockChannelPermResolver{ResolveChannelPermissionsFn: func(context.Context, string, string) (models.Permission, error) {
		return f.perms, nil
	}}
	voice := &testutil.MockVoiceStateGetter{
		GetUserVoiceStateFn: func(userID string) *models.VoiceState {
			if ch, ok := f.inChannel[userID]; ok {
				return &models.VoiceState{UserID: userID, ChannelID: ch, ServerID: entSrv}
			}
			return nil
		},
		GetChannelParticipantsFn: func(channelID string) []models.VoiceState {
			var out []models.VoiceState
			for u, ch := range f.inChannel {
				if ch == channelID {
					out = append(out, models.VoiceState{UserID: u, ChannelID: ch})
				}
			}
			return out
		},
	}
	svc := NewEntranceService(f.repo, members, roles, channels, perms, hub, voice, f.uploadDir).(*entranceService)
	svc.nowFn = func() time.Time { return f.now }
	f.svc = svc
	return f
}

// entranceWav builds a valid mono 24 kHz clip of ms milliseconds with a LIST
// chunk in front, so the canonical output differs from the input.
func entranceWav(ms int) []byte {
	list := entranceChunk("LIST", []byte("INFOISFTtest"))
	return buildEntranceWav(entranceWavSpec{channels: 1, rate: 24000, dataLen: 48 * ms, declared: -1, before: [][]byte{list}})
}

func (f *entranceFixture) upload(t *testing.T, userID string, body []byte) (*models.EntranceSound, error) {
	t.Helper()
	file, header := buildUpload(t, "clip.wav", "audio/wav", body)
	defer file.Close()
	return f.svc.CreateSound(context.Background(), userID, "Davul", file, header)
}

func TestEntranceCreateSound_WritesCanonicalWav(t *testing.T) {
	f := newEntranceFixture(t)
	in := entranceWav(1000) // > 512 bytes: the sniffed prefix must survive (§4 #163)
	if len(in) <= 512 {
		t.Fatalf("fixture too small: %d", len(in))
	}
	s, err := f.upload(t, entAlice, in)
	if err != nil {
		t.Fatalf("CreateSound: %v", err)
	}
	if !entranceSoundURLPattern.MatchString(s.URL) || s.DurationMs != 1000 || s.Name != "Davul" {
		t.Fatalf("sound = %+v", s)
	}
	pcm, ch, rate, _, err := ParsePCMWav(in)
	if err != nil {
		t.Fatalf("ParsePCMWav(fixture): %v", err)
	}
	want := EncodeCanonicalWav(pcm, ch, rate)
	got, err := os.ReadFile(filepath.Join(f.uploadDir, "entrance", s.ID+".wav"))
	if err != nil {
		t.Fatalf("read stored file: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Errorf("stored file (%d bytes) != canonical WAV (%d bytes)", len(got), len(want))
	}
	if s.Size != int64(len(want)) {
		t.Errorf("size = %d, want %d", s.Size, len(want))
	}
}

func TestEntranceCreateSound_Rejections(t *testing.T) {
	f := newEntranceFixture(t)
	mp3 := append([]byte("ID3\x03\x00\x00\x00\x00\x00\x00"), bytes.Repeat([]byte{0xFF, 0xFB, 0x90, 0x64}, 300)...)
	file, header := buildUpload(t, "clip.mp3", "audio/mpeg", mp3)
	if _, err := f.svc.CreateSound(context.Background(), entAlice, "x", file, header); !errors.Is(err, models.ErrEntranceInvalidAudio) {
		t.Errorf("mp3: err = %v, want ErrEntranceInvalidAudio", err)
	}
	if _, err := f.upload(t, entAlice, entranceWav(6000)); !errors.Is(err, models.ErrEntranceDurationInvalid) {
		t.Errorf("6 s clip: err = %v, want ErrEntranceDurationInvalid", err)
	}
	file, header = buildUpload(t, "clip.wav", "audio/wav", entranceWav(1000))
	if _, err := f.svc.CreateSound(context.Background(), entAlice, "bad‮name", file, header); !errors.Is(err, models.ErrEntranceNameInvalid) {
		t.Errorf("steering name: err = %v, want ErrEntranceNameInvalid", err)
	}
	if n := f.repo.SoundCount(); n != 0 {
		t.Errorf("%d rows stored after rejections, want 0", n)
	}
}

func entranceDirFiles(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(dir, "entrance"))
	if err != nil {
		t.Fatalf("read entrance dir: %v", err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

func TestEntranceCreateSound_SixthClipRejectedAndFileRemoved(t *testing.T) {
	f := newEntranceFixture(t)
	for i := 0; i < models.MaxEntranceSoundsPerUser; i++ {
		if _, err := f.upload(t, entAlice, entranceWav(200)); err != nil {
			t.Fatalf("clip %d: %v", i+1, err)
		}
	}
	if _, err := f.upload(t, entAlice, entranceWav(200)); !errors.Is(err, models.ErrEntranceLimitReached) {
		t.Fatalf("6th clip: err = %v, want ErrEntranceLimitReached", err)
	}
	if n := len(entranceDirFiles(t, f.uploadDir)); n != models.MaxEntranceSoundsPerUser {
		t.Errorf("%d files on disk, want %d (the rejected clip's file removed)", n, models.MaxEntranceSoundsPerUser)
	}
}

func TestEntranceCreateSound_DBErrorRemovesFile(t *testing.T) {
	f := newEntranceFixture(t)
	f.repo.CreateSoundWithCapFn = func(context.Context, *models.EntranceSound, int) error {
		return errors.New("db down")
	}
	if _, err := f.upload(t, entAlice, entranceWav(500)); err == nil {
		t.Fatal("expected an error when the insert fails")
	}
	if names := entranceDirFiles(t, f.uploadDir); len(names) != 0 {
		t.Errorf("files left on disk after a failed insert: %v", names)
	}
}

func TestEntranceDeleteSound_RemovesFileAfterRow(t *testing.T) {
	f := newEntranceFixture(t)
	s, err := f.upload(t, entAlice, entranceWav(500))
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	path := filepath.Join(f.uploadDir, "entrance", s.ID+".wav")

	// A failing row delete must leave the file alone.
	f.repo.DeleteSoundFn = func(context.Context, string, string) (string, error) {
		if _, err := os.Stat(path); err != nil {
			t.Errorf("file gone before the row delete ran: %v", err)
		}
		return "", errors.New("db down")
	}
	if err := f.svc.DeleteSound(context.Background(), entAlice, s.ID); err == nil {
		t.Fatal("expected the repo error")
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("file removed although the row delete failed: %v", err)
	}

	f.repo.DeleteSoundFn = nil
	if err := f.svc.DeleteSound(context.Background(), entBob, s.ID); !errors.Is(err, pkg.ErrNotFound) {
		t.Errorf("bob deleting alice's clip: err = %v, want not found", err)
	}
	if err := f.svc.DeleteSound(context.Background(), entAlice, s.ID); err != nil {
		t.Fatalf("DeleteSound: %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("file still on disk after delete (err = %v)", err)
	}
}

func TestEntrancePutSelection(t *testing.T) {
	f := newEntranceFixture(t)
	ctx := context.Background()
	s, err := f.upload(t, entAlice, entranceWav(500))
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	f.repo.PutSound(models.EntranceSound{ID: "b000000000000001", UserID: entBob, URL: "/api/uploads/entrance/b000000000000001.wav"})

	put := func(req models.PutEntranceSelectionRequest) ([]models.EntranceSelection, error) {
		return f.svc.PutSelection(ctx, entAlice, &req)
	}
	if _, err := put(models.PutEntranceSelectionRequest{Scope: "srv-not-mine", Kind: "preset", Preset: []byte(entPreset)}); !errors.Is(err, pkg.ErrNotFound) {
		t.Errorf("non-member server scope: err = %v, want not found", err)
	}
	bobID := "b000000000000001"
	if _, err := put(models.PutEntranceSelectionRequest{Scope: "global", Kind: "clip", SoundID: &bobID}); !errors.Is(err, pkg.ErrNotFound) {
		t.Errorf("someone else's clip: err = %v, want not found", err)
	}
	if _, err := put(models.PutEntranceSelectionRequest{Scope: "global", Kind: "preset", Preset: []byte(`{"v":1,"theme":"siren","waveform":"sine","pitch":0,"duration_ms":800}`)}); !errors.Is(err, models.ErrEntrancePresetInvalid) {
		t.Errorf("bad preset: err = %v, want ErrEntrancePresetInvalid", err)
	}

	if _, err := put(models.PutEntranceSelectionRequest{Scope: "global", Kind: "clip", SoundID: &s.ID}); err != nil {
		t.Fatalf("global clip: %v", err)
	}
	sels, err := put(models.PutEntranceSelectionRequest{Scope: entSrv, Kind: "preset", Preset: []byte(` {"duration_ms":800,"pitch":3,"waveform":"triangle","theme":"chime","v":1}`)})
	if err != nil {
		t.Fatalf("server preset: %v", err)
	}
	if len(sels) != 2 || sels[0].Scope != "global" || sels[0].Kind != "clip" || *sels[0].SoundID != s.ID ||
		sels[1].Scope != entSrv || sels[1].Preset == nil || sels[1].Preset.Pitch != 3 || sels[1].SoundID != nil {
		t.Fatalf("selections = %+v", sels)
	}

	sels, err = put(models.PutEntranceSelectionRequest{Scope: "global", Kind: "none"})
	if err != nil {
		t.Fatalf("none: %v", err)
	}
	if len(sels) != 1 || sels[0].Scope != entSrv {
		t.Errorf("after none: %+v, want only the server row", sels)
	}
}

func TestEntranceSetChannelEnabled(t *testing.T) {
	f := newEntranceFixture(t)
	ctx := context.Background()
	if err := f.svc.SetChannelEnabled(ctx, entSrv, entOther, false); !errors.Is(err, pkg.ErrNotFound) {
		t.Errorf("cross-server channel: err = %v, want not found", err)
	}
	if err := f.svc.SetChannelEnabled(ctx, entSrv, "missing", false); !errors.Is(err, pkg.ErrNotFound) {
		t.Errorf("missing channel: err = %v, want not found", err)
	}
	if err := f.svc.SetChannelEnabled(ctx, entSrv, entText, false); !errors.Is(err, models.ErrEntranceChannelNotVoice) {
		t.Errorf("text channel: err = %v, want ErrEntranceChannelNotVoice", err)
	}
	if err := f.svc.SetChannelEnabled(ctx, entSrv, entVoice, false); err != nil {
		t.Fatalf("disable voice: %v", err)
	}
	got, _ := f.svc.GetServerSettings(ctx, entSrv)
	if !slices.Equal(got.DisabledChannelIDs, []string{entVoice}) {
		t.Errorf("disabled = %v", got.DisabledChannelIDs)
	}
}

func TestEntranceSetMute_Hierarchy(t *testing.T) {
	f := newEntranceFixture(t)
	ctx := context.Background()
	f.roles[entAlice] = []models.Role{{Position: 5}}
	f.roles[entBob] = []models.Role{{Position: 5}}
	f.roles[entCarol] = []models.Role{{Position: 1, IsOwner: true}}

	if err := f.svc.SetMute(ctx, entSrv, entAlice, entAlice, true); !errors.Is(err, models.ErrEntranceSelfMute) || !errors.Is(err, pkg.ErrBadRequest) {
		t.Errorf("self: err = %v, want ErrEntranceSelfMute (400)", err)
	}
	if err := f.svc.SetMute(ctx, entSrv, entAlice, entCarol, true); !errors.Is(err, models.ErrEntranceHierarchy) {
		t.Errorf("owner target: err = %v, want ErrEntranceHierarchy", err)
	}
	if err := f.svc.SetMute(ctx, entSrv, entAlice, entBob, true); !errors.Is(err, models.ErrEntranceHierarchy) {
		t.Errorf("equal position: err = %v, want ErrEntranceHierarchy", err)
	}
	if err := f.svc.SetMute(ctx, entSrv, entAlice, "u-stranger", true); !errors.Is(err, pkg.ErrNotFound) {
		t.Errorf("non-member: err = %v, want not found", err)
	}
	f.roles[entAlice] = []models.Role{{Position: 6}}
	if err := f.svc.SetMute(ctx, entSrv, entAlice, entBob, true); err != nil {
		t.Fatalf("outranking mute: %v", err)
	}
	if ids, _ := f.svc.ListMutes(ctx, entSrv); !slices.Equal(ids, []string{entBob}) {
		t.Errorf("mutes = %v", ids)
	}
	if err := f.svc.SetMute(ctx, entSrv, entAlice, entBob, false); err != nil {
		t.Fatalf("unmute: %v", err)
	}
}

// ─── OnVoiceJoined ───

func (f *entranceFixture) selectPreset(t *testing.T, userID, scope string) {
	t.Helper()
	if _, err := f.svc.PutSelection(context.Background(), userID, &models.PutEntranceSelectionRequest{
		Scope: scope, Kind: "preset", Preset: []byte(entPreset),
	}); err != nil {
		t.Fatalf("PutSelection preset: %v", err)
	}
}

func TestOnVoiceJoined_BroadcastsPresetToParticipantsOnly(t *testing.T) {
	f := newEntranceFixture(t)
	f.inChannel[entCarol] = "some-other-channel"
	f.selectPreset(t, entAlice, "global")

	f.svc.OnVoiceJoined(entAlice, entSrv, entVoice)
	if f.sent.count() != 1 {
		t.Fatalf("broadcasts = %d, want 1", f.sent.count())
	}
	got := f.sent.events[0]
	to := slices.Clone(got.to)
	slices.Sort(to)
	if !slices.Equal(to, []string{entAlice, entBob}) {
		t.Errorf("recipients = %v, want the channel's participants incl. the joiner", to)
	}
	if got.event.Op != ws.OpEntranceSoundPlay {
		t.Errorf("op = %q", got.event.Op)
	}
	ev, ok := got.event.Data.(models.EntranceSoundPlayEvent)
	if !ok {
		t.Fatalf("payload type %T", got.event.Data)
	}
	if ev.Kind != "preset" || ev.SoundURL != "" || ev.Preset == nil || ev.Preset.Theme != "chime" ||
		ev.PlayMs != 800 || ev.UserID != entAlice || ev.ChannelID != entVoice || ev.ServerID != entSrv {
		t.Errorf("event = %+v", ev)
	}
}

func TestOnVoiceJoined_ClipPlayMsCappedByServerMax(t *testing.T) {
	f := newEntranceFixture(t)
	s, err := f.upload(t, entAlice, entranceWav(1800))
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	if _, err := f.svc.PutSelection(context.Background(), entAlice, &models.PutEntranceSelectionRequest{
		Scope: "global", Kind: "clip", SoundID: &s.ID,
	}); err != nil {
		t.Fatalf("PutSelection: %v", err)
	}
	ms := 1000
	if _, err := f.svc.PatchServerSettings(context.Background(), entSrv, &models.PatchServerEntranceSettingsRequest{MaxDurationMs: &ms}); err != nil {
		t.Fatalf("PatchServerSettings: %v", err)
	}

	f.svc.OnVoiceJoined(entAlice, entSrv, entVoice)
	if f.sent.count() != 1 {
		t.Fatalf("broadcasts = %d, want 1", f.sent.count())
	}
	ev := f.sent.events[0].event.Data.(models.EntranceSoundPlayEvent)
	if ev.Kind != "clip" || ev.SoundURL != s.URL || ev.Preset != nil || ev.PlayMs != 1000 {
		t.Errorf("event = %+v, want clip capped at 1000 ms", ev)
	}
}

func TestOnVoiceJoined_ServerSelectionOverridesGlobal(t *testing.T) {
	f := newEntranceFixture(t)
	s, err := f.upload(t, entAlice, entranceWav(300))
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	f.selectPreset(t, entAlice, "global")
	if _, err := f.svc.PutSelection(context.Background(), entAlice, &models.PutEntranceSelectionRequest{
		Scope: entSrv, Kind: "clip", SoundID: &s.ID,
	}); err != nil {
		t.Fatalf("PutSelection: %v", err)
	}
	f.svc.OnVoiceJoined(entAlice, entSrv, entVoice)
	if f.sent.count() != 1 {
		t.Fatalf("broadcasts = %d, want 1", f.sent.count())
	}
	if ev := f.sent.events[0].event.Data.(models.EntranceSoundPlayEvent); ev.Kind != "clip" || ev.PlayMs != 300 {
		t.Errorf("event = %+v, want the server-scoped clip", ev)
	}
}

func TestOnVoiceJoined_Cooldown(t *testing.T) {
	f := newEntranceFixture(t)
	f.selectPreset(t, entAlice, "global")

	f.svc.OnVoiceJoined(entAlice, entSrv, entVoice)
	f.now = f.now.Add(29 * time.Second)
	f.svc.OnVoiceJoined(entAlice, entSrv, entVoice)
	if f.sent.count() != 1 {
		t.Fatalf("broadcasts within 30 s = %d, want 1", f.sent.count())
	}
	f.now = f.now.Add(2 * time.Second) // 31 s after the first play
	f.svc.OnVoiceJoined(entAlice, entSrv, entVoice)
	if f.sent.count() != 2 {
		t.Fatalf("broadcasts after 31 s = %d, want 2", f.sent.count())
	}
}

func TestOnVoiceJoined_SkippedJoinDoesNotStartCooldown(t *testing.T) {
	f := newEntranceFixture(t)
	f.svc.OnVoiceJoined(entAlice, entSrv, entVoice) // no selection yet → nothing
	f.selectPreset(t, entAlice, "global")
	f.svc.OnVoiceJoined(entAlice, entSrv, entVoice)
	if f.sent.count() != 1 {
		t.Fatalf("broadcasts = %d, want 1 (a skipped join must not consume the cooldown)", f.sent.count())
	}
}

func TestOnVoiceJoined_Gates(t *testing.T) {
	cases := map[string]func(f *entranceFixture){
		"server disabled": func(f *entranceFixture) {
			off := false
			_, _ = f.svc.PatchServerSettings(context.Background(), entSrv, &models.PatchServerEntranceSettingsRequest{Enabled: &off})
		},
		"channel disabled": func(f *entranceFixture) {
			_ = f.svc.SetChannelEnabled(context.Background(), entSrv, entVoice, false)
		},
		"muted by a moderator": func(f *entranceFixture) {
			_ = f.repo.SetMute(context.Background(), entSrv, entAlice, true)
		},
		"no permission": func(f *entranceFixture) {
			f.perms = models.PermConnectVoice
		},
		"no selection": func(f *entranceFixture) {
			_ = f.repo.DeleteSelection(context.Background(), entAlice, "")
		},
		"no longer in the channel": func(f *entranceFixture) {
			delete(f.inChannel, entAlice)
		},
		"moved to another channel": func(f *entranceFixture) {
			f.inChannel[entAlice] = "voice2"
		},
		"settings unreadable": func(f *entranceFixture) {
			f.repo.GetServerSettingsFn = func(context.Context, string) (*models.ServerEntranceSettings, error) {
				return nil, errors.New("db down")
			}
		},
	}
	for name, setup := range cases {
		t.Run(name, func(t *testing.T) {
			f := newEntranceFixture(t)
			f.selectPreset(t, entAlice, "global")
			setup(f)
			f.svc.OnVoiceJoined(entAlice, entSrv, entVoice)
			if n := f.sent.count(); n != 0 {
				t.Errorf("broadcasts = %d, want 0", n)
			}
		})
	}
}

func TestOnVoiceJoined_AdminBypassesPermission(t *testing.T) {
	f := newEntranceFixture(t)
	f.perms = models.PermAdmin
	f.selectPreset(t, entAlice, "global")
	f.svc.OnVoiceJoined(entAlice, entSrv, entVoice)
	if f.sent.count() != 1 {
		t.Errorf("broadcasts = %d, want 1 (PermAdmin implies every bit)", f.sent.count())
	}
}

func TestOnVoiceJoined_RejectsUnexpectedClipURL(t *testing.T) {
	f := newEntranceFixture(t)
	f.repo.ResolveSelectionFn = func(context.Context, string, string) (*models.ResolvedEntrance, error) {
		return &models.ResolvedEntrance{Kind: "clip", SoundURL: "/api/uploads/entrance/../avatar.png", DurationMs: 500}, nil
	}
	f.svc.OnVoiceJoined(entAlice, entSrv, entVoice)
	if f.sent.count() != 0 {
		t.Errorf("broadcast an off-pattern clip URL")
	}
}

func TestEntranceCooldownPrune(t *testing.T) {
	f := newEntranceFixture(t)
	for i := 0; i < entranceCooldownPruneAt; i++ {
		f.svc.lastPlayed["old-"+strconv.Itoa(i)] = f.now.Add(-time.Minute)
	}
	if !f.svc.claimCooldown(entAlice) {
		t.Fatal("claimCooldown refused a fresh user")
	}
	if n := len(f.svc.lastPlayed); n != 1 {
		t.Errorf("cooldown map size after prune = %d, want 1", n)
	}
}
