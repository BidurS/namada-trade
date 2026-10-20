# Pagination, navigation and search: the build plan

Written 2026-10-20 against `master` (92a34c7), for engineers who have not seen the discussion. Read with `system.md` sections 3, 5, 8 (Palette, DataList, Field) and 9.5, and `build-plan.md` sections 3 (ownership), 5.2 (contracts) and 8 (gates). Every figure below is either read from the code at the line cited or measured on the live database with read-only `wrangler d1 execute namada-trade-db --remote --json` (the `sql_duration_ms` and `rows_read` fields of `meta`), on 2026-10-19 and 2026-10-20. Nothing here was deployed.

The owner's words: "please add pagination and awesome navigation with best search etc."

---

## 1. Goals, and what stays as it is

**Goal.** The Holders list grew from about 2,200 rows to 64,377 Namada addresses with NAM (plus 1,334 on Osmosis and 5,486 stakers) and the Transactions list holds 55,173 moves, and both are still served by one "Load more" button over OFFSET paging, with the filters, the search text and the loaded pages living only in React state. A reader cannot link a filtered view, cannot reach rank 30,000, loses the list on reload or Back, and every holders page, every search keystroke, Home's top 10, the overview's holder counts and the CSV export pay the same 230 to 880 ms database sort (the holders query is a 3-way union sorted in a temporary B-tree; measured below). The plan makes every page of both lists cost a few milliseconds, puts the page, the sort and every filter in the URL, adds numbered pages with "Go to rank" on desktop and a numbered "Load more" with a rank jump on phones, makes one search box find addresses by their start or end, names, validators, records by hash, pages, glossary words and typed filters ("sell >100k last 7 days"), with results grouped and ranked instantly, and documents every key in one place. All of it inside the design system: no new colours, plain words, sentence case, 44 px targets, text at least 11 px, no horizontal scroll, every figure stamped, and every list honest about the age of what it shows.

**Unchanged.** The six tabs and their order, keys `1` to `6`, `/`, Ctrl or Cmd K and Esc (`system.md` 3; `/` changes meaning on the two list pages only, section 3.3). The routes and H1s in `shared/routes.ts`. The 52 px page tabs `Transactions | Holders` and the Filter sheet with its count badge below 1024 px, inline controls from 1024 px. The provenance model: one `SourceLine` per list scope, `Num` on every figure, the N1 gate. The `DataList` and `TxList` rules: `role="table"`, no `<table>`, no `display: contents`. Rewind: `/api/holders`, `/api/address/*` and `/api/search` stay current-data and say so; `/api/flows` keeps `at`. The CSV exports and their caps (10,000 holders, 5,000 moves), only their wording changes. The HEAVY_LIMITER binding (one more binding is added beside it). The bulk index being built right now in `worker/src/cron.ts`, `worker/src/holders.ts` and `worker/src/sources/namada.ts` (uncommitted on 2026-10-20: every NAM balance read from the chain in one listing an hour and every bond in one listing every 40 minutes, diffed against the stored rows so only rows that differ are written, at most 3,000 a tick; `kv balance.listing` / `bond.listing` with their `completeAt`; `listingTimes()` and `confirmedAt()` stamping rows a listing confirmed; `HOLDER_DUST_SQL` and `holdersUnder1Nam`): this plan reads those files and changes them only in step 4, after that build has landed, and only through the triggers and statements named there. Nothing here depends on the per-tick refresh that build removes (`LIQUID_PER_TICK`, `LIQUID_DUE_SQL`, `refreshLiquidBalances`).

**Why the data layer comes first.** Measured on the live database (64,530 union rows on Namada):

| Query | D1 time | Rows read |
|---|---|---|
| `/api/holders` page 1, by total (the union, sorted) | 232 to 632 ms (two runs, two days) | 247,074 to 388,981 |
| page 1,001 (`OFFSET 50000`) | 884 ms | 388,981 |
| page 1,201 (`OFFSET 60000`) | 421 ms | 247,074 |
| the `COUNT(*)` the route runs on every request | 327 to 579 ms | 186,641 to 324,451 |
| address-fragment search (`LIKE '%…%'` over the union) | 322 to 989 ms | 186,665 to 340,634 |
| `HOLDER_COUNTS_SQL` (overview, every 20 s poll; the server-rendered page) | 159 ms | 172,107 |
| holders export, `LIMIT 10000` | 628 ms | 383,588 |
| `OFFSET 60000` on the plain `holders` table, `holders_rank` index | 348 ms | 120,101 |
| keyset read on the same index (`balance_num < ? OR (balance_num = ? AND address > ?) … LIMIT 50`) | **1.3 ms** | **153** |
| `/api/flows` page 1, default filters (`pairs=one`) | 1.2 ms | 105 |
| `/api/flows` `OFFSET 50000` | 131 ms | 103,761 |
| `/api/flows` `COUNT(*)` with `pairs=one` (every page today) | 145 ms | 57,594 |
| `/api/search` transaction-hash lookup (`SCAN flows`, no index) | 42 ms | 55,173 |

The slow part is the shape of the holders query (a union of two tables, three joins, `ORDER BY` a computed sum), not the page depth and not the chain. Once the sum is a stored, indexed column, a page is a 1 ms index read at any depth, and offset against cursor becomes a secondary choice. Section 2 is built on that.

---

## 2. Pagination

### 2.1 Holders: a stored total, keyset cursors and numbered pages on one index

**The enabling change (W, step 4; after the holders/cron build lands).** Two columns on `holders`, kept by database triggers so that no writer in `cron.ts`, `holders.ts`, `db.ts` or the live hub has to change:

```sql
-- migrations/0006_nav_search.sql (part 1 of 3: holders totals)
ALTER TABLE holders ADD COLUMN stake_num REAL NOT NULL DEFAULT 0;   -- COALESCE(stakes.bonded_num, stakes.estimated_num, 0); 0 on Osmosis
ALTER TABLE holders ADD COLUMN total_num REAL NOT NULL DEFAULT 0;   -- balance_num + stake_num

-- one-off backfill, in this order: stakers without a spendable row get one (balance 0, never "read"),
-- then every Namada row's stake, then every row's total
INSERT OR IGNORE INTO holders (chain, address, balance, balance_num, updated_at)
  SELECT 'namada', address, '0', 0, NULL FROM stakes WHERE COALESCE(bonded_num, estimated_num, 0) > 0;
UPDATE holders SET stake_num = COALESCE((SELECT COALESCE(s.bonded_num, s.estimated_num, 0) FROM stakes s WHERE s.address = holders.address), 0) WHERE chain = 'namada';
UPDATE holders SET total_num = balance_num + stake_num;

-- the triggers that keep them right (D1 runs SQLite triggers; prove each on the stand-in, test/d1-sqlite.ts).
-- Two statements where a value feeds the next: in one UPDATE every SET expression reads the row as it was,
-- so `total_num = balance_num + stake_num` beside `stake_num = …` would add the OLD stake.
CREATE TRIGGER IF NOT EXISTS holders_total_ai AFTER INSERT ON holders BEGIN
  UPDATE holders SET stake_num = CASE WHEN NEW.chain = 'namada' THEN COALESCE((SELECT COALESCE(bonded_num, estimated_num, 0) FROM stakes WHERE address = NEW.address), 0) ELSE 0 END
   WHERE chain = NEW.chain AND address = NEW.address;
  UPDATE holders SET total_num = balance_num + stake_num WHERE chain = NEW.chain AND address = NEW.address;
END;
CREATE TRIGGER IF NOT EXISTS holders_total_au AFTER UPDATE OF balance_num ON holders BEGIN
  UPDATE holders SET total_num = NEW.balance_num + stake_num WHERE chain = NEW.chain AND address = NEW.address;
END;
CREATE TRIGGER IF NOT EXISTS stakes_total_ai AFTER INSERT ON stakes BEGIN
  INSERT OR IGNORE INTO holders (chain, address, balance, balance_num, updated_at) VALUES ('namada', NEW.address, '0', 0, NULL);
  UPDATE holders SET stake_num = COALESCE(NEW.bonded_num, NEW.estimated_num, 0) WHERE chain = 'namada' AND address = NEW.address;
  UPDATE holders SET total_num = balance_num + stake_num WHERE chain = 'namada' AND address = NEW.address;
END;
CREATE TRIGGER IF NOT EXISTS stakes_total_au AFTER UPDATE OF bonded_num, estimated_num ON stakes BEGIN
  INSERT OR IGNORE INTO holders (chain, address, balance, balance_num, updated_at) VALUES ('namada', NEW.address, '0', 0, NULL);
  UPDATE holders SET stake_num = COALESCE(NEW.bonded_num, NEW.estimated_num, 0) WHERE chain = 'namada' AND address = NEW.address;
  UPDATE holders SET total_num = balance_num + stake_num WHERE chain = 'namada' AND address = NEW.address;
END;
-- Every writer on master is an INSERT … ON CONFLICT DO UPDATE (db.ts stmt.namadaBalance, verifiedBalance, stake,
-- stakeVerified; holders.ts listingBalanceStmts, listingZeroStmts; db.ts stakesVerified in the uncommitted build):
-- the insert path fires the AFTER INSERT triggers, the conflict path fires AFTER UPDATE OF, and a DO UPDATE whose
-- WHERE guard fails writes nothing and fires nothing.

-- the sort keys. Covering: chain and address ride along so a walk never touches the table row.
CREATE INDEX IF NOT EXISTS holders_total ON holders (total_num DESC, address, chain);
CREATE INDEX IF NOT EXISTS holders_stake ON holders (stake_num DESC, address, chain);
-- holders_rank (chain, balance_num DESC) stays: /api/address and the refresh queries use it
```

Why not a separate snapshot table with an integer rank per row (the first idea): rebuilding it writes 64,530 rows plus their index entries, and D1 bills rows written (the paid plan includes 50 million a month, then $1 per million, and an index update counts as a write); even an hourly rebuild would be about 46 million row writes a month before indexes. The two columns above are written only when a balance or a stake is written, which in the uncommitted bulk-index build means: the rows the hourly balance listing finds changed (at most 3,000 a tick, `LISTING_WRITE_CAP`), the rows the 40-minute bond listing finds changed, and a row per transfer from the live hub. A listing that finds the index current writes nothing, so the triggers cost nothing then. The exact per-write cost (one or two extra UPDATEs plus two index entries per holder write) must be read off the account's D1 metrics after a day on production before step 4 is called done.

A zero-balance row inserted for a staker is "not read from the chain yet" for the status (the route keeps `has_row` as `h.verified_at IS NOT NULL OR h.updated_at IS NOT NULL`, so `holderStatus`'s wording does not change). The next balance listing either writes its real balance (the row is "new and holds NAM" from the diff's point of view) or leaves it alone (`listingZeroStmts` touches only rows with `balance_num > 0`).

**The list query, replacing `HOLDERS_BASE` + `HOLDERS_UNION`** (`worker/src/api.ts` 258–266, `worker/src/holders.ts` 54–56):

```sql
SELECT h.chain, h.address, h.balance_num, h.stake_num, h.total_num, h.updated_at, h.verified_at,
       (h.verified_at IS NOT NULL OR h.updated_at IS NOT NULL) has_row,
       s.bonded_num, s.estimated_num, s.verified_at bonded_verified_at,
       l.label, l.category, l.source label_source, l.author label_author
FROM holders h INDEXED BY holders_total                                     -- by=total; holders_stake for by=staked; holders_rank for by=spendable
LEFT JOIN stakes s ON h.chain = 'namada' AND s.address = h.address
LEFT JOIN labels l ON l.address = h.address
WHERE h.total_num > 0
  AND h.address NOT IN (<INTERNAL_ADDRS>)                                   -- protocol accounts, as today
  AND NOT EXISTS (SELECT 1 FROM labels lp WHERE lp.address = h.address AND lp.category = 'pool')
  [AND h.chain = ?]                                                        -- chain=namada|osmosis; chain=all: no condition
  [AND LOWER(l.category) = ? | AND l.label IS NULL]                         -- what=<category> | what=none
  [AND (h.address >= ? AND h.address < ? OR h.address LIKE ? OR l.label LIKE ? …)]  -- search, section 4.3
  [AND h.total_num <= ? AND NOT (h.total_num = ? AND h.address <= ?)]        -- the cursor (after=): one index range, then a filter
ORDER BY h.total_num DESC, h.address
LIMIT ? [OFFSET ?]
```

`by=spendable` swaps `total_num` for `balance_num` (index `holders_rank (chain, balance_num DESC)`; ties sorted in memory, they are small groups; `chain=all` by spendable has no global index and sorts about 66,000 entries in memory: measure it at step 4 and add `(balance_num DESC, address, chain)` only if it is over 100 ms), `by=staked` for `stake_num` (`holders_stake`). One index serves all three chain filters because the walk is in sort order and filters `chain` from the index entry: Namada rows are 98% of the entries so a Namada page stops after about 50 entries; an Osmosis page walks about 50 times more (1,334 of 65,800), still thousands, not hundreds of thousands. The `EXISTS` on `labels` is one primary-key lookup per walked entry (28 pool labels in all).

**`INDEXED BY` is not optional.** Without statistics SQLite's planner prefers the equality index on `chain` (`holders_rank (chain=?)`) and sorts every matching row in a temporary B-tree, which is today's cost with a smaller constant. Proved on the real migrations plus the two columns and indexes above, with 70,000 synthetic rows (98% Namada), in-process SQLite 3.52 on a laptop (not D1; the shape transfers, the milliseconds do not): page 1 by total on Namada 20.7 ms with `USE TEMP B-TREE FOR ORDER BY` against 0.0 ms with the hint (`SEARCH h USING COVERING INDEX holders_total`); `OFFSET 49950` 35.0 ms against 4.0 ms; the last page (`OFFSET 68550`) 37.7 ms against 5.5 ms; a cursor page 17.3 ms against 0.0 ms; Osmosis's last page 2.6 ms; by staked page 1 0.1 ms with `INDEXED BY holders_stake`; `chain=all` page 1 0.0 ms either way (no equality to tempt the planner). `INDEXED BY` is SQLite syntax that D1 runs; the first thing step 4 does after the remote migration is a read-only `EXPLAIN QUERY PLAN` of the new page query through `wrangler d1 execute --remote`, before the route is deployed.

**Server contract, `GET /api/holders`.** Parameters, with the existing names kept so the edge cache keys (`worker/src/http.ts` CACHE_PARAMS) stay valid:

| Parameter | Values | Notes |
|---|---|---|
| `chain` | `namada` (default in the UI), `osmosis`, `all` | as today |
| `by` | `total`, `liquid`, `bonded` | as today (the URL says `spendable` / `staked`; `web/src/api.ts` maps) |
| `category` | raw category or `none` | as today |
| `search` | text | section 4.3 |
| `limit` | 10 to 100, default 50 | as today; the UI offers 25, 50, 100 |
| `page` | 1 … | `OFFSET (page-1)*limit` on the index walk. Numbered pages and "Go to rank" (page = ceil(rank / limit)) |
| `after` | opaque cursor | keyset: the last row of the previous page, `base64url(JSON [sortValue, address])`. Wins over `page` when both are sent. The appender ("Load more") uses it |

Response (`shared/types.ts` `HoldersResponse`, fields added, none removed):

```ts
export interface HoldersResponse {
  total: number;            // holders the chain, category and search select
  page: number;
  limit: number;
  holders: Holder[];        // rank = (page-1)*limit + i + 1, or the cursor's rank + i + 1
  next: string | null;      // the cursor for the rows after the last one here (null on the last page)
  asOf: number;             // when the list was read (the order is as of this time)
  countsAt: number | null;  // when `total` and `categories` were counted (null when counted in this request)
  categories: { total: number; counts: { category: string; n: number }[] } | null;  // over the chain and search, the category left out
}
```

**Counts cost nothing on the common path.** The cron writes `kv 'holders.counts'` (`{ at, byChain: { namada: { all, byCategory: {...}, none, under1Nam }, osmosis: {...}, all: {...} } }`) at the end of every tick in which a listing wrote rows or a listing pass completed, and otherwise every 10 minutes (the live hub's transfer writes move counts by ones), computed by one query over the new index (`SELECT chain, COALESCE(LOWER(l.category), 'none') c, COUNT(*) n FROM holders h LEFT JOIN labels l … WHERE total_num > 0 AND <not internal> AND <not pool> GROUP BY 1, 2`; about 65,800 index entries plus label lookups, expected 100 to 200 ms, measured before merge). `at` is the time the counts were taken; the Namada count's provenance keeps what the bulk-index build gives it (`listingTimes().balance`, the last complete listing). `/api/holders` without `search` reads `total` and `categories` from the key and stamps `countsAt`; `/api/overview` (api.ts 98–118) and `worker/src/seo.ts` read their holder counts and `holdersUnder1Nam` from the same key instead of running `HOLDER_COUNTS_SQL` (159 ms per call today) and `HOLDER_DUST_SQL` (a count with a correlated stake lookup per small balance; on the new column it is `total_num > 0 AND total_num < 1`, an index range at the foot of `holders_total`). `NAMADA_TOP10_SQL` keeps its two listing-time parameters and reads the first ten entries of `holders_total` instead of the union. With `search`, the route runs `SELECT COUNT(*)` and the category `GROUP BY` over the filtered walk itself (a scan of the 65,800-entry index, about 50 to 100 ms; the request is rate-limited, section 4.5) and leaves `countsAt` null. This also fixes the "What" chips: today the server never sends `categories`, so the chips count the 50 loaded rows (`Holders.tsx` 101–139 falls back; 59,137 of 64,530 rows are unlabelled). The client code for `categories` already exists (`catCountsOf`).

**Offset depth, honestly.** `page=1288` (`OFFSET 64350`) walks 64,350 index entries. The measured walk on `holders_rank` with table lookups on the live database was 348 ms for 60,000; the new index is covering and the 70,000-row proof above walked to the last page in 5.5 ms in-process. Ceiling for merging step 4: 150 ms of D1 time at the last page, by total, `chain=namada`, measured with `wrangler d1 execute --remote --json`. If it is over, add integer rank checkpoints (`kv 'holders.marks'`: every 500th row's sort value per sort and chain, 130 rows written per rebuild, rebuilt with the counts) and seek from the nearest mark; do not build that until the measurement says so.

**What a rank means.** The printed rank is the row's position in the live order at `asOf`. Between listings only rows touched by a transfer move (the live hub's post-balance writes); when the hourly balance listing or the 40-minute bond listing writes its changed rows (up to 3,000 a tick), many rows can move at once. So a row can move between two page reads. Keyset pages never repeat or skip a row unless it moved across the cursor; numbered pages can show a row twice or not at all when it moved between reads, and the client drops a duplicate it already holds (as `Holders.tsx` 91–92 does today) and says nothing more. The count line prints the order's time (section 2.5).

**The address sheet rank** (`api.ts` 471–475 counts by `balance_num`, so "No. N by spendable NAM" disagrees with the list's total order): add `rankTotal` next to `rank` in `AddressReport`, `SELECT COUNT(*) + 1 FROM holders WHERE total_num > ? OR (total_num = ? AND address < ?)` (an ordered walk on `holders_total`, cost proportional to the rank), and the sheet says "No. N by total NAM, No. M by spendable NAM" (S7).

### 2.2 Transactions: keyset cursor on `(ts, height, id)`, the feed's own order

The feed is newest first and grows at the head (streamed rows are merged on top, `Transactions.tsx` 133–146), so an offset page shifts under the reader; the client already has to dedupe appended pages by id (line 126). Page 1 costs 1.2 ms today; the cost that matters is the `COUNT(*)` with `pairs=one` on every page (145 ms, a correlated `EXISTS` per `ibc_in` row) and the linear offset walk (131 ms at 50,000).

**Server contract, `GET /api/flows`.** Existing parameters unchanged (`chain`, `kind`, `whale`, `minNam`, `arb`, `pairs`, `search`, `at`, `page`, `limit`). Added:

| Parameter | Values | SQL |
|---|---|---|
| `before` | opaque cursor `base64url(JSON [ts, height, id])`, or a plain unix-ms integer (a date jump) | `f.ts <= ? AND NOT (f.ts = ? AND (f.height > ? OR (f.height = ? AND f.id >= ?)))`; a plain integer is `f.ts < ?`. `flows_ts (ts DESC)` serves the range; the rest filters within equal timestamps |
| `since` | unix ms | `f.ts >= ?` ("last 7 days", "since 1 Oct") |
| `addr` | an address start of 8 characters or more, or a whole address | `(f.from_addr >= ? AND f.from_addr < ?) OR (f.to_addr >= ? AND f.to_addr < ?)` on `flows_from`, `flows_to` (the range form of a prefix match; `LIKE 'x%'` only uses an index on a NOCASE column in SQLite, and these columns are BINARY) |
| `hash` | 8 or more hex characters | `f.tx_hash >= ? AND f.tx_hash < ?` on the new `flows_hash (tx_hash)` index, term upper-cased |
| `height` | integer | `f.chain = ? AND f.height = ?` on `flows_chain_height`, or `f.height = ?` alone when no chain is given (a scan of 55k rows, 40 ms; acceptable, rare) |

`FLOWS_ORDER` stays exactly `ORDER BY f.ts DESC, f.height DESC, f.id DESC` (`flows-query.ts` 79): it already carries the full tie-break the cursor needs. The page runs `LIMIT limit + 1`; a `limit + 1`th row means there is a next page and becomes the cursor (no second query). `COUNT(*)` runs only on the head page (no `before`): pages behind a cursor return the `total` the client already has (`total: null` in the JSON, so a client never mistakes an absent count for zero). `?page=` keeps working for one release as an offset (old links; `web/src/api.ts` falls back to it when a server answers without `next`), then goes.

Response (`FlowsResponse`, added fields):

```ts
export interface FlowsResponse {
  total: number | null;     // null behind a cursor (the head page said it)
  page: number;             // 1 behind a cursor
  limit: number;
  flows: Flow[];
  next: string | null;      // cursor for older rows; null at the end of the index
  asOf: number;             // the time the page was read; with ?at= the rewound time
  firstTs: number | null;   // the oldest move in the index for this chain filter (for "The flow index starts on 3 Dec 2024"), head page only
}
```

Indexes (migration 0006, part 2): `CREATE INDEX IF NOT EXISTS flows_hash ON flows (tx_hash);` (the palette's record lookup scans 55,173 rows today, api.ts 533). Nothing on `amount_num` yet: a "Size 100,000+" page walks `flows_ts` until it finds 50 such rows; measure page 1 of each Size with the default filters; add `flows_amount (amount_num DESC, ts DESC)` only if any exceeds 50 ms.

Edge cache (`http.ts` CACHE_PARAMS `/api/flows`): add `before`, `since`, `addr`, `hash`, `height`; `/api/holders`: add `after`. A parameter the route reads and the list does not would make two answers share one cached copy, so this is a merge gate (a test in `test/routes.test.ts` asserts every `c.req.query(name)` in the two routes is listed). Cache lifetimes: the head page keeps `s-maxage=15`; a page behind a cursor gets `s-maxage=60`: it is not immutable, because the flow index can catch up and insert a row with an older time (the "last checked the chain N ago" sentence already covers that), so one minute, not five.

**"Jump to a date", not page numbers.** A time-sorted feed has no useful page numbers. The filter sheet and the inline controls gain a date field "Show moves from before" (a `datetime-local`, UTC, the same control as the palette's Rewind row) that becomes `before=<ms>`. It is not Rewind: Rewind (`?at=`) changes every number on the site; this only moves the list. The sentence under the field says so: "Only this list moves. To see every figure as it was then, use Rewind."

### 2.3 The client contract: `Pager` (F3, `web/src/ui/Pager.tsx`)

**Owner decision 2026-10-20 (supersedes anything below that says otherwise): numbered pages on every screen size, in the pattern of Etherscan's transaction list, never "Load more".** The list header is one row: left, the count line in words, `A total of 64,377 holders found` with, when the server caps what it will page, `(showing the first 10,000)`; right, `Download page data` (the existing CSV export, for the rows on screen, with the filters applied), then `First ‹ Page 1 of 200 › Last` where the `Page 1` box is a typed numeric field (Enter goes to that page; `of 200` is text), then the filter control (the Filter sheet button below 1024 px, inline from 1024 px). Below 1024 px the same row wraps to two lines: the count line, then the pager and the filter button; the page field keeps its 44 px height and the arrows stay 44 px targets; nothing collapses into "Load 50 more". The numbered run `1 2 3 … 1,288` of the desktop layout stays in addition from 1024 px when there is room; `First`, `Last`, `‹`, `›` and the page field are the required controls. Cursor mode (moves) keeps `Page n` as the position when the server gives no total behind a cursor: show `Page 3` with `of —` and say why in the scope sentence.

One primitive, two modes, used under both lists on every screen size. Rendered as `<nav aria-label="Pages">` with **real links** (`href` carries the whole URL state, so Cmd-click, middle-click and copy-link work, `system.md` 3 "Links are links") that navigate client-side through `linkClick(cfg, href)` as `Tabs.tsx` does.

```ts
export interface PagerProps {
  /** Accessible name of the nav ("Holder pages"). */
  label: string;
  /** Numbered mode: current page, the number of pages (null while the count is unknown). */
  page: number;
  pages: number | null;
  /** Rows per page and the choices (PAGE_SIZES from shared/paging.ts, never literals in TSX: the N2 lint). */
  size: number;
  sizes?: readonly number[];
  /** The href of page n with the current filters (the screen builds it from the URL state). */
  hrefFor: (page: number) => string;
  onSize?: (size: number) => void;
  /** "Go to rank" (holders) or "Show moves from before" (moves): a small form at the pager's end. */
  jump?: { label: string; kind: 'number' | 'datetime'; placeholder?: string; onJump: (value: string) => void };
  /** One sentence after "Page 3 of 1,288": the order's time ("ordered at 10:42 UTC"), 12 px mono, inside the list's scope. */
  asOf?: React.ReactNode;
  /** Cursor mode: no numbers; "Newest" (head) and "Older" (next) links, the position sentence between them. */
  cursor?: { newestHref: string | null; olderHref: string | null; position: React.ReactNode };
  className?: string;
}
```

Layout from 1024 px: `First · Previous · 1 2 3 … 1,288 · Next · Last` on one row (page numbers: current ±2, first and last, an ellipsis as text, never a button), each a 44 px target (`min-width: 44px; min-height: 44px`, 15 px 500, the current one `aria-current="page"` with the yellow 2 px underline, the same rule as the page tabs), disabled ends rendered as `aria-disabled="true"` links with `tabindex="-1"` (layout stays stable), visible words on First and Last, not icons alone. Under it: `Page 3 of 1,288 · 50 per page [25 | 50 | 100] · Go to rank [____] Go` where the size picker is the `Segmented` range variant (32 px plus 6 px padding each side = 44) and the rank field is a numeric `Field` (60 px box, `inputmode="numeric"`, Enter submits; an out-of-range rank gets a `Notice` under the field: "There are 64,377 holders; pick a rank up to that."). Cursor mode: `Newest · Moves 51 to 100 of 53,934 · Older`. The pager reserves its height (`min-height: 56px`) so the page never shifts while a page loads. Keyboard: Left and Right or `[` and `]` move a page when focus is inside the nav or on a list row (section 3.3).

**Where the numbers' provenance comes from.** `Page 3 of 1,288` and `of 64,377` are figures and the N1 gate requires a control or a scope for each: the pager sits inside the list's `ProvScope` and carries `data-prov-ref="act-h-scope"` exactly as the `.cap` line does today (`Holders.tsx` 319); page numbers 1, 2, 3 are not data and carry no `data-num`.

### 2.4 URL state (S5 with one router addition by F1)

The URL is the state; React state mirrors nothing. Both tabs read `useRoute().params` and write through one helper. Defaults are omitted so canonical links stay short; unknown or malformed values fall back to the default and are never guessed (the same rule as `flowsFilterFromQuery`); `?at=` and `?addr=` survive every write as they do now.

| Page | Parameter | Values | Default |
|---|---|---|---|
| `/holders` | `chain` | `namada` `osmosis` `all` | `namada` |
| | `by` | `total` `spendable` `staked` | `total` |
| | `what` | a category, `none` | all |
| | `q` | text | empty |
| | `page` | 1 … | 1 |
| | `size` | `25` `50` `100` | `50` |
| `/activity` | `chain` | `all` `namada` `osmosis` | `all` |
| | `what` | a kind, `dex`, `ibc` | all |
| | `min` | `1000` `10000` `100000` | 0 |
| | `bots` | `off` | shown |
| | `crossings` | `both` | once |
| | `q` | text | empty |
| | `since` | ISO date or unix ms | none |
| | `before` | cursor or unix ms | head |
| | `size` | `25` `50` `100` | `50` |

Router addition (`web/src/app/router.ts`, F1): `setParams(patch: Record<string, string | null>, opts: { push?: boolean } = {})`: sets or deletes several parameters in one `pushState` or `replaceState`, keeps `at`, emits once. `navigate`, `setAt`, `putParam` and `dropParams` are unchanged. `titleFor` gains a detail: `setTitleDetail('page 3')` → `Holders, page 3 · NamadaTrade` (`fullTitle` unchanged; the H1 never changes).

History rules: a filter, sort or size change is a `pushState` (Back undoes the filter); a page change is a `pushState`; typing in a search field is a `replaceState` on each applied value (250 ms after typing stops) and a `pushState` on Enter or blur; the phone appender writes the last loaded page with `replaceState` (section 2.6). `history.state` carries `{ scrollY }`, written on scroll end (100 ms after the last scroll event) and before every push, so Back and Forward restore the scroll offset (the router passes `history.state` through today only on replace; it must carry it on push too).

Scroll and focus on a page change: scroll so the count line sits under the sticky stack (the header, the rewound banner and, on phones, the sticky count line: `scroll-margin-top` on rows already clears the header and tab bar, `tokens.css` 359; add the list's stuck height as `--list-stuck-h`), then move focus to the first row of the new page (`tabindex="-1"`, `focus({ preventScroll: true })`). While a page loads, the previous rows stay on screen under `.is-busy` (as today); the skeleton (`Skeleton rows={size} heights={[64]}` holders, `[72]` moves, at the final heights, `system.md` 8) shows only when there is nothing to keep (first load, a size change).

Switching between `/activity` and `/holders` keeps each tab's parameters: the page tabs' hrefs are built from the other tab's last URL, remembered in a module-level map in `screens/activity/urlState.ts` (not in `localStorage`; a reload starts clean, which is honest).

### 2.5 Count line, data age and empty states (both lists)

The count line stays one sentence, and it now also says when the order is from: "50 of 64,377 holders on Namada, biggest first by total NAM · ordered at 10:42 UTC" where `ordered at` is `asOf` in `--t-12` mono and the counts carry `countsAt` in their stamp (the list's `SourceLine` gains a row "Holder count · Holder index · 10:40 UTC"). The holders answer is never "live": the rows' own ages come from `verified_at` as today. For moves: "53,934 moves match the filters, newest first · read at 10:42 UTC"; behind a cursor: "Moves 1,001 to 1,050 of 53,934". A capped count never reads as exact: when the server answers `exact: false` (an old server, `api.ts` `FlowsPage`) the line keeps "At least …".

When `asOf` changes between two pages of the same holders query by more than the refresh cadence (the client compares `countsAt`), one `Notice` (info) above the list: "The list was refreshed at 10:52 UTC while you were reading; later pages are from the new order. Start from the top" (button). Not shown for moves (a newer row at the head is what a feed does).

Empty states use `EmptyState` (title, one sentence, the last occurrence with a rewind link where one exists):

- Holders, search: title `No holder matches “abc”.` sentence `The search looks at the start and the end of addresses and at names. Try the first 10 characters of the address, its last 4, or a name.`
- Holders, rank jump past the end: `Notice` under the field (above), the page stays.
- Moves, filters: title `No recorded move matches these filters.` sentence as today, plus when the server returns `last` (the newest matching move of any age, head page only, one extra indexed read): `The last one was 2.3 days ago. Rewind to it.` (the `RewindLink` from `ui/Sheet.tsx`).
- Moves, date jump before the index: title `Nothing that early is recorded.` sentence `The flow index starts on 3 Dec 2024 (the oldest move: block 12,345,678).` from `firstTs`.
- A failed request keeps saying it failed (`Notice` warning with Try again, as today), never "nothing matches".

### 2.6 Phones (below 1024 px, the filter-sheet widths)

**The same pager as the desktop, not "Load more" (owner decision 2026-10-20).** At 375 px the required controls fit on one line: `First` (44 px), `‹` (44), the page field `[ 3 ] of 1,288` (the field 56 px wide, 44 high; "of 1,288" as text), `›` (44) and `Last` (44) = 232 px of targets plus four 8 px gaps = 264 px, inside the 343 px content width. The numbered run `1 2 3 …` is omitted below 1024 px. Rules:

1. The list header is two lines: the count line (`A total of 64,377 holders found`, with `showing the first 10,000` when capped), then the pager row with the Filter button (count badge) at its right end. The header is sticky under the site header (`position: sticky; top: var(--header-h)` plus the rewound banner's height when shown; `z-index` under sheets; the same `--c-bg` ground), so the page controls are always one tap away while reading.
2. A page change replaces the rows (no appending), scrolls to the first row of the new page and moves focus to it (`tabindex="-1"` on the row), writes `?page=` with `pushState`, and sets the title detail `Holders, page 3`. Back and Forward restore the page and the scroll offset through `history.state` (section 2.4).
3. `Download page data` sits under the pager on phones as a full-width secondary link (44 px), labelled with what it gives: `Download these 50 rows as CSV` (and `the biggest 10,000` on the holders export, as today).
4. The rank is printed on every row (it is, `HolderRow rank`), so a reader always knows where they are.
5. "Back to top": a 44 px pill (secondary button look, arrow icon, text "Top") fixed bottom-right, `bottom: calc(56px + env(safe-area-inset-bottom) + 12px)` above the tab bar, shown after two screens of scroll, hidden under reduced motion only in its fade (it still appears).
6. Rows stay the two-line phone rows; no table below 620 px, no horizontal scroll, the age opens the detail line on tap (no hover anywhere).
7. A page the server cannot give (past the cap, or a cursor list with no total) shows the pager with `of —` and one sentence under it saying why (`The list is capped at the biggest 10,000 holders; use the search or the CSV for the rest.`).

Avoided, and why: infinite scroll (the `SourceLine`, the CSV link and the pager become unreachable; Back loses position; no end for a screen reader); "Load more" (the owner's decision; and a 64k-row list in one phone page is a memory and scroll problem); a page-number run below 1024 px (seven 44 px targets do not fit beside the field at 375 px).

## 3. Navigation

What "awesome navigation" means here: the reader always knows where they are, can get anywhere in two actions, can share exactly what they see, and can do it all from the keyboard, without one more control on the screen than today. No new top-level tabs. The header and tab bar keep their six destinations; three things change in the shell, each with its reason.

### 3.1 The header search from 1024 px (F1, `Header.tsx`)

The search icon button becomes a field-shaped button from 1024 px: 44 px high, 260 px wide (220 from 1024 to 1199), the search icon, the placeholder words "Search an address, a name or a page" in `--c-ink-3`, and a `kbd` "/" at the right under `(pointer: fine)`. It is a `<button>` (`aria-label="Search"`, `aria-keyshortcuts="/ Control+K Meta+K"`) that opens the palette, not an input: a second input whose text would have to be mirrored into the palette's is a trap (GitHub's header does the same). Below 1024 px the icon stays as it is (the phone header has no room, `system.md` 3). Reason: the palette exists but the icon does not tell a first-time reader that it searches addresses; the words do.

### 3.2 Context in the address sheet (S7, `AddressSheet.tsx`)

When the sheet is opened from a list row it shows an eyebrow under the title in `--t-11` caps: `FROM HOLDERS · NO. 1,204 BY TOTAL NAM` or `FROM ACTIVITY · MOVE 51 OF 53,934`, from an `origin` the opener passes (`openAddress(address, { from: 'holders', rank })`; `openSheet` gains an optional `origin`). Closing the sheet already returns focus to the row's name button (`Sheet.tsx` restoreFocus), so "Back to the list" is the Close button and Escape; no breadcrumb bar. The sheet's rank line says "No. N by total NAM · No. M by spendable NAM" (section 2.1). Reason: a sheet opened from rank 1,204 with "No. 318 by spendable NAM" reads as a different list today.

### 3.3 Keys, documented in one place (F1 `keys.ts`, F4 lists, S5 wiring)

One table in `web/src/app/keys.ts`, `SHORTCUTS: { keys: string[]; does: string; where: 'everywhere' | 'lists' | 'search' }[]`, renders the "Keys" sheet (`?` opens it; `app/KeysSheet.tsx`, a kit `Sheet` with a two-column `kv` list) and the `kbd` hints, so the words and the bindings cannot drift. Every binding passes `keyAction`'s existing guards (ignore Meta, Ctrl, Alt; inert while typing or while an overlay is open) and hints render only under `(pointer: fine)`.

| Keys | Does | Where |
|---|---|---|
| `1` to `6` | Switch view | everywhere (as today) |
| `/` | Focus the list's search field on Activity and Holders; open search elsewhere | everywhere (changed on the two list pages) |
| Ctrl or Cmd `K` | Open or close search | everywhere (as today) |
| Esc | Close the top overlay; in a list search field, clear it, then leave it | everywhere |
| `?` | This list of keys | everywhere (new) |
| `j` / `k`, Down / Up | Next / previous row | lists (new; roving `tabindex`, section 3.4) |
| Enter | Open the row's address (holders) or the move's detail line (moves) | lists |
| `o` | Open the row's record on the explorer, in a new tab | lists (moves) |
| `[` / `]`, Left / Right | Previous / next page | lists and the pager |
| Home / End | First / last loaded row | lists |
| `.` | Next page (every screen size) | lists |
| Down / Up, Home / End, Page Down / Page Up (8 rows) | Move the active result | search |
| Enter | Run the active result | search |
| Tab | Accept a typed scope prefix as a chip (`@` addresses and names, `#` records, `>` actions, `?` glossary); Backspace on an empty input removes it | search |

`/` on the list pages: the screen registers its field with `useSlashTarget(ref)` (a context in `keys.ts`); `keyAction` returns `{ kind: 'focus-search' }` when a target is registered and nothing is typing. Reason: on a list page the reader wants the list searched, and the palette is one more key away (Ctrl K).

### 3.4 Rows you can walk (F4, `DataList.tsx`, `TxList.tsx`)

Rows get a roving `tabindex` (`0` on the current row, `-1` on the others; the row's `onKeyDown` handles `j k ArrowDown ArrowUp Home End Enter o`), `aria-rowindex` equal to the rank plus one (the header is row 1) and the table `aria-rowcount` equal to the full total plus one (64,378), so a screen reader hears "row 1,205 of 64,378" and knows the list is long and partly loaded (`TxList` sets `aria-rowcount={rows.length + 1}` today; it becomes `total + 1` when the count is exact). The row's focusable controls (name button, address buttons, the age toggle, the record link) keep their own tab stops; the row's `tabindex` is for walking only. A focused row shows the 2 px `--c-focus` ring inset (`outline-offset: -2px`), nothing else.

### 3.5 The active-filter chip strip (F3 `ui/FilterChips.tsx`, S5 wiring)

One chip per non-default filter and per parsed search token, in plain words, each a `button` named "Remove filter: at least 10,000 NAM" with a 12 px close glyph, 44 px high, the selectable-chip look (`system.md` 8 Chip), in a row that scrolls sideways on phones (`overflow-x: auto; scroll-snap-type: x proximity`, an edge fade, no visible scrollbar) and wraps from 640 px; hidden when empty. Below 1024 px it is stuck under the sticky count line (section 2.6); from 1024 px it sits under the inline controls. Reason: the Filter button's count badge is the only sign a filter is on today, and a reader who arrives from a shared link has no idea what "2" means.

### 3.6 Recent (F1, `app/recent.ts`)

`nt.recentAddr` (5 addresses, `overlays.tsx` 64–80) becomes `nt.recent`: up to 20 entries `{ kind: 'address' | 'search' | 'view'; key: string; label?: string; opens: number; lastAt: number }`, `localStorage` only, never sent anywhere (the privacy line in Settings stays true; `G10 N9`'s network assertion covers it), written on an address open, a run search (Enter in the palette with a term) and a view chosen from the palette; read by the palette's "Recent" group before typing and by the ranking (section 4.6) as a frecency score `opens × 0.5^(days since lastAt / 7)`. A "Clear recent" action in the palette's Actions group removes the key. Every read and write is in `try/catch` (private windows throw).

### 3.7 What does not change in the shell

The tab bar (six cells, 56 px, the Alerts count dot), the status pill, the price pill, the Rewind button (desktop) and the rewound banner. The palette's Rewind row stays where it is. No "More" menu, no breadcrumb bar, no second header row.

---

## 4. Search

One box, three places (the palette, the Holders field, the Transactions field), one grammar, one server route. The palette finds things across the site; the two list fields narrow their list and also take the grammar (so "sell >100k last 7 days" typed on Activity becomes chips and filters). Results are grouped, ranked, and the local groups render on every keystroke before the server answers.

### 4.1 The grammar (W, `shared/search-grammar.ts`, pure, tested)

`parse(input: string): Parsed` where

```ts
export interface Parsed {
  text: string[];                 // free words left over, matched against addresses, names and hashes
  address: string | null;         // a tnam1…/osmo1… start of 8+ characters, or a whole address
  tail: string | null;            // 4 to 8 trailing characters of an address ("…kj4m" or "kj4m" when it is not a word)
  hash: string | null;            // 8+ hex characters, upper-cased; also extracted from a pasted explorer URL
  height: number | null;          // 5+ digits
  pool: number | null;            // 1 to 4 digits (an Osmosis pool id, as today)
  kind: string | null;            // a FlowKind or 'dex' | 'ibc'
  chain: 'namada' | 'osmosis' | null;
  min: number | null;             // NAM
  max: number | null;
  since: number | null;           // unix ms
  until: number | null;
  bots: 'off' | null;
  crossings: 'both' | null;
  what: string | null;            // holders category: foundation | genesis | backer | validator | none
  chips: { label: string; param: string }[];   // what was understood, in plain words, one chip per token
}
```

Tokens, in the words the site already uses (`web/src/lib/kinds.ts` words, moved to a words table inside the grammar file so `shared/` imports nothing from `web/`):

| Typed | Means | Chip |
|---|---|---|
| `>100k`, `>=1m`, `<5000`, `100k..1m`, `>100000 nam` | `min` / `max` (k, m, b suffixes; "nam" optional; amounts are NAM only, `$` is not understood and the chip says so) | "At least 100,000 NAM" |
| `sell`, `sold`, `buy`, `bought`, `staked`, `stake`, `unstaking`, `unstake`, `unlocked`, `withdraw`, `bridged`, `bridge`, `shielded`, `shield`, `unshield`, `reward`, `rewards`, `pool`, `bot`, `bots`, `transfer`, `trades`, `crossings` | `kind` (`dex` for trades, `ibc` for crossings) | "Sells only" |
| `namada`, `osmosis`, `on namada` | `chain` | "On Osmosis" |
| `last 7 days`, `last 24 h`, `today`, `yesterday`, `since 2026-10-01`, `before 2026-10-01`, `2026-09-01..2026-10-01` | `since` / `until` (UTC midnight) | "Since 1 Oct 2026" |
| `-bots`, `no bots` | `bots: 'off'` | "Bot trades left out" |
| `both records` | `crossings: 'both'` | "Both records of each crossing" |
| `foundation`, `genesis`, `backers`, `validators`, `no label`, `unlabelled` | `what` (holders) | "Foundation only" |
| `tnam1qx…` (8+), `osmo1…` | `address` (never fuzzy: one wrong character is another account) | "Address starts with tnam1qx…" |
| `…kj4m`, or a 4 to 8 character `[0-9a-z]` token that is not a word | `tail` | "Address ends with kj4m" |
| 8+ hex, or an explorer URL | `hash` | "Record starts with A1B2C3D4" |
| 5+ digits | `height` | "Block 8,294,006" |
| `"Zondax"` | one `text` entry with the space kept | — |
| anything else | `text` | — |

Parse failures are not errors: a token that fits nothing is text. The chips are the active-filter strip (section 3.5); removing a chip removes its token from the field's text. Tokens map one to one onto URL parameters (section 2.4) and so onto API parameters; `addr`, `hash`, `height`, `since` are the new ones (section 2.2).

### 4.2 Where each thing is found (the server, W)

`GET /api/search?q=<text>&limit=6` keeps its response shape (`{ results: SearchResult[] }`, `SearchResult.type` gains `'validator'` and every result gains `group`), so an old client keeps working, and runs the groups side by side with a per-group `LIMIT`:

| Group | Source | Query | Cost |
|---|---|---|---|
| Addresses, exact | `labels` by primary key, `holders` by `(chain, address)` | as today | < 1 ms |
| Addresses, by start | `holders` (and `stakes` by its primary key until step 4 gives every staker a holders row) | `chain = ? AND address >= ? AND address < ?` (chain from the prefix `tnam1`/`osmo1`; the range is the prefix and the prefix with its last character incremented; bech32 is lowercase alphanumeric so the increment is safe) `LIMIT 6` | index seek, < 2 ms |
| Addresses, by end | `holders` | `address LIKE '%kj4m'` over the chain | a scan of 64,739 rows of one short column: expected 30 to 60 ms, measured before merge; rate-limited |
| Records | `flows` | `tx_hash >= ? AND tx_hash < ?` on `flows_hash`; a whole hash also exact | < 2 ms (42 ms today) |
| Names and validators | `labels_fts` (FTS5) | `labels_fts MATCH 'zond*' ORDER BY bm25(labels_fts) LIMIT 6`; `category = 'validator'` rows say "validator" in the subtitle. Validator names are already in `labels` (source `valopers`, written by the cron), so no new source and no chain read | < 2 ms over 5,959 rows |
| Names, fallback | `labels` | `label LIKE ?` with `labelSearchTerms` as today, when `labels_fts` is absent | 0.4 ms |
| Pool | as today | digits 1 to 4 | — |
| Block | `flows` | `height = ?` (5+ digits) on `flows_chain_height` per chain | < 5 ms |

FTS5 (migration 0006, part 3):

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS labels_fts USING fts5(label, address UNINDEXED, category UNINDEXED, tokenize = 'unicode61');
INSERT INTO labels_fts (label, address, category) SELECT label, address, category FROM labels;
CREATE TRIGGER IF NOT EXISTS labels_fts_ai AFTER INSERT ON labels BEGIN INSERT INTO labels_fts (label, address, category) VALUES (NEW.label, NEW.address, NEW.category); END;
CREATE TRIGGER IF NOT EXISTS labels_fts_au AFTER UPDATE ON labels BEGIN DELETE FROM labels_fts WHERE address = OLD.address; INSERT INTO labels_fts (label, address, category) VALUES (NEW.label, NEW.address, NEW.category); END;
CREATE TRIGGER IF NOT EXISTS labels_fts_ad AFTER DELETE ON labels BEGIN DELETE FROM labels_fts WHERE address = OLD.address; END;
```

Cloudflare's SQL statements page lists the FTS5 module as supported on D1; the test stand-in (Node 25.8, SQLite 3.52.0) runs `fts5` with `unicode61` and the `trigram` tokenizer (checked 2026-10-19). The route checks once per isolate (`SELECT 1 FROM sqlite_master WHERE name = 'labels_fts'`) and falls back to `LIKE` when the table is missing, so the migration can land after the route. Do not use the trigram tokenizer until a remote `CREATE VIRTUAL TABLE … tokenize='trigram'` has been tried on a scratch table; `unicode61` with prefix queries gives word-start matching and diacritic folding, which is what names need.

What is not searched on the server, on purpose: amounts, kinds and dates (those are filters the grammar turns into list parameters; the palette offers a "Lists" row for them, section 4.6), page body text, and anything fuzzy on addresses or hashes.

### 4.3 The two list fields (S5, with `SearchField` changes by F3)

The Holders field sends `search=` as today, and the server's `holdersWhere` (api.ts 272–287) becomes: a parsed `address` → the range form on `h.address`; a `tail` → `h.address LIKE '%tail'` (a scan of the index, 65,800 short entries; expected 30 to 80 ms, measured before merge; the count line says "searching the whole list" while it runs); free `text` → `l.label LIKE '%term%'` with `labelSearchTerms` variants (as today) and, when the text is 8 or more characters of `[0-9a-z]`, also `h.address LIKE '%text%'`; a parsed `min` / `max` → new `min=` / `max=` parameters on `total_num` (added to CACHE_PARAMS); a parsed `what` → `category=`. The Transactions field maps `address` → `addr=`, `hash` → `hash=`, `height` → `height=`, `kind` → `kind=`, `chain`, `min` → `minNam`, `since`, `until` → `before=<ms>`, `bots` → `arb=false`, `crossings` → `pairs`, and free text → `search=` as today (the `LIKE '%q%'` over `from_addr`, `to_addr`, `tx_hash`; it stays the slow path and stays rate-limited).

`SearchField` (`ui/Field.tsx`) gains: `applyAfterMs` (250 for the lists; the palette has its own input), `onEnter` (apply at once and `pushState`), Escape clears then blurs on the second press, `aria-describedby` to a 13 px hint under the field on the lists: "Addresses by their start or end, names, records, and words like sell >100k last 7 days" (plain, under 11 words per the 44 px pill's width it wraps to two lines on phones; that is fine). The 16 px input text and the 44 px clear button stay (iOS zoom, targets).

### 4.4 Cancellation, debounce, stale answers (W for `api.ts` and `http.ts`, F1 for the hook)

`web/src/api.ts` `get(url, { signal })` passes an `AbortSignal` to `fetch` (today it passes none, so every superseded keystroke runs to completion on the Worker and the database). One hook, `web/src/lib/useQuery.ts` (F1): `useQuery(key, fetcher, { debounceMs, keepPrevious: true })` keeps an `AbortController` per in-flight request, aborts it when a newer key arrives or the component unmounts, carries a monotonically increasing sequence so a late answer can never overwrite a newer one (the `live` flag pattern stays as a second guard), returns `{ data, previous, busy, error }`, and never shows a skeleton while there is previous data to keep. Enter bypasses the debounce. Debounce: 150 ms in the palette for the server groups (the local groups are not debounced), 250 ms in the list fields.

### 4.5 Rate limits and caching (W, `http.ts`, `wrangler.jsonc`)

HEAVY_LIMITER allows 30 requests a minute per client address per path prefix and covers exports, `/api/search`, `/api/address/*` and `/api/flows` with `search`; `/api/holders` with `search` (about 1 s today, the most expensive query measured) is not covered. A person typing at 5 characters a second with a 150 ms debounce sends roughly one request per pause, which a long session takes past 30 a minute, and the palette then shows "The search did not answer". Changes:

1. A second binding, `SEARCH_LIMITER` (`{ "name": "SEARCH_LIMITER", "namespace_id": "1002", "simple": { "limit": 120, "period": 60 } }`), for `/api/search`, `/api/holders?search=`, `/api/flows?search=`; HEAVY_LIMITER keeps exports and address reports. `isHeavy` becomes `limiterFor(url): 'heavy' | 'search' | null`. The 429 body for the search limiter: "Too many searches from your address; try again in a minute." (the palette prints the server's words, as it does for failures).
2. `/api/search` joins CACHEABLE_API with CACHE_PARAMS `['q', 'limit']`, `s-maxage=15`: the prefixes people type ("zond", "tnam1qx") repeat across readers and the answer is current data stamped with `asOf`.
3. `/api/holders` and `/api/flows` answers behind a cursor: section 2.2.
4. Prefetch, desktop only: when the last loaded row scrolls into view (an `IntersectionObserver`, one page ahead, never two) or the pager's Next is hovered for 150 ms, the next page is requested with its own signal; the result is held in the hook's cache keyed by URL and shown without a request when the reader gets there.

### 4.6 The palette (F1, `Palette.tsx`)

**Groups, in order while typing:** Addresses (an exact pasted address first, then by start, then by end), Records, Names (labels and validators, "validator" in the subtitle), Lists (a parsed filter set: "Moves: sells of at least 100,000 NAM, last 7 days" → `/activity?what=sell&min=100000&since=…`; "Holders: foundation, biggest by total" → `/holders?what=foundation`; shown when at least one grammar token parsed), Views, Actions, Glossary. Before typing: Recent (the last 5 of `nt.recent`, by frecency: addresses with their plain name and chain word; searches as "Search again: zondax"), Views, two Actions, then the Rewind block where it is. A scope prefix (`@ # > ?`, section 3.3) puts its group first and hides the others.

**Ranking inside a group** (Raycast's tiers, applied to our data): exact match, then start-of-value (address prefix, name word start from FTS `bm25`), then substring, then frecency from `nt.recent` on the device; ties keep the server's order. No fuzzy matching anywhere on addresses or hashes; names get word-start matching through FTS and nothing looser.

**Rows** stay 52 px (`system.md` 8): the label in `--t-15` 500, the address in mono, the plain name in text, and the chain word plus what is known from the list ("Namada address · staked 1.2 million NAM" when the holders answer carries the figure; stamped in the address sheet, not here, so no `data-num` in the palette: the figure is repeated from the sheet's source and the sheet is one tap away). A settled count under the input: "12 results in 4 groups" (section 4.7). The "no match" sentence stays "No address, record or name matches “abc”." and the failed-search sentence stays what it is.

**Instant feel.** Views, Actions, Glossary, Lists and the typed-address row are computed on every keystroke from local data (they are today); only Addresses, Records and Names wait 150 ms and the request. So the palette is never empty while typing, and a stale server answer (sequence lower than the current) is dropped.

**Phone sheet.** Full height with the input at the top, 16 px text, as built; the results scroll under a sticky input; the Rewind block scrolls with the results (it is below them). The scope chip, when one is set, sits in the input's left slot as a 32 px chip with its own remove button (44 px hit area through `::after`).

### 4.7 Accessibility of the search (F1)

The input already is `role="combobox"` with `aria-expanded`, `aria-controls`, `aria-activedescendant` over a `role="listbox"` of `role="group"` headings and `role="option"` rows, with DOM focus kept on the input (the APG combobox pattern). Add: `aria-autocomplete="list"`; `aria-expanded="false"` when nothing is listed; Home and End, Page Down and Page Up (8 rows); one `role="status" aria-live="polite"` line that announces the settled count ("12 results in 4 groups") only after the results have stopped changing for 500 ms (per keystroke is noise); each option's `aria-describedby` pointing at its group heading so "Zondax, validator" is read with "Names"; the glossary rows, which are not actionable, leave the listbox (they become a plain list under it with its own heading) instead of `role="option" aria-disabled="true"` rows that assistive technology still counts. The scope chip is announced through the input's `aria-description` ("Searching addresses and names").

---

## 5. File ownership for a parallel build

Roles as in `build-plan.md` section 3: **W** worker, shared, data and the client's API mirror; **F1** shell, router, keys, palette, e2e harness; **F3** controls (`Pager`, `FilterChips`, `SearchField`, `BackToTop`); **F4** data display (`DataList`, `TxList`); **S5** the Activity screen; **S7** sheets. One owner per file. `ui/index.ts` is F1's: F3 and F4 send F1 their export lines. `worker/src/cron.ts`, `worker/src/holders.ts` and `worker/src/sources/namada.ts` are being changed by another build now: **read them fresh from `master` before step 4, never from this document, and touch them only in step 4, after that build has merged.** The triggers in migration 0006 are designed so that step 4 needs nothing from those three files except the `kv 'holders.counts'` write (one function call in the tick) and reading the counts in `/api/overview` and `seo.ts`.

| Owner | Files | Work |
|---|---|---|
| W | `migrations/0006_nav_search.sql` (new) | holders `stake_num`, `total_num`, backfill, triggers, `holders_total`, `holders_stake`, `flows_hash`, `labels_fts` and its triggers |
| W | `worker/src/api.ts` | `/api/holders` (cursor, page, counts from kv, categories, `asOf`, `countsAt`, `min`/`max`, the new search conditions), `/api/flows` (`before`, `since`, `addr`, `hash`, `height`, `next`, `total: null` behind a cursor, `firstTs`, `last`), `/api/search` (groups, FTS with fallback, `asOf`), `/api/address` (`rankTotal`), export wording headers unchanged |
| W | `worker/src/flows-query.ts` | the new conditions and `flowsFilterFromQuery` fields; `prefixRange()` |
| W | `worker/src/http.ts`, `wrangler.jsonc` | CACHE_PARAMS, `/api/search` cacheable, `limiterFor`, SEARCH_LIMITER |
| W (step 4 only, after the other build) | `worker/src/cron.ts`, `worker/src/holders.ts`, `worker/src/seo.ts` | `writeHolderCounts()` called from the tick after a listing pass (and every 10 minutes); `HOLDER_COUNTS_SQL`, `HOLDER_DUST_SQL` and `NAMADA_TOP10_SQL` read the indexed `holders` instead of the union (`NAMADA_TOP10_SQL` keeps its listing-time parameters); the seo page reads counts from kv. Read these three files from `master` on the day: the uncommitted build rewrites most of `cron.ts` and `holders.ts` |
| W | `shared/types.ts`, `shared/paging.ts` (new: `PAGE_SIZES`, `encodeCursor`, `decodeCursor`, `prefixRange`), `shared/search-grammar.ts` (new) | contracts and pure helpers |
| W | `web/src/api.ts` | `get(url, { signal })`, `fetchHolders(opts)` and `fetchFlows(opts)` with the new parameters, `next` handling and the `?page=` fallback for old servers, `searchOmni(q, { signal })` |
| W | `test/paging.test.ts`, `test/search-grammar.test.ts`, `test/search.test.ts` (new), `test/holders.test.ts`, `test/flows.test.ts`, `test/routes.test.ts` | section 6 |
| F1 | `web/src/app/router.ts`, `keys.ts`, `Header.tsx`, `Palette.tsx`, `overlays.tsx`, `recent.ts` (new), `KeysSheet.tsx` (new), `web/src/lib/useQuery.ts` (new), `web/src/styles/components/shell.css`, `web/src/ui/index.ts`, `web/e2e/helpers.ts`, `web/e2e/shell.spec.ts`, `web/e2e/gates.spec.ts` | `setParams`, `setTitleDetail`, `history.state` scroll, slash target, `?` keys, the header field-button, palette groups, ranking, recents, prefixes, ARIA, the hook |
| F3 | `web/src/ui/Pager.tsx`, `FilterChips.tsx`, `BackToTop.tsx` (new), `Field.tsx`, `web/src/styles/components/controls.css`, `web/src/ui/Demo.tsx` (the `/__ui` kit demo gains the three) | section 2.3, 3.5, 4.3 |
| F4 | `web/src/ui/DataList.tsx`, `TxList.tsx`, `web/src/styles/components/data.css` | roving rows, `aria-rowcount` / `aria-rowindex`, sortable column heads (`aria-sort`, a `button` inside the `columnheader` for Total, Spendable, Staked, 7 days; click sets `by`; 7 days is not sortable on the server, so its head is plain), the stuck-head hairline (`.is-stuck` via a 1 px sentinel) |
| S5 | `web/src/screens/activity/Holders.tsx`, `Transactions.tsx`, `index.tsx`, `parts.tsx`, `urlState.ts` (new), `listKeys.ts` (new), `web/src/styles/screens/activity.css`, `web/e2e/activity.spec.ts` | URL state, pagers, appender, chips, the date jump, count lines, empty states, sticky count line, back to top, focus moves |
| S7 | `web/src/screens/sheets/AddressSheet.tsx` | the origin eyebrow, both ranks |

Contracts that let owners start before their neighbours finish: the API shapes in section 2 (W publishes the types first, in a day); `Pager`, `FilterChips` and `useQuery` props above (F3 and F1 publish the props as stubs in `ui/index.ts` on day one; S5 builds against them). No file is touched by two owners.

---

## 6. Tests and gates

**Unit (Vitest, `test/`, on the D1 stand-in `test/d1-sqlite.ts` with the real migrations applied):**

- `paging.test.ts`: `encodeCursor`/`decodeCursor` round-trip, a malformed cursor is ignored (head page), `prefixRange('tnam1qz')` is `['tnam1qz', 'tnam1q{')`. Holders: seed 300 rows across both chains, stakers without a spendable row, two pools, one protocol account; assert the triggers against the real writer statements on `master` that day (`stmt.namadaBalance`, `stmt.verifiedBalance`, `stmt.stake`, `stmt.stakeVerified`, and the multi-row `listingBalanceStmts`, `listingZeroStmts`, `stakesVerified` once the bulk-index build is in: a balance write updates `total_num`; a stake write inserts the missing row and updates both; a write whose guard fails changes neither; the backfill statements produce the same totals as `HOLDERS_BASE` did, row for row, by running the old union SQL against the same seed); page 2 by offset equals the rows after `next` of page 1; walking every page by cursor yields each row exactly once; `by=staked` and `by=spendable` orders; `chain=all` is in total order; a balance change between two cursor pages does not repeat or drop a row that did not cross the cursor; `total` and `categories` come from the kv counts when no search is set and are counted when it is; every page query's EXPLAIN QUERY PLAN on the stand-in contains `USING COVERING INDEX holders_total` (or `holders_stake`, `holders_rank` for the other sorts) and never `TEMP B-TREE FOR ORDER BY` (the `INDEXED BY` guard: a refactor that drops the hint fails this test); `search=tnam1qz` uses the primary key range, never `SCAN holders`; `rank` is `(page-1)*limit+i+1`. Flows: `before` as a cursor and as a plain time, `since`, `addr`, `hash` (EXPLAIN uses `flows_hash`), `height`; `next` is null on the last page; `total` is null behind a cursor and exact on the head; `?page=` still pages; `firstTs` and `last`.
- `search-grammar.test.ts`: a table of inputs to `Parsed` (every row of the table in section 4.1, plus "sell >100k last 7 days", "zondax", "tnam1qx…kj4m" pasted whole, an explorer URL, `"Anoma Foundation"`, "$100" → text with the chip that says amounts are NAM, "0x…" → text).
- `search.test.ts`: `/api/search` with `labels_fts` present and absent (drop the virtual table in the test) returns the same names; prefix and tail address results; a record by 8 hex characters; `group` on every result; the per-group limit; `asOf` present.
- `routes.test.ts`: every `c.req.query('<name>')` read by `/api/holders` and `/api/flows` appears in CACHE_PARAMS (parse `api.ts` and `flows-query.ts` for the names); `limiterFor` classifications; the 429 words.
- `holders.test.ts`, `flows.test.ts`: the existing cases pass unchanged (`limit=10`, `search=early backers`, the clamp, `page=2`, `pairs=one`).

**Playwright (`web/e2e/`, the G6 viewport matrix 360, 375, 390, 412, 768, 1280 unless marked):**

- `activity.spec.ts` (S5): page 2 from the pager (1280) changes the URL to `?page=2`, the first row has focus and is rank 51, Back returns to page 1 with the scroll offset restored (compare `scrollY` before and after); "Go to rank 1,204" lands on `?page=25` with row 1,204 focused and visible under the sticky stack; `?chain=osmosis&by=staked` on load shows the controls in that state and the count line says "on Osmosis" (the `by` segmented hidden); a shared link with `?what=sell&min=100000` opens filtered with two chips, each removable, the Filter badge says 2 below 1024 px; typing "sell >100k" in the list field shows the two chips and the URL after Enter; at 375 the pager row shows First, ‹, the page field, › and Last, each at least 44 px; › goes to `?page=2`, replaces the rows, focuses row 51, and a reload shows rows 51 to 100; typing 25 in the page field and Enter lands on `?page=25`; the count line reads "A total of N holders found"; the date jump before 3 Dec 2024 shows the "Nothing that early is recorded." empty state; the back-to-top pill appears after two screens and is 44 px; `layoutAudit('main')` on `?page=3`, with chips on, with the pager, at every viewport: `overflowX` false, no `<table>`, `smallTargets` and `smallText` empty; the existing tests (filter sheet badge, Load more appends, address rows write `?addr`, CSV links) pass; the CSV link text says "the biggest 10,000 of 64,377".
- `shell.spec.ts` (F1): `/` on `/holders` focuses the list field, on `/` opens the palette; Ctrl K opens it everywhere; typing "hold" lists the Holders view before any request completes (route `/api/search` with a 2 s delay and assert the row is there within 200 ms); Down, Down, Enter opens the third result; Home and End; the status line reads "N results in M groups" once per settled term (count the `role=status` text changes while typing 5 characters quickly: at most 2); `@` scopes to addresses and names, Backspace on an empty input removes the scope; the header field-button exists from 1024 px with the `/` hint and not below; `?` opens the Keys sheet and Escape returns focus to the body; recents appear after an address was opened and "Clear recent" empties them; no request leaves the site but `/api` and `/ws` (N9, with `nt.recent` populated).
- `gates.spec.ts` (F1, existing gates on the new states): G4 axe on `/holders?page=3`, `/activity?what=sell&min=100000` and with the palette open on a typed term; G5 copy on the new strings (sentence case; no banned word: the plan's UI words never use "cursor", "index" is fine, "D1" never appears in TSX); G6 with the pager and the chip strip; G7 reduced motion with the back-to-top pill shown; G10 N1 on `/holders?page=3` (the pager's figures sit in the scope through `data-prov-ref`).

**Screens and audits with `scripts/shoot.mjs`** (each prints the JSON line; every line must show `"overflowX":false`, `"smallText":[]`, `"smallTargets":[]`, `"tables":0`):

```
node scripts/shoot.mjs "http://localhost:8787/holders?page=3" docs/design/shots/holders-375-p3.png 375 812 --tall
node scripts/shoot.mjs "http://localhost:8787/holders?page=3&what=genesis&q=anoma" docs/design/shots/holders-375-chips.png 375 812
node scripts/shoot.mjs "http://localhost:8787/holders?page=1288" docs/design/shots/holders-1280-last.png 1280 800
node scripts/shoot.mjs "http://localhost:8787/activity?what=sell&min=100000&since=2026-10-01" docs/design/shots/activity-375-filtered.png 375 812 --tall
node scripts/shoot.mjs "http://localhost:8787/activity?before=1790000000000" docs/design/shots/activity-1280-jump.png 1280 800
node scripts/shoot.mjs "http://localhost:8787/holders" docs/design/shots/holders-320.png 320 700
```

**The other gates, unchanged and still required:** `npm run typecheck`, `npm test` (N10: `test/replay.test.ts` and the settings tests byte-identical), `node --experimental-strip-types scripts/copy-lint.ts` (G5 source half; `PAGE_SIZES` and every count live in `.ts` modules or come from the API so the N2 numeric-literal lint stays clean), `npm run build && node --experimental-strip-types scripts/budgets.ts` (G9: the grammar, `Pager` and the palette changes are in lazy chunks; the initial JS stays at most 130 KB gzip; print the before and after figures in the PR), `scripts/contrast.ts` (G4, no token changes expected: the plan adds no colour).

**Production checks before each step is called done** (read-only, `wrangler d1 execute namada-trade-db --remote --json`): the EXPLAIN QUERY PLAN of the new holders page (`USING COVERING INDEX holders_total`, no `TEMP B-TREE`; this also proves D1 accepts `INDEXED BY`), the deep-page time (ceiling 150 ms, section 2.1), the tail-search time (ceiling 100 ms), the counts query time, the FTS query time; and the account's D1 rows-written figure a day after the triggers are live. The proof scripts used for this plan are reproducible from `test/d1-sqlite.ts`'s approach (the real migrations on `node:sqlite`, then the migration-0006 statements, then the writer statements and `EXPLAIN QUERY PLAN`); `test/paging.test.ts` is their permanent home.

---

## 7. Order of work and effort

Engineer-days, by owner; five owners in parallel after day 1 give about three calendar weeks, with step 4 on the critical path behind the holders/cron build.

| Step | What | Owner | Days | Depends on |
|---|---|---|---|---|
| 0 | Contracts first: types in `shared/types.ts`, `shared/paging.ts`, the `Pager` / `FilterChips` / `useQuery` prop stubs exported from `ui/index.ts` | W, F3, F1 | 1 | — |
| 1 | URL state for both lists (`setParams`, `setTitleDetail`, `history.state` scroll restore, push/replace rules, tab hrefs that remember), the chip strip wired to the existing filters | F1 1, S5 2, F3 1 | 4 | 0 |
| 2 | `AbortSignal` in `get()`, `useQuery`, local palette groups rendering per keystroke, the settled status line, Home/End/Page keys | W 0.5, F1 2 | 2.5 | 0 |
| 3 | Flows cursor: `before`, `since`, `addr`, `hash`, `height`, `next`, head-only count, `flows_hash`, cache params, the `?page=` fallback; `Pager` in cursor mode and the date jump on the screen | W 2, S5 1.5, F3 1.5 (Pager, both modes) | 5 | 0 |
| 4 | Holders totals: migration part 1 with triggers and backfill (proved on the stand-in, then `--local`, then `--remote` off-peak), `holders_total` / `holders_stake`, the route on the index with `page` and `after`, counts in kv written by the tick, `categories`, `min`/`max`, overview and seo counts from kv, `rankTotal`; numbered pages (First ‹ page field › Last on every screen size), Go to rank, size | W 3 (after the other build merges), S5 2, S7 0.5 | 5.5 | 0, 3, the holders/cron build |
| 5 | `labels_fts` with triggers and the LIKE fallback, `/api/search` groups with `asOf`, SEARCH_LIMITER, `/api/search` at the edge; palette groups, ranking tiers, recents, scope prefixes, ARIA | W 2, F1 3 | 5 | 2 |
| 6 | The grammar (pure, tested), the list fields parsing it into chips and parameters, "Lists" rows in the palette, `/` focusing the list field, `?` and the Keys sheet, row keys (`j k Enter o Home End [ ]`) | W 1.5, F3 1, S5 1.5, F1 1, F4 1 | 6 | 1, 3, 4 |
| 7 | Sticky count line and chip strip on phones, back to top, sortable sticky heads with `aria-sort` on desktop, `aria-rowcount` / `aria-rowindex`, focus moves after Load more and page changes, the refresh `Notice` | F4 1.5, S5 1, F3 0.5 | 3 | 1, 4 |
| 8 | Tests, audits and the production measurements of section 6, the header field-button, shots into `docs/design/shots/` | W 2, S5 1.5, F1 1.5 | 5 | each step |
| | | | **37** | |

Ship order: steps 1 and 2 can go to production first (no API change; sharing and cancellation at once), then 3, then 4 as its own deploy with the migration (watch the D1 write figure for a day), then 5, 6 and 7 together, 8 throughout. Each deploy keeps old links working: `?page=` on flows for one release, `nt.recentAddr` read once and migrated into `nt.recent`, a client that meets a server without `next` falls back to offset pages.

---

## Appendix: the owner's question about running a Namada node, as far as this plan can answer it

Everything measured slow here is time inside Cloudflare D1 (the union sort, `LIKE` scans, offset walks), not time waiting on a Namada node: the list, search and export routes read only the database, and the chain is read by the cron and by `/api/address` (a live balance and delegation read with an 8 s per-node and 12 s total limit before it uses the stored reading). A self-run node would therefore not make paging or search faster, and nothing in this plan gets cheaper or dearer with one.

Where a node does bear: the uncommitted bulk-index build reads every NAM balance (11.98 MB) once an hour and every bond (5.37 MB) every 40 minutes from public nodes, about 481 MB a day across them, with a 20 s timeout and one attempt per node, and the block follower keeps moved addresses current in between. That cadence is set by what public nodes will bear, and a listing that fails leaves the index on the previous one. An own node would make those listings independent of other people's rate limits and goodwill and could run them every few minutes (fresher balances, fresher stakes, ranks that move sooner), and it would make `/api/address`'s live read answer from a node that is never busy with someone else. It would not change a single page or search time measured here. Judge it on freshness, coverage and independence, with the numbers the bulk-index build writes into its health rows (`Namada RPC (balance listing)`, `(bond listing)`: time, bytes, provider, failures), after this plan's query changes are in.
