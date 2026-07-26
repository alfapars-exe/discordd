// Package services — MediaAccessService: authorization decision for
// /api/uploads downloads, extracted from the HTTP handler so the
// attachment->message->permission and DM->participant logic lives in the
// service layer (and is unit-testable without an httptest harness). The
// handler keeps the HTTP concerns: token extraction, status mapping, and
// streaming the bytes.
package services

import (
	"context"
	"errors"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

// MediaDecision is the authorization outcome for a download request.
type MediaDecision int

const (
	// MediaPublic — the path is not an access-controlled attachment (avatar,
	// server icon, badge, soundboard sample, branding). Serve to anyone.
	MediaPublic MediaDecision = iota
	// MediaAllowed — an attachment the authenticated caller may see.
	MediaAllowed
	// MediaForbidden — an attachment the caller may NOT see.
	MediaForbidden
	// MediaNotFound — attachment references a deleted message/channel; 404 so
	// the orphan isn't disclosed.
	MediaNotFound
	// MediaRequiresAuth — an attachment was found but the caller is unauthenticated.
	MediaRequiresAuth
)

// Narrow getters — satisfied structurally by the concrete repositories and by
// test mocks. Kept minimal (ISP) so the service depends only on what it uses.
type (
	mediaAttachmentGetter interface {
		GetByFileURL(ctx context.Context, fileURL string) (*models.Attachment, error)
	}
	mediaMessageGetter interface {
		GetByID(ctx context.Context, id string) (*models.Message, error)
	}
	mediaDMGetter interface {
		GetAttachmentByFileURL(ctx context.Context, fileURL string) (*models.DMAttachment, error)
		GetMessageByID(ctx context.Context, id string) (*models.DMMessage, error)
		GetChannelByID(ctx context.Context, id string) (*models.DMChannel, error)
	}
)

// MediaAccessService decides whether a caller may download an upload URL.
type MediaAccessService interface {
	// Authorize resolves fileURL to a decision. resolveUser is invoked lazily —
	// only when fileURL turns out to be an access-controlled attachment — so
	// public assets never trigger token validation (preserving the handler's
	// original behaviour). It returns ("", false) for an unauthenticated caller.
	Authorize(ctx context.Context, fileURL string, resolveUser func() (userID string, ok bool)) (MediaDecision, error)
}

type mediaAccessService struct {
	attachments  mediaAttachmentGetter
	messages     mediaMessageGetter
	dms          mediaDMGetter
	permResolver ChannelPermResolver
}

func NewMediaAccessService(
	attachments mediaAttachmentGetter,
	messages mediaMessageGetter,
	dms mediaDMGetter,
	permResolver ChannelPermResolver,
) MediaAccessService {
	return &mediaAccessService{
		attachments:  attachments,
		messages:     messages,
		dms:          dms,
		permResolver: permResolver,
	}
}

func (s *mediaAccessService) Authorize(ctx context.Context, fileURL string, resolveUser func() (string, bool)) (MediaDecision, error) {
	// Channel attachment: file_url is the unique disk URL, so this EQ lookup
	// hits at most one row.
	if att, err := s.attachments.GetByFileURL(ctx, fileURL); err == nil {
		userID, ok := resolveUser()
		if !ok {
			return MediaRequiresAuth, nil
		}
		msg, err := s.messages.GetByID(ctx, att.MessageID)
		if err != nil {
			// Attachment points at a deleted message — 404, not 403, so we
			// don't disclose the orphan.
			return MediaNotFound, nil
		}
		perms, err := s.permResolver.ResolveChannelPermissions(ctx, userID, msg.ChannelID)
		if err != nil {
			return MediaNotFound, nil
		}
		if perms&models.PermReadMessages == 0 {
			return MediaForbidden, nil
		}
		return MediaAllowed, nil
	} else if !errors.Is(err, pkg.ErrNotFound) {
		return 0, err
	}

	// DM attachment.
	if dmAtt, err := s.dms.GetAttachmentByFileURL(ctx, fileURL); err == nil {
		userID, ok := resolveUser()
		if !ok {
			return MediaRequiresAuth, nil
		}
		dmMsg, err := s.dms.GetMessageByID(ctx, dmAtt.DMMessageID)
		if err != nil {
			return MediaNotFound, nil
		}
		dmChan, err := s.dms.GetChannelByID(ctx, dmMsg.DMChannelID)
		if err != nil {
			return MediaNotFound, nil
		}
		if dmChan.User1ID != userID && dmChan.User2ID != userID {
			return MediaForbidden, nil
		}
		return MediaAllowed, nil
	} else if !errors.Is(err, pkg.ErrNotFound) {
		return 0, err
	}

	// Neither attachment table claims this path — public asset.
	return MediaPublic, nil
}
