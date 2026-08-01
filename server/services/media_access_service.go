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
	"path"
	"strings"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

// MediaDecision is the authorization outcome for a download request.
type MediaDecision int

const (
	// mediaDecisionUnset is the zero value of MediaDecision. It is returned
	// only from Authorize's error paths (`return mediaDecisionUnset, err`),
	// paired with a non-nil error — callers must check err before switching
	// on the decision, and Serve does. It is deliberately NOT MediaPublic:
	// a type whose whole purpose is failing closed must not have "serve to
	// anyone" as the value a caller gets by accident (an unchecked err, a
	// zero-initialised variable, a future call site that forgets to test
	// err first) — that would fail OPEN instead. Unexported: a nil error
	// must always pair with one of the real decisions below, never with
	// this one.
	mediaDecisionUnset MediaDecision = iota
	// MediaPublic — fileURL is POSITIVELY confirmed to be a public asset: it
	// matches a public media column (user avatar/wallpaper, server icon/banner
	// via MediaAssetRepository.IsPublicAsset) or a known-public path prefix
	// (soundboard/, badges/). Serve to anyone. This is a positive allowlist,
	// not "nothing claimed it" — see MediaNotFound for the fail-closed dip
	// below it.
	MediaPublic
	// MediaAllowed — an attachment the authenticated caller may see.
	MediaAllowed
	// MediaForbidden — an attachment the caller may NOT see.
	MediaForbidden
	// MediaNotFound — either an attachment row pointed at a deleted parent
	// (message/report/ticket), or fileURL matched no ownership table AND no
	// positive public-asset check. Either way, 404 rather than falling open.
	//
	// The bottom fail-closed dip (fileURL matched nothing at all) is NOT dead
	// code, and which of the two shapes above fires depends on environment:
	// prod runs remote libSQL/Turso, which never enables the `foreign_keys`
	// PRAGMA, so `ON DELETE CASCADE` on the attachment tables never fires
	// there — a deleted message/report/ticket leaves its attachment row (and
	// thus fileURL) behind, so the orphan is caught by the nested
	// parent-lookup-failure checks inside the ownership branches below. Local
	// SQLite deployments DO enforce the cascade, so there the attachment row
	// itself is deleted along with its parent, fileURL matches no table from
	// the start, and it's the bottom dip that catches it.
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
	mediaReportGetter interface {
		GetAttachmentByFileURL(ctx context.Context, fileURL string) (*models.ReportAttachment, error)
		GetByID(ctx context.Context, id string) (*models.Report, error)
	}
	mediaFeedbackGetter interface {
		GetAttachmentByFileURL(ctx context.Context, fileURL string) (*models.FeedbackAttachment, error)
		GetTicketByID(ctx context.Context, id string) (*models.FeedbackTicketWithUser, error)
	}
	mediaUserGetter interface {
		GetByID(ctx context.Context, id string) (*models.User, error)
	}
	mediaPublicAssetChecker interface {
		// IsPublicAsset reports whether fileURL is referenced by a public media
		// column (avatar/wallpaper/icon/banner) — see MediaAssetRepository.
		IsPublicAsset(ctx context.Context, fileURL string) (bool, error)
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
	reports      mediaReportGetter
	feedback     mediaFeedbackGetter
	users        mediaUserGetter
	publicAssets mediaPublicAssetChecker
}

func NewMediaAccessService(
	attachments mediaAttachmentGetter,
	messages mediaMessageGetter,
	dms mediaDMGetter,
	permResolver ChannelPermResolver,
	reports mediaReportGetter,
	feedback mediaFeedbackGetter,
	users mediaUserGetter,
	publicAssets mediaPublicAssetChecker,
) MediaAccessService {
	return &mediaAccessService{
		attachments:  attachments,
		messages:     messages,
		dms:          dms,
		permResolver: permResolver,
		reports:      reports,
		feedback:     feedback,
		users:        users,
		publicAssets: publicAssets,
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
		return mediaDecisionUnset, err
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
		return mediaDecisionUnset, err
	}

	// Report attachment — moderation evidence. Visible to the reporter (their
	// own evidence) and to platform admins (investigating it); nobody else,
	// including the reported user.
	if reportAtt, err := s.reports.GetAttachmentByFileURL(ctx, fileURL); err == nil {
		userID, ok := resolveUser()
		if !ok {
			return MediaRequiresAuth, nil
		}
		report, err := s.reports.GetByID(ctx, reportAtt.ReportID)
		if err != nil {
			// Attachment points at a deleted report — 404, not 403, so we
			// don't disclose the orphan.
			return MediaNotFound, nil
		}
		if report.ReporterID == userID {
			return MediaAllowed, nil
		}
		user, err := s.users.GetByID(ctx, userID)
		if err != nil || !user.IsPlatformAdmin {
			// A lookup failure fails closed as Forbidden, not NotFound — the
			// report is already known to exist, so there's no orphan to hide.
			return MediaForbidden, nil
		}
		return MediaAllowed, nil
	} else if !errors.Is(err, pkg.ErrNotFound) {
		return mediaDecisionUnset, err
	}

	// Feedback attachment — support ticket evidence. Visible to the ticket
	// owner and to platform admins; nobody else.
	if fbAtt, err := s.feedback.GetAttachmentByFileURL(ctx, fileURL); err == nil {
		userID, ok := resolveUser()
		if !ok {
			return MediaRequiresAuth, nil
		}
		// sqliteFeedbackRepo.GetTicketByID wraps sql.ErrNoRows directly rather
		// than the pkg.ErrNotFound sentinel, so it cannot be distinguished
		// from any other lookup failure here. Any error — not-found or
		// otherwise — must therefore fail closed to MediaNotFound rather than
		// falling through to a laxer branch.
		ticket, err := s.feedback.GetTicketByID(ctx, fbAtt.TicketID)
		if err != nil {
			return MediaNotFound, nil
		}
		if ticket.UserID == userID {
			return MediaAllowed, nil
		}
		user, err := s.users.GetByID(ctx, userID)
		if err != nil || !user.IsPlatformAdmin {
			return MediaForbidden, nil
		}
		return MediaAllowed, nil
	} else if !errors.Is(err, pkg.ErrNotFound) {
		return mediaDecisionUnset, err
	}

	// Positive public-asset check — fileURL is referenced by a public media
	// column (avatar/wallpaper/icon/banner). This MUST run after every
	// ownership query above: checking it first would let a caller point their
	// own avatar_url at someone else's orphaned private file and have it
	// classified public before ownership is ever consulted.
	if public, err := s.publicAssets.IsPublicAsset(ctx, fileURL); err != nil {
		return mediaDecisionUnset, err
	} else if public {
		return MediaPublic, nil
	}

	// Known-public path prefixes with no attachment table to consult:
	// soundboard samples and badge icons. Same ordering rule as above — this
	// runs after ownership, not before.
	//
	// Unlike every lookup above (an exact-string DB match, which a
	// non-canonical fileURL simply misses — see the MediaNotFound doc
	// comment), this branch has no table to consult: it's a raw
	// strings.HasPrefix on fileURL itself. A non-canonical fileURL such as
	// "/api/uploads/soundboard/../victim.png" would match this prefix here
	// while a byte-serving path.Clean elsewhere resolves it onto a
	// completely different, unrelated file. Serve (upload_download.go)
	// already rejects non-canonical paths before calling Authorize, but
	// this service must not depend on that caller invariant holding for
	// every current and future call site — verify canonicality here too,
	// as a second, independent layer (the "invariant comments have lied
	// before" pattern — see upload_acl_canonical_test.go).
	name := strings.TrimPrefix(fileURL, "/api/uploads/")
	canonical := path.Clean("/"+name) == "/"+name
	if canonical && (strings.HasPrefix(name, "soundboard/") || strings.HasPrefix(name, "badges/")) {
		return MediaPublic, nil
	}

	// Nothing claimed this path: no ownership table, no positive public-asset
	// match. Fail closed — see the MediaNotFound doc comment for why this is
	// reachable rather than dead.
	return MediaNotFound, nil
}
