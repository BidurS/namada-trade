-- 2026-10-29. Stored counts for the moves list's first page (scale plan Stage 1 item 6). The count of the default list
-- (every move, each bridge crossing once) was a COUNT over every flow with the crossing twin's lookup for each received
-- crossing and the older-twin check for each Namada row: 0.76 to 0.93 s of D1 time per cache miss in D1's insights.
-- Nothing here changes a stored figure: one table of counts derived from the rows already kept, one row saying how far
-- it counts, and the triggers that say when it no longer holds.
--
-- Contains triggers: apply it with `wrangler d1 migrations apply`, never with scripts/d1-apply.ts (which splits a file
-- on ";\n" and would cut a trigger body in two).

-- flow_counts: the moves up to flow_count_mark.mark, by what the list filters on without a range of its own: the chain,
-- the kind, whether it is the receiving side of a crossing whose sending side is recorded (twin, worker/src/
-- flows-query.ts RECEIVED_TWIN, the rule of ?pairs=one), whether it is a bot trade (bot, NOT_BOT, the rule of
-- ?arb=false) and its NAM size step (size: 0 below 1,000 NAM or in another coin, 1 from 1,000, 2 from 10,000, 3 from
-- 100,000; FLOW_SIZE_STEPS, the sizes the list offers and the whale size). The older twins of migration 0004 are not
-- counted (NOT_LEGACY_TWIN), as no list shows them. Written by the cron only (worker/src/flow-counts.ts), in one
-- transaction with the mark.
CREATE TABLE IF NOT EXISTS flow_counts (
  chain TEXT NOT NULL,
  kind  TEXT NOT NULL,
  twin  INTEGER NOT NULL,
  bot   INTEGER NOT NULL,
  size  INTEGER NOT NULL,
  n     INTEGER NOT NULL,
  PRIMARY KEY (chain, kind, twin, bot, size)
);

-- One row: flow_counts counts the moves with ts <= mark (unix ms) and is exact while dirty = 0; `at` is when it was
-- last written. It starts dirty with no mark: the first tick after this migration writes it, and until then the list
-- counts as it did before.
CREATE TABLE IF NOT EXISTS flow_count_mark (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  mark  INTEGER,
  dirty INTEGER NOT NULL DEFAULT 1,
  at    INTEGER
);
INSERT OR IGNORE INTO flow_count_mark (id, mark, dirty, at) VALUES (1, NULL, 1, NULL);

-- The triggers keep the counts exact by marking them dirty, never by adding or taking away. Whether a move is counted
-- can depend on other moves (a received crossing on its sending side up to 15 minutes away, an older twin on its newer
-- one up to a minute away), and the Worker writes moves with INSERT OR REPLACE (worker/src/db.ts stmt.flow), whose
-- deletes fire no DELETE trigger (SQLite fires them only with recursive_triggers on): a counter kept by +1 and -1 would
-- drift. Every count up to the mark depends only on the moves up to mark + 900,000 ms (the crossing window,
-- flows-query.ts TWIN_WINDOW_MS, which test/flow-counts.test.ts holds to this file), so a write that touches one of
-- them marks the counts dirty: a row inserted there, a row replaced there (the same id, or a Namada row of the same
-- block, which the guard of migration 0004 replaces), a row deleted there, or a column the lists read changed there.
-- Moves written as they happen are later than that and touch nothing: the reader counts them live, from the mark on.
-- A write that marks it dirty when it did not need to (an INSERT OR IGNORE that is ignored) costs one count again.

CREATE TRIGGER IF NOT EXISTS flow_counts_bi BEFORE INSERT ON flows
  WHEN EXISTS (SELECT 1 FROM flow_count_mark m WHERE m.id = 1 AND m.dirty = 0 AND (
    NEW.ts <= m.mark + 900000
    OR EXISTS (SELECT 1 FROM flows o WHERE o.id = NEW.id AND o.ts <= m.mark + 900000)
    OR (NEW.chain = 'namada' AND EXISTS (SELECT 1 FROM flows o WHERE o.chain = 'namada' AND o.height = NEW.height AND o.ts <= m.mark + 900000))))
BEGIN
  UPDATE flow_count_mark SET dirty = 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS flow_counts_ad AFTER DELETE ON flows
  WHEN EXISTS (SELECT 1 FROM flow_count_mark m WHERE m.id = 1 AND m.dirty = 0 AND OLD.ts <= m.mark + 900000)
BEGIN
  UPDATE flow_count_mark SET dirty = 1 WHERE id = 1;
END;

-- Not price_usd, value_usd, counter_denom, counter_amount or pool_id: no count reads them (the price repairs write them).
CREATE TRIGGER IF NOT EXISTS flow_counts_au AFTER UPDATE OF id, chain, height, ts, tx_hash, kind, from_addr, to_addr, amount_num, meta ON flows
  WHEN EXISTS (SELECT 1 FROM flow_count_mark m WHERE m.id = 1 AND m.dirty = 0 AND (OLD.ts <= m.mark + 900000 OR NEW.ts <= m.mark + 900000))
BEGIN
  UPDATE flow_count_mark SET dirty = 1 WHERE id = 1;
END;
