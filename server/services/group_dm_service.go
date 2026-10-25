package services

import (
	"context"
	"crypto/hmac"
	cryptorand "crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
	"github.com/livekit/protocol/auth"
)

var groupDMLogger = logx.Component("service.group_dm")

type GroupDMService interface {
	SetMuted(context.Context, string, string, bool, ...int64) (*models.GroupDMReadState, error)
	SetMessagePinned(context.Context, string, string, string, bool) error
	ListPinnedMessages(context.Context, string, string) ([]models.GroupDMMessage, error)
	PrepareSend(context.Context, string, string, *models.CreateGroupDMMessageRequest, string, int) (*models.GroupSendOperation, error)
	GetSendOutcome(context.Context, string, string, string) (*models.GroupSendOutcome, error)
	CompleteSend(context.Context, string, string, string, []int) (*models.GroupSendOperation, error)
	ReconcileSend(context.Context, string, string, string) (*models.GroupSendOutcome, error)
	CancelSend(context.Context, string, string, string) (*models.GroupSendOutcome, error)
	Create(context.Context, string, *models.CreateGroupDMRequest) (*models.GroupDM, error)
	List(context.Context, string) ([]models.GroupDM, error)
	Get(context.Context, string, string) (*models.GroupDM, error)
	Update(context.Context, string, string, *models.UpdateGroupDMRequest) (*models.GroupDM, error)
	AddMember(context.Context, string, string, string) (*models.GroupDM, error)
	RemoveMember(context.Context, string, string, string) (*models.GroupDM, error)
	Leave(context.Context, string, string) error
	ListMessages(context.Context, string, string, string, int) ([]models.GroupDMMessage, error)
	GetMessagesAround(context.Context, string, string, string, int) (*models.GroupDMMessagePage, error)
	SendMessage(context.Context, string, string, *models.CreateGroupDMMessageRequest) (*models.GroupDMMessage, error)
	EditMessage(context.Context, string, string, string, *models.UpdateGroupDMMessageRequest) (*models.GroupDMMessage, error)
	DeleteMessage(context.Context, string, string, string) error
	ToggleReaction(context.Context, string, string, string, string) error
	MarkRead(context.Context, string, string, *string, ...int64) (*models.GroupDMReadState, error)
	MarkUnreadFrom(context.Context, string, string, string, ...int64) (*models.GroupDMReadState, error)
	BroadcastMessage(context.Context, *models.GroupDMMessage) error
	GenerateCallToken(context.Context, string, string) (*models.VoiceTokenResponse, error)
}

type groupDMService struct {
	groups                repository.GroupDMRepository
	users                 repository.UserRepository
	friendships           repository.FriendshipRepository
	hub                   ws.Broadcaster
	liveKitURL            string
	liveKitAPIKey         string
	liveKitAPISecret      string
	mediaKey              []byte
	uploadDir             string
	reactionNotifications repository.NotificationRepository
	reactionPreferences   profilePreferenceReader
	reactionBlocks        BlockChecker
}

func (s *groupDMService) SetReactionDelivery(notifications repository.NotificationRepository, prefs repository.PreferencesRepository, blocks BlockChecker) {
	s.reactionNotifications, s.reactionPreferences, s.reactionBlocks = notifications, prefs, blocks
}

func NewGroupDMService(groups repository.GroupDMRepository, users repository.UserRepository, friendships repository.FriendshipRepository, hub ws.Broadcaster, liveKitURL, liveKitAPIKey, liveKitAPISecret string, mediaKey []byte, uploadDir string) GroupDMService {
	return &groupDMService{groups: groups, users: users, friendships: friendships, hub: hub, liveKitURL: liveKitURL, liveKitAPIKey: liveKitAPIKey, liveKitAPISecret: liveKitAPISecret, mediaKey: append([]byte(nil), mediaKey...), uploadDir: uploadDir}
}

func (s *groupDMService) GenerateCallToken(ctx context.Context, groupID, userID string) (*models.VoiceTokenResponse, error) {
	g, err := s.requireMember(ctx, groupID, userID)
	if err != nil {
		return nil, err
	}
	if s.liveKitURL == "" || s.liveKitAPIKey == "" || s.liveKitAPISecret == "" || len(s.mediaKey) == 0 {
		return nil, fmt.Errorf("%w: group calls are not configured", pkg.ErrInternal)
	}
	if g.KeyEpoch < 0 || g.KeyEpoch > 9007199254740991 {
		return nil, fmt.Errorf("%w: invalid group media key epoch", pkg.ErrInternal)
	}
	u, err := s.users.GetByID(ctx, userID)
	if err != nil {
		return nil, err
	}
	name := u.Username
	if u.DisplayName != nil && *u.DisplayName != "" {
		name = *u.DisplayName
	}
	canPublish, canSubscribe, canPublishData := true, true, true
	room := "groupdm:" + g.CallRoomKey
	grant := &auth.VideoGrant{RoomJoin: true, Room: room, CanPublish: &canPublish, CanSubscribe: &canSubscribe, CanPublishData: &canPublishData}
	token, err := auth.NewAccessToken(s.liveKitAPIKey, s.liveKitAPISecret).SetVideoGrant(grant).SetIdentity(userID).SetName(name).SetValidFor(15 * time.Minute).ToJWT()
	if err != nil {
		return nil, fmt.Errorf("generate group call token: %w", err)
	}
	mac := hmac.New(sha256.New, s.mediaKey)
	_, _ = fmt.Fprintf(mac, "group-dm-media-v1:%s:%d", groupID, g.KeyEpoch)
	passphrase := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	contextMAC := hmac.New(sha256.New, s.mediaKey)
	_, _ = fmt.Fprintf(contextMAC, "group-dm-media-context-v1:%s:%s", groupID, g.CallRoomKey)
	return &models.VoiceTokenResponse{Token: token, URL: s.liveKitURL, ChannelID: groupID, E2EEPassphrase: passphrase, E2EEKeyIndex: uint32(uint64(g.KeyEpoch) % 256), E2EEKeyEpoch: uint64(g.KeyEpoch), E2EEKeyContext: base64.RawURLEncoding.EncodeToString(contextMAC.Sum(nil))}, nil
}

func randomGroupToken(prefix string) (string, error) {
	b := make([]byte, 16)
	if _, err := cryptorand.Read(b); err != nil {
		return "", err
	}
	return prefix + hex.EncodeToString(b), nil
}

func badGroupRequest(err error) error {
	return fmt.Errorf("%w: %s", pkg.ErrBadRequest, pkg.ErrText(err))
}

func (s *groupDMService) publicUser(ctx context.Context, userID string) (models.PublicUser, error) {
	u, err := s.users.GetByID(ctx, userID)
	if err != nil {
		return models.PublicUser{}, err
	}
	if u.IsPlatformBanned || u.IsBot {
		return models.PublicUser{}, pkg.ErrForbidden
	}
	return *models.ToPublicUser(u), nil
}

func (s *groupDMService) hydrate(ctx context.Context, group *models.GroupDM) error {
	ids, err := s.groups.ListMemberIDs(ctx, group.ID)
	if err != nil {
		return err
	}
	group.Members = make([]models.PublicUser, 0, len(ids))
	for _, id := range ids {
		u, err := s.users.GetByID(ctx, id)
		if err != nil {
			return err
		}
		group.Members = append(group.Members, *models.ToPublicUser(u))
	}
	return nil
}

func (s *groupDMService) requireMember(ctx context.Context, groupID, userID string) (*models.GroupDM, error) {
	g, err := s.groups.GetByID(ctx, groupID)
	if err != nil {
		return nil, err
	}
	ok, err := s.groups.IsMember(ctx, groupID, userID)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, pkg.ErrNotFound
	}
	return g, nil
}

func (s *groupDMService) Create(ctx context.Context, creatorID string, req *models.CreateGroupDMRequest) (*models.GroupDM, error) {
	if err := req.Validate(); err != nil {
		return nil, badGroupRequest(err)
	}
	if pkg.ContainsSteeringChars(req.Name) {
		return nil, badGroupRequest(errors.New("group name contains disallowed control or formatting characters"))
	}
	seen := map[string]struct{}{creatorID: {}}
	members := []string{creatorID}
	for _, rawID := range req.UserIDs {
		id := strings.TrimSpace(rawID)
		if id == "" || id == creatorID {
			return nil, badGroupRequest(errors.New("group members must be unique"))
		}
		if _, ok := seen[id]; ok {
			return nil, badGroupRequest(errors.New("group members must be unique"))
		}
		seen[id] = struct{}{}
		if _, err := s.publicUser(ctx, id); err != nil {
			return nil, err
		}
		blocked, err := s.friendships.IsBlocked(ctx, creatorID, id)
		if err != nil {
			return nil, err
		}
		if blocked {
			return nil, pkg.ErrForbidden
		}
		members = append(members, id)
	}
	id, err := randomGroupToken("gdm_")
	if err != nil {
		return nil, err
	}
	roomKey, err := randomGroupToken("gdm_room_")
	if err != nil {
		return nil, err
	}
	g := &models.GroupDM{ID: id, OwnerID: creatorID, Name: req.Name, KeyEpoch: 1, CallRoomKey: roomKey}
	if err := s.groups.Create(ctx, g, members); err != nil {
		return nil, err
	}
	if err := s.hydrate(ctx, g); err != nil {
		return nil, err
	}
	g.ReadKeyEpoch = g.KeyEpoch
	s.hub.BroadcastToUsers(members, ws.Event{Op: ws.OpGroupDMCreate, Data: g})
	return g, nil
}

func (s *groupDMService) List(ctx context.Context, userID string) ([]models.GroupDM, error) {
	groups, err := s.groups.ListForUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	for i := range groups {
		if err := s.hydrate(ctx, &groups[i]); err != nil {
			return nil, err
		}
		readState, readErr := s.groups.GetReadState(ctx, groups[i].ID, userID)
		err = readErr
		if err != nil {
			return nil, err
		}
		groups[i].UnreadCount, groups[i].ReadRevision = readState.UnreadCount, readState.Revision
		groups[i].OldestUnreadMessageID = readState.OldestUnreadMessageID
		groups[i].LastReadSourceSequence, groups[i].ReadKeyEpoch = readState.LastReadSourceSequence, readState.KeyEpoch
		groups[i].IsMuted, groups[i].SettingsRevision = readState.IsMuted, readState.SettingsRevision
	}
	return groups, nil
}

func (s *groupDMService) Get(ctx context.Context, groupID, userID string) (*models.GroupDM, error) {
	g, err := s.requireMember(ctx, groupID, userID)
	if err != nil {
		return nil, err
	}
	if err := s.hydrate(ctx, g); err != nil {
		return nil, err
	}
	readState, err := s.groups.GetReadState(ctx, groupID, userID)
	if err == nil {
		g.UnreadCount, g.ReadRevision = readState.UnreadCount, readState.Revision
		g.OldestUnreadMessageID = readState.OldestUnreadMessageID
		g.LastReadSourceSequence, g.ReadKeyEpoch = readState.LastReadSourceSequence, readState.KeyEpoch
		g.IsMuted, g.SettingsRevision = readState.IsMuted, readState.SettingsRevision
	}
	return g, err
}

func (s *groupDMService) Update(ctx context.Context, groupID, actorID string, req *models.UpdateGroupDMRequest) (*models.GroupDM, error) {
	g, err := s.requireMember(ctx, groupID, actorID)
	if err != nil {
		return nil, err
	}
	if g.OwnerID != actorID {
		return nil, pkg.ErrForbidden
	}
	if err := req.Validate(); err != nil {
		return nil, badGroupRequest(err)
	}
	if err := s.groups.UpdateProfile(ctx, groupID, req.Name, req.IconURL); err != nil {
		return nil, err
	}
	return s.broadcastGroup(ctx, groupID, ws.OpGroupDMUpdate, actorID)
}

func (s *groupDMService) AddMember(ctx context.Context, groupID, actorID, userID string) (*models.GroupDM, error) {
	g, err := s.requireMember(ctx, groupID, actorID)
	if err != nil {
		return nil, err
	}
	if g.OwnerID != actorID {
		return nil, pkg.ErrForbidden
	}
	ids, err := s.groups.ListMemberIDs(ctx, groupID)
	if err != nil {
		return nil, err
	}
	if len(ids) >= 10 {
		return nil, fmt.Errorf("%w: group member limit reached", pkg.ErrConflict)
	}
	if _, err := s.publicUser(ctx, userID); err != nil {
		return nil, err
	}
	blocked, err := s.friendships.IsBlocked(ctx, actorID, userID)
	if err != nil {
		return nil, err
	}
	if blocked {
		return nil, pkg.ErrForbidden
	}
	epoch, err := s.groups.AddMember(ctx, groupID, userID)
	if err != nil {
		return nil, err
	}
	g, err = s.broadcastGroup(ctx, groupID, ws.OpGroupDMUpdate, actorID)
	if err == nil {
		s.hub.BroadcastToUsers(append(ids, userID), ws.Event{Op: ws.OpGroupDMRekey, Data: map[string]any{"group_id": groupID, "key_epoch": epoch}})
	}
	return g, err
}

func (s *groupDMService) RemoveMember(ctx context.Context, groupID, actorID, userID string) (*models.GroupDM, error) {
	g, err := s.requireMember(ctx, groupID, actorID)
	if err != nil {
		return nil, err
	}
	if g.OwnerID != actorID || userID == actorID {
		return nil, pkg.ErrForbidden
	}
	ids, err := s.groups.ListMemberIDs(ctx, groupID)
	if err != nil {
		return nil, err
	}
	epoch, err := s.groups.RemoveMember(ctx, groupID, userID)
	if err != nil {
		return nil, err
	}
	remaining := make([]string, 0, len(ids)-1)
	for _, id := range ids {
		if id != userID {
			remaining = append(remaining, id)
		}
	}
	s.hub.BroadcastToUser(userID, ws.Event{Op: ws.OpGroupDMDelete, Data: map[string]string{"group_id": groupID}})
	s.refreshGroupInbox(ctx, userID)
	g, err = s.broadcastGroup(ctx, groupID, ws.OpGroupDMUpdate, actorID)
	if err == nil {
		s.hub.BroadcastToUsers(remaining, ws.Event{Op: ws.OpGroupDMRekey, Data: map[string]any{"group_id": groupID, "key_epoch": epoch}})
	}
	return g, err
}

func (s *groupDMService) Leave(ctx context.Context, groupID, userID string) error {
	g, err := s.requireMember(ctx, groupID, userID)
	if err != nil {
		return err
	}
	ids, err := s.groups.ListMemberIDs(ctx, groupID)
	if err != nil {
		return err
	}
	if len(ids) == 1 {
		urls, _ := s.groups.GetAttachmentFileURLsByGroup(ctx, groupID)
		if err := s.groups.Delete(ctx, groupID); err != nil {
			return err
		}
		removeUploadFilesByURL(s.uploadDir, urls)
		s.hub.BroadcastToUser(userID, ws.Event{Op: ws.OpGroupDMDelete, Data: map[string]string{"group_id": groupID}})
		s.refreshGroupInbox(ctx, userID)
		return nil
	}
	if g.OwnerID == userID {
		for _, id := range ids {
			if id != userID {
				if err := s.groups.TransferOwner(ctx, groupID, id); err != nil {
					return err
				}
				break
			}
		}
	}
	epoch, err := s.groups.RemoveMember(ctx, groupID, userID)
	if err != nil {
		return err
	}
	remaining := slices.DeleteFunc(slices.Clone(ids), func(id string) bool { return id == userID })
	s.hub.BroadcastToUser(userID, ws.Event{Op: ws.OpGroupDMDelete, Data: map[string]string{"group_id": groupID}})
	s.refreshGroupInbox(ctx, userID)
	if _, err := s.broadcastGroup(ctx, groupID, ws.OpGroupDMUpdate); err != nil {
		return err
	}
	s.hub.BroadcastToUsers(remaining, ws.Event{Op: ws.OpGroupDMRekey, Data: map[string]any{"group_id": groupID, "key_epoch": epoch}})
	return nil
}

func (s *groupDMService) broadcastGroup(ctx context.Context, groupID, op string, viewerID ...string) (*models.GroupDM, error) {
	g, err := s.groups.GetByID(ctx, groupID)
	if err != nil {
		return nil, err
	}
	if err := s.hydrate(ctx, g); err != nil {
		return nil, err
	}
	var viewer *models.GroupDM
	for _, member := range g.Members {
		copy := *g
		readState, readErr := s.groups.GetReadState(ctx, groupID, member.ID)
		err = readErr
		if err != nil {
			return nil, err
		}
		copy.UnreadCount, copy.ReadRevision = readState.UnreadCount, readState.Revision
		copy.IsMuted, copy.SettingsRevision = readState.IsMuted, readState.SettingsRevision
		copy.LastReadSourceSequence, copy.ReadKeyEpoch = readState.LastReadSourceSequence, readState.KeyEpoch
		if len(viewerID) > 0 && member.ID == viewerID[0] {
			viewer = &copy
		}
		s.hub.BroadcastToUser(member.ID, ws.Event{Op: op, Data: &copy})
	}
	if len(viewerID) > 0 {
		if viewer == nil {
			return nil, pkg.ErrNotFound
		}
		return viewer, nil
	}
	return g, nil
}

func (s *groupDMService) ListMessages(ctx context.Context, groupID, userID, beforeID string, limit int) ([]models.GroupDMMessage, error) {
	if _, err := s.requireMember(ctx, groupID, userID); err != nil {
		return nil, err
	}
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	items, err := s.groups.ListMessages(ctx, groupID, beforeID, limit)
	if err != nil {
		return nil, err
	}
	slices.Reverse(items)
	if err := s.enrichMessageHistory(ctx, items); err != nil {
		return nil, err
	}
	return items, nil
}

func (s *groupDMService) GetMessagesAround(ctx context.Context, groupID, userID, anchorID string, limit int) (*models.GroupDMMessagePage, error) {
	if _, err := s.requireMember(ctx, groupID, userID); err != nil {
		return nil, err
	}
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	items, hasMoreBefore, hasMoreAfter, err := s.groups.GetMessagesAround(ctx, groupID, anchorID, limit)
	if err != nil {
		return nil, err
	}
	if err := s.enrichMessageHistory(ctx, items); err != nil {
		return nil, err
	}
	if items == nil {
		items = []models.GroupDMMessage{}
	}
	return &models.GroupDMMessagePage{Messages: items, HasMore: hasMoreBefore, HasMoreAfter: hasMoreAfter}, nil
}

func (s *groupDMService) enrichMessageHistory(ctx context.Context, items []models.GroupDMMessage) error {
	for i := range items {
		u, err := s.users.GetByID(ctx, items[i].UserID)
		if err != nil {
			return err
		}
		items[i].User = models.ToPublicUser(u)
	}
	ids := make([]string, len(items))
	for i := range items {
		ids[i] = items[i].ID
	}
	reactions, err := s.groups.GetReactions(ctx, ids)
	if err != nil {
		return err
	}
	for i := range items {
		items[i].Reactions = reactions[items[i].ID]
		if items[i].Reactions == nil {
			items[i].Reactions = []models.ReactionGroup{}
		}
	}
	attachments, err := s.groups.GetAttachments(ctx, ids)
	if err != nil {
		return err
	}
	for i := range items {
		items[i].Attachments = attachments[items[i].ID]
		if items[i].Attachments == nil {
			items[i].Attachments = []models.GroupDMAttachment{}
		}
	}
	return nil
}

func (s *groupDMService) SendMessage(ctx context.Context, groupID, userID string, req *models.CreateGroupDMMessageRequest) (*models.GroupDMMessage, error) {
	g, err := s.requireMember(ctx, groupID, userID)
	if err != nil {
		return nil, err
	}
	if err := req.Validate(); err != nil {
		return nil, badGroupRequest(err)
	}
	if req.KeyEpoch != g.KeyEpoch {
		return nil, fmt.Errorf("%w: group encryption key changed", pkg.ErrConflict)
	}
	if len(*req.Ciphertext) > 2_000_000 || (req.E2EEMetadata != nil && (len(*req.E2EEMetadata) > 1_000_000 || !json.Valid([]byte(*req.E2EEMetadata)))) {
		return nil, badGroupRequest(errors.New("invalid encrypted group message payload"))
	}
	if req.ReplyToID != nil {
		if _, err := s.groups.GetMessage(ctx, groupID, *req.ReplyToID); err != nil {
			return nil, badGroupRequest(errors.New("reply target not found"))
		}
	}
	// Resolve required response data before the write. A failed profile lookup
	// after commit would report a saved message as failed and invite a duplicate.
	u, err := s.users.GetByID(ctx, userID)
	if err != nil {
		return nil, err
	}
	m := &models.GroupDMMessage{GroupID: groupID, UserID: userID, EncryptionVersion: 1, Ciphertext: req.Ciphertext, SenderDeviceID: req.SenderDeviceID, E2EEMetadata: req.E2EEMetadata, KeyEpoch: req.KeyEpoch, ReplyToID: req.ReplyToID, Reactions: []models.ReactionGroup{}, Attachments: []models.GroupDMAttachment{}}
	if req.ClientRequestID != "" {
		op, opErr := s.groups.GetSendOperation(ctx, groupID, userID, req.ClientRequestID)
		if opErr != nil {
			return nil, opErr
		}
		if req.RequestHash == "" || op.RequestHash != req.RequestHash || op.Phase != "prepared" {
			return nil, pkg.ErrConflict
		}
		m.SendRequestID = req.ClientRequestID
	}
	m.User = models.ToPublicUser(u)
	if err := s.groups.CreateMessage(ctx, m); err != nil {
		return nil, err
	}
	return m, nil
}

func (s *groupDMService) BroadcastMessage(ctx context.Context, m *models.GroupDMMessage) error {
	ids, err := s.groups.ListMemberIDs(ctx, m.GroupID)
	if err != nil {
		groupDMLogger.Error("committed message broadcast skipped", "group_id", m.GroupID, "err", pkg.ErrText(err))
		return nil
	}
	s.hub.BroadcastToUsers(ids, ws.Event{Op: ws.OpGroupDMMessageCreate, Data: m})
	s.deliverGroupIncomingNotifications(ctx, m)
	s.refreshGroupInbox(ctx, m.UserID)
	return s.broadcastReadStates(ctx, m.GroupID, ids)
}

func (s *groupDMService) EditMessage(ctx context.Context, groupID, messageID, userID string, req *models.UpdateGroupDMMessageRequest) (*models.GroupDMMessage, error) {
	g, err := s.requireMember(ctx, groupID, userID)
	if err != nil {
		return nil, err
	}
	if err = req.Validate(); err != nil {
		return nil, badGroupRequest(err)
	}
	if req.KeyEpoch != g.KeyEpoch {
		return nil, fmt.Errorf("%w: group encryption key changed", pkg.ErrConflict)
	}
	m, err := s.groups.GetMessage(ctx, groupID, messageID)
	if err != nil {
		return nil, err
	}
	if m.UserID != userID {
		return nil, pkg.ErrForbidden
	}
	if len(*req.Ciphertext) > 2_000_000 {
		return nil, badGroupRequest(errors.New("invalid encrypted group message payload"))
	}
	if err = s.groups.UpdateMessage(ctx, groupID, messageID, userID, req); err != nil {
		return nil, err
	}
	m, err = s.groups.GetMessage(ctx, groupID, messageID)
	if err != nil {
		return nil, err
	}
	u, err := s.users.GetByID(ctx, userID)
	if err != nil {
		return nil, err
	}
	m.User = models.ToPublicUser(u)
	reactions, err := s.groups.GetReactions(ctx, []string{messageID})
	if err != nil {
		return nil, err
	}
	m.Reactions = reactions[messageID]
	if m.Reactions == nil {
		m.Reactions = []models.ReactionGroup{}
	}
	attachments, err := s.groups.GetAttachments(ctx, []string{messageID})
	if err != nil {
		return nil, err
	}
	m.Attachments = attachments[messageID]
	if m.Attachments == nil {
		m.Attachments = []models.GroupDMAttachment{}
	}
	ids, err := s.groups.ListMemberIDs(ctx, groupID)
	if err != nil {
		return nil, err
	}
	s.hub.BroadcastToUsers(ids, ws.Event{Op: ws.OpGroupDMMessageUpdate, Data: m})
	return m, nil
}
func (s *groupDMService) DeleteMessage(ctx context.Context, groupID, messageID, userID string) error {
	if _, err := s.requireMember(ctx, groupID, userID); err != nil {
		return err
	}
	m, err := s.groups.GetMessage(ctx, groupID, messageID)
	if err != nil {
		return err
	}
	if m.UserID != userID {
		return pkg.ErrForbidden
	}
	attachments, _ := s.groups.GetAttachments(ctx, []string{messageID})
	if err = s.groups.DeleteMessage(ctx, groupID, messageID, userID); err != nil {
		return err
	}
	urls := make([]string, 0, len(attachments[messageID]))
	for _, a := range attachments[messageID] {
		urls = append(urls, a.FileURL)
	}
	removeUploadFilesByURL(s.uploadDir, urls)
	ids, err := s.groups.ListMemberIDs(ctx, groupID)
	if err != nil {
		groupDMLogger.Error("committed deletion broadcast skipped", "group_id", groupID, "err", pkg.ErrText(err))
		return nil
	}
	s.hub.BroadcastToUsers(ids, ws.Event{Op: ws.OpGroupDMMessageDelete, Data: map[string]string{"group_id": groupID, "id": messageID}})
	for _, id := range ids {
		s.refreshGroupInbox(ctx, id)
	}
	return s.broadcastReadStates(ctx, groupID, ids)
}
func (s *groupDMService) ToggleReaction(ctx context.Context, groupID, messageID, userID, emoji string) error {
	if _, err := s.requireMember(ctx, groupID, userID); err != nil {
		return err
	}
	message, err := s.groups.GetMessage(ctx, groupID, messageID)
	if err != nil {
		return err
	}
	custom, _, _, err := models.ParseReactionEmoji(emoji)
	if err != nil {
		return err
	}
	if custom {
		return fmt.Errorf("%w: server custom emoji are unavailable in group DMs", pkg.ErrBadRequest)
	}
	added, err := s.groups.ToggleReaction(ctx, messageID, userID, emoji)
	if err != nil {
		return err
	}
	r, err := s.groups.GetReactions(ctx, []string{messageID})
	if err != nil {
		return err
	}
	ids, err := s.groups.ListMemberIDs(ctx, groupID)
	if err != nil {
		return err
	}
	s.hub.BroadcastToUsers(ids, ws.Event{Op: ws.OpGroupDMReactionUpdate, Data: map[string]any{"group_id": groupID, "message_id": messageID, "reactions": r[messageID]}})
	if added && message.UserID != userID && slices.Contains(ids, message.UserID) {
		if creator, ok := s.reactionNotifications.(reactionNotificationCreator); ok {
			if s.reactionBlocks != nil {
				blocked, err := s.reactionBlocks.IsBlocked(ctx, userID, message.UserID)
				if err != nil || blocked {
					return nil
				}
			}
			payload, _ := json.Marshal(map[string]string{"group_id": groupID})
			n := &models.Notification{UserID: message.UserID, Kind: models.NotificationKindSystem, ActorID: &userID, MessageID: &message.ID, Payload: payload}
			deliverReactionNotification(ctx, creator, s.reactionPreferences, s.users, s.hub, n, emoji, true)
		}
	}
	return nil
}
func (s *groupDMService) MarkRead(ctx context.Context, groupID, userID string, messageID *string, expectedEpoch ...int64) (*models.GroupDMReadState, error) {
	if _, err := s.requireMember(ctx, groupID, userID); err != nil {
		return nil, err
	}
	if messageID != nil {
		if _, err := s.groups.GetMessage(ctx, groupID, *messageID); err != nil {
			return nil, err
		}
	}
	if err := s.groups.MarkRead(ctx, groupID, userID, messageID, expectedEpoch...); err != nil {
		return nil, err
	}
	state, err := s.groups.GetReadState(ctx, groupID, userID)
	if err != nil {
		return nil, err
	}
	s.hub.BroadcastToUser(userID, ws.Event{Op: ws.OpGroupDMRead, Data: state})
	s.refreshGroupInbox(ctx, userID)
	return state, nil
}

func (s *groupDMService) MarkUnreadFrom(ctx context.Context, groupID, userID, messageID string, expectedEpoch ...int64) (*models.GroupDMReadState, error) {
	if strings.TrimSpace(messageID) == "" {
		return nil, badGroupRequest(errors.New("message_id is required"))
	}
	if _, err := s.requireMember(ctx, groupID, userID); err != nil {
		return nil, err
	}
	state, err := s.groups.MarkUnreadFrom(ctx, groupID, userID, messageID, expectedEpoch...)
	if err != nil {
		return nil, err
	}
	s.hub.BroadcastToUser(userID, ws.Event{Op: ws.OpGroupDMRead, Data: state})
	return state, nil
}

func (s *groupDMService) broadcastReadStates(ctx context.Context, groupID string, ids []string) error {
	for _, id := range ids {
		state, err := s.groups.GetReadState(ctx, groupID, id)
		if errors.Is(err, pkg.ErrNotFound) {
			continue
		}
		if err != nil {
			groupDMLogger.Error("committed read-state broadcast skipped", "group_id", groupID, "user_id", id, "err", pkg.ErrText(err))
			continue
		}
		s.hub.BroadcastToUser(id, ws.Event{Op: ws.OpGroupDMRead, Data: state})
	}
	return nil
}
