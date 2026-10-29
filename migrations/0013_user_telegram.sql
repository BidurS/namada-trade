-- 2026-10-28. The users' settings rows with a Telegram chat on (worker/src/settings.ts TELEGRAM_ROWS).
--
-- A row now carries `tg` (alerts go to its Telegram chat) and `tgc` (the linked chat's keyed digest) in plain text
-- beside its sealed blob, as it carries `on` and `hook` for Discord (0012). The Telegram dispatcher reads only the
-- rows with `tg` on; this index is partial over those rows, and its WHERE terms are the exact text of TELEGRAM_ROWS
-- (SQLite matches a partial index's WHERE by expression). Nothing stored changes; a row written before has no `tg` and
-- is not read, as it has no chat. Before it is applied the same query reads the whole user: range, which is correct
-- and bounded (settings.ts USER_ROWS_MAX).
CREATE INDEX IF NOT EXISTS kv_user_telegram ON kv (key) WHERE key >= 'user:' AND key < 'user;' AND json_extract(value, '$.tg') = 1;
