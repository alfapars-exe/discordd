package services

import (
	"context"
	"errors"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
)

// Remove-only path: a custom-emoji reaction whose emoji no longer validates
// (deleted, or the user left its server) can be taken back through the
// delete-only RemoveReaction, never added, and never via Toggle.

const goneEmojiKey = "<:fedcba9876543210>" // not in newReactionResolver's repo

// reactionStore is a tiny (user, key) set behind the RemoveReaction /
// Toggle mock hooks; toggles counts Toggle calls so tests can prove the
// remove-only path never reaches it.
type reactionStore struct {
	rows    map[[2]string]bool
	toggles int
}

func newReactionStore(rows ...[2]string) *reactionStore {
	s := &reactionStore{rows: map[[2]string]bool{}}
	for _, r := range rows {
		s.rows[r] = true
	}
	return s
}

func (s *reactionStore) remove(_ context.Context, _, userID, key string) (bool, error) {
	k := [2]string{userID, key}
	if !s.rows[k] {
		return false, nil
	}
	delete(s.rows, k)
	return true, nil
}

func (s *reactionStore) toggle(_ context.Context, _, _, _ string) (bool, error) {
	s.toggles++
	return true, nil
}

func removeOnlyChannelService(store *reactionStore, perms models.Permission, events *[]ws.Event) ReactionService {
	hub := &testutil.MockBroadcastAndOnline{
		MockBroadcaster: testutil.MockBroadcaster{
			BroadcastToUsersFn: func(_ []string, e ws.Event) { *events = append(*events, e) },
		},
		GetOnlineUserIDsForServerFn: func(string) []string { return []string{reactMember} },
	}
	resolver := &testutil.MockChannelPermResolver{
		ResolveChannelPermissionsFn: func(_ context.Context, _, _ string) (models.Permission, error) { return perms, nil },
		ResolveChannelPermissionsBulkFn: func(_ context.Context, _ string, ids []string) (map[string]models.Permission, error) {
			out := map[string]models.Permission{}
			for _, id := range ids {
				out[id] = perms
			}
			return out, nil
		},
	}
	svc := NewReactionService(
		&testutil.MockReactionRepo{ToggleFn: store.toggle, RemoveReactionFn: store.remove},
		&testutil.MockMessageRepo{GetByIDFn: func(_ context.Context, _ string) (*models.Message, error) {
			return &models.Message{ID: "m1", ChannelID: "ch1"}, nil
		}},
		&testutil.MockChannelRepo{GetByIDFn: func(_ context.Context, _ string) (*models.Channel, error) {
			return &models.Channel{ID: "ch1", ServerID: "srv1"}, nil
		}},
		hub, resolver, nil,
	)
	svc.SetEmojiResolver(newReactionResolver())
	return svc
}

func TestReactionEmoji_Channel_RemoveOnly(t *testing.T) {
	readPerms := models.PermViewChannel | models.PermReadMessages
	ctx := context.Background()

	t.Run("deleted emoji: own reaction can be removed", func(t *testing.T) {
		store := newReactionStore([2]string{reactMember, goneEmojiKey})
		var events []ws.Event
		svc := removeOnlyChannelService(store, readPerms, &events)
		if err := svc.ToggleReaction(ctx, "srv1", "m1", reactMember, goneEmojiKey); err != nil {
			t.Fatalf("remove: %v", err)
		}
		if len(store.rows) != 0 || store.toggles != 0 {
			t.Errorf("rows=%v toggles=%d, want removed via RemoveReaction only", store.rows, store.toggles)
		}
		if len(events) != 1 || events[0].Op != ws.OpReactionUpdate {
			t.Fatalf("events = %+v, want one reaction_update", events)
		}
		if d, _ := events[0].Data.(map[string]any); d["added"] != false {
			t.Errorf("broadcast added = %v, want false", d["added"])
		}
	})

	t.Run("left the server: own reaction can be removed", func(t *testing.T) {
		key := "<:" + reactEmojiID + ">"
		store := newReactionStore([2]string{reactNonMember, key})
		var events []ws.Event
		svc := removeOnlyChannelService(store, readPerms, &events)
		if err := svc.ToggleReaction(ctx, "srv1", "m1", reactNonMember, key); err != nil {
			t.Fatalf("remove after leaving: %v", err)
		}
		if len(store.rows) != 0 || store.toggles != 0 {
			t.Errorf("rows=%v toggles=%d", store.rows, store.toggles)
		}
	})

	t.Run("add still fails with the same error", func(t *testing.T) {
		store := newReactionStore()
		var events []ws.Event
		svc := removeOnlyChannelService(store, readPerms, &events)
		err := svc.ToggleReaction(ctx, "srv1", "m1", reactMember, goneEmojiKey)
		if err == nil || err.Error() != models.ErrUnknownEmoji.Error() {
			t.Fatalf("err = %v, want %q", err, models.ErrUnknownEmoji)
		}
		if store.toggles != 0 || len(store.rows) != 0 || len(events) != 0 {
			t.Errorf("unvalidated add reached the store: rows=%v toggles=%d events=%d", store.rows, store.toggles, len(events))
		}
	})

	t.Run("someone else's reaction is not removable", func(t *testing.T) {
		store := newReactionStore([2]string{reactNonMember, goneEmojiKey})
		var events []ws.Event
		svc := removeOnlyChannelService(store, readPerms, &events)
		err := svc.ToggleReaction(ctx, "srv1", "m1", reactMember, goneEmojiKey)
		if err == nil || err.Error() != models.ErrUnknownEmoji.Error() {
			t.Fatalf("err = %v, want %q", err, models.ErrUnknownEmoji)
		}
		if len(store.rows) != 1 {
			t.Error("another user's reaction was removed")
		}
	})

	t.Run("permission checks still run first", func(t *testing.T) {
		store := newReactionStore([2]string{reactMember, goneEmojiKey})
		var events []ws.Event
		svc := removeOnlyChannelService(store, models.PermSendMessages, &events)
		if err := svc.ToggleReaction(ctx, "srv1", "m1", reactMember, goneEmojiKey); !errors.Is(err, pkg.ErrForbidden) {
			t.Fatalf("err = %v, want ErrForbidden", err)
		}
		if len(store.rows) != 1 {
			t.Error("reaction removed without channel read permission")
		}
	})
}

func removeOnlyDMService(store *reactionStore, participants [2]string) DMService {
	f := newDMFixture()
	f.repo.GetMessageByIDFn = func(_ context.Context, id string) (*models.DMMessage, error) {
		return &models.DMMessage{ID: id, DMChannelID: "dm1"}, nil
	}
	f.repo.GetChannelByIDFn = func(_ context.Context, id string) (*models.DMChannel, error) {
		return &models.DMChannel{ID: id, User1ID: participants[0], User2ID: participants[1]}, nil
	}
	f.repo.ToggleReactionFn = store.toggle
	f.repo.RemoveReactionFn = store.remove
	f.svc.SetEmojiResolver(newReactionResolver())
	return f.svc
}

func TestReactionEmoji_DM_RemoveOnly(t *testing.T) {
	ctx := context.Background()
	pair := [2]string{reactMember, reactNonMember}

	t.Run("deleted emoji: own reaction can be removed", func(t *testing.T) {
		store := newReactionStore([2]string{reactMember, goneEmojiKey})
		if err := removeOnlyDMService(store, pair).ToggleReaction(ctx, reactMember, "d1", goneEmojiKey); err != nil {
			t.Fatalf("remove: %v", err)
		}
		if len(store.rows) != 0 || store.toggles != 0 {
			t.Errorf("rows=%v toggles=%d", store.rows, store.toggles)
		}
	})

	t.Run("not a member of the emoji's server: own reaction can be removed", func(t *testing.T) {
		key := "<:" + reactEmojiID + ">"
		store := newReactionStore([2]string{reactNonMember, key})
		if err := removeOnlyDMService(store, pair).ToggleReaction(ctx, reactNonMember, "d1", key); err != nil {
			t.Fatalf("remove: %v", err)
		}
		if len(store.rows) != 0 || store.toggles != 0 {
			t.Errorf("rows=%v toggles=%d", store.rows, store.toggles)
		}
	})

	t.Run("add still fails, never-made reaction same error", func(t *testing.T) {
		store := newReactionStore()
		err := removeOnlyDMService(store, pair).ToggleReaction(ctx, reactMember, "d1", goneEmojiKey)
		if err == nil || err.Error() != models.ErrUnknownEmoji.Error() {
			t.Fatalf("err = %v, want %q", err, models.ErrUnknownEmoji)
		}
		if store.toggles != 0 || len(store.rows) != 0 {
			t.Errorf("unvalidated add reached the store: rows=%v toggles=%d", store.rows, store.toggles)
		}
	})

	t.Run("non-participant is refused before the store", func(t *testing.T) {
		store := newReactionStore([2]string{"stranger", goneEmojiKey})
		err := removeOnlyDMService(store, pair).ToggleReaction(ctx, "stranger", "d1", goneEmojiKey)
		if !errors.Is(err, pkg.ErrForbidden) {
			t.Fatalf("err = %v, want ErrForbidden", err)
		}
		if len(store.rows) != 1 {
			t.Error("non-participant removed a reaction")
		}
	})
}
