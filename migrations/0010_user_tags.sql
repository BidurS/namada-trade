-- 2026-10-22. A wallet's tags (labels with source 'user'): when each was first written, and two indexes for the caps
-- (security review, 2026-10-22).
--
-- POST /api/labels admits a new tag only while its wallet holds fewer than TAGS_PER_AUTHOR tags and the site took fewer
-- than TAGS_PER_DAY new tags in the last 24 h. Both counts scanned every label row (5,959 on 2026-10-22) and the daily
-- one read updated_at, which a re-save renews, so one actor could keep the day's allowance full by re-saving its own
-- tags. created_at is the first write and is never updated; the daily count reads it. The counts are now part of the
-- insert itself (worker/src/db.ts stmt.userTag), each on its partial index.
--
-- Apply before deploying the Worker that names these indexes and the column: until then a tag post answers 500.
ALTER TABLE labels ADD COLUMN created_at INTEGER;
UPDATE labels SET created_at = updated_at WHERE source = 'user' AND created_at IS NULL;
CREATE INDEX IF NOT EXISTS labels_user_author ON labels (author, address) WHERE source = 'user';
CREATE INDEX IF NOT EXISTS labels_user_created ON labels (created_at, address) WHERE source = 'user';
