-- The built-in music identity predates generic application accounts. Mark it
-- explicitly as a bot so human-account administration, privacy export and
-- lifecycle screens never treat the service identity as a person.
UPDATE users
SET is_bot = 1
WHERE id = '__music_bot__';
