-- Spendable NAM balances as read from the chain over time (W13), the source of holder 24 h and 7 d changes.
-- One row is a stretch of identical readings: every chain read of `address` between from_ts and to_ts
-- returned `balance`, and consecutive reads were at most 6 h apart (worker/src/holders.ts SPAN_MAX_GAP_MS).
-- A reading that differs, or comes after a longer gap, opens a new row. A balance at time t is known only
-- when a row contains t; otherwise the change is reported as unknown (null), never as 0.
-- Written by the cron after each batch of reads (Namada: the rolling refresh; Osmosis: the hourly full list).
-- Rows that ended more than 8 days ago are deleted by the cron.
CREATE TABLE IF NOT EXISTS balance_spans (
  chain       TEXT NOT NULL,               -- 'namada' | 'osmosis'
  address     TEXT NOT NULL,
  from_ts     INTEGER NOT NULL,            -- unix ms of the first read of this balance
  to_ts       INTEGER NOT NULL,            -- unix ms of the latest read of the same balance
  balance     TEXT NOT NULL,               -- base units, exact
  balance_num REAL NOT NULL,               -- NAM
  reads       INTEGER NOT NULL DEFAULT 1,  -- how many reads this row stands for
  PRIMARY KEY (chain, address, from_ts)
);
CREATE INDEX IF NOT EXISTS balance_spans_to ON balance_spans (to_ts);
