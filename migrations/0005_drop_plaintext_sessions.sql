-- 2026-10-18. Session rows written before tokens were hashed (security/plaintext-tokens).
--
-- Until 2e46d4f a session or API key was stored as kv `session:<token>` with the token in the value too, and
-- kv `sessions:<address>` listed the raw tokens. Anyone holding a copy of the database (an export, Time Travel,
-- a backup) could send such a token as a bearer token and read the decrypted watchlist through /api/me/settings,
-- which the Settings page says the operator cannot do. New rows are `session:<sha256(token) hex>` with no token
-- field (worker/src/auth.ts). D1's SQL has no sha256, so the old rows cannot be re-keyed here: they are deleted.
-- The Worker refuses and deletes any that are left (sessionFromRequest, sweepAuth).
--
-- RELEASE NOTE: everyone signed in before this deploy is signed out once and signs in again; API keys made before
-- it stop working and must be made again under Settings, For developers. (Read-only count on production,
-- 2026-10-18 02:57 UTC: two session rows, one via Namada Keychain and one via Keplr, both live and both plaintext;
-- no API keys.)
DELETE FROM kv WHERE key LIKE 'session:%' AND json_extract(value, '$.token') IS NOT NULL;
DELETE FROM kv WHERE key LIKE 'sessions:%';
