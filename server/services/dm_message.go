// Package services — DM message CRUD.
// Privacy enforcement (block / friends_only / message_request) lives in
// SendMessage; broadcasts are deferred to BroadcastCreate so attachments
// uploaded at the handler layer ship together with the message event.
package services

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
)

const (
	unreadDMEmailDelay = 10 * time.Minute
	unreadDMEmailTTL   = 24 * time.Hour
)

func (s *dmService) GetMessages(ctx context.Context, userID, channelID string, beforeID string, limit int) (*models.DMMessagePage, error) {
	if limit <= 0 || limit > 100 {
		limit = 50
	}

	if _, err := s.verifyChannelMembership(ctx, userID, channelID); err != nil {
		return nil, err
	}

	messages, err := s.dmRepo.GetMessages(ctx, channelID, beforeID, limit+1)
	if err != nil {
		return nil, fmt.Errorf("failed to get DM messages: %w", err)
	}

	hasMore := len(messages) > limit
	if hasMore {
		messages = messages[:limit]
	}

	// Reverse: DB returns DESC, frontend expects ASC
	for i, j := 0, len(messages)-1; i < j; i, j = i+1, j-1 {
		messages[i], messages[j] = messages[j], messages[i]
	}

	if err := s.enrichMessages(ctx, messages); err != nil {
		return nil, err
	}

	if messages == nil {
		messages = []models.DMMessage{}
	}

	return &models.DMMessagePage{
		Messages: messages,
		HasMore:  hasMore,
	}, nil
}

// SendMessage creates a DM message. WS broadcast is done via BroadcastCreate after file uploads.
func (s *dmService) SendMessage(ctx context.Context, userID, channelID string, req *models.CreateDMMessageRequest) (*models.DMMessage, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, pkg.ErrText(err))
	}

	channel, err := s.verifyChannelMembership(ctx, userID, channelID)
	if err != nil {
		return nil, err
	}

	otherUserID := channel.User1ID
	if channel.User1ID == userID {
		otherUserID = channel.User2ID
	}
	// Self-DM ("notes to self", dm_self.go): both participants are the
	// caller, so there is nobody to block, no privacy/request gate to pass
	// and no recipient whose unread counter should move.
	isSelf := otherUserID == userID

	sender, _ := s.userRepo.GetByID(ctx, userID)
	isPlatformAdmin := sender != nil && sender.IsPlatformAdmin

	// becamePending records whether THIS call flipped the channel to
	// pending (the message-request transition below) — the one case that
	// earns the recipient a dm_request inbox row.
	becamePending := false
	serverDMNonFriend := false

	// Bidirectional block check — platform admins bypass
	if !isSelf && !isPlatformAdmin && s.blockChecker != nil {
		blocked, err := s.blockChecker.IsBlocked(ctx, userID, otherUserID)
		if err != nil {
			return nil, fmt.Errorf("failed to check block status: %w", err)
		}
		if blocked {
			return nil, fmt.Errorf("%w: cannot send message to blocked user", pkg.ErrForbidden)
		}
	}

	// DM privacy + request enforcement
	requestHash := ""
	if req.ClientMessageID != "" {
		encoded, err := json.Marshal(req)
		if err != nil {
			return nil, err
		}
		requestHash = fmt.Sprintf("%x", sha256.Sum256(encoded))
		receipts, ok := s.dmRepo.(repository.DMSendReceipts)
		if !ok {
			return nil, fmt.Errorf("%w: dm_send_receipts_unavailable", pkg.ErrBadRequest)
		}
		previous, err := receipts.FindDMSend(ctx, channelID, userID, req.ClientMessageID, requestHash)
		if err != nil || previous != nil {
			return previous, err
		}
	}

	if !isPlatformAdmin && !isSelf {
		if channel.Status == models.DMStatusPending {
			// Fail-closed on a pending channel with a nil InitiatedBy:
			// the earlier code checked "InitiatedBy != nil && …" in BOTH
			// branches, so a pending row with InitiatedBy=NULL (data
			// corruption, a failed SetInitiatedBy at line ~124, or a
			// migration gap) fell through both guards and turned the
			// channel into a normal-send row. Every write to the DB
			// after that would land without ever triggering the
			// request-accept flow, and the recipient still saw the
			// channel as "pending" — the guard is only meaningful when
			// it rejects the write.
			if channel.InitiatedBy == nil {
				return nil, fmt.Errorf("%w: dm_request_not_accepted", pkg.ErrForbidden)
			}
			// Initiator already sent their 1 message — must wait for accept.
			if *channel.InitiatedBy == userID {
				return nil, fmt.Errorf("%w: dm_request_pending", pkg.ErrForbidden)
			}
			// Recipient must accept before replying.
			return nil, fmt.Errorf("%w: dm_request_not_accepted", pkg.ErrForbidden)
		}

		// Opening a DM window does not establish a conversation. Recheck the
		// recipient's current server permissions before the first message so
		// an empty channel created before a preference change cannot bypass it.
		// Channels with history stay usable, as they do in GetOrCreateChannel.
		if s.serverDMPolicy != nil {
			friends := false
			if s.friendChecker != nil {
				friends, err = s.friendChecker.AreFriends(ctx, userID, otherUserID)
				if err != nil {
					return nil, fmt.Errorf("failed to check friendship: %w", err)
				}
			}
			if !friends {
				serverDMNonFriend = true
				hasHistory, err := s.dmRepo.HasMessages(ctx, channelID)
				if err != nil {
					return nil, fmt.Errorf("failed to check DM history: %w", err)
				}
				if !hasHistory {
					allowed, err := s.serverDMPolicy.CanCreate(ctx, userID, otherUserID)
					if err != nil {
						return nil, fmt.Errorf("failed to check server DM policy: %w", err)
					}
					if !allowed {
						return nil, fmt.Errorf("%w: this user disabled direct messages from shared servers", pkg.ErrForbidden)
					}
				}
			}
		}

		// First message on an accepted channel from a non-friend → transition to pending
		if channel.Status == models.DMStatusAccepted && s.friendChecker != nil {
			recipient, err := s.userRepo.GetByID(ctx, otherUserID)
			if err != nil {
				return nil, fmt.Errorf("failed to get DM recipient privacy: %w", err)
			}
			if recipient == nil {
				return nil, fmt.Errorf("%w: DM recipient not found", pkg.ErrNotFound)
			}
			if recipient != nil && recipient.DMPrivacy == "message_request" {
				friends, err := s.friendChecker.AreFriends(ctx, userID, otherUserID)
				if err != nil {
					return nil, fmt.Errorf("failed to check friendship: %w", err)
				}
				if !friends {
					// Skip request flow if the conversation is already established:
					// the other party has sent messages, meaning the request was
					// previously accepted and a back-and-forth is in progress.
					otherMsgCount, err := s.dmRepo.CountMessagesBySender(ctx, channelID, otherUserID)
					if err != nil {
						return nil, fmt.Errorf("failed to count messages: %w", err)
					}
					if otherMsgCount == 0 {
						msgCount, err := s.dmRepo.CountMessagesBySender(ctx, channelID, userID)
						if err != nil {
							return nil, fmt.Errorf("failed to count messages: %w", err)
						}
						if msgCount == 0 {
							// Commit the request transition with the message below.
							// A rejected game grant or later write must not leave
							// a pending channel without its request message.
							channel.Status = models.DMStatusPending
							channel.InitiatedBy = &userID
							becamePending = true
						} else {
							return nil, fmt.Errorf("%w: dm_request_pending", pkg.ErrForbidden)
						}
					}
				}
			}
			// friends_only at send time: block non-friends entirely
			if recipient != nil && recipient.DMPrivacy == "friends_only" {
				friends, err := s.friendChecker.AreFriends(ctx, userID, otherUserID)
				if err != nil {
					return nil, fmt.Errorf("failed to check friendship: %w", err)
				}
				if !friends {
					return nil, fmt.Errorf("%w: this user only accepts messages from friends", pkg.ErrForbidden)
				}
			}
		}
	}

	// Reply validation
	if req.ReplyToID != nil && *req.ReplyToID != "" {
		refMsg, err := s.dmRepo.GetMessageByID(ctx, *req.ReplyToID)
		if err != nil {
			return nil, fmt.Errorf("%w: referenced message not found", pkg.ErrBadRequest)
		}
		if refMsg.DMChannelID != channelID {
			return nil, fmt.Errorf("%w: referenced message is not in this DM channel", pkg.ErrBadRequest)
		}
	}

	var contentPtr *string
	if req.Content != "" {
		contentPtr = &req.Content
	}

	msg := &models.DMMessage{
		DMChannelID:       channelID,
		UserID:            userID,
		Content:           contentPtr,
		ReplyToID:         req.ReplyToID,
		EncryptionVersion: req.EncryptionVersion,
		Ciphertext:        req.Ciphertext,
		SenderDeviceID:    req.SenderDeviceID,
		E2EEMetadata:      req.E2EEMetadata,
	}

	// Atomic write set: message INSERT + recipient unread bump + (on the
	// request transition only) the dm_request inbox row commit or roll back
	// together, so the sidebar badge can never drift from the messages the
	// recipient actually has.
	var requestNotif *models.Notification
	var incomingNotif *models.Notification
	txErr := s.txRunner.InTx(ctx, func(r *repository.DMTxRepos) error {
		if r.LockChannel != nil {
			if err := r.LockChannel(ctx, channelID); err != nil {
				return err
			}
		}
		if req.ClientMessageID != "" {
			receipts, ok := r.DM.(repository.DMSendReceipts)
			if !ok || r.LockChannel == nil {
				return fmt.Errorf("%w: dm_send_receipts_unavailable", pkg.ErrBadRequest)
			}
			previous, err := receipts.FindDMSend(ctx, channelID, userID, req.ClientMessageID, requestHash)
			if err != nil {
				return err
			}
			if previous != nil {
				msg = previous
				return nil
			}
		}
		if r.LockChannel != nil && !isPlatformAdmin && !isSelf {
			// A concurrent first send may have made our preflight snapshot pending.
			current, err := r.DM.GetChannelByID(ctx, channelID)
			if err != nil {
				return err
			}
			if current.Status == models.DMStatusPending {
				if current.InitiatedBy != nil && *current.InitiatedBy == userID {
					return fmt.Errorf("%w: dm_request_pending", pkg.ErrForbidden)
				}
				return fmt.Errorf("%w: dm_request_not_accepted", pkg.ErrForbidden)
			}
		}
		// Production policies must read preferences and history through this
		// transaction. The preferences row lock matches the PostgreSQL updater;
		// SQLite's channel write already holds the database writer lock.
		if _, ok := s.serverDMPolicy.(*RepositoryServerDMPolicy); ok && serverDMNonFriend && r.Preferences != nil && r.Servers != nil {
			hasHistory, err := r.DM.HasMessages(ctx, channelID)
			if err != nil {
				return err
			}
			if !hasHistory {
				if r.LockPreferences != nil {
					if err := r.LockPreferences(ctx, otherUserID); err != nil {
						return err
					}
				}
				allowed, err := NewServerDMPolicy(r.Preferences, r.Servers).CanCreate(ctx, userID, otherUserID)
				if err != nil {
					return fmt.Errorf("failed to check server DM policy: %w", err)
				}
				if !allowed {
					return fmt.Errorf("%w: this user disabled direct messages from shared servers", pkg.ErrForbidden)
				}
			}
		}
		if becamePending && r.LockChannel != nil {
			// A request may have been sent and accepted while this call waited.
			// Do not turn that established conversation back into a request.
			hasHistory, err := r.DM.HasMessages(ctx, channelID)
			if err != nil {
				return err
			}
			becamePending = !hasHistory
		}
		if becamePending {
			if err := r.DM.TransitionToPending(ctx, channelID, userID); err != nil {
				return fmt.Errorf("failed to transition DM channel to pending: %w", err)
			}
		}
		if err := r.DM.CreateMessage(ctx, msg); err != nil {
			return fmt.Errorf("failed to create DM message: %w", err)
		}
		for _, staged := range req.StagedAttachments {
			attachment := staged
			attachment.DMMessageID = msg.ID
			if err := r.DM.CreateAttachment(ctx, &attachment); err != nil {
				return err
			}
			msg.Attachments = append(msg.Attachments, attachment)
		}
		if !isSelf {
			if err := r.DMRead.IncrementUnread(ctx, otherUserID, channelID); err != nil {
				return fmt.Errorf("failed to increment DM unread count: %w", err)
			}
		}
		if req.ClientMessageID != "" {
			if err := r.DM.(repository.DMSendReceipts).RecordDMSend(ctx, channelID, userID, req.ClientMessageID, requestHash, msg.ID); err != nil {
				return err
			}
		}
		if becamePending {
			requestNotif = &models.Notification{
				UserID:      otherUserID,
				Kind:        models.NotificationKindDMRequest,
				ActorID:     &userID,
				DMChannelID: &channelID,
				Payload:     json.RawMessage(`{}`),
			}
			if err := r.Notification.Create(ctx, requestNotif); err != nil {
				return fmt.Errorf("failed to create dm_request notification: %w", err)
			}
		}
		if !isSelf && !becamePending && channel.Status == models.DMStatusAccepted {
			n := &models.Notification{UserID: otherUserID, ActorID: &userID, MessageID: &msg.ID, DMChannelID: &channelID}
			created, err := r.Notification.CreateDMMessageIfAbsent(ctx, n)
			if err != nil {
				return fmt.Errorf("failed to create DM message notification: %w", err)
			}
			if created {
				incomingNotif = n
			}
		}
		return nil
	})
	if txErr != nil {
		return nil, txErr
	}
	if msg.SendReplayed {
		return msg, nil
	}

	author, err := s.userRepo.GetByID(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to get message author: %w", err)
	}
	msg.Author = models.ToPublicUser(author)

	// Accepted DM messages can produce one delayed, generic notice. Pending
	// message requests and self-DMs do not; no plaintext, sender identity, or
	// message preview is put in the email. Delivery rechecks that this exact
	// message still exists and remains unread.
	if !isSelf && !becamePending && channel.Status == models.DMStatusAccepted && s.communicationEmailEnqueuer != nil {
		now := time.Now().UTC()
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		_, enqueueErr := s.communicationEmailEnqueuer.EnqueueWithOptions(
			ctx, otherUserID, models.EmailCategoryCommunication, "unread-dm:"+msg.ID,
			"You have an unread direct message", "<p>You have an unread direct message waiting in HiChat. Open HiChat to read it.</p>",
			EmailEnqueueOptions{NotBefore: now.Add(unreadDMEmailDelay), ExpiresAt: now.Add(unreadDMEmailTTL), DMMessageID: msg.ID},
		)
		cancel()
		if enqueueErr != nil {
			dmLogger.Error("unread DM email enqueue failed", "category", models.EmailCategoryCommunication)
		}
	}

	// Post-commit only — see broadcastNotificationCreate.
	if requestNotif != nil && s.deliveryDB == nil {
		requestNotif.Actor = msg.Author
		broadcastNotificationCreate(s.hub, requestNotif)
	}
	if incomingNotif != nil && s.deliveryDB == nil {
		incomingNotif.Actor = msg.Author
		broadcastNotificationCreate(s.hub, incomingNotif)
	}

	// Load reply reference
	if msg.ReplyToID != nil && *msg.ReplyToID != "" {
		refMsg, err := s.dmRepo.GetMessageByID(ctx, *msg.ReplyToID)
		if err == nil {
			ref := &models.MessageReference{
				ID:      refMsg.ID,
				Content: refMsg.Content,
			}
			if refMsg.Author != nil {
				ref.Author = refMsg.Author
			}
			msg.ReferencedMessage = ref
		}
	}

	if msg.Attachments == nil {
		msg.Attachments = []models.DMAttachment{}
	}
	msg.Reactions = []models.ReactionGroup{}

	// Auto-unhide: if either user hid this DM, show it again on new message (best-effort)
	if s.unhider != nil {
		if !isSelf {
			_ = s.unhider.UnhideForNewMessage(ctx, otherUserID, channelID)
		}
		_ = s.unhider.UnhideForNewMessage(ctx, userID, channelID)
	}

	return msg, nil
}

// BroadcastCreate sends the DM message to both users after file uploads complete.
func (s *dmService) BroadcastCreate(message *models.DMMessage) {
	if s.deliveryDB != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := s.FinalizeDMCreate(ctx, message); err != nil {
			dmLogger.Error("DM outbox completion failed")
		}
		return
	}
	if message.SendReplayed {
		return
	}
	channel, err := s.dmRepo.GetChannelByID(context.Background(), message.DMChannelID)
	if err != nil {
		return
	}

	event := ws.Event{
		Op:   ws.OpDMMessageCreate,
		Data: message,
	}
	s.broadcastToBothUsers(channel, event)

	// If channel just became pending, notify both users
	if channel.Status == models.DMStatusPending {
		s.broadcastToBothUsers(channel, ws.Event{
			Op: ws.OpDMChannelStatusChange,
			Data: map[string]any{
				"dm_channel_id": channel.ID,
				"status":        channel.Status,
				"initiated_by":  channel.InitiatedBy,
			},
		})
	}
}

func (s *dmService) EditMessage(ctx context.Context, userID, messageID string, req *models.UpdateDMMessageRequest) (*models.DMMessage, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, pkg.ErrText(err))
	}

	msg, channel, err := s.verifyMessageAccess(ctx, userID, messageID)
	if err != nil {
		return nil, err
	}

	if msg.UserID != userID {
		return nil, fmt.Errorf("%w: you can only edit your own messages", pkg.ErrForbidden)
	}

	if err := s.dmRepo.UpdateMessage(ctx, messageID, req); err != nil {
		return nil, err
	}

	updated, err := s.dmRepo.GetMessageByID(ctx, messageID)
	if err != nil {
		return nil, err
	}

	enriched := []models.DMMessage{*updated}
	if err := s.enrichMessages(ctx, enriched); err != nil {
		return nil, err
	}

	s.broadcastToBothUsers(channel, ws.Event{
		Op:   ws.OpDMMessageUpdate,
		Data: &enriched[0],
	})

	return &enriched[0], nil
}

func (s *dmService) DeleteMessage(ctx context.Context, userID, messageID string) error {
	_, err := s.DeleteMessageWithReceipt(ctx, userID, messageID)
	return err
}

func (s *dmService) DeleteMessageWithReceipt(ctx context.Context, userID, messageID string) (*models.DMMessageDeleteReceipt, error) {
	msg, channel, err := s.verifyMessageAccess(ctx, userID, messageID)
	if err != nil {
		return nil, err
	}

	if msg.UserID != userID {
		return nil, fmt.Errorf("%w: you can only delete your own messages", pkg.ErrForbidden)
	}

	// Pre-fetch attachment file_urls for the post-delete disk cleanup below.
	// A fetch failure here is logged and non-fatal — the delete still
	// proceeds, it just can't clean up files it couldn't enumerate.
	attMap, attErr := s.dmRepo.GetAttachmentsByMessageIDs(ctx, []string{messageID})
	if attErr != nil {
		dmLogger.Error("failed to fetch DM attachments before message delete", "message_id", messageID, "err", pkg.ErrText(attErr))
	}

	if err := s.dmRepo.DeleteMessage(ctx, messageID); err != nil {
		return nil, err
	}

	// Only remove files once the DB delete has actually committed — see
	// upload_cleanup.go for why the ordering matters.
	if atts := attMap[messageID]; len(atts) > 0 {
		fileURLs := make([]string, len(atts))
		for i, a := range atts {
			fileURLs[i] = a.FileURL
		}
		removeUploadFilesByURL(s.uploadDir, fileURLs)
	}

	// Best-effort: inbox rows that pointed at this message would otherwise
	// deep-link to nothing. No DM writer sets message_id today, so this is
	// forward-looking cleanup, logged rather than surfaced on failure.
	if err := s.notificationRepo.DeleteByMessageID(ctx, messageID); err != nil {
		dmLogger.Error("failed to delete notifications for DM message", "message_id", messageID, "err", pkg.ErrText(err))
	}

	s.broadcastToBothUsers(channel, ws.Event{
		Op: ws.OpDMMessageDelete,
		Data: map[string]string{
			"id":            messageID,
			"dm_channel_id": msg.DMChannelID,
		},
	})

	return &models.DMMessageDeleteReceipt{ID: messageID, DMChannelID: msg.DMChannelID, Message: "message deleted"}, nil
}

// MarkRead — membership is checked first (403 for outsiders, 404 for an
// unknown channel via GetChannelByID), then the caller's dm_reads row is
// upserted. The dm_read echo goes to the caller only: the other participant
// has no use for it (no read receipts in this phase).
func (s *dmService) MarkRead(ctx context.Context, userID, channelID string, messageID *string) error {
	if _, err := s.verifyChannelMembership(ctx, userID, channelID); err != nil {
		return err
	}
	var ids []string
	var unread *int
	actualCursor := messageID // Legacy in-memory fixtures lack a stored-state reader.
	if err := s.txRunner.InTx(ctx, func(r *repository.DMTxRepos) error {
		if r.LockChannel != nil {
			if err := r.LockChannel(ctx, channelID); err != nil {
				return err
			}
		}
		if err := r.DMRead.MarkRead(ctx, userID, channelID, messageID); err != nil {
			return err
		}
		var err error
		ids, err = r.Notification.MarkDMMessagesRead(ctx, userID, channelID, messageID)
		if err == nil && r.ReadState != nil {
			var count int
			actualCursor, count, err = r.ReadState(ctx, userID, channelID)
			unread = &count
		}
		return err
	}); err != nil {
		return err
	}
	if len(ids) > 0 {
		if counts, err := NotificationUnreadSummary(ctx, s.notificationRepo, userID); err == nil {
			broadcastNotificationRead(s.hub, userID, ids, false, counts.UnreadCount, counts.BadgeUnreadCount)
		}
	}
	data := map[string]any{"dm_channel_id": channelID, "user_id": userID, "last_read_message_id": actualCursor}
	if unread != nil {
		data["unread_count"] = *unread
	}
	s.hub.BroadcastToUser(userID, ws.Event{
		Op:   ws.OpDMRead,
		Data: data,
	})
	return nil
}

func (s *dmService) MarkUnreadFrom(ctx context.Context, userID, channelID, messageID string) (int, error) {
	if _, err := s.verifyChannelMembership(ctx, userID, channelID); err != nil {
		return 0, err
	}
	count, err := s.dmReadRepo.MarkUnreadFrom(ctx, userID, channelID, messageID)
	if err != nil {
		return 0, err
	}
	s.hub.BroadcastToUser(userID, ws.Event{Op: ws.OpDMRead, Data: map[string]any{
		"dm_channel_id": channelID, "user_id": userID,
		"last_read_message_id": messageID, "unread_count": count,
	}})
	return count, nil
}
