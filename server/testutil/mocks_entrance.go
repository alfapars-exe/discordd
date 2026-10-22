package testutil

import (
	"context"
	"sort"
	"sync"

	"github.com/argeinfina/hichat/models"
)

// MockEntranceRepo satisfies repository.EntranceRepository. A set Fn
// overrides the method; otherwise a small in-memory store with the SQLite
// repo's contract answers (user-scoped sounds, per-user cap, DeleteSound
// also drops the selections using the clip, server row > global row in
// ResolveSelection, default settings {enabled, 5000}, non-nil empty lists).
type MockEntranceRepo struct {
	CreateSoundWithCapFn func(ctx context.Context, s *models.EntranceSound, maxCount int) error
	DeleteSoundFn        func(ctx context.Context, userID, id string) (string, error)
	GetServerSettingsFn  func(ctx context.Context, serverID string) (*models.ServerEntranceSettings, error)
	ResolveSelectionFn   func(ctx context.Context, userID, serverID string) (*models.ResolvedEntrance, error)

	mu         sync.Mutex
	sounds     map[string]models.EntranceSound
	selections map[[2]string]models.EntranceSelectionRow // (user, scope)
	settings   map[string]models.ServerEntranceSettings
	disabled   map[string]string // channel -> server
	mutes      map[[2]string]bool
}

func (m *MockEntranceRepo) init() {
	if m.sounds == nil {
		m.sounds = make(map[string]models.EntranceSound)
		m.selections = make(map[[2]string]models.EntranceSelectionRow)
		m.settings = make(map[string]models.ServerEntranceSettings)
		m.disabled = make(map[string]string)
		m.mutes = make(map[[2]string]bool)
	}
}

// PutSound seeds a clip.
func (m *MockEntranceRepo) PutSound(s models.EntranceSound) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.init()
	m.sounds[s.ID] = s
}

// SoundCount reports how many clips the store holds.
func (m *MockEntranceRepo) SoundCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.sounds)
}

func (m *MockEntranceRepo) CreateSoundWithCap(ctx context.Context, s *models.EntranceSound, maxCount int) error {
	if m.CreateSoundWithCapFn != nil {
		return m.CreateSoundWithCapFn(ctx, s, maxCount)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.init()
	n := 0
	for _, x := range m.sounds {
		if x.UserID == s.UserID {
			n++
		}
	}
	if n >= maxCount {
		return models.ErrEntranceLimitReached
	}
	s.CreatedAt = "2026-10-22T10:00:00Z"
	m.sounds[s.ID] = *s
	return nil
}

func (m *MockEntranceRepo) GetSound(_ context.Context, userID, id string) (*models.EntranceSound, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.init()
	s, ok := m.sounds[id]
	if !ok || s.UserID != userID {
		return nil, models.ErrEntranceSoundNotFound
	}
	return &s, nil
}

func (m *MockEntranceRepo) ListSounds(_ context.Context, userID string) ([]models.EntranceSound, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.init()
	out := []models.EntranceSound{}
	for _, s := range m.sounds {
		if s.UserID == userID {
			out = append(out, s)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func (m *MockEntranceRepo) RenameSound(_ context.Context, userID, id, name string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.init()
	s, ok := m.sounds[id]
	if !ok || s.UserID != userID {
		return models.ErrEntranceSoundNotFound
	}
	s.Name = name
	m.sounds[id] = s
	return nil
}

func (m *MockEntranceRepo) DeleteSound(ctx context.Context, userID, id string) (string, error) {
	if m.DeleteSoundFn != nil {
		return m.DeleteSoundFn(ctx, userID, id)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.init()
	s, ok := m.sounds[id]
	if !ok || s.UserID != userID {
		return "", models.ErrEntranceSoundNotFound
	}
	for k, sel := range m.selections {
		if k[0] == userID && sel.SoundID != nil && *sel.SoundID == id {
			delete(m.selections, k)
		}
	}
	delete(m.sounds, id)
	return s.URL, nil
}

func (m *MockEntranceRepo) FileURLsByUser(_ context.Context, userID string) ([]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.init()
	out := []string{}
	for _, s := range m.sounds {
		if s.UserID == userID {
			out = append(out, s.URL)
		}
	}
	sort.Strings(out)
	return out, nil
}

func (m *MockEntranceRepo) ListSelections(_ context.Context, userID string) ([]models.EntranceSelectionRow, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.init()
	out := []models.EntranceSelectionRow{}
	for k, sel := range m.selections {
		if k[0] == userID {
			out = append(out, sel)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ScopeServerID < out[j].ScopeServerID })
	return out, nil
}

func (m *MockEntranceRepo) UpsertSelection(_ context.Context, row *models.EntranceSelectionRow) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.init()
	r := *row
	r.UpdatedAt = "2026-10-22T10:00:00Z"
	m.selections[[2]string{row.UserID, row.ScopeServerID}] = r
	return nil
}

func (m *MockEntranceRepo) DeleteSelection(_ context.Context, userID, scopeServerID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.init()
	delete(m.selections, [2]string{userID, scopeServerID})
	return nil
}

func (m *MockEntranceRepo) ResolveSelection(ctx context.Context, userID, serverID string) (*models.ResolvedEntrance, error) {
	if m.ResolveSelectionFn != nil {
		return m.ResolveSelectionFn(ctx, userID, serverID)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.init()
	for _, scope := range []string{serverID, ""} {
		sel, ok := m.selections[[2]string{userID, scope}]
		if !ok {
			continue
		}
		if sel.Kind == models.EntranceKindPreset && sel.Preset != nil {
			return &models.ResolvedEntrance{Kind: sel.Kind, Preset: *sel.Preset}, nil
		}
		if sel.SoundID != nil {
			if s, ok := m.sounds[*sel.SoundID]; ok && s.UserID == userID {
				return &models.ResolvedEntrance{Kind: sel.Kind, SoundID: s.ID, SoundURL: s.URL, DurationMs: s.DurationMs}, nil
			}
		}
	}
	return nil, nil
}

func (m *MockEntranceRepo) GetServerSettings(ctx context.Context, serverID string) (*models.ServerEntranceSettings, error) {
	if m.GetServerSettingsFn != nil {
		return m.GetServerSettingsFn(ctx, serverID)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.init()
	if s, ok := m.settings[serverID]; ok {
		s.DisabledChannelIDs = []string{}
		return &s, nil
	}
	return &models.ServerEntranceSettings{
		ServerID: serverID, Enabled: true, MaxDurationMs: models.EntranceMaxDurationMs, DisabledChannelIDs: []string{},
	}, nil
}

func (m *MockEntranceRepo) PatchServerSettings(_ context.Context, serverID string, enabled *bool, maxDurationMs *int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.init()
	s, ok := m.settings[serverID]
	if !ok {
		s = models.ServerEntranceSettings{ServerID: serverID, Enabled: true, MaxDurationMs: models.EntranceMaxDurationMs}
	}
	if enabled != nil {
		s.Enabled = *enabled
	}
	if maxDurationMs != nil {
		s.MaxDurationMs = *maxDurationMs
	}
	m.settings[serverID] = s
	return nil
}

func (m *MockEntranceRepo) ListDisabledChannels(_ context.Context, serverID string) ([]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.init()
	out := []string{}
	for ch, srv := range m.disabled {
		if srv == serverID {
			out = append(out, ch)
		}
	}
	sort.Strings(out)
	return out, nil
}

func (m *MockEntranceRepo) SetChannelDisabled(_ context.Context, serverID, channelID string, disabled bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.init()
	if disabled {
		m.disabled[channelID] = serverID
	} else if m.disabled[channelID] == serverID {
		delete(m.disabled, channelID)
	}
	return nil
}

func (m *MockEntranceRepo) IsChannelDisabled(_ context.Context, channelID string) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.init()
	_, ok := m.disabled[channelID]
	return ok, nil
}

func (m *MockEntranceRepo) ListMutes(_ context.Context, serverID string) ([]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.init()
	out := []string{}
	for k := range m.mutes {
		if k[0] == serverID {
			out = append(out, k[1])
		}
	}
	sort.Strings(out)
	return out, nil
}

func (m *MockEntranceRepo) SetMute(_ context.Context, serverID, userID string, muted bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.init()
	if muted {
		m.mutes[[2]string{serverID, userID}] = true
	} else {
		delete(m.mutes, [2]string{serverID, userID})
	}
	return nil
}

func (m *MockEntranceRepo) IsMuted(_ context.Context, serverID, userID string) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.init()
	return m.mutes[[2]string{serverID, userID}], nil
}
