-- SQLite's single writer serialized retirement/anonymization with new state.
-- In PostgreSQL, ordinary writes share this transaction lock; rare retirement
-- operations take it exclusively before their first read or write. Statement
-- triggers acquire it before row locks, so guards observe the committed state.
CREATE FUNCTION hichat_shared_write_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM pg_advisory_xact_lock_shared(7341982002); RETURN NULL; END $$;
CREATE FUNCTION hichat_exclusive_write_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM pg_advisory_xact_lock(7341982002); RETURN NULL; END $$;

DO $$ DECLARE item record; BEGIN
  FOR item IN SELECT DISTINCT event_object_table AS name
    FROM information_schema.triggers
    WHERE trigger_schema=current_schema()
      AND (trigger_name LIKE 'deleted_%' OR trigger_name LIKE 'retired_%')
  LOOP
    EXECUTE format('CREATE TRIGGER aab_hichat_shared BEFORE INSERT OR UPDATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION hichat_shared_write_barrier()',item.name);
  END LOOP;
END $$;
CREATE TRIGGER aaa_hichat_user_retirement BEFORE UPDATE OF deleted_at,is_bot OR DELETE ON users
FOR EACH STATEMENT EXECUTE FUNCTION hichat_exclusive_write_barrier();
CREATE TRIGGER aaa_hichat_asset_retirement BEFORE UPDATE OF retired_at ON account_asset_cleanup
FOR EACH STATEMENT EXECUTE FUNCTION hichat_exclusive_write_barrier();
