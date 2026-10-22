package testutil

import (
	"context"
	"fmt"
	"sort"
	"sync"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

// MockStickerRepo satisfies repository.StickerRepository. A set Fn overrides
// the method; a nil Fn falls back to a small in-memory store with the same
// contract as the SQLite repo (one cap for both types, UNIQUE (server_id,
// name), server-scoped GetInServer/Update/Delete, non-nil empty lists).
// ListForUser has no membership data, so its default returns no rows.
type MockStickerRepo struct {
	CreateWithCapFn func(ctx context.Context, s *models.ServerSticker, maxCount int) error
	GetByIDFn       func(ctx context.Context, id string) (*models.ServerSticker, error)
	GetInServerFn   func(ctx context.Context, serverID, id string) (*models.ServerSticker, error)
	ListByServerFn  func(ctx context.Context, serverID string) ([]models.ServerSticker, error)
	ListForUserFn   func(ctx context.Context, userID string) ([]models.ServerSticker, error)
	CountByServerFn func(ctx context.Context, serverID string) (int, error)
	UpdateFn        func(ctx context.Context, s *models.ServerSticker) error
	DeleteFn        func(ctx context.Context, serverID, id string) error

	mu   sync.Mutex
	rows map[string]models.ServerSticker
}

// Put seeds the in-memory store.
func (m *MockStickerRepo) Put(s models.ServerSticker) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.rows == nil {
		m.rows = make(map[string]models.ServerSticker)
	}
	if s.Tags == nil {
		s.Tags = []string{}
	}
	m.rows[s.ID] = s
}

// Len reports how many rows the in-memory store holds.
func (m *MockStickerRepo) Len() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.rows)
}

func (m *MockStickerRepo) nameTaken(serverID, name, exceptID string) bool {
	for _, r := range m.rows {
		if r.ServerID == serverID && r.Name == name && r.ID != exceptID {
			return true
		}
	}
	return false
}

func (m *MockStickerRepo) CreateWithCap(ctx context.Context, s *models.ServerSticker, maxCount int) error {
	if m.CreateWithCapFn != nil {
		return m.CreateWithCapFn(ctx, s, maxCount)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.rows == nil {
		m.rows = make(map[string]models.ServerSticker)
	}
	n := 0
	for _, r := range m.rows {
		if r.ServerID == s.ServerID {
			n++
		}
	}
	if n >= maxCount {
		return models.ErrExpressionLimitReached
	}
	if m.nameTaken(s.ServerID, s.Name, "") {
		return fmt.Errorf("%w: sticker name taken", pkg.ErrAlreadyExists)
	}
	if s.Tags == nil {
		s.Tags = []string{}
	}
	s.CreatedAt = "2026-10-22T10:00:00Z"
	m.rows[s.ID] = *s
	return nil
}

func (m *MockStickerRepo) GetByID(ctx context.Context, id string) (*models.ServerSticker, error) {
	if m.GetByIDFn != nil {
		return m.GetByIDFn(ctx, id)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.rows[id]
	if !ok {
		return nil, pkg.ErrNotFound
	}
	return &r, nil
}

func (m *MockStickerRepo) GetInServer(ctx context.Context, serverID, id string) (*models.ServerSticker, error) {
	if m.GetInServerFn != nil {
		return m.GetInServerFn(ctx, serverID, id)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.rows[id]
	if !ok || r.ServerID != serverID {
		return nil, pkg.ErrNotFound
	}
	return &r, nil
}

func (m *MockStickerRepo) ListByServer(ctx context.Context, serverID string) ([]models.ServerSticker, error) {
	if m.ListByServerFn != nil {
		return m.ListByServerFn(ctx, serverID)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []models.ServerSticker{}
	for _, r := range m.rows {
		if r.ServerID == serverID {
			out = append(out, r)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func (m *MockStickerRepo) ListForUser(ctx context.Context, userID string) ([]models.ServerSticker, error) {
	if m.ListForUserFn != nil {
		return m.ListForUserFn(ctx, userID)
	}
	return []models.ServerSticker{}, nil
}

func (m *MockStickerRepo) CountByServer(ctx context.Context, serverID string) (int, error) {
	if m.CountByServerFn != nil {
		return m.CountByServerFn(ctx, serverID)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	n := 0
	for _, r := range m.rows {
		if r.ServerID == serverID {
			n++
		}
	}
	return n, nil
}

func (m *MockStickerRepo) Update(ctx context.Context, s *models.ServerSticker) error {
	if m.UpdateFn != nil {
		return m.UpdateFn(ctx, s)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.rows[s.ID]
	if !ok || r.ServerID != s.ServerID {
		return pkg.ErrNotFound
	}
	if m.nameTaken(s.ServerID, s.Name, s.ID) {
		return fmt.Errorf("%w: sticker name taken", pkg.ErrAlreadyExists)
	}
	r.Name, r.DisplayName, r.Description, r.Tags, r.Copyable = s.Name, s.DisplayName, s.Description, s.Tags, s.Copyable
	m.rows[s.ID] = r
	return nil
}

func (m *MockStickerRepo) Delete(ctx context.Context, serverID, id string) error {
	if m.DeleteFn != nil {
		return m.DeleteFn(ctx, serverID, id)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.rows[id]
	if !ok || r.ServerID != serverID {
		return pkg.ErrNotFound
	}
	delete(m.rows, id)
	return nil
}
