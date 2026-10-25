package services

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/google/uuid"
)

var ErrGameJoinExpired = errors.New("game join expired")

const gameJoinOfferTTL = 90 * time.Second
const gameJoinTicketTTL = 30 * time.Second
const maxGameJoinRevision = uint64(1<<53 - 1)

type GameJoinContext struct {
	TargetUserID string `json:"target_user_id"`
	Context      string `json:"context"`
	ServerID     string `json:"server_id,omitempty"`
	ChannelID    string `json:"channel_id,omitempty"`
}

func (c GameJoinContext) Valid() bool {
	return c.TargetUserID != "" && len(c.TargetUserID) <= 256 && ((c.Context == "friend" && c.ServerID == "" && c.ChannelID == "") || (c.Context == "voice" && c.ServerID != "" && c.ChannelID != "" && len(c.ServerID) <= 256 && len(c.ChannelID) <= 256))
}

type GameJoinOfferInput struct {
	RequestID       string                     `json:"request_id"`
	ActivityEpoch   string                     `json:"activity_epoch"`
	SourceGameID    string                     `json:"source_game_id"`
	CanonicalGameID string                     `json:"canonical_game_id"`
	OfferRevision   uint64                     `json:"offer_revision"`
	Recipe          *models.CS2SteamJoinRecipe `json:"recipe"`
}

func (in *GameJoinOfferInput) UnmarshalJSON(raw []byte) error {
	var fields map[string]json.RawMessage
	if len(raw) > 2048 || json.Unmarshal(raw, &fields) != nil || len(fields) != 6 {
		return pkg.ErrBadRequest
	}
	for key := range fields {
		switch key {
		case "request_id", "activity_epoch", "source_game_id", "canonical_game_id", "offer_revision", "recipe":
		default:
			return pkg.ErrBadRequest
		}
	}
	// Six required fields, with recipe present even for an explicit withdrawal.
	if len(fields) != 6 {
		return pkg.ErrBadRequest
	}
	type plain GameJoinOfferInput
	var parsed plain
	if json.Unmarshal(raw, &parsed) != nil {
		return pkg.ErrBadRequest
	}
	if string(fields["recipe"]) != "null" {
		recipe, e := models.DecodeCS2SteamJoinRecipe(fields["recipe"])
		if e != nil {
			return pkg.ErrBadRequest
		}
		parsed.Recipe = &recipe
	}
	*in = GameJoinOfferInput(parsed)
	return nil
}

type GameJoinOfferState struct {
	RequestID     string     `json:"request_id"`
	Accepted      bool       `json:"accepted"`
	OfferRevision uint64     `json:"offer_revision"`
	ExpiresAt     *time.Time `json:"expires_at,omitempty"`
	Reason        string     `json:"reason,omitempty"`
}
type GameJoinTarget struct {
	GameJoinContext
	Joinable      bool       `json:"joinable"`
	OfferRevision uint64     `json:"offer_revision,omitempty"`
	ExpiresAt     *time.Time `json:"expires_at,omitempty"`
	Adapter       string     `json:"adapter,omitempty"`
}
type GameJoinTicket struct {
	TicketID      string    `json:"ticket_id"`
	Ticket        string    `json:"ticket"`
	ViewerUserID  string    `json:"viewer_user_id"`
	TargetUserID  string    `json:"target_user_id"`
	OfferRevision uint64    `json:"offer_revision"`
	ExpiresAt     time.Time `json:"expires_at"`
	Adapter       string    `json:"adapter"`
}
type GameJoinConsumed struct {
	TicketID      string                    `json:"ticket_id"`
	ViewerUserID  string                    `json:"viewer_user_id"`
	TargetUserID  string                    `json:"target_user_id"`
	OfferRevision uint64                    `json:"offer_revision"`
	ExpiresAt     time.Time                 `json:"expires_at"`
	Recipe        models.CS2SteamJoinRecipe `json:"recipe"`
}

// Authorize performs fresh repository checks and returns an admission closure.
// The closure must recheck transient voice membership under its read lock and
// invoke commit while that lock remains held. No database work belongs in commit.
type GameJoinPolicy interface {
	Authorize(context.Context, string, GameJoinContext) (func(func() error) error, error)
}
type gameJoinOffer struct {
	connection            uint64
	incarnation, sourceID string
	revision              uint64
	until                 time.Time
	recipe                models.CS2SteamJoinRecipe
}
type gameJoinPending struct {
	publicID, viewer, session, target string
	context                           GameJoinContext
	offer                             gameJoinOffer
	until                             time.Time
}
type GameJoinService struct {
	activity  *GameActivityService
	policy    GameJoinPolicy
	mu        sync.Mutex
	offers    map[string]gameJoinOffer
	revisions map[string]map[uint64]uint64
	tickets   map[[32]byte]gameJoinPending
	now       func() time.Time
}

func NewGameJoinService(activity *GameActivityService, policy GameJoinPolicy) *GameJoinService {
	s := &GameJoinService{activity: activity, policy: policy, offers: map[string]gameJoinOffer{}, revisions: map[string]map[uint64]uint64{}, tickets: map[[32]byte]gameJoinPending{}, now: time.Now}
	if activity != nil {
		activity.gameJoin = s
	}
	return s
}

func (s *GameJoinService) disconnectLocked(user string, connection uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.revisions[user], connection)
	if len(s.revisions[user]) == 0 {
		delete(s.revisions, user)
	}
	if o, ok := s.offers[user]; ok && o.connection == connection {
		delete(s.offers, user)
	}
	for key, p := range s.tickets {
		if p.target == user && p.offer.connection == connection {
			delete(s.tickets, key)
		}
	}
}

// A manual offer is tied to one continuously selected source. A newer device
// taking over retires it permanently, even if the older activity later becomes
// the selected fallback again. Only an explicit new host offer can renew it.
func (s *GameJoinService) retireObsoleteOfferLocked(user string) {
	s.mu.Lock()
	o, exists := s.offers[user]
	s.mu.Unlock()
	if !exists {
		return
	}
	if _, ok := s.sourceLocked(user, o.connection, o.sourceID, o.incarnation); ok && s.now().Before(o.until) {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if current, ok := s.offers[user]; !ok || current != o {
		return
	}
	delete(s.offers, user)
	for key, p := range s.tickets {
		if p.target == user && p.offer == o {
			delete(s.tickets, key)
		}
	}
}
func (s *GameJoinService) withHostLive(user string, connection uint64, commit func() error) error {
	gate, ok := s.activity.hub.(interface {
		WithGameActivityConnection(string, uint64, func() error) error
	})
	if !ok {
		return pkg.ErrForbidden
	}
	return gate.WithGameActivityConnection(user, connection, commit)
}
func (s *GameJoinService) validateHost(ctx context.Context, user string, connection uint64) error {
	validator, ok := s.activity.hub.(interface {
		ValidateGameActivityConnection(context.Context, string, uint64) error
	})
	if !ok {
		return pkg.ErrForbidden
	}
	return validator.ValidateGameActivityConnection(ctx, user, connection)
}

// sourceLocked is called with the target's activity gate held. The selected
// source must be exactly the offering physical connection, not another tab.
func (s *GameJoinService) sourceLocked(user string, connection uint64, sourceID, incarnation string) (gameActivitySource, bool) {
	a := s.activity
	a.mu.Lock()
	defer a.mu.Unlock()
	now := s.now()
	source, ok := a.sources[user][connection]
	if !ok || !a.connections[user][connection] || !now.Before(source.leaseUntil) || source.game.ID != sourceID || source.game.CanonicalGameID != models.CS2CanonicalGameID || (incarnation != "" && source.incarnation != incarnation) {
		return gameActivitySource{}, false
	}
	for id, other := range a.sources[user] {
		if id != connection && now.Before(other.leaseUntil) && (!other.changedAt.Before(source.changedAt)) {
			return gameActivitySource{}, false
		}
	}
	if live, ok := a.hub.(interface{ HasGameActivityConnection(string, uint64) bool }); !ok || !live.HasGameActivityConnection(user, connection) {
		return gameActivitySource{}, false
	}
	return source, true
}
func (s *GameJoinService) SetOffer(ctx context.Context, user string, connection uint64, in GameJoinOfferInput) GameJoinOfferState {
	out := GameJoinOfferState{RequestID: in.RequestID, OfferRevision: in.OfferRevision, Reason: "invalid"}
	if s.activity == nil || s.activity.policy == nil || ctx.Err() != nil || user == "" || connection == 0 || in.ActivityEpoch != s.activity.epoch || in.CanonicalGameID != models.CS2CanonicalGameID || in.OfferRevision == 0 || in.OfferRevision > maxGameJoinRevision {
		return out
	}
	if _, err := uuid.Parse(in.RequestID); err != nil {
		return out
	}
	if _, err := uuid.Parse(in.SourceGameID); err != nil {
		return out
	}
	if in.Recipe != nil && in.Recipe.Validate() != nil {
		return out
	}
	unlock := s.activity.lockTarget(user)
	defer unlock()
	source, ok := s.sourceLocked(user, connection, in.SourceGameID, "")
	if !ok {
		out.Reason = "stale"
		return out
	}
	allowed, err := s.activity.policy.CanPublish(ctx, user)
	if err != nil || !allowed {
		out.Reason = "denied"
		return out
	}
	if s.validateHost(ctx, user, connection) != nil {
		out.Reason = "denied"
		return out
	}
	if _, ok = s.sourceLocked(user, connection, in.SourceGameID, source.incarnation); !ok {
		out.Reason = "stale"
		return out
	}
	s.activity.mu.Lock()
	s.activity.revisions[user]++
	serverRevision := s.activity.revisions[user]
	s.activity.mu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneLocked()
	if _, exists := s.offers[user]; in.Recipe != nil && !exists && len(s.offers) >= 4096 {
		out.Reason = "busy"
		return out
	}
	if s.revisions[user] == nil {
		s.revisions[user] = map[uint64]uint64{}
	}
	if in.OfferRevision <= s.revisions[user][connection] {
		out.Reason = "stale"
		return out
	}
	s.revisions[user][connection] = in.OfferRevision
	delete(s.offers, user)
	if in.Recipe != nil {
		until := s.now().UTC().Add(gameJoinOfferTTL)
		s.offers[user] = gameJoinOffer{connection: connection, incarnation: source.incarnation, sourceID: source.game.ID, revision: serverRevision, until: until, recipe: *in.Recipe}
		out.ExpiresAt = &until
	}
	out.Accepted = true
	out.OfferRevision = serverRevision
	out.Reason = ""
	return out
}
func (s *GameJoinService) currentOfferLocked(target string) (gameJoinOffer, error) {
	s.mu.Lock()
	o, ok := s.offers[target]
	s.mu.Unlock()
	if !ok {
		return o, pkg.ErrNotFound
	}
	if !s.now().Before(o.until) {
		return o, ErrGameJoinExpired
	}
	if _, ok = s.sourceLocked(target, o.connection, o.sourceID, o.incarnation); !ok {
		return o, pkg.ErrConflict
	}
	return o, nil
}
func (s *GameJoinService) Target(ctx context.Context, viewer string, c GameJoinContext) GameJoinTarget {
	out := GameJoinTarget{GameJoinContext: c}
	if s.activity == nil || s.policy == nil || !c.Valid() || viewer == c.TargetUserID {
		return out
	}
	unlock := s.activity.lockTarget(c.TargetUserID)
	defer unlock()
	o, err := s.currentOfferLocked(c.TargetUserID)
	if err != nil {
		return out
	}
	admit, err := s.policy.Authorize(ctx, viewer, c)
	if err != nil || admit == nil {
		return out
	}
	if s.validateHost(ctx, c.TargetUserID, o.connection) != nil {
		return out
	}
	if current, err := s.currentOfferLocked(c.TargetUserID); err != nil || current != o {
		return out
	}
	_ = admit(func() error {
		return s.withHostLive(c.TargetUserID, o.connection, func() error {
			out.Joinable = true
			out.OfferRevision = o.revision
			out.ExpiresAt = &o.until
			out.Adapter = models.CS2SteamAdapter
			return nil
		})
	})
	return out
}
func (s *GameJoinService) Mint(ctx context.Context, viewer, session string, c GameJoinContext, revision uint64) (GameJoinTicket, error) {
	if s.activity == nil || s.policy == nil || viewer == "" || session == "" || viewer == c.TargetUserID || !c.Valid() {
		return GameJoinTicket{}, pkg.ErrForbidden
	}
	unlock := s.activity.lockTarget(c.TargetUserID)
	defer unlock()
	o, err := s.currentOfferLocked(c.TargetUserID)
	if err != nil {
		return GameJoinTicket{}, err
	}
	if revision != o.revision {
		return GameJoinTicket{}, pkg.ErrConflict
	}
	admit, err := s.policy.Authorize(ctx, viewer, c)
	if err != nil {
		return GameJoinTicket{}, err
	}
	if admit == nil {
		return GameJoinTicket{}, pkg.ErrForbidden
	}
	if err := s.validateHost(ctx, c.TargetUserID, o.connection); err != nil {
		return GameJoinTicket{}, err
	}
	if current, err := s.currentOfferLocked(c.TargetUserID); err != nil {
		return GameJoinTicket{}, err
	} else if current != o {
		return GameJoinTicket{}, pkg.ErrConflict
	}
	secret := make([]byte, 32)
	if _, err = rand.Read(secret); err != nil {
		return GameJoinTicket{}, pkg.ErrInternal
	}
	ticket := base64.RawURLEncoding.EncodeToString(secret)
	until := s.now().UTC().Add(gameJoinTicketTTL)
	if o.until.Before(until) {
		until = o.until
	}
	id := uuid.NewString()
	err = admit(func() error {
		return s.withHostLive(c.TargetUserID, o.connection, func() error {
			s.mu.Lock()
			defer s.mu.Unlock()
			s.pruneLocked()
			if len(s.tickets) >= 8192 {
				return pkg.ErrConflict
			}
			pending := 0
			for _, p := range s.tickets {
				if p.viewer == viewer {
					pending++
				}
			}
			if pending >= 8 {
				return pkg.ErrConflict
			}
			if !s.now().Before(until) {
				return ErrGameJoinExpired
			}
			s.tickets[sha256.Sum256([]byte(ticket))] = gameJoinPending{publicID: id, viewer: viewer, session: session, target: c.TargetUserID, context: c, offer: o, until: until}
			return nil
		})
	})
	if err != nil {
		return GameJoinTicket{}, err
	}
	return GameJoinTicket{id, ticket, viewer, c.TargetUserID, o.revision, until, models.CS2SteamAdapter}, nil
}
func (s *GameJoinService) Consume(ctx context.Context, viewer, session, ticket string) (GameJoinConsumed, error) {
	if len(ticket) != 43 || s.activity == nil || s.policy == nil {
		return GameJoinConsumed{}, pkg.ErrNotFound
	}
	key := sha256.Sum256([]byte(ticket))
	s.mu.Lock()
	p, ok := s.tickets[key]
	s.mu.Unlock()
	if !ok {
		return GameJoinConsumed{}, pkg.ErrNotFound
	}
	if p.viewer != viewer || p.session != session {
		return GameJoinConsumed{}, pkg.ErrForbidden
	}
	unlock := s.activity.lockTarget(p.target)
	defer unlock()
	if !s.now().Before(p.until) {
		return GameJoinConsumed{}, ErrGameJoinExpired
	}
	o, err := s.currentOfferLocked(p.target)
	if err != nil {
		return GameJoinConsumed{}, err
	}
	if o != p.offer {
		return GameJoinConsumed{}, pkg.ErrConflict
	}
	admit, err := s.policy.Authorize(ctx, viewer, p.context)
	if err != nil {
		return GameJoinConsumed{}, err
	}
	if admit == nil {
		return GameJoinConsumed{}, pkg.ErrForbidden
	}
	if err := s.validateHost(ctx, p.target, o.connection); err != nil {
		return GameJoinConsumed{}, err
	}
	if current, err := s.currentOfferLocked(p.target); err != nil {
		return GameJoinConsumed{}, err
	} else if current != o {
		return GameJoinConsumed{}, pkg.ErrConflict
	}
	err = admit(func() error {
		return s.withHostLive(p.target, o.connection, func() error {
			s.mu.Lock()
			defer s.mu.Unlock()
			current, exists := s.tickets[key]
			if !exists || current != p {
				return pkg.ErrNotFound
			}
			if !s.now().Before(p.until) {
				return ErrGameJoinExpired
			}
			delete(s.tickets, key)
			return nil
		})
	})
	if err != nil {
		return GameJoinConsumed{}, err
	}
	return GameJoinConsumed{p.publicID, viewer, p.target, o.revision, p.until, o.recipe}, nil
}
func (s *GameJoinService) pruneLocked() {
	now := s.now()
	for k, p := range s.tickets {
		if !now.Before(p.until) {
			delete(s.tickets, k)
		}
	}
	for k, o := range s.offers {
		if !now.Before(o.until) {
			delete(s.offers, k)
		}
	}
}
