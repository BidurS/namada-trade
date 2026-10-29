-- 2026-10-29. The users' settings rows by the Telegram chat they are linked to (worker/src/settings.ts rowsOfChat).
--
-- The bot finds the rows of a chat by its keyed digest `tgc` (0013) on every /status and /stop, a blocked bot, a group
-- left or made a supergroup, and a test message to a chat that is gone: any Telegram user can send /status. 0013's
-- index holds the rows with sending on only, and a paused row keeps its chat, so the read went through the whole user:
-- range (up to settings.ts USER_ROWS_MAX rows) each time. This index is partial over the user: rows, its WHERE terms
-- the exact range rowsOfChat repeats (SQLite matches a partial index's WHERE by expression), so json_extract is never
-- evaluated on other kv rows (some of which are not JSON). Nothing stored changes, and no query names the index:
-- before it is applied the same query reads the whole user: range, which is correct and bounded.
CREATE INDEX IF NOT EXISTS kv_user_telegram_chat ON kv (json_extract(value, '$.tgc')) WHERE key >= 'user:' AND key < 'user;';
