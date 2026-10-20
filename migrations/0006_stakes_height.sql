-- The chain height a stake was read at (the bond listing's answer height), so a listing from a node that is
-- behind never overwrites a row written from a newer one (worker/src/db.ts stakesVerified). NULL on rows written
-- before this migration: any height counts as newer than them.
ALTER TABLE stakes ADD COLUMN verified_height INTEGER;
