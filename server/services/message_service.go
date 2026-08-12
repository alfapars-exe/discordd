package services

import (
	"context"
	"fmt"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
)

var messageLogger = logx.Component("service.message")

type MessageService interface {
	GetByChannelID(ctx context.Context, serverID, channelID, userID string, beforeID string, limit int) (*models.MessagePage, error)
	Create(ctx context.Context, serverID, channelID, userID string, req *models.CreateMessageRequest) (*models.Message, error)
	BroadcastCreate(message *models.Message)
	Update(ctx context.Context, serverID, id, userID string, req *models.UpdateMessageRequest) (*models.Message, error)
	Delete(ctx context.Context, serverID, id, userID string, userPermissions models.Permission) error
	SetAuditLogger(logger AuditWriter)
	SetUploadDir(dir string)
}

type messageService struct {
	messageRepo     repository.MessageRepository
	attachmentRepo  repository.AttachmentRepository
	channelRepo     repository.ChannelRepository
	userRepo        repository.UserRepository
	mentionRepo     repository.MentionRepository
	roleMentionRepo repository.RoleMentionRepository
	roleRepo        repository.RoleRepository
	reactionRepo    repository.ReactionRepository
	readStateRepo   repository.ReadStateRepository
	timeoutRepo     repository.MemberTimeoutRepository
	txRunner        repository.MessageTxRunner
	hub             ws.BroadcastAndOnline
	permResolver    ChannelPermResolver
	auditLogger     AuditWriter
	// uploadDir enables best-effort disk cleanup on message delete (see
	// upload_cleanup.go). Blank (the zero value, and every existing test's
	// default) disables cleanup — set via SetUploadDir, wired in
	// init_services.go so the constructor signature above stays unchanged.
	uploadDir string
}

func (s *messageService) SetAuditLogger(logger AuditWriter) {
	s.auditLogger = logger
}

func (s *messageService) SetUploadDir(dir string) {
	s.uploadDir = dir
}

// audit emits an audit log event if an audit logger is wired. Nil-safe.
// Only called from the moderator-delete branch of Delete (author-delete
// is not auditable — a user deleting their own message is not a moderation
// action).
func (s *messageService) audit(entry models.AuditLog) {
	if s.auditLogger == nil {
		messageLogger.Warn("audit event dropped, auditLogger not wired", "event_type", entry.EventType, "server_id", entry.ServerID)
		return
	}
	messageLogger.Info("audit event emitted", "event_type", entry.EventType, "server_id", entry.ServerID)
	s.auditLogger.Write(entry)
}

func NewMessageService(
	messageRepo repository.MessageRepository,
	attachmentRepo repository.AttachmentRepository,
	channelRepo repository.ChannelRepository,
	userRepo repository.UserRepository,
	mentionRepo repository.MentionRepository,
	roleMentionRepo repository.RoleMentionRepository,
	roleRepo repository.RoleRepository,
	reactionRepo repository.ReactionRepository,
	readStateRepo repository.ReadStateRepository,
	timeoutRepo repository.MemberTimeoutRepository,
	txRunner repository.MessageTxRunner,
	hub ws.BroadcastAndOnline,
	permResolver ChannelPermResolver,
) MessageService {
	return &messageService{
		messageRepo:     messageRepo,
		attachmentRepo:  attachmentRepo,
		channelRepo:     channelRepo,
		userRepo:        userRepo,
		mentionRepo:     mentionRepo,
		roleMentionRepo: roleMentionRepo,
		roleRepo:        roleRepo,
		reactionRepo:    reactionRepo,
		readStateRepo:   readStateRepo,
		timeoutRepo:     timeoutRepo,
		txRunner:        txRunner,
		hub:             hub,
		permResolver:    permResolver,
	}
}

// GetByChannelID returns messages with cursor-based pagination.
// Checks per-channel ReadMessages permission (override-aware).
func (s *messageService) GetByChannelID(ctx context.Context, serverID, channelID, userID string, beforeID string, limit int) (*models.MessagePage, error) {
	if _, err := s.validateChannelScope(ctx, serverID, channelID); err != nil {
		return nil, err
	}

	channelPerms, err := s.permResolver.ResolveChannelPermissions(ctx, userID, channelID)
	if err != nil {
		return nil, fmt.Errorf("failed to resolve channel permissions: %w", err)
	}
	if !models.PermCanReadChannel(channelPerms) {
		return nil, fmt.Errorf("%w: missing read messages permission for this channel", pkg.ErrForbidden)
	}

	if limit <= 0 || limit > 100 {
		limit = 50
	}

	// Fetch limit+1 to determine if more pages exist
	messages, err := s.messageRepo.GetByChannelID(ctx, channelID, beforeID, limit+1)
	if err != nil {
		return nil, fmt.Errorf("failed to get messages: %w", err)
	}

	hasMore := len(messages) > limit
	if hasMore {
		messages = messages[:limit]
	}

	// Reverse: DB returns DESC, frontend expects ASC (oldest first)
	for i, j := 0, len(messages)-1; i < j; i, j = i+1, j-1 {
		messages[i], messages[j] = messages[j], messages[i]
	}

	// Batch load attachments, mentions, reactions (avoid N+1)
	if len(messages) > 0 {
		messageIDs := make([]string, len(messages))
		for i, m := range messages {
			messageIDs[i] = m.ID
		}

		attachments, err := s.attachmentRepo.GetByMessageIDs(ctx, messageIDs)
		if err != nil {
			return nil, fmt.Errorf("failed to get attachments: %w", err)
		}

		attachmentMap := make(map[string][]models.Attachment)
		for _, a := range attachments {
			attachmentMap[a.MessageID] = append(attachmentMap[a.MessageID], a)
		}

		mentionMap, err := s.mentionRepo.GetByMessageIDs(ctx, messageIDs)
		if err != nil {
			return nil, fmt.Errorf("failed to get mentions: %w", err)
		}

		reactionMap, err := s.reactionRepo.GetByMessageIDs(ctx, messageIDs)
		if err != nil {
			return nil, fmt.Errorf("failed to get reactions: %w", err)
		}

		roleMentionMap, err := s.roleMentionRepo.GetByMessageIDs(ctx, messageIDs)
		if err != nil {
			return nil, fmt.Errorf("failed to get role mentions: %w", err)
		}

		for i := range messages {
			messages[i].Attachments = attachmentMap[messages[i].ID]
			if messages[i].Attachments == nil {
				messages[i].Attachments = []models.Attachment{}
			}
			messages[i].Mentions = mentionMap[messages[i].ID]
			if messages[i].Mentions == nil {
				messages[i].Mentions = []string{}
			}
			messages[i].RoleMentions = roleMentionMap[messages[i].ID]
			if messages[i].RoleMentions == nil {
				messages[i].RoleMentions = []string{}
			}
			messages[i].Reactions = reactionMap[messages[i].ID]
			if messages[i].Reactions == nil {
				messages[i].Reactions = []models.ReactionGroup{}
			}
		}
	}

	// nil slice serializes as JSON null — ensure empty array
	if messages == nil {
		messages = []models.Message{}
	}

	return &models.MessagePage{
		Messages: messages,
		HasMore:  hasMore,
	}, nil
}

// Create creates a new message. Checks per-channel SendMessages permission.
// WS broadcast is NOT done here — handler calls BroadcastCreate after file uploads.
func (s *messageService) Create(ctx context.Context, serverID, channelID, userID string, req *models.CreateMessageRequest) (*models.Message, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, pkg.ErrText(err))
	}

	channel, err := s.validateChannelScope(ctx, serverID, channelID)
	if err != nil {
		return nil, err
	}

	// Timeout gate — moderators apply Discord-style timeouts via
	// member_service.Timeout(); enforcement lives at every write
	// boundary (here for messages, voice_service for joins, etc.).
	// We check BEFORE the perm resolver to give the more specific
	// error message ("you are timed out") instead of a generic 403.
	if channel.ServerID != "" && s.timeoutRepo != nil {
		active, tErr := s.timeoutRepo.IsActive(ctx, channel.ServerID, userID)
		if tErr != nil {
			return nil, fmt.Errorf("check timeout: %w", tErr)
		}
		if active {
			return nil, fmt.Errorf("%w: you are timed out on this server", pkg.ErrForbidden)
		}
	}

	channelPerms, err := s.permResolver.ResolveChannelPermissions(ctx, userID, channelID)
	if err != nil {
		return nil, fmt.Errorf("failed to resolve channel permissions: %w", err)
	}
	if !channelPerms.Has(models.PermViewChannel) || !channelPerms.Has(models.PermSendMessages) {
		return nil, fmt.Errorf("%w: missing send messages permission for this channel", pkg.ErrForbidden)
	}

	message := &models.Message{
		ChannelID:         channelID,
		UserID:            userID,
		EncryptionVersion: req.EncryptionVersion,
		Ciphertext:        req.Ciphertext,
		SenderDeviceID:    req.SenderDeviceID,
		E2EEMetadata:      req.E2EEMetadata,
	}

	// E2EE messages have nil Content — payload is in Ciphertext
	if req.EncryptionVersion == 0 {
		message.Content = &req.Content
	}

	// Reply validation — referenced message must be in the same channel
	if req.ReplyToID != nil && *req.ReplyToID != "" {
		refMsg, err := s.messageRepo.GetByID(ctx, *req.ReplyToID)
		if err != nil {
			return nil, fmt.Errorf("%w: referenced message not found", pkg.ErrBadRequest)
		}
		if refMsg.ChannelID != channelID {
			return nil, fmt.Errorf("%w: cannot reply to a message in a different channel", pkg.ErrBadRequest)
		}
		message.ReplyToID = req.ReplyToID
	}

	// Extract mentions BEFORE the write transaction — extraction is read-only
	// (user/role lookups) and keeping reads out of the tx keeps it short.
	// channel.ServerID comes from validateChannelScope above (the old code
	// refetched the channel here for the same value).
	var mentionedIDs, roleMentionIDs []string
	if req.EncryptionVersion == 0 {
		mentionedIDs = s.extractMentions(ctx, req.Content)
		roleMentionIDs = s.extractRoleMentions(ctx, req.Content, channel.ServerID)
	}

	// Atomic write set: message INSERT + unread bumps + mention rows commit
	// or roll back together. Previously each ran auto-commit with failures
	// only logged, which left drifting unread badges and missing mention
	// rows next to an already-persisted message.
	txErr := s.txRunner.InTx(ctx, func(r *repository.MessageTxRepos) error {
		if err := r.Message.Create(ctx, message); err != nil {
			return fmt.Errorf("failed to create message: %w", err)
		}
		if err := r.ReadState.IncrementUnreadCounts(ctx, channelID, userID); err != nil {
			return fmt.Errorf("failed to increment unread counts: %w", err)
		}
		if len(mentionedIDs) > 0 {
			if err := r.Mention.SaveMentions(ctx, message.ID, mentionedIDs); err != nil {
				return fmt.Errorf("failed to save mentions: %w", err)
			}
		}
		if len(roleMentionIDs) > 0 {
			if err := r.RoleMention.SaveRoleMentions(ctx, message.ID, roleMentionIDs); err != nil {
				return fmt.Errorf("failed to save role mentions: %w", err)
			}
		}
		return nil
	})
	if txErr != nil {
		return nil, txErr
	}

	if req.EncryptionVersion == 0 {
		message.Mentions = mentionedIDs
		message.RoleMentions = roleMentionIDs
	} else {
		message.Mentions = []string{}
		message.RoleMentions = []string{}
	}

	author, err := s.userRepo.GetByID(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to get message author: %w", err)
	}
	message.Author = models.ToPublicUser(author)
	message.Attachments = []models.Attachment{}
	message.Reactions = []models.ReactionGroup{}

	// Load reply reference for API response / WS broadcast
	if message.ReplyToID != nil {
		refMsg, err := s.messageRepo.GetByID(ctx, *message.ReplyToID)
		if err == nil && refMsg != nil {
			message.ReferencedMessage = &models.MessageReference{
				ID:      refMsg.ID,
				Author:  refMsg.Author,
				Content: refMsg.Content,
			}
		}
		// If deleted, ReferencedMessage stays nil
	}

	return message, nil
}

// allowedViewers returns online user IDs that have both ViewChannel and ReadMessages
// permission on the given channel. Used to filter all channel-scoped WS broadcasts.
// Scoped to the channel's server members so permission checks don't iterate every
// user on the platform.
//
// One bulk resolve, not one per member: the per-user loop this replaces cost 3
// queries per online member on a cold cache, so a 100-member server paid ~300
// round trips per broadcast every time the permission cache expired.
//
// Runs post-commit from a broadcast goroutine with no request context to
// inherit, hence the bounded background context.
//
// The bool reports whether the viewer set could actually be RESOLVED: (nil,
// true) means "resolved, nobody online may read this channel" while (nil,
// false) means "resolve failed — the empty set says nothing". Callers that
// can degrade gracefully (BroadcastCreate) branch on it; edit/delete
// broadcasts stay fail-closed and ignore it.
func (s *messageService) allowedViewers(channelID string) ([]string, bool) {
	ctx, cancel := BroadcastContext()
	defer cancel()

	channel, err := s.channelRepo.GetByID(ctx, channelID)
	if err != nil || channel == nil {
		// Loud, not silent: this used to return nil with no trace, which made
		// "message persisted but nobody received it" undiagnosable in prod.
		messageLogger.Error("allowedViewers channel fetch failed",
			"channel_id", channelID, "err", pkg.ErrText(err))
		return nil, false
	}

	onlineUsers := s.hub.GetOnlineUserIDsForServer(channel.ServerID)
	perms, err := s.permResolver.ResolveChannelPermissionsBulk(ctx, channelID, onlineUsers)
	if err != nil {
		// Fail closed — better a missed broadcast (clients refetch) than
		// leaking a message into a channel someone may not read.
		messageLogger.Error("bulk permission resolve failed", "channel_id", channelID, "err", pkg.ErrText(err))
		return nil, false
	}

	allowed := make([]string, 0, len(onlineUsers))
	for _, userID := range onlineUsers {
		if models.PermCanReadChannel(perms[userID]) {
			allowed = append(allowed, userID)
		}
	}

	return allowed, true
}

// BroadcastCreate sends the message via WS after file uploads complete.
// Only sends to users with ViewChannel + ReadMessages permission on the channel.
func (s *messageService) BroadcastCreate(message *models.Message) {
	viewers, ok := s.allowedViewers(message.ChannelID)
	if !ok {
		// Viewer resolve failed (transient DB error / 5s broadcast budget
		// exceeded). Do NOT fall back to BroadcastToServer — that would leak
		// the message to members without ViewChannel. The author provably has
		// access (they just posted): echo to them so their own message doesn't
		// silently vanish; everyone else heals via refetch on reconnect.
		messageLogger.Error("message_create broadcast degraded to author-only echo",
			"message_id", message.ID, "channel_id", message.ChannelID)
		s.hub.BroadcastToUser(message.UserID, ws.Event{
			Op:   ws.OpMessageCreate,
			Data: message,
		})
		return
	}
	s.hub.BroadcastToUsers(viewers, ws.Event{
		Op:   ws.OpMessageCreate,
		Data: message,
	})
}

// Update edits a message. Only the message owner can edit.
func (s *messageService) Update(ctx context.Context, serverID, id, userID string, req *models.UpdateMessageRequest) (*models.Message, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, pkg.ErrText(err))
	}

	message, err := s.messageRepo.GetByID(ctx, id)
	if err != nil {
		return nil, err
	}

	if message.UserID != userID {
		return nil, fmt.Errorf("%w: you can only edit your own messages", pkg.ErrForbidden)
	}
	channel, err := s.validateChannelScope(ctx, serverID, message.ChannelID)
	if err != nil {
		return nil, err
	}

	// Timeout gate — mirrors Create's gate (~:206): a timed-out user can
	// still own messages posted before the timeout, but can't edit them
	// while it's active. channel.ServerID != "" is structural
	// defense-in-depth — DM channels never reach here in practice (DM
	// edits go through dm_message.go), but the guard costs nothing. Checked
	// before the perm resolver for the same reason as Create: a specific
	// "you are timed out" error beats a generic 403.
	if channel.ServerID != "" && s.timeoutRepo != nil {
		active, tErr := s.timeoutRepo.IsActive(ctx, channel.ServerID, userID)
		if tErr != nil {
			return nil, fmt.Errorf("check timeout: %w", tErr)
		}
		if active {
			return nil, fmt.Errorf("%w: you are timed out on this server", pkg.ErrForbidden)
		}
	}

	channelPerms, err := s.permResolver.ResolveChannelPermissions(ctx, userID, message.ChannelID)
	if err != nil {
		return nil, fmt.Errorf("failed to resolve channel permissions: %w", err)
	}
	if !models.PermCanReadChannel(channelPerms) {
		return nil, fmt.Errorf("%w: missing read messages permission for this channel", pkg.ErrForbidden)
	}

	// Reject mismatched encryption versions. The repo decides which columns
	// to write off message.EncryptionVersion (loaded from DB) — if the
	// request asks to send a different shape we'd silently scribble the
	// wrong payload into the wrong columns. The client should never produce
	// this; a paranoid 400 here makes the inconsistency loud.
	if req.EncryptionVersion != message.EncryptionVersion {
		return nil, fmt.Errorf("%w: cannot change encryption_version on edit (stored=%d, requested=%d)",
			pkg.ErrBadRequest, message.EncryptionVersion, req.EncryptionVersion)
	}

	if req.EncryptionVersion == 1 {
		message.Ciphertext = req.Ciphertext
		message.SenderDeviceID = req.SenderDeviceID
		message.E2EEMetadata = req.E2EEMetadata
		message.Content = nil
	} else {
		message.Content = &req.Content
	}

	if err := s.messageRepo.Update(ctx, message); err != nil {
		return nil, err
	}

	attachments, err := s.attachmentRepo.GetByMessageID(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("failed to get attachments: %w", err)
	}
	message.Attachments = attachments
	if message.Attachments == nil {
		message.Attachments = []models.Attachment{}
	}

	// Re-parse mentions (server can't read E2EE content)
	if req.EncryptionVersion == 0 {
		channel, _ := s.channelRepo.GetByID(ctx, message.ChannelID)
		serverID := ""
		if channel != nil {
			serverID = channel.ServerID
		}

		if err := s.mentionRepo.DeleteByMessageID(ctx, id); err != nil {
			messageLogger.Error("failed to delete old mentions", "message_id", id, "err", pkg.ErrText(err))
		}
		mentionedIDs := s.extractMentions(ctx, req.Content)
		if len(mentionedIDs) > 0 {
			if err := s.mentionRepo.SaveMentions(ctx, id, mentionedIDs); err != nil {
				messageLogger.Error("failed to save mentions", "message_id", id, "err", pkg.ErrText(err))
			}
		}
		message.Mentions = mentionedIDs

		if err := s.roleMentionRepo.DeleteByMessageID(ctx, id); err != nil {
			messageLogger.Error("failed to delete old role mentions", "message_id", id, "err", pkg.ErrText(err))
		}
		roleMentionIDs := s.extractRoleMentions(ctx, req.Content, serverID)
		if len(roleMentionIDs) > 0 {
			if err := s.roleMentionRepo.SaveRoleMentions(ctx, id, roleMentionIDs); err != nil {
				messageLogger.Error("failed to save role mentions", "message_id", id, "err", pkg.ErrText(err))
			}
		}
		message.RoleMentions = roleMentionIDs
	} else {
		message.Mentions = []string{}
		message.RoleMentions = []string{}
	}

	// Fail-closed on resolve failure (ok ignored): an undelivered edit is
	// recoverable via refetch and never leaks content to the wrong users.
	updateViewers, _ := s.allowedViewers(message.ChannelID)
	s.hub.BroadcastToUsers(updateViewers, ws.Event{
		Op:   ws.OpMessageUpdate,
		Data: message,
	})

	return message, nil
}

// Delete deletes a message. Owner or MANAGE_MESSAGES permission required.
func (s *messageService) Delete(ctx context.Context, serverID, id, userID string, userPermissions models.Permission) error {
	message, err := s.messageRepo.GetByID(ctx, id)
	if err != nil {
		return err
	}
	channel, err := s.validateChannelScope(ctx, serverID, message.ChannelID)
	if err != nil {
		return err
	}

	if message.UserID != userID && !userPermissions.Has(models.PermManageMessages) {
		return fmt.Errorf("%w: you can only delete your own messages", pkg.ErrForbidden)
	}

	// Snapshot what we need for the audit BEFORE the row is deleted; the
	// message and (in theory) its channel may not be reachable after.
	wasModeratorDelete := message.UserID != userID
	var channelName string
	if wasModeratorDelete {
		channelName = channel.Name
	}

	// Pre-fetch attachment file_urls for the post-delete disk cleanup below.
	// A fetch failure here is logged and non-fatal — the delete still
	// proceeds, it just can't clean up files it couldn't enumerate.
	attachments, attErr := s.attachmentRepo.GetByMessageID(ctx, id)
	if attErr != nil {
		messageLogger.Error("failed to fetch attachments before message delete", "message_id", id, "err", pkg.ErrText(attErr))
	}

	if err := s.messageRepo.Delete(ctx, id); err != nil {
		return err
	}

	// Only remove files once the DB delete has actually committed — see
	// upload_cleanup.go for why the ordering matters.
	if len(attachments) > 0 {
		fileURLs := make([]string, len(attachments))
		for i, a := range attachments {
			fileURLs[i] = a.FileURL
		}
		removeUploadFilesByURL(s.uploadDir, fileURLs)
	}

	// Decrement unread_count for every user who had this message as unread.
	// Uses the message's CreatedAt (captured before delete) as the watermark.
	if err := s.readStateRepo.DecrementUnreadForDeleted(ctx, message.ChannelID, message.UserID, message.CreatedAt); err != nil {
		messageLogger.Error("failed to decrement unread counts on delete", "channel_id", message.ChannelID, "err", pkg.ErrText(err))
	}

	// Fail-closed on resolve failure (ok ignored) — same rationale as the
	// update broadcast above.
	deleteViewers, _ := s.allowedViewers(message.ChannelID)
	s.hub.BroadcastToUsers(deleteViewers, ws.Event{
		Op: ws.OpMessageDelete,
		Data: map[string]string{
			"id":         id,
			"channel_id": message.ChannelID,
		},
	})

	// Audit only on moderator-delete (author-delete is not a mod action).
	// Server-scoped audit_logs require a serverID; if channel lookup failed
	// we skip the audit rather than write an orphan row.
	if wasModeratorDelete && serverID != "" {
		actor := userID
		target := message.UserID
		var content string
		if message.Content != nil {
			content = *message.Content
		}
		preview := messagePreview(content)
		s.audit(models.AuditLog{
			ServerID:     serverID,
			ActorUserID:  &actor,
			TargetUserID: &target,
			EventType:    models.AuditEventMessageDelete,
			Metadata:     fmt.Sprintf(`{"channel_name":%q,"content_preview":%q}`, channelName, preview),
		})
	}

	return nil
}

func (s *messageService) validateChannelScope(ctx context.Context, serverID, channelID string) (*models.Channel, error) {
	return resolveChannelInServer(ctx, s.channelRepo, serverID, channelID)
}
