package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"

	"github.com/google/uuid"
)

var friendshipLogger = logx.Component("service.friendship")

type FriendshipService interface {
	AreFriends(ctx context.Context, userA, userB string) (bool, error)
	SendRequest(ctx context.Context, senderID string, req *models.SendFriendRequestRequest) (*models.FriendshipWithUser, error)
	AcceptRequest(ctx context.Context, userID, requestID string) (*models.FriendshipWithUser, error)
	DeclineRequest(ctx context.Context, userID, requestID string) error
	RemoveFriend(ctx context.Context, userID, targetUserID string) error
	ListFriends(ctx context.Context, userID string) ([]models.FriendshipWithUser, error)
	ListRequests(ctx context.Context, userID string) (*FriendRequestsResponse, error)
	SetDMAcceptor(acceptor DMRequestAcceptor)
	SetEmailEnqueuer(enqueuer EmailEnqueuer)
}

// DMRequestAcceptor is a minimal ISP interface for auto-accepting pending DMs.
type DMRequestAcceptor interface {
	AcceptPendingChannels(ctx context.Context, userA, userB string) error
}

// EmailEnqueuer is the minimum queue API needed for optional social email.
type EmailEnqueuer interface {
	Enqueue(ctx context.Context, userID, category, dedupeKey, subject, body string) (bool, error)
}

type FriendRequestsResponse struct {
	Incoming []models.FriendshipWithUser `json:"incoming"`
	Outgoing []models.FriendshipWithUser `json:"outgoing"`
}

type friendshipService struct {
	friendRepo    repository.FriendshipRepository
	userRepo      repository.UserRepository
	notifRepo     repository.NotificationRepository
	hub           ws.Broadcaster
	dmAcceptor    DMRequestAcceptor
	requestPolicy FriendRequestPolicy
	emailEnqueuer EmailEnqueuer
	gameActivity  GameActivityPrivacyInvalidator
}

func (s *friendshipService) SetGameActivityPrivacyInvalidator(invalidator GameActivityPrivacyInvalidator) {
	s.gameActivity = invalidator
}

func (s *friendshipService) reconcileActivityRelationship(ctx context.Context, userA, userB string) {
	if s.gameActivity != nil {
		s.gameActivity.RelationshipChanged(ctx, userA, userB)
	}
}

func NewFriendshipService(
	friendRepo repository.FriendshipRepository,
	userRepo repository.UserRepository,
	notifRepo repository.NotificationRepository,
	hub ws.Broadcaster,
	policies ...FriendRequestPolicy,
) FriendshipService {
	service := &friendshipService{
		friendRepo: friendRepo,
		userRepo:   userRepo,
		notifRepo:  notifRepo,
		hub:        hub,
	}
	if len(policies) > 0 {
		service.requestPolicy = policies[0]
	}
	return service
}

func (s *friendshipService) SetDMAcceptor(acceptor DMRequestAcceptor) {
	s.dmAcceptor = acceptor
}

func (s *friendshipService) SetEmailEnqueuer(enqueuer EmailEnqueuer) {
	s.emailEnqueuer = enqueuer
}

// AreFriends checks if two users have an accepted friendship. Satisfies FriendChecker ISP.
func (s *friendshipService) AreFriends(ctx context.Context, userA, userB string) (bool, error) {
	f, err := s.friendRepo.GetByPair(ctx, userA, userB)
	if err != nil {
		if errors.Is(err, pkg.ErrNotFound) {
			return false, nil
		}
		return false, err
	}
	return f.Status == models.FriendshipStatusAccepted, nil
}

func (s *friendshipService) SendRequest(ctx context.Context, senderID string, req *models.SendFriendRequestRequest) (*models.FriendshipWithUser, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, pkg.ErrText(err))
	}

	target, err := s.userRepo.GetByUsername(ctx, req.Username)
	if err != nil {
		if errors.Is(err, pkg.ErrNotFound) {
			return nil, fmt.Errorf("%w: user %q not found", pkg.ErrNotFound, req.Username)
		}
		return nil, err
	}

	if senderID == target.ID {
		return nil, fmt.Errorf("%w: cannot send friend request to yourself", pkg.ErrBadRequest)
	}

	existing, err := s.friendRepo.GetByPair(ctx, senderID, target.ID)
	if err != nil && !errors.Is(err, pkg.ErrNotFound) {
		return nil, err
	}

	if existing != nil {
		switch existing.Status {
		case models.FriendshipStatusAccepted:
			return nil, fmt.Errorf("%w: already friends with %s", pkg.ErrAlreadyExists, req.Username)
		case models.FriendshipStatusPending:
			// Mutual request: other party already sent one -> auto-accept
			if existing.UserID == target.ID {
				return s.acceptExisting(ctx, existing, senderID)
			}
			return nil, fmt.Errorf("%w: friend request already sent to %s", pkg.ErrAlreadyExists, req.Username)
		case models.FriendshipStatusBlocked:
			// Don't reveal blocked state
			return nil, fmt.Errorf("%w: user %q not found", pkg.ErrNotFound, req.Username)
		}
	}

	if s.requestPolicy != nil {
		allowed, err := s.requestPolicy.CanSend(ctx, senderID, target.ID)
		if err != nil {
			return nil, fmt.Errorf("failed to evaluate friend request policy: %w", err)
		}
		if !allowed {
			return nil, fmt.Errorf("%w: this user is not accepting friend requests from you", pkg.ErrForbidden)
		}
	}

	now := time.Now().UTC()
	friendship := &models.Friendship{
		ID:        uuid.New().String(),
		UserID:    senderID,
		FriendID:  target.ID,
		Status:    models.FriendshipStatusPending,
		CreatedAt: now,
		UpdatedAt: now,
	}

	if err := s.friendRepo.Create(ctx, friendship); err != nil {
		return nil, err
	}

	sender, err := s.userRepo.GetByID(ctx, senderID)
	if err != nil {
		return nil, err
	}
	s.enqueueFriendRequestEmail(target.ID, friendship.ID)

	result := &models.FriendshipWithUser{
		ID:               friendship.ID,
		Status:           friendship.Status,
		CreatedAt:        friendship.CreatedAt,
		UserID:           target.ID,
		Username:         target.Username,
		DisplayName:      target.DisplayName,
		AvatarURL:        target.AvatarURL,
		UserStatus:       string(target.Status),
		UserCustomStatus: target.CustomStatus,
	}

	// Notify target
	s.hub.BroadcastToUser(target.ID, ws.Event{
		Op: ws.OpFriendRequestCreate,
		Data: models.FriendshipWithUser{
			ID:               friendship.ID,
			Status:           friendship.Status,
			CreatedAt:        friendship.CreatedAt,
			UserID:           sender.ID,
			Username:         sender.Username,
			DisplayName:      sender.DisplayName,
			AvatarURL:        sender.AvatarURL,
			UserStatus:       string(sender.Status),
			UserCustomStatus: sender.CustomStatus,
		},
	})

	// Inbox row for the target — best-effort: the request itself already
	// persisted and was pushed above, so a notifications write failure is
	// logged, not surfaced. The mutual auto-accept path (acceptExisting)
	// deliberately writes no inbox row.
	notif := &models.Notification{
		UserID:  target.ID,
		Kind:    models.NotificationKindFriendRequest,
		ActorID: &sender.ID,
		Payload: json.RawMessage(fmt.Sprintf(`{"friendship_id":%q}`, friendship.ID)),
	}
	if err := s.notifRepo.Create(ctx, notif); err != nil {
		friendshipLogger.Error("failed to write friend_request notification",
			"target_id", target.ID, "friendship_id", friendship.ID, "err", pkg.ErrText(err))
	} else {
		notif.Actor = models.ToPublicUser(sender)
		broadcastNotificationCreate(s.hub, notif)
	}

	return result, nil
}

func (s *friendshipService) enqueueFriendRequestEmail(targetID, friendshipID string) {
	s.enqueueFriendshipEmail(targetID, friendshipID, "request", "New friend request", "<p>You have a new friend request. Open HiChat to review and respond.</p>")
}

func (s *friendshipService) enqueueFriendshipAcceptedEmail(targetID, friendshipID string) {
	s.enqueueFriendshipEmail(targetID, friendshipID, "accepted", "Friend request accepted", "<p>Your friend request was accepted. Open HiChat to start chatting.</p>")
}

func (s *friendshipService) enqueueFriendshipEmail(targetID, friendshipID, event, subject, body string) {
	if s.emailEnqueuer == nil {
		return
	}
	contextual, ok := s.emailEnqueuer.(ScheduledEmailEnqueuer)
	if !ok {
		// Fail closed rather than create an unbound social email that cannot
		// recheck whether the underlying friendship event is still current.
		friendshipLogger.Error("friendship email enqueuer lacks event-context support", "event", event)
		return
	}
	mailCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if _, err := contextual.EnqueueWithOptions(
		mailCtx,
		targetID,
		models.EmailCategorySocial,
		"friend-"+event+":"+friendshipID,
		subject,
		body,
		EmailEnqueueOptions{FriendshipID: friendshipID, FriendshipEvent: event},
	); err != nil {
		// Event identifiers, addresses and error content are deliberately omitted.
		friendshipLogger.Error("failed to enqueue friendship email", "event", event)
	}
}

// acceptExisting auto-accepts a mutual friend request.
func (s *friendshipService) acceptExisting(ctx context.Context, existing *models.Friendship, acceptorID string) (*models.FriendshipWithUser, error) {
	if err := s.friendRepo.UpdateStatus(ctx, existing.ID, models.FriendshipStatusAccepted); err != nil {
		return nil, err
	}
	s.enqueueFriendshipAcceptedEmail(existing.UserID, existing.ID)

	sender, err := s.userRepo.GetByID(ctx, existing.UserID)
	if err != nil {
		return nil, err
	}
	acceptor, err := s.userRepo.GetByID(ctx, acceptorID)
	if err != nil {
		return nil, err
	}

	// Notify original sender
	s.hub.BroadcastToUser(existing.UserID, ws.Event{
		Op: ws.OpFriendRequestAccept,
		Data: models.FriendshipWithUser{
			ID:               existing.ID,
			Status:           models.FriendshipStatusAccepted,
			CreatedAt:        existing.CreatedAt,
			UserID:           acceptor.ID,
			Username:         acceptor.Username,
			DisplayName:      acceptor.DisplayName,
			AvatarURL:        acceptor.AvatarURL,
			UserStatus:       string(acceptor.Status),
			UserCustomStatus: acceptor.CustomStatus,
		},
	})

	// Auto-accept any pending DM requests between the two users
	if s.dmAcceptor != nil {
		_ = s.dmAcceptor.AcceptPendingChannels(ctx, existing.UserID, acceptorID)
	}

	// The acceptor was the recipient of the existing request; their inbox
	// row for it is now stale (best-effort, see settleRequestNotifications).
	ids, markErr := s.notifRepo.MarkFriendRequestRead(ctx, acceptorID, existing.UserID)
	settleRequestNotifications(ctx, s.notifRepo, s.hub, acceptorID, ids, markErr)

	return &models.FriendshipWithUser{
		ID:               existing.ID,
		Status:           models.FriendshipStatusAccepted,
		CreatedAt:        existing.CreatedAt,
		UserID:           sender.ID,
		Username:         sender.Username,
		DisplayName:      sender.DisplayName,
		AvatarURL:        sender.AvatarURL,
		UserStatus:       string(sender.Status),
		UserCustomStatus: sender.CustomStatus,
	}, nil
}

func (s *friendshipService) AcceptRequest(ctx context.Context, userID, requestID string) (*models.FriendshipWithUser, error) {
	friendship, err := s.friendRepo.GetByID(ctx, requestID)
	if err != nil {
		return nil, err
	}

	// Only the recipient can accept
	if friendship.FriendID != userID {
		return nil, fmt.Errorf("%w: you can only accept requests sent to you", pkg.ErrForbidden)
	}

	if friendship.Status != models.FriendshipStatusPending {
		return nil, fmt.Errorf("%w: request is not pending", pkg.ErrBadRequest)
	}

	if err := s.friendRepo.UpdateStatus(ctx, requestID, models.FriendshipStatusAccepted); err != nil {
		return nil, err
	}
	s.reconcileActivityRelationship(ctx, friendship.UserID, friendship.FriendID)
	s.enqueueFriendshipAcceptedEmail(friendship.UserID, friendship.ID)

	sender, err := s.userRepo.GetByID(ctx, friendship.UserID)
	if err != nil {
		return nil, err
	}

	acceptor, err := s.userRepo.GetByID(ctx, userID)
	if err != nil {
		return nil, err
	}

	// Notify sender
	s.hub.BroadcastToUser(friendship.UserID, ws.Event{
		Op: ws.OpFriendRequestAccept,
		Data: models.FriendshipWithUser{
			ID:               friendship.ID,
			Status:           models.FriendshipStatusAccepted,
			CreatedAt:        friendship.CreatedAt,
			UserID:           acceptor.ID,
			Username:         acceptor.Username,
			DisplayName:      acceptor.DisplayName,
			AvatarURL:        acceptor.AvatarURL,
			UserStatus:       string(acceptor.Status),
			UserCustomStatus: acceptor.CustomStatus,
		},
	})

	// Auto-accept any pending DM requests between the two users
	if s.dmAcceptor != nil {
		_ = s.dmAcceptor.AcceptPendingChannels(ctx, friendship.UserID, friendship.FriendID)
	}

	// The recipient just acted on the request; retire their inbox row for
	// it (best-effort, see settleRequestNotifications).
	ids, markErr := s.notifRepo.MarkFriendRequestRead(ctx, friendship.FriendID, friendship.UserID)
	settleRequestNotifications(ctx, s.notifRepo, s.hub, friendship.FriendID, ids, markErr)

	return &models.FriendshipWithUser{
		ID:               friendship.ID,
		Status:           models.FriendshipStatusAccepted,
		CreatedAt:        friendship.CreatedAt,
		UserID:           sender.ID,
		Username:         sender.Username,
		DisplayName:      sender.DisplayName,
		AvatarURL:        sender.AvatarURL,
		UserStatus:       string(sender.Status),
		UserCustomStatus: sender.CustomStatus,
	}, nil
}

// DeclineRequest declines or cancels a friend request. Both sender and recipient can do this.
func (s *friendshipService) DeclineRequest(ctx context.Context, userID, requestID string) error {
	friendship, err := s.friendRepo.GetByID(ctx, requestID)
	if err != nil {
		return err
	}

	if friendship.UserID != userID && friendship.FriendID != userID {
		return fmt.Errorf("%w: not your friend request", pkg.ErrForbidden)
	}

	if friendship.Status != models.FriendshipStatusPending {
		return fmt.Errorf("%w: request is not pending", pkg.ErrBadRequest)
	}

	if err := s.friendRepo.Delete(ctx, requestID); err != nil {
		return err
	}

	// Notify the other party
	otherUserID := friendship.UserID
	if friendship.UserID == userID {
		otherUserID = friendship.FriendID
	}

	s.hub.BroadcastToUser(otherUserID, ws.Event{
		Op: ws.OpFriendRequestDecline,
		Data: map[string]string{
			"id":      requestID,
			"user_id": userID,
		},
	})

	// Whether the recipient declined or the sender cancelled, the
	// recipient's (FriendID) inbox row for this request is now stale
	// (best-effort, see settleRequestNotifications).
	ids, markErr := s.notifRepo.MarkFriendRequestRead(ctx, friendship.FriendID, friendship.UserID)
	settleRequestNotifications(ctx, s.notifRepo, s.hub, friendship.FriendID, ids, markErr)

	return nil
}

func (s *friendshipService) RemoveFriend(ctx context.Context, userID, targetUserID string) error {
	friendship, err := s.friendRepo.GetByPair(ctx, userID, targetUserID)
	if err != nil {
		return err
	}

	if friendship.Status != models.FriendshipStatusAccepted {
		return fmt.Errorf("%w: not friends with this user", pkg.ErrBadRequest)
	}

	if err := s.friendRepo.DeleteByPair(ctx, userID, targetUserID); err != nil {
		return err
	}
	s.reconcileActivityRelationship(ctx, userID, targetUserID)

	s.hub.BroadcastToUser(targetUserID, ws.Event{
		Op: ws.OpFriendRemove,
		Data: map[string]string{
			"user_id": userID,
		},
	})

	return nil
}

func (s *friendshipService) ListFriends(ctx context.Context, userID string) ([]models.FriendshipWithUser, error) {
	friends, err := s.friendRepo.ListFriends(ctx, userID)
	if err != nil {
		return nil, err
	}

	if friends == nil {
		friends = []models.FriendshipWithUser{}
	}
	return friends, nil
}

func (s *friendshipService) ListRequests(ctx context.Context, userID string) (*FriendRequestsResponse, error) {
	incoming, err := s.friendRepo.ListIncoming(ctx, userID)
	if err != nil {
		return nil, err
	}

	outgoing, err := s.friendRepo.ListOutgoing(ctx, userID)
	if err != nil {
		return nil, err
	}

	if incoming == nil {
		incoming = []models.FriendshipWithUser{}
	}
	if outgoing == nil {
		outgoing = []models.FriendshipWithUser{}
	}

	return &FriendRequestsResponse{
		Incoming: incoming,
		Outgoing: outgoing,
	}, nil
}
