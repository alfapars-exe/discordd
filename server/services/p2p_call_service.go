package services

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/argeinfina/hichat/ws"

	"github.com/google/uuid"
)

var p2pLogger = logx.Component("service.p2p_call")

// ISP interfaces — minimal deps instead of full repositories.

// FriendChecker verifies friendship between two users.
type FriendChecker interface {
	GetByPair(ctx context.Context, userID, friendID string) (*models.Friendship, error)
}

// UserInfoGetter retrieves user info by ID.
type UserInfoGetter interface {
	GetByID(ctx context.Context, id string) (*models.User, error)
}

// P2PAppLogger writes structured logs. ISP to avoid circular dependency.
type P2PAppLogger interface {
	Log(ctx context.Context, level models.LogLevel, category models.LogCategory, userID, serverID *string, message string, metadata map[string]string)
}

type P2PCallService interface {
	InitiateCall(callerID, receiverID string, callType models.P2PCallType) error
	AcceptCall(userID, callID string) error
	DeclineCall(userID, callID string) error
	EndCall(userID string) error
	RelaySignal(senderID, callID string, signal ws.P2PSignalData) error
	HandleDisconnect(userID string)
	GetUserCall(userID string) *models.P2PCall
	SetAppLogger(logger P2PAppLogger)
}

type p2pCallTimer interface{ Stop() bool }
type p2pAfterFunc func(time.Duration, func()) p2pCallTimer

type P2PCallEmailConfigurer interface {
	SetEmailEnqueuer(EmailEnqueuer)
}

const p2pRingTimeout = 30 * time.Second

type p2pCallService struct {
	friendChecker FriendChecker
	userGetter    UserInfoGetter
	hub           ws.BroadcastAndOnline
	appLogger     P2PAppLogger

	// In-memory state, cleared on server restart.
	activeCalls   map[string]*models.P2PCall // callID -> call
	userCalls     map[string]string          // userID -> callID (max 1 call per user)
	signals       map[string]map[string]p2pSignalRevision
	timers        map[string]p2pCallTimer
	ringTimeout   time.Duration
	afterFunc     p2pAfterFunc
	emailEnqueuer EmailEnqueuer
	mu            sync.RWMutex
}

func (s *p2pCallService) SetEmailEnqueuer(enqueuer EmailEnqueuer) {
	s.mu.Lock()
	s.emailEnqueuer = enqueuer
	s.mu.Unlock()
}

func (s *p2pCallService) SetAppLogger(logger P2PAppLogger) {
	s.appLogger = logger
}

// context.Background(): logError's callers span request-handling and
// WS-disconnect-driven cleanup, not all of which carry a request-scoped
// context that's still relevant by the time the log fires. Threading ctx
// through every caller is out of scope for P3.8 — see AppLogService.Log's
// doc comment.
func (s *p2pCallService) logError(userID *string, message string, metadata map[string]string) {
	if s.appLogger != nil {
		s.appLogger.Log(context.Background(), models.LogLevelError, models.LogCategoryVoice, userID, nil, message, metadata)
	}
}

func NewP2PCallService(
	friendChecker FriendChecker,
	userGetter UserInfoGetter,
	hub ws.BroadcastAndOnline,
) P2PCallService {
	return &p2pCallService{
		friendChecker: friendChecker,
		userGetter:    userGetter,
		hub:           hub,
		activeCalls:   make(map[string]*models.P2PCall),
		userCalls:     make(map[string]string),
		timers:        make(map[string]p2pCallTimer),
		signals:       make(map[string]map[string]p2pSignalRevision),
		ringTimeout:   p2pRingTimeout,
		afterFunc:     func(d time.Duration, fn func()) p2pCallTimer { return time.AfterFunc(d, fn) },
	}
}

func (s *p2pCallService) InitiateCall(callerID, receiverID string, callType models.P2PCallType) error {
	if callerID == receiverID {
		return fmt.Errorf("%w: cannot call yourself", pkg.ErrBadRequest)
	}

	ctx := context.Background()
	friendship, err := s.friendChecker.GetByPair(ctx, callerID, receiverID)
	if err != nil {
		return fmt.Errorf("%w: not friends", pkg.ErrForbidden)
	}
	if friendship.Status != models.FriendshipStatusAccepted {
		return fmt.Errorf("%w: not friends", pkg.ErrForbidden)
	}

	s.mu.Lock()
	_, callerBusy := s.userCalls[callerID]
	_, receiverBusy := s.userCalls[receiverID]

	if callerBusy {
		s.mu.Unlock()
		return fmt.Errorf("%w: already in a call", pkg.ErrBadRequest)
	}

	// Send busy signal if receiver is in another call
	if receiverBusy {
		s.mu.Unlock()
		s.hub.BroadcastToUser(callerID, ws.Event{
			Op:   ws.OpP2PCallBusy,
			Data: map[string]string{"receiver_id": receiverID},
		})
		return fmt.Errorf("%w: user is busy", pkg.ErrBadRequest)
	}

	call := &models.P2PCall{
		ID:         uuid.New().String(),
		CallerID:   callerID,
		ReceiverID: receiverID,
		CallType:   callType,
		Status:     models.P2PCallStatusRinging,
		CreatedAt:  time.Now().UTC(),
	}

	s.activeCalls[call.ID] = call
	s.userCalls[callerID] = call.ID // Reserve both parties through ringing to prevent duplicate calls.
	s.userCalls[receiverID] = call.ID
	s.mu.Unlock()

	p2pLogger.Info("call initiated", "caller_id", callerID, "receiver_id", receiverID, "call_type", callType, "call_id", call.ID)

	caller, err := s.userGetter.GetByID(ctx, callerID)
	if err != nil {
		s.cleanupCall(call.ID)
		s.logError(&callerID, "P2P call initiate: caller lookup failed", map[string]string{
			"call_id": call.ID, "error": pkg.ErrText(err),
		})
		return err
	}
	receiver, err := s.userGetter.GetByID(ctx, receiverID)
	if err != nil {
		s.cleanupCall(call.ID)
		s.logError(&callerID, "P2P call initiate: receiver lookup failed", map[string]string{
			"call_id": call.ID, "receiver_id": receiverID, "error": pkg.ErrText(err),
		})
		return err
	}

	s.mu.RLock()
	if s.activeCalls[call.ID] != call {
		s.mu.RUnlock()
		return fmt.Errorf("%w: call ended during initialization", pkg.ErrNotFound)
	}
	broadcast := s.buildBroadcast(call, caller, receiver)
	s.mu.RUnlock()

	// Notify both parties
	s.hub.BroadcastToUser(receiverID, ws.Event{
		Op:   ws.OpP2PCallInitiate,
		Data: broadcast,
	})
	s.hub.BroadcastToUser(callerID, ws.Event{
		Op:   ws.OpP2PCallInitiate,
		Data: broadcast,
	})

	// The server owns the ring deadline. Start the timer after the invite has
	// been delivered, and only if the call is still ringing (a fast accept or
	// decline may already have won while broadcasts were dispatched).
	s.mu.Lock()
	if s.activeCalls[call.ID] == call && call.Status == models.P2PCallStatusRinging {
		timer := s.afterFunc(s.ringTimeout, func() { s.expireRingingCall(call.ID, call) })
		s.timers[call.ID] = timer
	} else {
		s.mu.Unlock()
		return nil
	}
	s.mu.Unlock()

	return nil
}

func (s *p2pCallService) AcceptCall(userID, callID string) error {
	s.mu.Lock()
	call, exists := s.activeCalls[callID]
	if !exists {
		s.mu.Unlock()
		return fmt.Errorf("%w: call not found", pkg.ErrNotFound)
	}

	if call.ReceiverID != userID {
		s.mu.Unlock()
		return fmt.Errorf("%w: only receiver can accept", pkg.ErrForbidden)
	}

	if call.Status != models.P2PCallStatusRinging {
		s.mu.Unlock()
		return fmt.Errorf("%w: call is not ringing", pkg.ErrBadRequest)
	}

	call.Status = models.P2PCallStatusActive
	s.userCalls[userID] = callID
	s.stopCallTimerLocked(callID)
	s.mu.Unlock()

	p2pLogger.Info("call accepted", "user_id", userID, "call_id", callID)

	// Notify caller to start WebRTC negotiation
	s.hub.BroadcastToUser(call.CallerID, ws.Event{
		Op:   ws.OpP2PCallAccept,
		Data: map[string]string{"call_id": callID},
	})
	s.hub.BroadcastToUser(userID, ws.Event{
		Op:   ws.OpP2PCallAccept,
		Data: map[string]string{"call_id": callID},
	})

	return nil
}

// DeclineCall declines an incoming call or cancels an outgoing one.
func (s *p2pCallService) DeclineCall(userID, callID string) error {
	s.mu.Lock()
	call, exists := s.activeCalls[callID]
	if !exists {
		s.mu.Unlock()
		return fmt.Errorf("%w: call not found", pkg.ErrNotFound)
	}

	if call.CallerID != userID && call.ReceiverID != userID {
		s.mu.Unlock()
		return fmt.Errorf("%w: not part of this call", pkg.ErrForbidden)
	}

	delete(s.activeCalls, callID)
	delete(s.signals, callID)
	s.stopCallTimerLocked(callID)
	delete(s.userCalls, call.CallerID)
	delete(s.userCalls, call.ReceiverID)
	s.mu.Unlock()

	p2pLogger.Info("call declined", "user_id", userID, "call_id", callID)

	otherUserID := call.CallerID
	if call.CallerID == userID {
		otherUserID = call.ReceiverID
	}

	s.hub.BroadcastToUser(otherUserID, ws.Event{
		Op:   ws.OpP2PCallDecline,
		Data: map[string]string{"call_id": callID},
	})

	return nil
}

func (s *p2pCallService) EndCall(userID string) error {
	s.mu.RLock()
	callID, exists := s.userCalls[userID]
	s.mu.RUnlock()

	if !exists {
		return fmt.Errorf("%w: not in a call", pkg.ErrBadRequest)
	}

	s.mu.Lock()
	call, exists := s.activeCalls[callID]
	if !exists {
		s.mu.Unlock()
		return fmt.Errorf("%w: call not found", pkg.ErrNotFound)
	}

	delete(s.activeCalls, callID)
	delete(s.signals, callID)
	s.stopCallTimerLocked(callID)
	delete(s.userCalls, call.CallerID)
	delete(s.userCalls, call.ReceiverID)
	s.mu.Unlock()

	p2pLogger.Info("call ended", "user_id", userID, "call_id", callID)

	otherUserID := call.CallerID
	if call.CallerID == userID {
		otherUserID = call.ReceiverID
	}

	s.hub.BroadcastToUser(otherUserID, ws.Event{
		Op:   ws.OpP2PCallEnd,
		Data: map[string]string{"call_id": callID},
	})

	return nil
}

type p2pSignalRevision struct {
	revision      uint64
	descriptionID string
	pendingOffer  string
}

// RelaySignal validates authenticated call membership and optional v1 revision
// relationships under the call lock; network delivery never runs under it.
func (s *p2pCallService) RelaySignal(senderID, callID string, signal ws.P2PSignalData) error {
	if signal.CallID != callID {
		return fmt.Errorf("%w: call mismatch", pkg.ErrBadRequest)
	}
	if err := signal.Validate(); err != nil {
		return fmt.Errorf("%w: invalid signal", pkg.ErrBadRequest)
	}
	s.mu.Lock()
	call, exists := s.activeCalls[callID]
	if !exists {
		s.mu.Unlock()
		return fmt.Errorf("%w: call not found", pkg.ErrNotFound)
	}
	if call.Status != models.P2PCallStatusActive || (call.CallerID != senderID && call.ReceiverID != senderID) || s.userCalls[senderID] != callID || s.userCalls[call.CallerID] != callID || s.userCalls[call.ReceiverID] != callID {
		s.mu.Unlock()
		return fmt.Errorf("%w: not an active call participant", pkg.ErrForbidden)
	}
	otherUserID := call.CallerID
	if otherUserID == senderID {
		otherUserID = call.ReceiverID
	}
	if signal.MediaProtocol == 1 {
		peers := s.signals[callID]
		if peers == nil {
			peers = make(map[string]p2pSignalRevision)
		}
		prior, other := peers[senderID], peers[otherUserID]
		if signal.DescriptionRevision <= prior.revision || signal.DescriptionID == prior.descriptionID || signal.DescriptionID == other.descriptionID {
			s.mu.Unlock()
			return fmt.Errorf("%w: stale description", pkg.ErrConflict)
		}
		if signal.Type == "answer" {
			if other.pendingOffer == "" || other.pendingOffer != signal.ReplyToDescriptionID {
				s.mu.Unlock()
				return fmt.Errorf("%w: unrelated answer", pkg.ErrConflict)
			}
			other.pendingOffer = ""
			peers[otherUserID] = other
		}
		prior.revision = signal.DescriptionRevision
		prior.descriptionID = signal.DescriptionID
		prior.pendingOffer = ""
		if signal.Type == "offer" {
			prior.pendingOffer = signal.DescriptionID
		}
		peers[senderID] = prior
		s.signals[callID] = peers
	} else if peers := s.signals[callID]; peers != nil && signal.Type != "ice-candidate" {
		// A legacy description replaces/consumes any previous v1 offer relation.
		// Keep revision high-water marks: compatibility must not revive old IDs.
		actor := senderID
		if signal.Type == "answer" {
			actor = otherUserID
		}
		prior := peers[actor]
		prior.pendingOffer = ""
		peers[actor] = prior
	}
	s.mu.Unlock()
	s.hub.BroadcastToUser(otherUserID, ws.Event{Op: ws.OpP2PSignal, Data: signal})
	return nil
}

// HandleDisconnect cleans up active call when a user's WS connection drops.
func (s *p2pCallService) HandleDisconnect(userID string) {
	s.mu.RLock()
	callID, exists := s.userCalls[userID]
	s.mu.RUnlock()

	if !exists {
		return
	}

	s.mu.Lock()
	call, exists := s.activeCalls[callID]
	if !exists {
		s.mu.Unlock()
		return
	}

	delete(s.activeCalls, callID)
	delete(s.signals, callID)
	s.stopCallTimerLocked(callID)
	delete(s.userCalls, call.CallerID)
	delete(s.userCalls, call.ReceiverID)
	s.mu.Unlock()

	p2pLogger.Info("call ended due to disconnect", "user_id", userID, "call_id", callID)
	s.logError(&userID, "P2P call ended due to WS disconnect", map[string]string{
		"call_id": callID,
	})

	otherUserID := call.CallerID
	if call.CallerID == userID {
		otherUserID = call.ReceiverID
	}

	s.hub.BroadcastToUser(otherUserID, ws.Event{
		Op:   ws.OpP2PCallEnd,
		Data: map[string]string{"call_id": callID, "reason": "disconnect"},
	})
}

// GetUserCall returns the user's active call, or nil if not in a call.
func (s *p2pCallService) GetUserCall(userID string) *models.P2PCall {
	s.mu.RLock()
	defer s.mu.RUnlock()
	callID, exists := s.userCalls[userID]
	if !exists {
		return nil
	}
	call := s.activeCalls[callID]
	if call == nil {
		return nil
	}
	// Call status is mutable under mu. Never expose the live state pointer to
	// readers that may inspect it while AcceptCall changes it.
	snapshot := *call
	return &snapshot
}

// cleanupCall removes call state on error.
func (s *p2pCallService) cleanupCall(callID string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	call, exists := s.activeCalls[callID]
	if !exists {
		return
	}

	delete(s.activeCalls, callID)
	delete(s.signals, callID)
	s.stopCallTimerLocked(callID)
	delete(s.userCalls, call.CallerID)
	delete(s.userCalls, call.ReceiverID)
}

func (s *p2pCallService) stopCallTimerLocked(callID string) {
	if timer, ok := s.timers[callID]; ok {
		delete(s.timers, callID)
		timer.Stop()
	}
}

// expireRingingCall is the single server-authoritative no-answer transition.
// Pointer identity plus status under mu ensures accept/decline/end/disconnect
// and timeout have exactly one winner.
func (s *p2pCallService) expireRingingCall(callID string, expected *models.P2PCall) {
	s.mu.Lock()
	call, exists := s.activeCalls[callID]
	if !exists || call != expected || call.Status != models.P2PCallStatusRinging {
		s.mu.Unlock()
		return
	}
	delete(s.activeCalls, callID)
	delete(s.signals, callID)
	delete(s.userCalls, call.CallerID)
	delete(s.userCalls, call.ReceiverID)
	delete(s.timers, callID)
	enqueuer := s.emailEnqueuer
	s.mu.Unlock()

	end := ws.Event{Op: ws.OpP2PCallEnd, Data: map[string]string{"call_id": callID, "reason": "no_answer"}}
	s.hub.BroadcastToUser(call.CallerID, end)
	s.hub.BroadcastToUser(call.ReceiverID, end)
	if enqueuer != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		_, err := enqueuer.Enqueue(ctx, call.ReceiverID, models.EmailCategoryCommunication, "missed-call:"+callID,
			"You missed a HiChat call", "<p>You have a missed HiChat call. Open HiChat to see your recent activity.</p>")
		cancel()
		if err != nil {
			p2pLogger.Error("missed call email enqueue failed", "category", models.EmailCategoryCommunication)
		}
	}
}

func (s *p2pCallService) buildBroadcast(call *models.P2PCall, caller, receiver *models.User) models.P2PCallBroadcast {
	return models.P2PCallBroadcast{
		ID:                  call.ID,
		CallerID:            call.CallerID,
		CallerUsername:      caller.Username,
		CallerDisplayName:   caller.DisplayName,
		CallerAvatarURL:     caller.AvatarURL,
		ReceiverID:          call.ReceiverID,
		ReceiverUsername:    receiver.Username,
		ReceiverDisplayName: receiver.DisplayName,
		ReceiverAvatarURL:   receiver.AvatarURL,
		CallType:            call.CallType,
		Status:              call.Status,
		CreatedAt:           call.CreatedAt,
	}
}
