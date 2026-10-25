-- A retired bot is an immutable shared-history author, never a live principal.
-- Reject delayed token issuance even where foreign keys are not enforced.
CREATE TRIGGER retired_application_token_insert BEFORE INSERT ON bot_tokens
WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.bot_user_id AND is_bot=1 AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'application is not active'); END;

CREATE TRIGGER retired_application_token_update BEFORE UPDATE OF bot_user_id ON bot_tokens
WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.bot_user_id AND is_bot=1 AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'application is not active'); END;
