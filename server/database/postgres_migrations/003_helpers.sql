-- Keep timestamp aggregation output and JSON array counts compatible with
-- repository contracts while storing actual instants as TIMESTAMPTZ.
CREATE FUNCTION json_array_length(value TEXT) RETURNS INTEGER
LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT jsonb_array_length(value::jsonb) $$;
-- Audit snapshots consist of text fields; typed arguments also let PostgreSQL
-- infer repeated bind parameters passed to this variadic function.
CREATE FUNCTION hichat_json_object(VARIADIC fields TEXT[]) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$ SELECT json_build_object(VARIADIC fields)::text $$;
CREATE FUNCTION instr(value TEXT, needle TEXT) RETURNS INTEGER
LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT strpos(value, needle) $$;
CREATE FUNCTION datetime(value TEXT) RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE STRICT AS $$ SELECT value::timestamptz $$;
CREATE FUNCTION strftime(format TEXT, value TIMESTAMPTZ) RETURNS TEXT
LANGUAGE plpgsql STABLE STRICT AS $$
BEGIN
  RETURN CASE format
    WHEN '%s' THEN floor(extract(epoch FROM value))::bigint::text
    WHEN '%Y-%m-%dT%H:00:00' THEN to_char(value AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:00:00')
    WHEN '%Y-%m-%dT' THEN to_char(value AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"')
    WHEN '%H' THEN to_char(value AT TIME ZONE 'UTC', 'HH24')
    ELSE NULL END;
END $$;
CREATE FUNCTION printf(format TEXT, value BIGINT) RETURNS TEXT
LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT CASE WHEN format='%02d' THEN lpad(value::text,2,'0') END $$;
