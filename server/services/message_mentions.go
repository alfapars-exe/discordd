package services

// Mention parsing + audit preview helpers for messageService. Split out of
// message_service.go to keep that file focused on message CRUD; these are
// still methods on *messageService (same package), so the public interface,
// constructor, and wiring are unchanged.

import (
	"bytes"
	"context"
	"encoding/json"
	"regexp"
	"strings"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

// Discord-style token patterns: <@userId> for user mentions, <@&roleId>
// for role mentions. The character class is [a-z0-9] (not just hex)
// because legacy seed role IDs from older database snapshots are
// alphanumeric — tightening to [a-f0-9] would silently drop them.
var userMentionRegex = regexp.MustCompile(`<@([a-z0-9]+)>`)
var roleMentionRegex = regexp.MustCompile(`<@&([a-z0-9]+)>`)

// e2eeMentionIDRegex validates each entry of the client-supplied
// mention_user_ids list on an E2EE message (see extractMentionsFromMetadata).
var e2eeMentionIDRegex = regexp.MustCompile(`^[a-z0-9]{1,32}$`)

// maxE2EEMentions caps how many mention_user_ids entries are honoured on
// one E2EE message; anything past it is ignored.
const maxE2EEMentions = 50

// notificationPreviewMaxRunes caps the plaintext preview stored in a
// mention/reply notification payload.
const notificationPreviewMaxRunes = 120

// notificationPreview truncates a plaintext body for the inbox payload so
// the result is at most notificationPreviewMaxRunes runes INCLUDING the
// trailing ellipsis. Newlines collapse to spaces like messagePreview;
// returns nil for an empty body (file-only message) so the payload carries
// JSON null, never "".
func notificationPreview(content string) *string {
	cleaned := strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(content, "\r", " "), "\n", " "))
	if cleaned == "" {
		return nil
	}
	runes := []rune(cleaned)
	if len(runes) > notificationPreviewMaxRunes {
		cleaned = string(runes[:notificationPreviewMaxRunes-1]) + "…"
	}
	return &cleaned
}

// extractMentionsFromMetadata reads the mention targets of an E2EE message
// from its e2ee_metadata JSON (key "mention_user_ids": string[]). The
// server cannot parse <@id> tokens out of ciphertext, so the client declares
// them in the clear — an ACCEPTED metadata disclosure: the server learns who
// mentioned whom (already true for plaintext channels), never what was said.
//
// Defensive by design: malformed or absent metadata, a non-string entry,
// an ID outside ^[a-z0-9]{1,32}$, or an unknown user all degrade to "no
// mention" — never an error, since the metadata is opaque client data that
// must not be able to fail a send. Deduplicated, first maxE2EEMentions
// entries only.
func (s *messageService) extractMentionsFromMetadata(ctx context.Context, metadata *string) []string {
	if metadata == nil || *metadata == "" {
		return []string{}
	}
	var meta struct {
		MentionUserIDs []string `json:"mention_user_ids"`
	}
	if err := json.Unmarshal([]byte(*metadata), &meta); err != nil {
		return []string{}
	}
	ids := meta.MentionUserIDs
	if len(ids) > maxE2EEMentions {
		ids = ids[:maxE2EEMentions]
	}

	seen := make(map[string]bool, len(ids))
	userIDs := []string{}
	for _, id := range ids {
		if seen[id] || !e2eeMentionIDRegex.MatchString(id) {
			continue
		}
		seen[id] = true
		if _, err := s.userRepo.GetByID(ctx, id); err != nil {
			continue
		}
		userIDs = append(userIDs, id)
	}
	return userIDs
}

// messagePreview truncates and sanitises a message body for audit metadata.
// Newlines collapse to spaces (one-line audit entries), and the cap at 80
// runes keeps the JSON cheap on every event while still giving moderators
// enough context to identify what was deleted.
func messagePreview(content string) string {
	cleaned := strings.ReplaceAll(content, "\r", " ")
	cleaned = strings.ReplaceAll(cleaned, "\n", " ")
	runes := []rune(cleaned)
	const max = 80
	if len(runes) > max {
		return string(runes[:max]) + "…"
	}
	return cleaned
}

// buildMessageNotifications assembles the mention/reply inbox rows for a
// message about to be created: one 'mention' per mentioned user (author
// excluded), one 'reply' for the replied-to author when they are neither
// the author nor already in the mention set. Every target is dropped unless
// they can read the channel (PermCanReadChannel) — a resolver failure is
// treated as "cannot read" and logged, never as a send error. MessageID is
// left nil: the caller fills it inside the transaction once the message
// row exists. Payload preview is plaintext only (nil for E2EE/file-only).
func (s *messageService) buildMessageNotifications(
	ctx context.Context,
	channel *models.Channel,
	message *models.Message,
	req *models.CreateMessageRequest,
	mentionedIDs []string,
	replyTargetID string,
) []*models.Notification {
	type target struct {
		userID string
		kind   string
	}
	var targets []target
	mentioned := make(map[string]bool, len(mentionedIDs))
	for _, id := range mentionedIDs {
		if id == message.UserID {
			continue
		}
		mentioned[id] = true
		targets = append(targets, target{userID: id, kind: models.NotificationKindMention})
	}
	if replyTargetID != "" && replyTargetID != message.UserID && !mentioned[replyTargetID] {
		targets = append(targets, target{userID: replyTargetID, kind: models.NotificationKindReply})
	}
	if len(targets) == 0 {
		return nil
	}

	var preview *string
	if req.EncryptionVersion == 0 {
		preview = notificationPreview(req.Content)
	}
	// Encoder, not json.Marshal: Marshal HTML-escapes < and >, which would
	// store every <@id> mention token as <@id>. The payload is
	// JSON data, never injected as HTML, so escaping is off.
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(struct {
		Preview     *string `json:"preview"`
		ChannelName string  `json:"channel_name"`
	}{Preview: preview, ChannelName: channel.Name}); err != nil {
		// Two string fields cannot fail to encode; keep the row well-formed anyway.
		buf.Reset()
		buf.WriteString(`{}`)
	}
	payload := bytes.TrimRight(buf.Bytes(), "\n") // Encode appends a newline

	// A channel without a server stores NULL, not '' — the orphan repair
	// and cascade statements match on server_id and must not see a bogus
	// empty-string server.
	var serverID *string
	if channel.ServerID != "" {
		sid := channel.ServerID
		serverID = &sid
	}
	channelID := channel.ID
	var out []*models.Notification
	for _, t := range targets {
		perms, err := s.permResolver.ResolveChannelPermissions(ctx, t.userID, channelID)
		if err != nil {
			messageLogger.Warn("notification target permission resolve failed, skipping",
				"user_id", t.userID, "channel_id", channelID, "err", pkg.ErrText(err))
			continue
		}
		if !models.PermCanReadChannel(perms) {
			continue
		}
		actorID := message.UserID
		out = append(out, &models.Notification{
			UserID:    t.userID,
			Kind:      t.kind,
			ActorID:   &actorID,
			ServerID:  serverID,
			ChannelID: &channelID,
			Payload:   json.RawMessage(payload),
		})
	}
	return out
}

// extractRoleMentions parses <@&roleId> tokens from content and returns role IDs.
// Only includes roles that exist in the server and are mentionable.
func (s *messageService) extractRoleMentions(ctx context.Context, content string, serverID string) []string {
	if serverID == "" {
		return []string{}
	}

	matches := roleMentionRegex.FindAllStringSubmatch(content, -1)
	if len(matches) == 0 {
		return []string{}
	}

	// Load all server roles to validate IDs and check mentionable flag
	roles, err := s.roleRepo.GetAllByServer(ctx, serverID)
	if err != nil {
		return []string{}
	}

	roleByID := make(map[string]*models.Role, len(roles))
	for i := range roles {
		roleByID[roles[i].ID] = &roles[i]
	}

	seen := make(map[string]bool)
	var roleIDs []string

	for _, match := range matches {
		roleID := match[1]
		if seen[roleID] {
			continue
		}
		seen[roleID] = true

		role, ok := roleByID[roleID]
		if !ok || !role.Mentionable {
			continue
		}
		roleIDs = append(roleIDs, roleID)
	}

	if roleIDs == nil {
		roleIDs = []string{}
	}
	return roleIDs
}

// extractMentions parses <@userId> tokens from content and returns valid user IDs.
// Validates that each user ID exists. Deduplicates results.
func (s *messageService) extractMentions(ctx context.Context, content string) []string {
	matches := userMentionRegex.FindAllStringSubmatch(content, -1)
	if len(matches) == 0 {
		return []string{}
	}

	seen := make(map[string]bool)
	var userIDs []string

	for _, match := range matches {
		userID := match[1]
		if seen[userID] {
			continue
		}
		seen[userID] = true

		// Validate user exists
		_, err := s.userRepo.GetByID(ctx, userID)
		if err != nil {
			continue
		}
		userIDs = append(userIDs, userID)
	}

	if userIDs == nil {
		userIDs = []string{}
	}
	return userIDs
}
