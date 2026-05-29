package services

// Mention parsing + audit preview helpers for messageService. Split out of
// message_service.go to keep that file focused on message CRUD; these are
// still methods on *messageService (same package), so the public interface,
// constructor, and wiring are unchanged.

import (
	"context"
	"regexp"
	"strings"

	"github.com/argeinfina/hichat/models"
)

// Discord-style token patterns: <@userId> for user mentions, <@&roleId>
// for role mentions. The character class is [a-z0-9] (not just hex)
// because legacy seed role IDs from older database snapshots are
// alphanumeric — tightening to [a-f0-9] would silently drop them.
var userMentionRegex = regexp.MustCompile(`<@([a-z0-9]+)>`)
var roleMentionRegex = regexp.MustCompile(`<@&([a-z0-9]+)>`)

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
