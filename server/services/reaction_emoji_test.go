package services

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/testutil"
)

const (
	reactEmojiID   = "0123456789abcdef"
	reactEmojiSrv  = "emoji-srv"
	reactMember    = "u1"
	reactNonMember = "outsider"
)

// newReactionResolver is a real emojiService over the in-memory mock repo:
// one static emoji in reactEmojiSrv, of which only reactMember is a member.
func newReactionResolver() EmojiService {
	repo := &testutil.MockEmojiRepo{}
	repo.Put(models.ServerEmoji{ID: reactEmojiID, ServerID: reactEmojiSrv, Name: "kedi", URL: "/api/uploads/emojis/" + reactEmojiID + ".png"})
	members := &testutil.MockServerRepo{IsMemberFn: func(_ context.Context, serverID, userID string) (bool, error) {
		return serverID == reactEmojiSrv && userID == reactMember, nil
	}}
	return NewEmojiService(repo, members, &testutil.MockBroadcaster{}, "")
}

// channelReactionCase builds a reaction service whose message/channel/perm
// checks all pass, capturing the stored emoji key.
func channelReactionCase(resolver EmojiResolver) (ReactionService, *string) {
	stored := new(string)
	svc := newTestReactionService(
		&testutil.MockReactionRepo{
			ToggleFn: func(_ context.Context, _, _, emoji string) (bool, error) {
				*stored = emoji
				return true, nil
			},
		},
		&testutil.MockMessageRepo{GetByIDFn: func(_ context.Context, _ string) (*models.Message, error) {
			return &models.Message{ID: "m1", ChannelID: "ch1"}, nil
		}},
		&testutil.MockChannelRepo{GetByIDFn: func(_ context.Context, _ string) (*models.Channel, error) {
			return &models.Channel{ID: "ch1", ServerID: "srv1"}, nil
		}},
		&testutil.MockBroadcastAndOnline{},
		&testutil.MockChannelPermResolver{
			ResolveChannelPermissionsFn: func(_ context.Context, _, _ string) (models.Permission, error) {
				return models.PermViewChannel | models.PermReadMessages, nil
			},
		},
		nil,
	)
	if resolver != nil {
		svc.SetEmojiResolver(resolver)
	}
	return svc, stored
}

func dmReactionCase(resolver EmojiResolver) DMService {
	f := newDMFixture()
	f.repo.GetMessageByIDFn = func(_ context.Context, id string) (*models.DMMessage, error) {
		return &models.DMMessage{ID: id, DMChannelID: "dm1"}, nil
	}
	f.repo.GetChannelByIDFn = func(_ context.Context, id string) (*models.DMChannel, error) {
		return &models.DMChannel{ID: id, User1ID: reactMember, User2ID: reactNonMember}, nil
	}
	if resolver != nil {
		f.svc.SetEmojiResolver(resolver)
	}
	return f.svc
}

func TestReactionEmoji_Channel(t *testing.T) {
	resolver := newReactionResolver()
	cases := []struct {
		name, user, emoji, wantKey string
		wantErr                    error
	}{
		{"member custom", reactMember, "<:" + reactEmojiID + ">", "<:" + reactEmojiID + ">", nil},
		{"non-member", reactNonMember, "<:" + reactEmojiID + ">", "", models.ErrUnknownEmoji},
		{"missing emoji", reactMember, "<:fedcba9876543210>", "", models.ErrUnknownEmoji},
		{"animated mismatch", reactMember, "<a:" + reactEmojiID + ">", "", models.ErrUnknownEmoji},
		{"content-token form", reactMember, "<:kedi:" + reactEmojiID + ">", "", models.ErrReactionEmojiInvalid},
		{"unicode trimmed", reactMember, " 👍 ", "👍", nil},
		{"zwj family", reactMember, "👨‍👩‍👧", "👨‍👩‍👧", nil},
		{"33 runes", reactMember, strings.Repeat("a", 33), "", models.ErrReactionEmojiTooLong},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			svc, stored := channelReactionCase(resolver)
			err := svc.ToggleReaction(context.Background(), "srv1", "m1", tc.user, tc.emoji)
			if tc.wantErr != nil {
				if !errors.Is(err, tc.wantErr) || !errors.Is(err, pkg.ErrBadRequest) {
					t.Fatalf("err = %v, want %v (400)", err, tc.wantErr)
				}
				if *stored != "" {
					t.Errorf("reaction %q stored despite the error", *stored)
				}
				return
			}
			if err != nil {
				t.Fatalf("ToggleReaction: %v", err)
			}
			if *stored != tc.wantKey {
				t.Errorf("stored key = %q, want %q", *stored, tc.wantKey)
			}
		})
	}
}

// TestReactionEmoji_SameErrorForEveryFailure — non-member, missing and
// animated-mismatch must be byte-identical so an emoji id cannot be probed.
func TestReactionEmoji_SameErrorForEveryFailure(t *testing.T) {
	resolver := newReactionResolver()
	ctx := context.Background()
	errs := []error{
		resolver.ResolveForReaction(ctx, reactNonMember, reactEmojiID, false),
		resolver.ResolveForReaction(ctx, reactMember, "fedcba9876543210", false),
		resolver.ResolveForReaction(ctx, reactMember, reactEmojiID, true),
	}
	for i, err := range errs {
		if err == nil || err.Error() != models.ErrUnknownEmoji.Error() {
			t.Errorf("failure %d: err = %v, want %q", i, err, models.ErrUnknownEmoji)
		}
	}
	if err := resolver.ResolveForReaction(ctx, reactMember, reactEmojiID, false); err != nil {
		t.Errorf("member: %v", err)
	}
}

func TestReactionEmoji_NilResolver(t *testing.T) {
	svc, _ := channelReactionCase(nil)
	if err := svc.ToggleReaction(context.Background(), "srv1", "m1", reactMember, "<:"+reactEmojiID+">"); !errors.Is(err, models.ErrUnknownEmoji) {
		t.Errorf("custom with nil resolver: err = %v, want ErrUnknownEmoji", err)
	}
	if err := svc.ToggleReaction(context.Background(), "srv1", "m1", reactMember, "👍"); err != nil {
		t.Errorf("unicode with nil resolver: %v", err)
	}
	dm := dmReactionCase(nil)
	if err := dm.ToggleReaction(context.Background(), reactMember, "d1", "<:"+reactEmojiID+">"); !errors.Is(err, models.ErrUnknownEmoji) {
		t.Errorf("DM custom with nil resolver: err = %v, want ErrUnknownEmoji", err)
	}
	if err := dm.ToggleReaction(context.Background(), reactMember, "d1", "👍"); err != nil {
		t.Errorf("DM unicode with nil resolver: %v", err)
	}
}

func TestReactionEmoji_DM(t *testing.T) {
	resolver := newReactionResolver()
	cases := []struct {
		name, user, emoji string
		wantErr           error
	}{
		{"member custom", reactMember, "<:" + reactEmojiID + ">", nil},
		// reactNonMember is a DM participant but not in the emoji's server.
		{"non-member", reactNonMember, "<:" + reactEmojiID + ">", models.ErrUnknownEmoji},
		{"missing emoji", reactMember, "<:fedcba9876543210>", models.ErrUnknownEmoji},
		{"animated mismatch", reactMember, "<a:" + reactEmojiID + ">", models.ErrUnknownEmoji},
		{"zwj family", reactMember, "👨‍👩‍👧", nil},
		// Regression pin: DM reactions had no length cap before Faz D.
		{"33 runes", reactMember, strings.Repeat("a", 33), models.ErrReactionEmojiTooLong},
		{"empty", reactMember, "  ", models.ErrReactionEmojiRequired},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := dmReactionCase(resolver).ToggleReaction(context.Background(), tc.user, "d1", tc.emoji)
			if tc.wantErr == nil {
				if err != nil {
					t.Fatalf("ToggleReaction: %v", err)
				}
				return
			}
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("err = %v, want %v", err, tc.wantErr)
			}
		})
	}
}
