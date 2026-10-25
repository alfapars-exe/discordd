-- Explicit server classification; existing servers remain normal servers.
ALTER TABLE servers ADD COLUMN is_community INTEGER NOT NULL DEFAULT 0 CHECK (is_community IN (0, 1));
