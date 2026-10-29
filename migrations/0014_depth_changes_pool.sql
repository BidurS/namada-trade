-- One pool's changes (GET /api/depth/changes?pool=, worker/src/api-depth.ts): read newest first by (pool_id, ts), so a
-- pool with few rows costs the rows it has and not a walk of the ts index through every other pool's rows. The ts
-- index of 0013 stays for the page over every pool; the primary key (pool_id, ref, ts) is in ref order, not time order.
CREATE INDEX IF NOT EXISTS depth_changes_pool_ts ON depth_changes (pool_id, ts);
