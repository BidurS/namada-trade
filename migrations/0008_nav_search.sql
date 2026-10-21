-- 2026-10-21. Fast deep pages and the search (docs/design/nav-search-plan.md 2.1, 2.2, 4.2; the plan names this
-- file 0006, which was taken). Nothing here changes a stored figure: two columns are derived from the rows already
-- kept, indexes are added or widened in place, and a word table is derived from the labels.
--
-- Contains triggers: apply it with `wrangler d1 migrations apply`, never with scripts/d1-apply.ts (which splits a file
-- on ";\n" and would cut a trigger body in two).

-- ---------------------------------------------------------------- 1. holders: the stored stake and total
--
-- The holder list's order (spendable + staked, the default), its count and every page of it were a three-way union
-- sorted in a temporary B-tree on every request (230 to 880 ms and 250,000 to 390,000 rows read on 2026-10-19/20).
-- Each row now carries its stake and its total, kept by the triggers below, so a page is a walk of one index.
--
-- stake_num: the stakes row's stake by the holder list's rule (worker/src/holders.ts stakeNum): the chain's figure
--   (bonded_num); the flow-history estimate only while no bond listing has gone through completely (kv bond.listing
--   completeAt); else 0. Never below 0 (an estimate can be negative when an unbond was recorded without its bond).
--   Always 0 on Osmosis.
-- total_num: balance_num + stake_num.
-- A Namada staker with no spendable row gets one (balance '0'; updated_at, verified_at and verified_src NULL: never
-- read), so a stake-only holder is on the same index. Every reader that asks whether a spendable reading exists asks
-- for a reading, not for a row (worker/src/holders.ts HAS_READING): the balance listing's diff leaves such rows out
-- of the rows it compares (the address is "not stored" to it, as before), and the API says "the chain lists no
-- spendable NAM" for it after a complete listing, as before.

ALTER TABLE holders ADD COLUMN stake_num REAL NOT NULL DEFAULT 0;
ALTER TABLE holders ADD COLUMN total_num REAL NOT NULL DEFAULT 0;

-- The backfill, in this order: stakers without a spendable row get one, then every staker's stake, then every total.
INSERT INTO holders (chain, address, balance, balance_num)
  SELECT 'namada', s.address, '0', 0 FROM stakes s
  WHERE MAX(0, COALESCE(s.bonded_num, CASE WHEN NOT EXISTS (SELECT 1 FROM kv WHERE key = 'bond.listing' AND json_extract(value, '$.completeAt') > 0) THEN s.estimated_num END, 0)) > 0
    AND NOT EXISTS (SELECT 1 FROM holders h WHERE h.chain = 'namada' AND h.address = s.address);
UPDATE holders SET stake_num = (SELECT MAX(0, COALESCE(s.bonded_num, CASE WHEN NOT EXISTS (SELECT 1 FROM kv WHERE key = 'bond.listing' AND json_extract(value, '$.completeAt') > 0) THEN s.estimated_num END, 0))
                                FROM stakes s WHERE s.address = holders.address)
  WHERE chain = 'namada' AND address IN (SELECT s.address FROM stakes s
    WHERE MAX(0, COALESCE(s.bonded_num, CASE WHEN NOT EXISTS (SELECT 1 FROM kv WHERE key = 'bond.listing' AND json_extract(value, '$.completeAt') > 0) THEN s.estimated_num END, 0)) > 0);
UPDATE holders SET total_num = balance_num + stake_num WHERE balance_num != 0 OR stake_num != 0;

-- The sort keys. Each carries the columns its walk filters on, so a page, a deep offset or a count never reads a table
-- row for an entry it skips. holders_total and the two below serve chain = namada | osmosis directly and chain = all
-- as a merge of the two (SQLite's MERGE (UNION ALL)); every list query names its index (INDEXED BY): without
-- statistics the planner prefers the primary key's equality on `chain` and sorts every row of the chain. Not partial
-- (no WHERE total_num > 0): the list's own condition is written `+total_num > 0` so that it is never taken as the
-- range of a walk, and a size (`total_num >= ?`) or a rank count seeks to its own bound (on production a count with
-- both bounds walked all 65,007 entries for a holder at No. 295, 2026-10-20).
CREATE INDEX IF NOT EXISTS holders_total ON holders (chain, total_num DESC, address);
CREATE INDEX IF NOT EXISTS holders_stake ON holders (chain, stake_num DESC, address, total_num);
-- holders_rank (chain, balance_num DESC) widened in place: the address breaks ties (the list by spendable NAM has a
-- total order), total_num rides along for the walk's filter. Every query that used it (the address report's rank,
-- the Osmosis top 10, the series' Osmosis holder count) reads the same leading columns.
DROP INDEX IF EXISTS holders_rank;
CREATE INDEX IF NOT EXISTS holders_rank ON holders (chain, balance_num DESC, address, total_num);
-- An address by its end ("…kj4m", 4 to 8 characters): the last four characters are one index key (32^4 values,
-- about 0.06 rows each), the rest of the end is checked on the few rows found. Written once per row (an address
-- never changes).
CREATE INDEX IF NOT EXISTS holders_tail ON holders (substr(address, -4));

-- The triggers. Every writer is an INSERT … ON CONFLICT DO UPDATE or an UPDATE (db.ts stmt.namadaBalance,
-- stmt.verifiedBalance, stmt.stakesVerified; holders.ts listingBalanceStmts, listingZeroStmts, osmosisDroppedStmt;
-- cron.ts STAKE_ESTIMATES_SQL): the insert path fires AFTER INSERT, the conflict path AFTER UPDATE OF, and a
-- DO UPDATE whose WHERE guard fails writes nothing and fires nothing (test/paging.test.ts runs each one).
-- One statement per trigger where it can be: in one UPDATE every SET expression reads the row as it was, so the
-- total is computed from the new values themselves, never from a column the same statement sets.

-- A new holder row: its stake from stakes (Namada), its total.
CREATE TRIGGER IF NOT EXISTS holders_total_ai AFTER INSERT ON holders BEGIN
  UPDATE holders SET
    stake_num = CASE WHEN NEW.chain = 'namada' THEN COALESCE((SELECT MAX(0, COALESCE(s.bonded_num, CASE WHEN NOT EXISTS (SELECT 1 FROM kv WHERE key = 'bond.listing' AND json_extract(value, '$.completeAt') > 0) THEN s.estimated_num END, 0)) FROM stakes s WHERE s.address = NEW.address), 0) ELSE 0 END,
    total_num = NEW.balance_num + CASE WHEN NEW.chain = 'namada' THEN COALESCE((SELECT MAX(0, COALESCE(s.bonded_num, CASE WHEN NOT EXISTS (SELECT 1 FROM kv WHERE key = 'bond.listing' AND json_extract(value, '$.completeAt') > 0) THEN s.estimated_num END, 0)) FROM stakes s WHERE s.address = NEW.address), 0) ELSE 0 END
  WHERE chain = NEW.chain AND address = NEW.address;
END;

-- A balance that changed: the new total. A stake-only row (never read) that gets its first NAM also gets first_seen
-- (migration 0007: the time this site first saw the address hold NAM), as a new row would have.
CREATE TRIGGER IF NOT EXISTS holders_total_au AFTER UPDATE OF balance_num ON holders
  WHEN NEW.balance_num IS NOT OLD.balance_num BEGIN
  UPDATE holders SET
    total_num = NEW.balance_num + stake_num,
    first_seen = CASE WHEN first_seen IS NULL AND NEW.chain = 'namada' AND NEW.balance_num > 0 AND OLD.updated_at IS NULL AND OLD.verified_at IS NULL
                      THEN COALESCE(NEW.updated_at, NEW.verified_at) ELSE first_seen END
  WHERE chain = NEW.chain AND address = NEW.address;
END;

-- A stake written (the bond listing, the estimates): the staker's row, created when it holds no spendable NAM.
-- No INSERT OR IGNORE: inside a trigger the outer statement's conflict policy replaces the inner one, so an
-- INSERT OR REPLACE INTO stakes would turn it into a REPLACE of the holder row. NOT EXISTS needs no policy.
CREATE TRIGGER IF NOT EXISTS stakes_total_ai AFTER INSERT ON stakes BEGIN
  INSERT INTO holders (chain, address, balance, balance_num)
    SELECT 'namada', NEW.address, '0', 0
    WHERE MAX(0, COALESCE(NEW.bonded_num, CASE WHEN NOT EXISTS (SELECT 1 FROM kv WHERE key = 'bond.listing' AND json_extract(value, '$.completeAt') > 0) THEN NEW.estimated_num END, 0)) > 0
      AND NOT EXISTS (SELECT 1 FROM holders h WHERE h.chain = 'namada' AND h.address = NEW.address);
  UPDATE holders SET
    stake_num = MAX(0, COALESCE(NEW.bonded_num, CASE WHEN NOT EXISTS (SELECT 1 FROM kv WHERE key = 'bond.listing' AND json_extract(value, '$.completeAt') > 0) THEN NEW.estimated_num END, 0)),
    total_num = balance_num + MAX(0, COALESCE(NEW.bonded_num, CASE WHEN NOT EXISTS (SELECT 1 FROM kv WHERE key = 'bond.listing' AND json_extract(value, '$.completeAt') > 0) THEN NEW.estimated_num END, 0))
  WHERE chain = 'namada' AND address = NEW.address
    AND stake_num IS NOT MAX(0, COALESCE(NEW.bonded_num, CASE WHEN NOT EXISTS (SELECT 1 FROM kv WHERE key = 'bond.listing' AND json_extract(value, '$.completeAt') > 0) THEN NEW.estimated_num END, 0));
END;
CREATE TRIGGER IF NOT EXISTS stakes_total_au AFTER UPDATE OF bonded_num, estimated_num ON stakes BEGIN
  INSERT INTO holders (chain, address, balance, balance_num)
    SELECT 'namada', NEW.address, '0', 0
    WHERE MAX(0, COALESCE(NEW.bonded_num, CASE WHEN NOT EXISTS (SELECT 1 FROM kv WHERE key = 'bond.listing' AND json_extract(value, '$.completeAt') > 0) THEN NEW.estimated_num END, 0)) > 0
      AND NOT EXISTS (SELECT 1 FROM holders h WHERE h.chain = 'namada' AND h.address = NEW.address);
  UPDATE holders SET
    stake_num = MAX(0, COALESCE(NEW.bonded_num, CASE WHEN NOT EXISTS (SELECT 1 FROM kv WHERE key = 'bond.listing' AND json_extract(value, '$.completeAt') > 0) THEN NEW.estimated_num END, 0)),
    total_num = balance_num + MAX(0, COALESCE(NEW.bonded_num, CASE WHEN NOT EXISTS (SELECT 1 FROM kv WHERE key = 'bond.listing' AND json_extract(value, '$.completeAt') > 0) THEN NEW.estimated_num END, 0))
  WHERE chain = 'namada' AND address = NEW.address
    AND stake_num IS NOT MAX(0, COALESCE(NEW.bonded_num, CASE WHEN NOT EXISTS (SELECT 1 FROM kv WHERE key = 'bond.listing' AND json_extract(value, '$.completeAt') > 0) THEN NEW.estimated_num END, 0));
END;
CREATE TRIGGER IF NOT EXISTS stakes_total_ad AFTER DELETE ON stakes BEGIN
  UPDATE holders SET stake_num = 0, total_num = balance_num WHERE chain = 'namada' AND address = OLD.address AND stake_num != 0;
END;
-- Not covered by a trigger, on purpose: the moment the first bond listing completes (kv bond.listing gets its
-- completeAt), estimates stop counting. By then that listing has written every stakes row whose only figure was a
-- positive estimate (cron.ts runBondListing sets bonded_num to 0 for each), and the stakes triggers above have
-- applied the rule to each; a stakes row written later is read under the new rule as it is written.

-- ---------------------------------------------------------------- 2. flows: the feed's order in its indexes, and records by hash
--
-- The feed's order is ts DESC, height DESC, id DESC (worker/src/flows-query.ts FLOWS_ORDER, the moves cursor). Each
-- index a moves page walks is widened in place to carry the whole order, so no page sorts the rows of equal times in
-- a temporary B-tree and a page behind a cursor seeks to it. Same names, same leading columns: every query that
-- names them (INDEXED BY flows_ts / flows_kind / flows_from) reads as before; no index is added per flow written.
DROP INDEX IF EXISTS flows_ts;
CREATE INDEX IF NOT EXISTS flows_ts ON flows (ts DESC, height DESC, id DESC);
DROP INDEX IF EXISTS flows_from;
CREATE INDEX IF NOT EXISTS flows_from ON flows (from_addr, ts DESC, height DESC, id DESC);
DROP INDEX IF EXISTS flows_to;
CREATE INDEX IF NOT EXISTS flows_to ON flows (to_addr, ts DESC, height DESC, id DESC);
DROP INDEX IF EXISTS flows_kind;
CREATE INDEX IF NOT EXISTS flows_kind ON flows (kind, ts DESC, height DESC, id DESC);

-- A record by its hash or the start of it (8 or more hex characters, read in upper case): the record lookup scanned
-- every flow (55,173 rows, 42 ms on 2026-10-20). Rows imported from the Namada indexer keep the inner hash in tx_hash
-- (upper case) and the explorer's (wrapper) hash in meta.wrapper, which the indexer gives in LOWER case (44,770 of
-- 51,477 Namada rows on 2026-10-20, none in upper case); rows from this site's block reader keep the wrapper in
-- tx_hash and the inner one in meta.innerTxHash, both upper case. All three are indexed, the two from meta only where
-- present, and the wrapper upper-cased (worker/src/flows-query.ts HASH_COLUMNS reads the same expression), so a
-- record is found by the hash the explorers file it under, as the site shows it, whatever case it was stored in.
CREATE INDEX IF NOT EXISTS flows_hash ON flows (tx_hash);
CREATE INDEX IF NOT EXISTS flows_hash_wrapper ON flows (upper(json_extract(meta, '$.wrapper'))) WHERE upper(json_extract(meta, '$.wrapper')) IS NOT NULL;
CREATE INDEX IF NOT EXISTS flows_hash_inner ON flows (json_extract(meta, '$.innerTxHash')) WHERE json_extract(meta, '$.innerTxHash') IS NOT NULL;

-- ---------------------------------------------------------------- 3. names: the words of every label
--
-- A name is found by the start of any of its words ("zond" finds "Zondax", "usdc" the NAM / USDC pools): one range
-- on this table's primary key, never a pass over every label (`label LIKE '%…%'` read all 5,959 labels a search).
-- A plain table, not an FTS5 virtual table: `wrangler d1 export`, which the backups use, refuses a database that
-- holds a virtual table. Kept by the triggers below from every label write; a word is a run of letters and digits
-- of the label in lower case (ASCII letters folded, as SQLite's lower() does; the API folds the typed text the same
-- way), every punctuation mark a separator.
CREATE TABLE IF NOT EXISTS label_tokens (
  token   TEXT NOT NULL,
  address TEXT NOT NULL,
  PRIMARY KEY (token, address)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS label_tokens_address ON label_tokens (address);

-- The words of each label (the one definition of a word: the triggers and the backfill read it), in three steps:
-- every separator becomes a space (20 in the first view, 19 in the second), the words become a JSON array, and
-- json_each lists them. Split in steps so no statement nests more than about 20 calls: the SQLite that ships with
-- macOS has a fixed parser stack (it overflowed between 25 and 30 nested calls on 2026-10-20) and could not open a
-- database whose schema held all 39 in one expression ("malformed database schema"), which would break reading a
-- local copy or an export with the stock sqlite3.
CREATE VIEW IF NOT EXISTS label_text AS
  SELECT address, replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(lower(label), '!', ' '), '"', ' '), '#', ' '), '$', ' '), '%', ' '), '&', ' '), '''', ' '), '(', ' '), ')', ' '), '*', ' '), '+', ' '), ',', ' '), '-', ' '), '.', ' '), '/', ' '), ':', ' '), ';', ' '), '<', ' '), '=', ' '), '>', ' ') AS t
  FROM labels;
CREATE VIEW IF NOT EXISTS label_json AS
  SELECT address, '["' || replace(trim(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(t, '?', ' '), '@', ' '), '[', ' '), '\', ' '), ']', ' '), '^', ' '), '_', ' '), '`', ' '), '{', ' '), '|', ' '), '}', ' '), '~', ' '), char(9), ' '), char(10), ' '), char(13), ' '), '…', ' '), '·', ' '), '–', ' '), '—', ' ')), ' ', '","') || '"]' AS js
  FROM label_text;
CREATE VIEW IF NOT EXISTS label_words AS
  SELECT l.address AS address, j.value AS token
  FROM label_json l, json_each(CASE WHEN json_valid(l.js) THEN l.js ELSE '[]' END) j
  WHERE j.value != '';

INSERT OR IGNORE INTO label_tokens (token, address) SELECT DISTINCT token, address FROM label_words;

-- The pool labels are rewritten every 10 minutes with the same words (cron.ts): the update trigger runs only when
-- the label itself changed.
CREATE TRIGGER IF NOT EXISTS label_tokens_ai AFTER INSERT ON labels BEGIN
  DELETE FROM label_tokens WHERE address = NEW.address;
  INSERT OR IGNORE INTO label_tokens (token, address) SELECT DISTINCT token, address FROM label_words WHERE address = NEW.address;
END;
CREATE TRIGGER IF NOT EXISTS label_tokens_au AFTER UPDATE OF label ON labels WHEN NEW.label IS NOT OLD.label BEGIN
  DELETE FROM label_tokens WHERE address = OLD.address;
  INSERT OR IGNORE INTO label_tokens (token, address) SELECT DISTINCT token, address FROM label_words WHERE address = NEW.address;
END;
CREATE TRIGGER IF NOT EXISTS label_tokens_ad AFTER DELETE ON labels BEGIN
  DELETE FROM label_tokens WHERE address = OLD.address;
END;
