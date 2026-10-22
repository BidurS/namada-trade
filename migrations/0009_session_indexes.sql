-- 2026-10-22. Session and API-key rows by address, by expiry, and the rows from before tokens were hashed
-- (security review, 2026-10-22).
--
-- A session or API key is kv `session:<sha256(token) hex>`; its address and expiry live only in the JSON value.
-- Finding one address's rows read every session row on the site (a range of kv's primary key, json_extract on each),
-- and so did the cron's expiry and legacy sweeps every minute. Each index here is partial over the session key range
-- only: json_extract is never evaluated on other kv rows (some of which are not JSON), and the WHERE terms are the
-- exact text of auth.ts keyPrefix('session'), which every query that uses them repeats (SQLite matches a partial
-- index's WHERE by expression, not by algebra). The queries name their index (INDEXED BY), so a query that stops
-- matching fails in the tests instead of scanning the range again.
--
-- Nothing stored changes. Apply before deploying the Worker that names these indexes: until then its session
-- queries fail ("no such index") and sign-in answers 500.
CREATE INDEX IF NOT EXISTS kv_session_addr ON kv (json_extract(value, '$.address')) WHERE key >= 'session:' AND key < 'session;';
CREATE INDEX IF NOT EXISTS kv_session_expiry ON kv (CAST(json_extract(value, '$.expiresAt') AS INTEGER)) WHERE key >= 'session:' AND key < 'session;';
CREATE INDEX IF NOT EXISTS kv_session_legacy ON kv (key) WHERE key >= 'session:' AND key < 'session;' AND json_extract(value, '$.token') IS NOT NULL;
