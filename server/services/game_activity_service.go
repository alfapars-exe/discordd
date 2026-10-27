package services

import (
	"context"
	"hash/fnv"
	"sort"
	"sync"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/ws"
	"github.com/google/uuid"
)

const gameActivityLease = 90 * time.Second

type gameActivitySource struct {
	incarnation string
	game        ws.GameActivityClientGame
	changedAt   time.Time
	leaseUntil  time.Time
	sequence    uint64
}
type gameActivityGrant struct{ viewerID, serverID string }
type gameActivityPublished struct {
	game   *ws.GameActivityGame
	active bool
}

// GameActivityPrivacyInvalidator is wired into the services that mutate
// social and membership authorization. Implementations emit only targeted
// revocations, never a global activity event.
type GameActivityPrivacyInvalidator interface {
	PolicyChanged(context.Context, string)
	RelationshipChanged(context.Context, string, string)
	MembershipAdded(context.Context, string, string)
	MembershipRemoved(context.Context, string, string)
	ServerDeleted(context.Context, string)
}
type gameActivityRecipientFriendReader interface {
	ListFriends(context.Context, string) ([]models.FriendshipWithUser, error)
}
type gameActivityRecipientServerReader interface {
	GetUserServers(context.Context, string) ([]models.ServerListItem, error)
	ListMemberIDs(context.Context, string) ([]string, error)
	IsMember(context.Context, string, string) (bool, error)
}

// GameActivityService owns transient, per-physical-connection activity. It
// never stores process paths or treats a client title as verified identity.
type GameActivityService struct {
	mu              sync.Mutex // protects maps; never held across repository calls
	lifecycleMu     sync.Mutex
	started         bool
	stopped         bool
	workerDone      chan struct{}
	workerCancel    context.CancelFunc
	tickerFactory   func(time.Duration) (<-chan time.Time, func())
	targetLocks     [64]chan struct{}
	policy          GameActivityPrivacyPolicy
	epoch           string
	friends         gameActivityRecipientFriendReader
	servers         gameActivityRecipientServerReader
	hub             ws.Broadcaster
	sources         map[string]map[uint64]gameActivitySource
	connections     map[string]map[uint64]bool
	lastSequences   map[string]map[uint64]uint64
	grants          map[string]map[gameActivityGrant]bool
	revisions       map[string]uint64
	published       map[string]gameActivityPublished
	reconcileCursor string
	stop            chan struct{}
	gameJoin        *GameJoinService
}

func (s *GameActivityService) targetLock(userID string) chan struct{} {
	h := fnv.New32a()
	_, _ = h.Write([]byte(userID))
	return s.targetLocks[h.Sum32()%uint32(len(s.targetLocks))]
}

func (s *GameActivityService) lockTarget(userID string) func() {
	lock, ok := s.lockTargetContext(context.Background(), userID)
	if !ok {
		panic("unbounded game activity target lock acquisition was cancelled")
	}
	return lock
}

func (s *GameActivityService) lockTargetContext(ctx context.Context, userID string) (func(), bool) {
	if err := ctx.Err(); err != nil {
		return nil, false
	}
	lock := s.targetLock(userID)
	select {
	case <-lock:
		if err := ctx.Err(); err != nil {
			lock <- struct{}{}
			return nil, false
		}
		return func() { lock <- struct{}{} }, true
	case <-ctx.Done():
		return nil, false
	}
}

func NewGameActivityService(policy GameActivityPrivacyPolicy, friends gameActivityRecipientFriendReader, servers gameActivityRecipientServerReader, hub ws.Broadcaster) *GameActivityService {
	epoch := uuid.NewString()
	if provider, ok := hub.(interface{ GameActivityEpoch() string }); ok && provider.GameActivityEpoch() != "" {
		epoch = provider.GameActivityEpoch()
	}
	service := &GameActivityService{policy: policy, epoch: epoch, friends: friends, servers: servers, hub: hub, sources: map[string]map[uint64]gameActivitySource{}, connections: map[string]map[uint64]bool{}, lastSequences: map[string]map[uint64]uint64{}, grants: map[string]map[gameActivityGrant]bool{}, revisions: map[string]uint64{}, published: map[string]gameActivityPublished{}, stop: make(chan struct{}), workerDone: make(chan struct{}), tickerFactory: func(interval time.Duration) (<-chan time.Time, func()) {
		ticker := time.NewTicker(interval)
		return ticker.C, ticker.Stop
	}}
	for i := range service.targetLocks {
		service.targetLocks[i] = make(chan struct{}, 1)
		service.targetLocks[i] <- struct{}{}
	}
	return service
}

func (s *GameActivityService) Connect(userID string, connectionID uint64) {
	if userID == "" || connectionID == 0 {
		return
	}
	unlock := s.lockTarget(userID)
	defer unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.connections[userID] == nil {
		s.connections[userID] = map[uint64]bool{}
	}
	if s.lastSequences[userID] == nil {
		s.lastSequences[userID] = map[uint64]uint64{}
	}
	s.connections[userID][connectionID] = true
	s.lastSequences[userID][connectionID] = 0
}

func (s *GameActivityService) Update(ctx context.Context, userID string, connectionID, sequence uint64, game *ws.GameActivityClientGame) {
	if userID == "" || connectionID == 0 {
		return
	}
	unlock := s.lockTarget(userID)
	defer unlock()
	s.mu.Lock()
	if !s.connections[userID][connectionID] || sequence <= s.lastSequences[userID][connectionID] {
		s.mu.Unlock()
		return
	}
	s.lastSequences[userID][connectionID] = sequence
	s.mu.Unlock()
	if game == nil {
		s.mu.Lock()
		if byConnection := s.sources[userID]; byConnection != nil {
			delete(byConnection, connectionID)
			if len(byConnection) == 0 {
				delete(s.sources, userID)
			}
		}
		s.mu.Unlock()
		s.reconcileTargetLocked(ctx, userID)
		return
	}
	allowed, err := s.policy.CanPublish(ctx, userID)
	if err != nil || !allowed {
		s.mu.Lock()
		delete(s.sources, userID)
		s.mu.Unlock()
		s.reconcileTargetLocked(ctx, userID)
		return
	}
	s.mu.Lock()
	byConnection := s.sources[userID]
	if byConnection == nil {
		byConnection = map[uint64]gameActivitySource{}
		s.sources[userID] = byConnection
	}
	old, exists := byConnection[connectionID]
	now := time.Now().UTC()
	changed := !exists || old.game.ID != game.ID || old.game.Name != game.Name || old.game.CanonicalGameID != game.CanonicalGameID || !now.Before(old.leaseUntil)
	notifyTransition := !exists || old.game.ID != game.ID || old.game.CanonicalGameID != game.CanonicalGameID || !now.Before(old.leaseUntil)
	started := old.changedAt
	incarnation := old.incarnation
	if changed {
		started = now
		incarnation = uuid.NewString()
	}
	byConnection[connectionID] = gameActivitySource{incarnation: incarnation, game: *game, changedAt: started, leaseUntil: now.Add(gameActivityLease), sequence: sequence}
	s.mu.Unlock()
	if notifyTransition {
		s.reconcileTargetLocked(ctx, userID, gameActivityTransition{connection: connectionID, incarnation: incarnation})
	} else {
		s.reconcileTargetLocked(ctx, userID)
	}
}

func (s *GameActivityService) Disconnect(ctx context.Context, userID string, connectionID uint64) {
	unlock := s.lockTarget(userID)
	defer unlock()
	s.mu.Lock()
	if !s.connections[userID][connectionID] {
		s.mu.Unlock()
		return
	}
	delete(s.connections[userID], connectionID)
	delete(s.lastSequences[userID], connectionID)
	if len(s.connections[userID]) == 0 {
		delete(s.connections, userID)
		delete(s.lastSequences, userID)
	}
	if byConnection := s.sources[userID]; byConnection != nil {
		delete(byConnection, connectionID)
		if len(byConnection) == 0 {
			delete(s.sources, userID)
		}
	}
	s.mu.Unlock()
	if s.gameJoin != nil {
		s.gameJoin.disconnectLocked(userID, connectionID)
	}
	s.reconcileTargetLocked(ctx, userID)
}

// Snapshot sends only activity individually authorized for viewerID. It is
// called for each new physical connection; delivery is user-targeted, never
// global, and duplicate snapshots across a user's tabs are harmless revisions.
func (s *GameActivityService) Snapshot(ctx context.Context, viewerID string) {
	s.mu.Lock()
	ids := make([]string, 0, len(s.sources))
	for targetID := range s.sources {
		ids = append(ids, targetID)
	}
	s.mu.Unlock()
	for _, targetID := range ids {
		unlock := s.lockTarget(targetID)
		s.mu.Lock()
		game, _, ok := s.selectedLocked(targetID, time.Now())
		s.mu.Unlock()
		if !ok {
			unlock()
			continue
		}
		for _, serverID := range s.contextsForViewer(ctx, targetID, viewerID) {
			allowed, err := s.policy.CanView(ctx, viewerID, targetID, serverID)
			if err == nil && allowed {
				s.mu.Lock()
				if s.grants[targetID] == nil {
					s.grants[targetID] = map[gameActivityGrant]bool{}
				}
				s.grants[targetID][gameActivityGrant{viewerID, serverID}] = true
				s.mu.Unlock()
				s.deliver(viewerID, targetID, serverID, game)
			}
		}
		unlock()
	}
}

// ReconcileTarget re-evaluates every previous grant and current candidate.
// Call this after preference, block, friendship, membership, or presence changes;
// a periodic expiry/reconcile pass is still needed for lost hooks.
func (s *GameActivityService) ReconcileTarget(ctx context.Context, userID string) {
	unlock := s.lockTarget(userID)
	defer unlock()
	s.reconcileTargetLocked(ctx, userID)
}

func (s *GameActivityService) PolicyChanged(ctx context.Context, userID string) {
	s.ReconcileTarget(ctx, userID)
}

func (s *GameActivityService) RelationshipChanged(ctx context.Context, userA, userB string) {
	if userA != "" {
		s.ReconcileTarget(ctx, userA)
	}
	if userB != "" && userB != userA {
		s.ReconcileTarget(ctx, userB)
	}
}

// MembershipAdded re-evaluates active targets in the server plus the joining
// user's own source. The persisted join-time snapshot and full policy decide
// whether any activity is actually delivered.
func (s *GameActivityService) MembershipAdded(ctx context.Context, serverID, userID string) {
	if serverID == "" || userID == "" || s.servers == nil {
		return
	}
	members, err := s.servers.ListMemberIDs(ctx, serverID)
	if err != nil || ctx.Err() != nil {
		s.ReconcileTarget(ctx, userID)
		return
	}
	s.mu.Lock()
	active := make(map[string]bool, len(s.sources))
	for targetID := range s.sources {
		active[targetID] = true
	}
	s.mu.Unlock()
	for _, memberID := range members {
		if ctx.Err() != nil {
			return
		}
		if active[memberID] {
			s.ReconcileTarget(ctx, memberID)
		}
	}
	s.ReconcileTarget(ctx, userID)
}

// MembershipRemoved clears only server-scoped grants previously delivered
// to the removed viewer, then reconciles their own activity for other valid
// contexts, such as accepted-friend global sharing.
func (s *GameActivityService) MembershipRemoved(ctx context.Context, serverID, userID string) {
	if serverID == "" || userID == "" {
		return
	}
	targets := make([]string, 0)
	s.mu.Lock()
	for targetID, grants := range s.grants {
		grant := gameActivityGrant{viewerID: userID, serverID: serverID}
		if grants[grant] {
			targets = append(targets, targetID)
		}
	}
	s.mu.Unlock()
	sort.Strings(targets)
	for _, targetID := range targets {
		unlock := s.lockTarget(targetID)
		s.mu.Lock()
		grant := gameActivityGrant{viewerID: userID, serverID: serverID}
		grants := s.grants[targetID]
		present := grants[grant]
		if present {
			delete(grants, grant)
			if len(grants) == 0 {
				delete(s.grants, targetID)
			}
		}
		s.mu.Unlock()
		if present {
			s.deliver(userID, targetID, serverID, nil)
		}
		unlock()
	}
	s.ReconcileTarget(ctx, userID)
}

// ServerDeleted tombstones every previously delivered server context. The
// transaction has removed the server and its memberships, so no grant can be
// re-created from repository state after this method returns.
func (s *GameActivityService) ServerDeleted(ctx context.Context, serverID string) {
	if serverID == "" {
		return
	}
	targets := make([]string, 0)
	s.mu.Lock()
	for targetID, grants := range s.grants {
		for grant := range grants {
			if grant.serverID == serverID {
				targets = append(targets, targetID)
				break
			}
		}
	}
	s.mu.Unlock()
	sort.Strings(targets)
	for _, targetID := range targets {
		unlock := s.lockTarget(targetID)
		s.mu.Lock()
		grants := s.grants[targetID]
		var revokedViewers []string
		for grant := range grants {
			if grant.serverID == serverID {
				delete(grants, grant)
				revokedViewers = append(revokedViewers, grant.viewerID)
			}
		}
		if len(grants) == 0 {
			delete(s.grants, targetID)
		}
		s.mu.Unlock()
		for _, viewerID := range revokedViewers {
			s.deliver(viewerID, targetID, serverID, nil)
		}
		unlock()
	}
	_ = ctx // deletion must revoke even if the initiating request was canceled
}

func (s *GameActivityService) ExpireAndReconcile(ctx context.Context) {
	if ctx.Err() != nil {
		return
	}
	// Take a stable list, then serialize expiry with updates per target. The
	// global map lock is never held while waiting for a target lock.
	s.mu.Lock()
	allIDs := make([]string, 0, len(s.sources))
	for id := range s.sources {
		allIDs = append(allIDs, id)
	}
	s.mu.Unlock()
	sort.Strings(allIDs)
	now := time.Now()
	for _, userID := range allIDs {
		if ctx.Err() != nil {
			return
		}
		unlock, ok := s.lockTargetContext(ctx, userID)
		if !ok {
			return
		}
		if ctx.Err() != nil {
			unlock()
			return
		}
		s.mu.Lock()
		byConnection := s.sources[userID]
		expired := false
		for id, source := range byConnection {
			if !now.Before(source.leaseUntil) {
				delete(byConnection, id)
				expired = true
			}
		}
		if len(byConnection) == 0 {
			delete(s.sources, userID)
		}
		s.mu.Unlock()
		if expired {
			// Reconcile expiry immediately. A non-selected source expiring must
			// not flicker the current activity; an expired selected source with
			// a live fallback transitions directly to that game.
			s.reconcileTargetLocked(ctx, userID)
		}
		unlock()
	}
	s.mu.Lock()
	ids := make([]string, 0, len(s.sources))
	for id := range s.sources {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	start := 0
	if s.reconcileCursor != "" && len(ids) > 0 {
		start = sort.SearchStrings(ids, s.reconcileCursor)
		if start < len(ids) && ids[start] <= s.reconcileCursor {
			start++
		}
		if start >= len(ids) {
			start = 0
		}
	}
	limit := 32
	if len(ids) < limit {
		limit = len(ids)
	}
	s.mu.Unlock()
	for i := 0; i < limit; i++ {
		if ctx.Err() != nil {
			return
		}
		userID := ids[(start+i)%len(ids)]
		unlock, ok := s.lockTargetContext(ctx, userID)
		if !ok {
			return
		}
		if ctx.Err() != nil {
			unlock()
			return
		}
		s.mu.Lock()
		_, exists := s.sources[userID]
		s.mu.Unlock()
		if exists {
			s.reconcileTargetLocked(ctx, userID)
		}
		unlock()
	}
	if limit > 0 {
		s.mu.Lock()
		s.reconcileCursor = ids[(start+limit-1)%len(ids)]
		s.mu.Unlock()
	}
}

func (s *GameActivityService) Start() {
	s.lifecycleMu.Lock()
	if s.started || s.stopped {
		s.lifecycleMu.Unlock()
		return
	}
	s.started = true
	workerCtx, workerCancel := context.WithCancel(context.Background())
	s.workerCancel = workerCancel
	ticks, stopTicker := s.tickerFactory(10 * time.Second)
	go func() {
		defer close(s.workerDone)
		defer stopTicker()
		defer workerCancel()
		for {
			select {
			case _, ok := <-ticks:
				if !ok {
					return
				}
				ctx, cancel := context.WithTimeout(workerCtx, broadcastResolveTimeout)
				s.ExpireAndReconcile(ctx)
				cancel()
			case <-s.stop:
				return
			}
		}
	}()
	s.lifecycleMu.Unlock()
}
func (s *GameActivityService) Stop() {
	s.lifecycleMu.Lock()
	if !s.stopped {
		s.stopped = true
		close(s.stop)
		if s.workerCancel != nil {
			s.workerCancel()
		}
	}
	started := s.started
	s.lifecycleMu.Unlock()
	if started {
		<-s.workerDone
	}
}

func (s *GameActivityService) reconcileTargetLocked(ctx context.Context, targetID string, transition ...gameActivityTransition) {
	if s.gameJoin != nil {
		s.gameJoin.retireObsoleteOfferLocked(targetID)
	}
	s.mu.Lock()
	game, _, active := s.selectedLocked(targetID, time.Now())
	oldPublished := s.published[targetID]
	oldGrants := make(map[gameActivityGrant]bool, len(s.grants[targetID]))
	for grant := range s.grants[targetID] {
		oldGrants[grant] = true
	}
	s.mu.Unlock()
	if active {
		allowed, err := s.policy.CanPublish(ctx, targetID)
		if err != nil || !allowed {
			s.mu.Lock()
			delete(s.sources, targetID)
			s.mu.Unlock()
			active = false
			game = nil
		}
	}
	candidates := make(map[gameActivityGrant]bool, len(oldGrants))
	for grant := range oldGrants {
		candidates[grant] = true
	}
	// The owner can see their own currently published activity in a global
	// context. CanPublish still gates the source, so this never bypasses opt-in
	// or visible-online requirements.
	candidates[gameActivityGrant{viewerID: targetID, serverID: ""}] = true
	if s.friends == nil || s.servers == nil {
		active = false
		game = nil
	} else {
		friends, err := s.friends.ListFriends(ctx, targetID)
		if ctx.Err() != nil {
			s.revokeTargetLocked(targetID)
			return
		}
		if err == nil {
			for _, friend := range friends {
				if friend.Status == models.FriendshipStatusAccepted {
					candidates[gameActivityGrant{friend.UserID, ""}] = true
				}
			}
		}
		servers, err := s.servers.GetUserServers(ctx, targetID)
		if ctx.Err() != nil {
			s.revokeTargetLocked(targetID)
			return
		}
		if err == nil {
			for _, server := range servers {
				if ctx.Err() != nil {
					s.revokeTargetLocked(targetID)
					return
				}
				members, memberErr := s.servers.ListMemberIDs(ctx, server.ID)
				if ctx.Err() != nil {
					s.revokeTargetLocked(targetID)
					return
				}
				if memberErr == nil {
					for _, viewer := range members {
						candidates[gameActivityGrant{viewer, server.ID}] = true
					}
				}
			}
		}
	}
	stateChanged := oldPublished.active != active || (active && (oldPublished.game == nil || game == nil || oldPublished.game.ID != game.ID || oldPublished.game.Name != game.Name || oldPublished.game.CanonicalGameID != game.CanonicalGameID || oldPublished.game.StartedAt != game.StartedAt))
	next := map[gameActivityGrant]bool{}
	for grant := range candidates {
		if ctx.Err() != nil {
			s.revokeTargetLocked(targetID)
			return
		}
		if grant.viewerID == "" {
			continue
		}
		allowed := false
		if active {
			var err error
			allowed, err = s.policy.CanView(ctx, grant.viewerID, targetID, grant.serverID)
			if err != nil {
				allowed = false
			}
		}
		if ctx.Err() != nil {
			s.revokeTargetLocked(targetID)
			return
		}
		if allowed {
			next[grant] = true
			if stateChanged || !oldGrants[grant] {
				liveTransition := len(transition) == 1 && grant.serverID == "" && grant.viewerID != targetID && s.isSelectedActivityTransition(targetID, transition[0])
				s.deliverActivityTransition(grant.viewerID, targetID, grant.serverID, game, liveTransition)
			}
		} else if oldGrants[grant] {
			s.deliver(grant.viewerID, targetID, grant.serverID, nil)
		}
	}
	s.mu.Lock()
	if len(next) == 0 {
		delete(s.grants, targetID)
	} else {
		s.grants[targetID] = next
	}
	s.published[targetID] = gameActivityPublished{game: game, active: active}
	s.mu.Unlock()
}

// revokeTargetLocked revokes every known grant without relying on another DB
// read. It is used on cancellation and is therefore safe under fail-closed
// repository/time-budget errors.
func (s *GameActivityService) revokeTargetLocked(targetID string) {
	s.mu.Lock()
	grants := s.grants[targetID]
	delete(s.grants, targetID)
	s.published[targetID] = gameActivityPublished{}
	s.mu.Unlock()
	for grant := range grants {
		s.deliver(grant.viewerID, targetID, grant.serverID, nil)
	}
}

func (s *GameActivityService) deliver(viewerID, targetID, serverID string, game *ws.GameActivityGame) {
	s.deliverActivityTransition(viewerID, targetID, serverID, game, false)
}

func (s *GameActivityService) contextsForViewer(ctx context.Context, targetID, viewerID string) []string {
	if viewerID == targetID {
		return []string{""}
	}
	result := []string{}
	if s.friends != nil {
		if friends, err := s.friends.ListFriends(ctx, targetID); err == nil {
			for _, f := range friends {
				if f.UserID == viewerID && f.Status == models.FriendshipStatusAccepted {
					result = append(result, "")
					break
				}
			}
		}
	}
	if s.servers != nil {
		if servers, err := s.servers.GetUserServers(ctx, targetID); err == nil {
			for _, server := range servers {
				if member, err := s.servers.IsMember(ctx, server.ID, viewerID); err == nil && member {
					result = append(result, server.ID)
				}
			}
		}
	}
	return result
}

func (s *GameActivityService) selectedLocked(userID string, now time.Time) (*ws.GameActivityGame, time.Time, bool) {
	var selected *gameActivitySource
	for _, source := range s.sources[userID] {
		if !now.Before(source.leaseUntil) {
			continue
		}
		if selected == nil || source.changedAt.After(selected.changedAt) {
			copy := source
			selected = &copy
		}
	}
	if selected == nil {
		return nil, time.Time{}, false
	}
	return &ws.GameActivityGame{ID: selected.game.ID, Name: selected.game.Name, CanonicalGameID: selected.game.CanonicalGameID, StartedAt: selected.changedAt.Format(time.RFC3339Nano)}, selected.changedAt, true
}
