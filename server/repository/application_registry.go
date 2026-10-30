package repository

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

func (r *BotRepository) PutManifest(ctx context.Context, ownerID, botID, description string, testMode bool, actions []models.ApplicationAction) (*models.ApplicationManifest, error) {
	raw := database.RawDB(r.db)
	if raw == nil {
		return nil, fmt.Errorf("manifest transaction unavailable")
	}
	err := database.WithTx(ctx, raw, func(tx *sql.Tx) error {
		result, err := tx.ExecContext(ctx, `INSERT INTO application_manifests(bot_user_id,description,test_mode,updated_at)
			SELECT id,?,?,CURRENT_TIMESTAMP FROM users WHERE id=? AND owner_user_id=? AND is_bot=1 AND deleted_at IS NULL
			ON CONFLICT(bot_user_id) DO UPDATE SET description=excluded.description,test_mode=excluded.test_mode,updated_at=CURRENT_TIMESTAMP`, description, testMode, botID, ownerID)
		if err != nil {
			return err
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if affected != 1 {
			return pkg.ErrNotFound
		}
		if _, err = tx.ExecContext(ctx, `DELETE FROM application_actions WHERE bot_user_id=?`, botID); err != nil {
			return err
		}
		for i := range actions {
			id, err := generateIDN(16)
			if err != nil {
				return err
			}
			actions[i].ID = id
			actions[i].BotID = botID
			actions[i].Position = i
			if _, err = tx.ExecContext(ctx, `INSERT INTO application_actions(id,bot_user_id,name,label,context,position) VALUES(?,?,?,?,?,?)`, id, botID, actions[i].Name, actions[i].Label, actions[i].Context, i); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return r.ManifestByBot(ctx, botID)
}

func (r *BotRepository) ManifestByBot(ctx context.Context, botID string) (*models.ApplicationManifest, error) {
	var out models.ApplicationManifest
	if err := r.db.QueryRowContext(ctx, `SELECT bot_user_id,description,test_mode,updated_at FROM application_manifests WHERE bot_user_id=?`, botID).Scan(&out.BotID, &out.Description, &out.TestMode, &out.UpdatedAt); err != nil {
		return nil, err
	}
	rows, err := r.db.QueryContext(ctx, `SELECT id,bot_user_id,name,label,context,position FROM application_actions WHERE bot_user_id=? ORDER BY position,id`, botID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var a models.ApplicationAction
		if err := rows.Scan(&a.ID, &a.BotID, &a.Name, &a.Label, &a.Context, &a.Position); err != nil {
			return nil, err
		}
		out.Actions = append(out.Actions, a)
	}
	return &out, rows.Err()
}

func (r *BotRepository) ListOwnedManifests(ctx context.Context, ownerID string) ([]models.ApplicationManifest, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT m.bot_user_id FROM application_manifests m JOIN users b ON b.id=m.bot_user_id WHERE b.owner_user_id=? AND b.deleted_at IS NULL ORDER BY m.updated_at DESC`, ownerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]models.ApplicationManifest, 0, len(ids))
	for _, id := range ids {
		m, err := r.ManifestByBot(ctx, id)
		if err != nil {
			return nil, err
		}
		out = append(out, *m)
	}
	return out, nil
}

func (r *BotRepository) InstallApplication(ctx context.Context, actorID, serverID, botID string, scopes []string) (*models.ApplicationInstallation, error) {
	encoded, _ := json.Marshal(scopes)
	raw := database.RawDB(r.db)
	if raw == nil {
		return nil, fmt.Errorf("installation transaction unavailable")
	}
	err := database.WithTx(ctx, raw, func(tx *sql.Tx) error {
		result, err := tx.ExecContext(ctx, `INSERT INTO application_installations(bot_user_id,server_id,scopes,installed_by,installed_at,revoked_at)
			SELECT m.bot_user_id,s.id,?,?,CURRENT_TIMESTAMP,NULL FROM application_manifests m JOIN servers s ON s.id=? WHERE m.bot_user_id=?
			ON CONFLICT(bot_user_id,server_id) DO UPDATE SET scopes=excluded.scopes,installed_by=excluded.installed_by,installed_at=CURRENT_TIMESTAMP,revoked_at=NULL`, string(encoded), actorID, serverID, botID)
		if err != nil {
			return err
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if affected != 1 {
			return pkg.ErrNotFound
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO server_members(server_id,user_id) VALUES(?,?) ON CONFLICT DO NOTHING`, serverID, botID)
		return err
	})
	if err != nil {
		return nil, err
	}
	return r.ApplicationInstallation(ctx, serverID, botID)
}

func (r *BotRepository) ApplicationInstallation(ctx context.Context, serverID, botID string) (*models.ApplicationInstallation, error) {
	var out models.ApplicationInstallation
	var encoded string
	err := r.db.QueryRowContext(ctx, `SELECT i.bot_user_id,COALESCE(NULLIF(b.display_name,''),b.username),i.server_id,i.scopes,i.installed_by,i.installed_at,i.revoked_at FROM application_installations i JOIN users b ON b.id=i.bot_user_id WHERE i.server_id=? AND i.bot_user_id=?`, serverID, botID).Scan(&out.BotID, &out.BotName, &out.ServerID, &encoded, &out.InstalledBy, &out.InstalledAt, &out.RevokedAt)
	if err != nil {
		return nil, err
	}
	if err = json.Unmarshal([]byte(encoded), &out.Scopes); err != nil {
		return nil, err
	}
	return &out, nil
}

func (r *BotRepository) ListInstallations(ctx context.Context, serverID string) ([]models.ApplicationInstallation, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT bot_user_id FROM application_installations WHERE server_id=? ORDER BY installed_at`, serverID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]models.ApplicationInstallation, 0, len(ids))
	for _, id := range ids {
		x, err := r.ApplicationInstallation(ctx, serverID, id)
		if err != nil {
			return nil, err
		}
		out = append(out, *x)
	}
	return out, nil
}

func (r *BotRepository) ListAvailableApplicationActions(ctx context.Context, serverID string) ([]models.ApplicationAction, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT a.id,a.bot_user_id,a.name,a.label,a.context,a.position
		FROM application_actions a JOIN application_installations i ON i.bot_user_id=a.bot_user_id
		WHERE i.server_id=? AND i.revoked_at IS NULL ORDER BY i.installed_at,a.position,a.id`, serverID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []models.ApplicationAction
	for rows.Next() {
		var action models.ApplicationAction
		if err := rows.Scan(&action.ID, &action.BotID, &action.Name, &action.Label, &action.Context, &action.Position); err != nil {
			return nil, err
		}
		out = append(out, action)
	}
	return out, rows.Err()
}

func (r *BotRepository) RevokeInstallation(ctx context.Context, serverID, botID string) error {
	raw := database.RawDB(r.db)
	if raw == nil {
		return fmt.Errorf("installation transaction unavailable")
	}
	return database.WithTx(ctx, raw, func(tx *sql.Tx) error {
		result, err := tx.ExecContext(ctx, `UPDATE application_installations SET revoked_at=CURRENT_TIMESTAMP WHERE server_id=? AND bot_user_id=? AND revoked_at IS NULL`, serverID, botID)
		if err != nil {
			return err
		}
		n, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if n != 1 {
			return pkg.ErrNotFound
		}
		_, err = tx.ExecContext(ctx, `DELETE FROM server_members WHERE server_id=? AND user_id=?`, serverID, botID)
		return err
	})
}

func containsScope(scopes []string, want string) bool {
	for _, scope := range scopes {
		if scope == want {
			return true
		}
	}
	return false
}

func (r *BotRepository) CreateInvocation(ctx context.Context, actorID, serverID, channelID, messageID, actionID string, expires time.Time) (*models.ApplicationInvocationContext, error) {
	var botID, actionName, encoded, content string
	err := r.db.QueryRowContext(ctx, `SELECT a.bot_user_id,a.name,i.scopes,COALESCE(m.content,'') FROM application_actions a
		JOIN application_installations i ON i.bot_user_id=a.bot_user_id AND i.server_id=? AND i.revoked_at IS NULL
		JOIN channels c ON c.id=? AND c.server_id=i.server_id JOIN messages m ON m.id=? AND m.channel_id=c.id
		WHERE a.id=?`, serverID, channelID, messageID, actionID).Scan(&botID, &actionName, &encoded, &content)
	if err != nil {
		return nil, err
	}
	var scopes []string
	if err = json.Unmarshal([]byte(encoded), &scopes); err != nil {
		return nil, err
	}
	id, err := generateIDN(16)
	if err != nil {
		return nil, err
	}
	_, err = r.db.ExecContext(ctx, `INSERT INTO application_invocations(id,action_id,bot_user_id,actor_user_id,server_id,channel_id,message_id,allow_response,expires_at) VALUES(?,?,?,?,?,?,?,?,?)`, id, actionID, botID, actorID, serverID, channelID, messageID, containsScope(scopes, models.ApplicationScopeSendResponse), expires.UTC())
	if err != nil {
		return nil, err
	}
	inv, err := r.InvocationByID(ctx, actorID, id)
	if err != nil {
		return nil, err
	}
	out := &models.ApplicationInvocationContext{Invocation: *inv, ActionName: actionName}
	if containsScope(scopes, models.ApplicationScopeReadMessage) {
		out.MessageContent = &content
	}
	return out, nil
}

func (r *BotRepository) InvocationByID(ctx context.Context, actorID, id string) (*models.ApplicationInvocation, error) {
	var out models.ApplicationInvocation
	err := r.db.QueryRowContext(ctx, `SELECT id,action_id,bot_user_id,actor_user_id,server_id,channel_id,message_id,is_test,status,result_text,error_code,created_at,expires_at,completed_at FROM application_invocations WHERE id=? AND actor_user_id=?`, id, actorID).Scan(&out.ID, &out.ActionID, &out.BotID, &out.ActorUserID, &out.ServerID, &out.ChannelID, &out.MessageID, &out.IsTest, &out.Status, &out.ResultText, &out.ErrorCode, &out.CreatedAt, &out.ExpiresAt, &out.CompletedAt)
	return &out, err
}

func (r *BotRepository) CompleteInvocation(ctx context.Context, botID, id, status string, resultText, errorCode *string, now time.Time) error {
	result, err := r.db.ExecContext(ctx, `UPDATE application_invocations SET status=?,result_text=?,error_code=?,completed_at=?
		WHERE id=? AND bot_user_id=? AND status='pending' AND expires_at>?
		AND (is_test=1 OR EXISTS (SELECT 1 FROM application_installations i WHERE i.bot_user_id=application_invocations.bot_user_id AND i.server_id=application_invocations.server_id AND i.revoked_at IS NULL))
		AND (? IS NULL OR allow_response=1)`, status, resultText, errorCode, now.UTC(), id, botID, now.UTC(), resultText)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return pkg.ErrNotFound
	}
	return nil
}

func (r *BotRepository) CreateTestInvocation(ctx context.Context, ownerID, botID, actionID string, expires time.Time) (*models.ApplicationInvocationContext, error) {
	var actionName string
	if err := r.db.QueryRowContext(ctx, `SELECT a.name FROM application_actions a JOIN application_manifests m ON m.bot_user_id=a.bot_user_id JOIN users b ON b.id=m.bot_user_id WHERE a.id=? AND a.bot_user_id=? AND b.owner_user_id=? AND m.test_mode=1 AND b.deleted_at IS NULL`, actionID, botID, ownerID).Scan(&actionName); err != nil {
		return nil, err
	}
	id, err := generateIDN(16)
	if err != nil {
		return nil, err
	}
	_, err = r.db.ExecContext(ctx, `INSERT INTO application_invocations(id,action_id,bot_user_id,actor_user_id,is_test,allow_response,expires_at) VALUES(?,?,?,?,1,1,?)`, id, actionID, botID, ownerID, expires.UTC())
	if err != nil {
		return nil, err
	}
	inv, err := r.InvocationByID(ctx, ownerID, id)
	if err != nil {
		return nil, err
	}
	return &models.ApplicationInvocationContext{Invocation: *inv, ActionName: actionName}, nil
}
