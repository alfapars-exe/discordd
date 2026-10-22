package testutil

import (
	"context"
	"fmt"
	"sort"
	"sync"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

// MockEmojiRepo satisfies repository.EmojiRepository. A set Fn overrides
// the method; a nil Fn falls back to a small in-memory store with the same
// contract as the SQLite repo (per-type cap, UNIQUE (server_id, name),
// server-scoped GetInServer/Update/Delete, non-nil empty lists).
// ListForUser has no membership data, so its default returns no rows.
type MockEmojiRepo struct {
	CreateWithCapFn func(ctx context.Context, e *models.ServerEmoji, maxForType int) error
	GetByIDFn       func(ctx context.Context, id string) (*models.ServerEmoji, error)
	GetInServerFn   func(ctx context.Context, serverID, id string) (*models.ServerEmoji, error)
	ListByServerFn  func(ctx context.Context, serverID string) ([]models.ServerEmoji, error)
	ListForUserFn   func(ctx context.Context, userID string) ([]models.ServerEmoji, error)
	CountByServerFn func(ctx context.Context, serverID string) (int, int, error)
	UpdateFn        func(ctx context.Context, e *models.ServerEmoji) error
	DeleteFn        func(ctx context.Context, serverID, id string) error

	mu   sync.Mutex
	rows map[string]models.ServerEmoji
}

// Put seeds the in-memory store.
func (m *MockEmojiRepo) Put(e models.ServerEmoji) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.rows == nil {
		m.rows = make(map[string]models.ServerEmoji)
	}
	m.rows[e.ID] = e
}

// Len reports how many rows the in-memory store holds.
func (m *MockEmojiRepo) Len() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.rows)
}

func (m *MockEmojiRepo) nameTaken(serverID, name, exceptID string) bool {
	for _, r := range m.rows {
		if r.ServerID == serverID && r.Name == name && r.ID != exceptID {
			return true
		}
	}
	return false
}

func (m *MockEmojiRepo) CreateWithCap(ctx context.Context, e *models.ServerEmoji, maxForType int) error {
	if m.CreateWithCapFn != nil {
		return m.CreateWithCapFn(ctx, e, maxForType)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.rows == nil {
		m.rows = make(map[string]models.ServerEmoji)
	}
	n := 0
	for _, r := range m.rows {
		if r.ServerID == e.ServerID && r.Animated == e.Animated {
			n++
		}
	}
	if n >= maxForType {
		return models.ErrExpressionLimitReached
	}
	if m.nameTaken(e.ServerID, e.Name, "") {
		return fmt.Errorf("%w: emoji name taken", pkg.ErrAlreadyExists)
	}
	e.CreatedAt = "2026-10-22T10:00:00Z"
	m.rows[e.ID] = *e
	return nil
}

func (m *MockEmojiRepo) GetByID(ctx context.Context, id string) (*models.ServerEmoji, error) {
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

func (m *MockEmojiRepo) GetInServer(ctx context.Context, serverID, id string) (*models.ServerEmoji, error) {
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

func (m *MockEmojiRepo) ListByServer(ctx context.Context, serverID string) ([]models.ServerEmoji, error) {
	if m.ListByServerFn != nil {
		return m.ListByServerFn(ctx, serverID)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []models.ServerEmoji{}
	for _, r := range m.rows {
		if r.ServerID == serverID {
			out = append(out, r)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func (m *MockEmojiRepo) ListForUser(ctx context.Context, userID string) ([]models.ServerEmoji, error) {
	if m.ListForUserFn != nil {
		return m.ListForUserFn(ctx, userID)
	}
	return []models.ServerEmoji{}, nil
}

func (m *MockEmojiRepo) CountByServer(ctx context.Context, serverID string) (int, int, error) {
	if m.CountByServerFn != nil {
		return m.CountByServerFn(ctx, serverID)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	var static, animated int
	for _, r := range m.rows {
		if r.ServerID != serverID {
			continue
		}
		if r.Animated {
			animated++
		} else {
			static++
		}
	}
	return static, animated, nil
}

func (m *MockEmojiRepo) Update(ctx context.Context, e *models.ServerEmoji) error {
	if m.UpdateFn != nil {
		return m.UpdateFn(ctx, e)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.rows[e.ID]
	if !ok || r.ServerID != e.ServerID {
		return pkg.ErrNotFound
	}
	if m.nameTaken(e.ServerID, e.Name, e.ID) {
		return fmt.Errorf("%w: emoji name taken", pkg.ErrAlreadyExists)
	}
	r.Name, r.DisplayName, r.Copyable = e.Name, e.DisplayName, e.Copyable
	m.rows[e.ID] = r
	return nil
}

func (m *MockEmojiRepo) Delete(ctx context.Context, serverID, id string) error {
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
