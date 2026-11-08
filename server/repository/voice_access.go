package repository

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

type postgresVoiceChannelRepo struct{ *sqliteChannelRepo }

// Read the channel and its authorization facts in the same statement. Both
// token issuance and WS admission take a fresh snapshot (including revocations).
func (r *postgresVoiceChannelRepo) VoiceAdmission(ctx context.Context, userID, channelID string) (*models.VoiceAdmission, error) {
	const query = `SELECT c.id, c.server_id, c.type, c.user_limit,
		EXISTS (SELECT 1 FROM server_members m WHERE m.server_id=c.server_id AND m.user_id=?),
		EXISTS (SELECT 1 FROM member_timeouts t WHERE t.server_id=c.server_id AND t.user_id=? AND t.expires_at>CURRENT_TIMESTAMP),
		COALESCE(bit_or(r.permissions),0), COALESCE(bit_or(o.allow),0), COALESCE(bit_or(o.deny),0)
		FROM channels c
		LEFT JOIN user_roles ur ON ur.server_id=c.server_id AND ur.user_id=?
		LEFT JOIN roles r ON r.id=ur.role_id AND r.server_id=c.server_id
		LEFT JOIN channel_permissions o ON o.channel_id=c.id AND o.role_id=r.id
		WHERE c.id=? GROUP BY c.id, c.server_id, c.type, c.user_limit`
	var a models.VoiceAdmission
	var base, allow, deny models.Permission
	err := r.db.QueryRowContext(ctx, query, userID, userID, userID, channelID).Scan(&a.Channel.ID, &a.Channel.ServerID, &a.Channel.Type, &a.Channel.UserLimit, &a.Member, &a.TimedOut, &base, &allow, &deny)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	a.Permissions = models.EffectiveChannelPermission(base, allow, deny)
	return &a, nil
}

// VoiceVisibleUsers resolves only connected candidates. Membership, channel
// scope and effective permissions are read together, without a shared cache.
func (r *postgresVoiceChannelRepo) VoiceVisibleUsers(ctx context.Context, serverID, channelID string, online []string) ([]string, error) {
	if len(online) == 0 {
		return nil, nil
	}
	args := make([]any, 0, len(online)+2)
	args = append(args, serverID, channelID)
	for _, id := range online {
		args = append(args, id)
	}
	query := `SELECT m.user_id,bit_or(r.permissions),COALESCE(bit_or(o.allow),0),COALESCE(bit_or(o.deny),0)
	FROM channels c
	JOIN server_members m ON m.server_id=c.server_id
	JOIN user_roles ur ON ur.user_id=m.user_id AND ur.server_id=m.server_id
	JOIN roles r ON r.id=ur.role_id AND r.server_id=c.server_id
	LEFT JOIN channel_permissions o ON o.channel_id=c.id AND o.role_id=r.id
	WHERE c.server_id=? AND c.id=? AND c.type='voice' AND m.user_id IN (` + strings.TrimSuffix(strings.Repeat("?,", len(online)), ",") + `) GROUP BY m.user_id`
	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var visible []string
	for rows.Next() {
		var id string
		var base, allow, deny models.Permission
		if err := rows.Scan(&id, &base, &allow, &deny); err != nil {
			return nil, err
		}
		if models.EffectiveChannelPermission(base, allow, deny).Has(models.PermViewChannel) {
			visible = append(visible, id)
		}
	}
	return visible, rows.Err()
}
