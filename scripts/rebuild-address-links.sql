-- One-time rebuild of address_links from the receiving side of the bridge (docs/security-review.md, E1, 2026-10-19).
--
-- Until this change a link (osmo1 <-> tnam1) was written twice per crossing: once from the send (Osmosis ibc_out,
-- Namada ibc_out) and once from the receive (Osmosis ibc_in, Namada ibc_in). A send links nothing any more: its
-- receiver is text the sender chose, and a send that times out is refunded, so a sender could link their own
-- address to anyone's for the cost of a fee. The parsers now link on the receiving chain's record only
-- (worker/src/parse/osmosis.ts recv_packet, worker/src/parse/namada.ts kind 'ibc_in'), and this file brings the
-- existing rows to the same meaning: one row per (osmo1, tnam1) pair that completed a crossing, transfers and
-- volume_num counting completed crossings, first_seen and last_seen their timestamps.
--
-- What counts, the parsers' rule:
--   Osmosis ibc_in: from_addr is the Namada sender (tnam1), to_addr the Osmosis receiver (osmo1).
--   Namada ibc_in:  from_addr is the Osmosis sender (osmo1), to_addr the Namada receiver (tnam1), never the shielded
--                   pool (its address is everyone's), and NAM only (rows of other tokens carry meta.tokenSymbol).
-- The receiving chain checked both addresses before it credited the NAM, so no checksum step is needed here.
--
-- Run once, after the parsers of this change are deployed (so that no send-side row is written again):
--   npm run db:apply -- scripts/rebuild-address-links.sql
-- (scripts/d1-apply.ts sends the statements through `wrangler d1 execute --command`, which the OAuth login allows.)
-- Safe to run again: it rebuilds the table from flows each time. For the record, before and after:
--   npx wrangler d1 execute namada-trade-db --remote --command "SELECT COUNT(*) rows, SUM(transfers) transfers, SUM(volume_num) volume FROM address_links"

DELETE FROM address_links;

INSERT INTO address_links (osmo_addr, namada_addr, first_seen, last_seen, transfers, volume_num)
SELECT osmo_addr, namada_addr, MIN(ts), MAX(ts), COUNT(*), SUM(amount_num)
  FROM (
    SELECT to_addr AS osmo_addr, from_addr AS namada_addr, ts, amount_num
      FROM flows
     WHERE chain = 'osmosis' AND kind = 'ibc_in'
       AND to_addr LIKE 'osmo1%' AND from_addr LIKE 'tnam1%'
    UNION ALL
    SELECT from_addr AS osmo_addr, to_addr AS namada_addr, ts, amount_num
      FROM flows
     WHERE chain = 'namada' AND kind = 'ibc_in'
       AND from_addr LIKE 'osmo1%' AND to_addr LIKE 'tnam1%'
       AND to_addr != 'tnam1pcqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzmefah'
       AND (meta IS NULL OR meta NOT LIKE '%"tokenSymbol":%')
  )
 GROUP BY osmo_addr, namada_addr;
