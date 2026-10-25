package services

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
	"github.com/google/uuid"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type joinTestHub struct {
	testutil.MockBroadcaster
	live atomic.Bool
	mu   sync.RWMutex
}

func (h *joinTestHub) ValidateGameActivityConnection(context.Context, string, uint64) error {
	if !h.live.Load() {
		return pkg.ErrForbidden
	}
	return nil
}

func (h *joinTestHub) HasGameActivityConnection(string, uint64) bool { return h.live.Load() }
func (h *joinTestHub) WithGameActivityConnection(_ string, _ uint64, commit func() error) error {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if !h.live.Load() {
		return pkg.ErrForbidden
	}
	return commit()
}

type joinTestPolicy struct {
	deny      bool
	before    func()
	admitDeny bool
}

func (p *joinTestPolicy) Authorize(context.Context, string, GameJoinContext) (func(func() error) error, error) {
	if p.before != nil {
		p.before()
	}
	if p.deny {
		return nil, pkg.ErrForbidden
	}
	return func(commit func() error) error {
		if p.admitDeny {
			return pkg.ErrForbidden
		}
		return commit()
	}, nil
}
func joinFixture(t *testing.T) (*GameJoinService, *GameActivityService, *joinTestHub, *joinTestPolicy, GameJoinOfferInput) {
	t.Helper()
	h := &joinTestHub{}
	h.live.Store(true)
	a := NewGameActivityService(&activityPolicyStub{}, nil, nil, h)
	p := &joinTestPolicy{}
	s := NewGameJoinService(a, p)
	game := ws.GameActivityClientGame{ID: "11111111-1111-4111-8111-111111111111", Name: "CS2", CanonicalGameID: models.CS2CanonicalGameID}
	a.Connect("host", 1)
	a.Update(context.Background(), "host", 1, 1, &game)
	recipe := models.CS2SteamJoinRecipe{Adapter: models.CS2SteamAdapter, LobbyID: strconv.FormatUint((1<<56)|(8<<52)|((1<<18)<<32)|1, 10), InviterID: strconv.FormatUint((1<<56)|(1<<52)|(1<<32)|1, 10)}
	in := GameJoinOfferInput{RequestID: uuid.NewString(), ActivityEpoch: a.epoch, SourceGameID: game.ID, CanonicalGameID: models.CS2CanonicalGameID, OfferRevision: 1, Recipe: &recipe}
	if state := s.SetOffer(context.Background(), "host", 1, in); !state.Accepted {
		t.Fatal("valid offer rejected", state.Reason)
	}
	return s, a, h, p, in
}
func joinMint(t *testing.T, s *GameJoinService) GameJoinTicket {
	t.Helper()
	c := GameJoinContext{TargetUserID: "host", Context: "friend"}
	target := s.Target(context.Background(), "viewer", c)
	if !target.Joinable {
		t.Fatal("target not joinable")
	}
	ticket, e := s.Mint(context.Background(), "viewer", "session", c, target.OfferRevision)
	if e != nil {
		t.Fatal(e)
	}
	return ticket
}
func TestGameJoinSingleUseSessionBindingAndNoRecipeBeforeConsume(t *testing.T) {
	s, _, _, _, _ := joinFixture(t)
	ticket := joinMint(t, s)
	if ticket.TicketID == ticket.Ticket || len(ticket.Ticket) != 43 {
		t.Fatal("ticket secret/public ID not separate")
	}
	raw, _ := json.Marshal(ticket)
	var obj map[string]any
	_ = json.Unmarshal(raw, &obj)
	if _, ok := obj["recipe"]; ok {
		t.Fatal("mint disclosed recipe")
	}
	for _, pair := range [][2]string{{"other", "session"}, {"viewer", "wrong"}} {
		if _, e := s.Consume(context.Background(), pair[0], pair[1], ticket.Ticket); !errors.Is(e, pkg.ErrForbidden) {
			t.Fatal("cross-account/session consume", e)
		}
	}
	result, e := s.Consume(context.Background(), "viewer", "session", ticket.Ticket)
	if e != nil || result.TicketID != ticket.TicketID || result.ExpiresAt != ticket.ExpiresAt {
		t.Fatal("consume changed authority/expiry", e)
	}
	if _, e = s.Consume(context.Background(), "viewer", "session", ticket.Ticket); !errors.Is(e, pkg.ErrNotFound) {
		t.Fatal("replayed ticket", e)
	}
}
func TestGameJoinConcurrentConsumeOnlyOneWinner(t *testing.T) {
	s, _, _, _, _ := joinFixture(t)
	ticket := joinMint(t, s)
	var successes atomic.Int32
	var wg sync.WaitGroup
	for range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, e := s.Consume(context.Background(), "viewer", "session", ticket.Ticket); e == nil {
				successes.Add(1)
			}
		}()
	}
	wg.Wait()
	if successes.Load() != 1 {
		t.Fatal("duplicate consumes succeeded", successes.Load())
	}
}
func TestGameJoinFreshPolicyAndPhysicalDisconnectDuringLookup(t *testing.T) {
	for _, action := range []string{"deny", "leave-during-admission", "disconnect-during-database"} {
		t.Run(action, func(t *testing.T) {
			s, _, h, p, _ := joinFixture(t)
			ticket := joinMint(t, s)
			switch action {
			case "deny":
				p.deny = true
			case "leave-during-admission":
				p.admitDeny = true
			case "disconnect-during-database":
				p.before = func() { h.live.Store(false) }
			}
			if _, e := s.Consume(context.Background(), "viewer", "session", ticket.Ticket); e == nil {
				t.Fatal("revoked authority disclosed recipe")
			}
			if got := s.Target(context.Background(), "viewer", GameJoinContext{TargetUserID: "host", Context: "friend"}); got.Joinable {
				t.Fatal("revoked target remained joinable")
			}
		})
	}
}
func TestGameJoinSourceReplacementAndExplicitWithdrawInvalidateTickets(t *testing.T) {
	for _, action := range []string{"replace", "withdraw", "disconnect", "competing-tab"} {
		t.Run(action, func(t *testing.T) {
			s, a, _, _, in := joinFixture(t)
			ticket := joinMint(t, s)
			switch action {
			case "replace":
				a.Update(context.Background(), "host", 1, 2, &ws.GameActivityClientGame{ID: in.SourceGameID, Name: "Other", CanonicalGameID: models.CS2CanonicalGameID})
			case "withdraw":
				in.OfferRevision++
				in.RequestID = uuid.NewString()
				in.Recipe = nil
				if !s.SetOffer(context.Background(), "host", 1, in).Accepted {
					t.Fatal("withdraw rejected")
				}
			case "disconnect":
				a.Disconnect(context.Background(), "host", 1)
				if len(s.revisions) != 0 {
					t.Fatal("disconnect leaked revision maps")
				}
			case "competing-tab":
				a.Connect("host", 2)
				time.Sleep(time.Millisecond)
				a.Update(context.Background(), "host", 2, 1, &ws.GameActivityClientGame{ID: in.SourceGameID, Name: "CS2", CanonicalGameID: models.CS2CanonicalGameID})
			}
			if _, e := s.Consume(context.Background(), "viewer", "session", ticket.Ticket); e == nil {
				t.Fatal("obsolete source consumed")
			}
		})
	}
}
func TestGameJoinHeartbeatDoesNotRenewOfferOrTicket(t *testing.T) {
	s, a, _, _, in := joinFixture(t)
	ticket := joinMint(t, s)
	before := s.offers["host"].until
	a.Update(context.Background(), "host", 1, 2, &ws.GameActivityClientGame{ID: in.SourceGameID, Name: "CS2", CanonicalGameID: models.CS2CanonicalGameID})
	if s.offers["host"].until != before {
		t.Fatal("heartbeat renewed manual offer")
	}
	s.now = func() time.Time { return ticket.ExpiresAt }
	if _, e := s.Consume(context.Background(), "viewer", "session", ticket.Ticket); !errors.Is(e, ErrGameJoinExpired) {
		t.Fatal("ticket expiry failed", e)
	}
}
func TestGameJoinOfferSequenceAndStrictRecipe(t *testing.T) {
	s, _, _, _, in := joinFixture(t)
	if s.SetOffer(context.Background(), "host", 1, in).Accepted {
		t.Fatal("replayed sequence accepted")
	}
	in.OfferRevision++
	in.ActivityEpoch = uuid.NewString()
	if s.SetOffer(context.Background(), "host", 1, in).Accepted {
		t.Fatal("old process epoch accepted")
	}
	raw, _ := json.Marshal(in)
	var copy GameJoinOfferInput
	if json.Unmarshal(raw, &copy) != nil {
		t.Fatal("canonical typed payload rejected")
	}
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	m["recipe"].(map[string]any)["url"] = "steam://run/730"
	bad, _ := json.Marshal(m)
	if json.Unmarshal(bad, &copy) == nil {
		t.Fatal("recipe extra authority accepted")
	}
	delete(m, "recipe")
	bad, _ = json.Marshal(m)
	if json.Unmarshal(bad, &copy) == nil {
		t.Fatal("missing recipe treated as withdrawal")
	}
}
func TestGameJoinOutstandingTicketBound(t *testing.T) {
	s, _, _, _, _ := joinFixture(t)
	for range 8 {
		joinMint(t, s)
	}
	target := s.Target(context.Background(), "viewer", GameJoinContext{TargetUserID: "host", Context: "friend"})
	if _, e := s.Mint(context.Background(), "viewer", "session", target.GameJoinContext, target.OfferRevision); !errors.Is(e, pkg.ErrConflict) {
		t.Fatal("per-viewer ticket cap missing", e)
	}
}

func TestGameJoinCompetingSourceNeverRevivesRetiredOfferOnFallback(t *testing.T) {
	s, a, _, _, in := joinFixture(t)
	old := joinMint(t, s)
	a.Connect("host", 2)
	time.Sleep(time.Millisecond)
	a.Update(context.Background(), "host", 2, 1, &ws.GameActivityClientGame{ID: in.SourceGameID, Name: "CS2", CanonicalGameID: models.CS2CanonicalGameID})
	if _, e := s.Consume(context.Background(), "viewer", "session", old.Ticket); e == nil {
		t.Fatal("old selected source still admitted")
	}
	a.Disconnect(context.Background(), "host", 2)
	if got := s.Target(context.Background(), "viewer", GameJoinContext{TargetUserID: "host", Context: "friend"}); got.Joinable {
		t.Fatal("fallback revived retired manual offer")
	}
	if _, e := s.Consume(context.Background(), "viewer", "session", old.Ticket); e == nil {
		t.Fatal("fallback revived old ticket")
	}
	in.OfferRevision++
	in.RequestID = uuid.NewString()
	if !s.SetOffer(context.Background(), "host", 1, in).Accepted {
		t.Fatal("explicit fresh fallback offer denied")
	}
	joinMint(t, s)
}
