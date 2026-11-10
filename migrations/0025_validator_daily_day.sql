-- 2026-11-10. validator_daily by day, for the validators view (worker/src/validators.ts, GET /api/validators).
--
-- The table's key is (validator, day): one validator over days is a range of it, but one day over validators read
-- every row the table holds (about 3,500 on 2026-11-10, about 250 more each day). With this index a day's rows are
-- one range, and the newest day, the day on record before a day and the list of days are one seek each.
--
-- The Worker names the index in every statement that reads by day (INDEXED BY), so a statement that stops matching
-- fails in the tests instead of reading the whole table again. Nothing stored changes. Apply before deploying the
-- Worker that names it: until then /api/validators answers that the listing could not be read.
CREATE INDEX IF NOT EXISTS validator_daily_day ON validator_daily (day);
