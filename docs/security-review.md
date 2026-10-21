# Security review before going public (2026-10-19)

**Verdict: the site is fit to go live with this commit.** No secret is committed or exposed, the wallet sign-in proves control of the exact address it claims, nothing lets an outsider write data or read another user's settings, and the client renders every outside string as text. What the review found was almost all abuse surface: ways to make the site do expensive work, flood its tables, swap a visitor's session through a link, stall the live block scan, or post hostile text into Discord. Every finding in the must-fix tier is fixed in this commit, with a test for each where a unit test is feasible (`test/security-review.test.ts`), and E1 in the commit that followed the same day; the rest are listed as accepted, with the reason.

**Nothing needs rotating.** The Keplr key, the Discord webhook and the settings key were never committed (history and tree scanned); the only key-shaped strings in the repository are the identifier `keplr_rest` and protobuf transaction bytes in fixtures.

## How the review was done

Five reviewers read the whole deployable surface, one dimension each (authentication and sessions; injection; abuse and denial of service, including hostile chain bytes in the hand-written borsh reader; client side; secrets, configuration, headers and data integrity). Twenty-two skeptics then tried to refute each finding that would lead to a change, re-rated it for a public site, and critiqued the proposed fix; several fixes below are the skeptics' corrections (for example, the first fix for `HEAD` would have let an attacker store an empty body in the edge cache). Probes ran against the real Hono app over the in-memory D1 stand-in, and, for the cache rules, against the live site with six requests to the cheapest route.

Severity is as re-rated after verification. "Where" names the code as it was before the fix; the fix column names the code as it is now.

## Must-fix findings, all fixed

| Id | Severity | Finding |
|---|---|---|
| A1 | high | `POST /api/auth/nonce` stored any string that started with `tnam1`/`osmo1`, of any length, one D1 row per call, with no body cap and no rate limit |
| C6 | high | Five hundred free sign-ins with a 1 NAM threshold turned every move into hundreds of sequential webhook posts inside the block scan |
| C14 | high | Rewound reads (`?at=`), alert windows (`?since=`), metric histories and searched holder lists each miss the edge cache on every distinct value, with no limit |
| E2 | high | Any signed-in wallet could tag every holder with free text, links included, with no cap and no rate limit |
| A2 | medium | Opening `/alerts?pair=CODE` claimed the pairing code on page load: a link signed the visitor's browser into the link maker's account |
| C2 | medium | `/api/quote` was neither cached nor limited and cost 2 to 5 Osmosis quote-service calls per request; an impossible size gave a 500 |
| C3 | medium | `/api/intel?refresh=true` let any visitor make the forum and the indexer answer (up to 18 outbound requests) |
| C7 | medium | A block whose events or rows could not be fetched or written was skipped for good; three node shapes threw out of the parsers |
| C8 | medium | The live scan read the head from one node only: that node down stopped both chains' indexing |
| C9 | medium | The live scan's block reads waited up to 90 s on a hung node before asking the other |
| C10 | medium | The live feed accepted every socket, without a cap, and answered any message |
| B1 | medium | Forum posts, proposals, labels and bridge receiver strings reached Discord as live markdown, with no `allowed_mentions` |
| E1 | medium | A bridge send linked its sender to any receiver at send time; a send with a one-second timeout to a victim's real address is refunded, yet linked the sender to the victim, each attempt with a fresh hash (fixed the same day, in the commit after the review) |
| C1 | low | The edge cache and the heavy-request limiter could be slipped past with an `Authorization` header, `HEAD`, or a percent-encoded path |
| A3 | low | Sign-in asked the indexer before checking the signature |
| A4 | low | A nonce or pair code read-then-deleted let two concurrent uses both succeed |
| A5 | low | Pair codes: a new code never retired the old; a colliding draw overwrote another device's code |
| A6 | low | A JSON body of `null` gave a 500 on every JSON route |
| B4 | low | `?page=` past int64 gave an uncaught D1 error (500) |
| A13 | low | The browser signed whatever message the server returned |
| HYG | low | API answers lacked `nosniff` and `no-store`; `HttpError` kept the unredacted Keplr URL; alert claim rows were never swept; a line break in a value could split a generated .sql file; a refused token stayed in the browser; two client nits |

### A1. Nonce rows, request bodies, address shape, rate limits on writes

- **Where:** `worker/src/api.ts` nonce route (was line 548), `worker/src/auth.ts:41` issueNonce, `worker/src/util.ts:139` chainOf (`{38,}` / `{40,}`, no upper bound), `worker/src/http.ts:46` isHeavy (GET paths only).
- **Exploit:** `POST /api/auth/nonce` with `{"address":"tnam1"+"q"×1,900,000}` repeatedly. Each call wrote a 1.9 MB row that lived five minutes; under 20 requests a second filled a 10 GB database in minutes, after which every write (block scan, sessions, settings) failed. A reviewer stored a 1.5 MB row in-process. Any POST body up to the platform's 100 MB was read and parsed.
- **Fix:** `hono/body-limit` caps every `/api/*` body at 16 KB with a JSON 413 (`api.ts` MAX_BODY_BYTES); `chainOf` bounds the length at 80; the nonce route accepts only a `chainOf` shape; `rateLimited()` now also covers every write (`POST /api/auth/*`, `POST /api/labels`, every `/api/me/*` write), 30 a minute per client address and path family (`http.ts` isHeavy).
- **Tests:** `A1/A6` block.

### C6. Alert fan-out as an amplifier that stalls the block scan

- **Where:** `worker/src/sources/discord.ts:228-241` (sequential posts, 8 s each), `worker/src/settings.ts:109` allDeliverable (full scan + decrypt per move), `worker/src/live-hub.ts:275-286` (inside the per-block loop, before the cursor write).
- **Exploit:** sign-in is free (any locally generated key). Register 500 wallets, each with a Discord webhook URL that need not exist and every rule at the 1 NAM floor: every move of 10 NAM or more then posted 500 times, one after another, inside the scan; at ~150 ms per answer that is 75 s per move, at the 8 s timeout 67 minutes, during which the scan, the price broadcast and the Osmosis catch-up search waited, and after 50 blocks of lag blocks were dropped. The reviewer probed the full path.
- **Fix:** one post per webhook per move, six at a time, all started within 15 s or counted as skipped in kv `alerts.skipped` (shown by the cron health view); a webhook that fails three times in a row is left alone for ten minutes; settings are read at most once per 15 s; the Namada fan-out runs after the cursor is written (`live-hub.ts` scanNamada), so a slow webhook holds up alerts, never the scan; sign-in and settings writes are rate limited (A1). The claim that dedupes a move still happens before any post.
- **Behaviour change to know:** a change to alert settings takes effect within 15 s; two logins of one person on one channel get one post per move instead of two.
- **Tests:** `B1/C6` block.

### C14. Cache busting through keyed parameters

- **Where:** `worker/src/http.ts:13-27` CACHE_PARAMS; `worker/src/api.ts` asOfParam accepts any millisecond.
- **Exploit:** `/api/overview?at=1`, `?at=2`, … each a cache miss running ~25 D1 statements including two full holder scans; `/api/metrics/history?hours=9600&at=N` a range of up to half a million metric rows; `/api/holders?search=<random>` two scans of the holders∪stakes union (the flows search was already limited, the holders search was not). D1 bills per row read.
- **Fix:** a second rate-limit binding `REPLAY_LIMITER` (120 a minute per address and path family, `wrangler.jsonc`) applied to any read carrying `at` or `since` and to `/api/metrics/history`, counted on cache misses only (`http.ts` replayLimited); `/api/holders?search=` joins the heavy limiter. The rewind control issues about six keyed requests per position, so the budget is twenty positions a minute per family. Without the binding (local dev, tests) nothing is limited.
- **Note for the operator:** `wrangler deploy` creates the binding from `wrangler.jsonc`; a zone WAF rate rule on `/api/*` would count before the Worker runs and is worth adding as well.
- **Review 3 (2026-10-20), keys no page asks for:** `/api/series` exempted any `from`/`to` shaped as a day, so any of 10^5 day pairs was an unlimited miss that read the series' whole history (46,772 rows, 64 ms for the pool price on production); values the routes ignore or read loosely (`count=<anything>`, `chain=zz`, `whale=t1`, `arb=f1`, `pairs=x`, `page=-5`, `page=0.3`, `by=r1`, `chain=all%20`, `/api/series/trades?limit=-1`) were each a cache entry of their own, about 55,000 to 110,000 flow rows per miss, with no limit. Fix: a series `from` must be one of the days the Trade page sends today (30, 90, 365, 1,200 and 14 days back, and the day either side) and any `to` is limited (`http.ts` seriesFromDays); the tape's `limit` other than the page's 60 and a `page` spelled other than `1` are limited; a chain, switch, sort or `count` spelled other than the app sends it is refused with a 400 (never cached).
- **Review 3, Object's own members:** `?category=__proto__` and `?category=constructor` read `Object.prototype` from the stored counts (a malformed `total`, a walk of the whole holder index) and `/holders?what=constructor` printed Object's source as a chip; the counts are read by own key only and the link's category refuses those names.

### E2. User tags

- **Where:** `worker/src/api.ts` labels route (was lines 800-823).
- **Exploit:** one free wallet tagged every one of the ~3,600 holders in minutes (a reviewer made 604 tags in 35 ms) with text such as "Binance hot wallet" or "claim airdrop https://…", shown as typed in the holder list, the flow lists, the address sheet and search, with only a "Tag by tnam1…" byline; a tag on a new pool contract blocked the curated pool label for good.
- **Fix:** a wallet may hold 200 tags; the site takes 500 new tags a day (editing one's own tag is never counted); labels and notes that read as links (`://`, `www.`, `domain/`) or hold control or format characters are refused with plain words; protocol accounts cannot be tagged; the route is rate limited (A1). Curated-versus-user precedence stays a policy item (below).
- **Tests:** `E2` block.

### A2. Login CSRF through a pairing link

- **Where:** `web/src/screens/sheets/SignInSheet.tsx:44-47` (auto-claim on mount), `web/src/app/overlays.tsx:143-154`.
- **Exploit:** an attacker signs in with a throwaway wallet, makes a code, and posts `https://namada.trade/alerts?pair=CODE`. A visitor who opens it is silently signed in as the attacker; their own token is dropped from the browser (and stays valid server-side); the watchlist or webhook they then save lands in the attacker's account, where `GET /api/me/settings` reads it.
- **Fix:** the sheet opens on the code step with the code filled in and claims it only when Pair is pressed; a browser that is already signed in is told so. Server unchanged. The e2e spec (`web/e2e/sheets.spec.ts`) now presses Pair first; Playwright was not run here.
- **Behaviour change to know:** the QR flow needs one tap on the phone.

### C2. Quote amplification

- **Where:** `worker/src/api.ts` quote route (was line 401), `worker/src/sources/sqs.ts:130-138`.
- **Exploit:** each request cost a price call plus 1 (sell) or up to 4 (buy) router calls; the 10 s memo keyed on the rounded amount, so `amount=1000,1001,…` were all fresh; the quote service rate-limits the Worker's egress address, which also takes the price away from the overview, the live feed, the cron and the size table. `amount=1e303` reached `BigInt(Infinity)` and gave a 500.
- **Fix:** `/api/quote` joins the heavy limiter (its own bucket; the Trade page debounces and refreshes every 30 s, far under 30 a minute); sizes above one trillion NAM and an unknown side are refused with a 400 before any call.

### C3. Public refetch button

- **Where:** `worker/src/api.ts` intel route (was lines 503-512).
- **Fix:** the route serves the copy the cron keeps every minute, whatever its age (the copy carries its own fetch time), and reads live only when there is no copy at all; `refresh` is gone (the web app never sent it).

### C7. Blocks skipped for good; parser shape faults

- **Where:** `worker/src/live-hub.ts:244-296` (a failed block_results, a failed D1 write or any parser exception logged and then `done = h`), `worker/src/parse/namada-unbond.ts:51-56`, `worker/src/parse/namada.ts:46`.
- **Effect:** a block the nodes could not serve this tick, or a D1 error mid-write, was passed over and the coverage stamp said it was scanned; a `tx/applied` event whose `batch` attribute is `null`, a `changed_keys` that is not an array, or an event without attributes threw out of the parser and lost the block. A reviewer reproduced all three through the real alarm.
- **Fix:** `scanNamada()` leaves the cursor below a block whose time, events or tx bytes could not be fetched or whose rows could not be written (next tick retries); a block this parser cannot read as a block is recorded in kv `namada.scan` and shown by the cron health view ("Namada RPC (live block scan)"), as is the range jumped when the scan falls more than 50 blocks behind; the parsers read every unexpected shape as "nothing here". Known residue: a write that fails after an earlier 80-statement chunk committed will, on retry, add the committed chunk's link counts again (only a block with more than 80 statements; links are the one non-idempotent statement).
- **Tests:** `C7` block (parsers); the alarm itself cannot run under Vitest (it imports `cloudflare:workers`).

### C8, C9. Live scan reads

- **Where:** `worker/src/live-hub.ts:221` (`namadaStatus()` on the first node only), `worker/src/sources/namada.ts:33-64` (15 s and 30 s timeouts, three attempts a node, the first node always first).
- **Fix:** `namadaStatusAny()` takes the head from the first node that answers; the scan's reads use one 10 s attempt per node with a per-tick breaker that asks the nodes that failed last (the pattern the cron already used); an answer without the expected shape counts as no answer and the next node is asked (`rpcRead`). Scripts keep the patient defaults. The Osmosis side of the alarm now runs whatever happens to the Namada side.
- **Tests:** `C8/C9` block.

### C10. Live feed admission

- **Where:** `worker/src/index.ts:31-35`, `worker/src/live-hub.ts:452-484`.
- **Fix:** at most 1,000 sockets (about 0.3 MB each measured locally) and 16 per client address (`worker/src/ws-admit.ts`; 503 and 429 with `Retry-After`); a client that sends anything but `ping` is disconnected; a non-upgrade request to `/ws` is answered 426 in the Worker, never by the Durable Object. The browser client sends nothing, so nothing changes for it.
- **Tests:** `C10` block.

### B1. Discord content

- **Where:** `worker/src/sources/discord.ts` (excerpts, display names, abstracts and labels interpolated raw; address slices inside backticks).
- **Exploit:** a forum reply "Claim your NAM: [namada.trade/claim](https://evil.tld)" (new accounts may post two links) reached the operator's channel and every user with forum alerts as a rendered masked link; a bridge receiver string with a backtick closed the code span. Mentions never notified (embeds do not ping), so `allowed_mentions` is defence in depth.
- **Fix:** every body carries `allowed_mentions: { parse: [] }`; outsiders' text goes through `plainMd` at the sink ("](" becomes "] (", so no masked link survives, and the public `/api/intel` text is untouched); address slices lose backticks and line breaks, and a party that is not an address is marked "(not an address)".
- **Tests:** `B1/C6` block.

### E1. Links from the receiving side only (fixed 2026-10-19, the commit after the review)

- **Where:** `worker/src/parse/osmosis.ts` `ibc_transfer` branch (was line 230), `worker/src/parse/namada.ts` packet pairing (was lines 291-296), `scripts/backfill-history.ts` namada step (the link rule).
- **Exploit:** An IBC send was recorded, linked and alerted when it was sent. A send to a victim's real address with a one-second timeout is refunded by the chain, yet it wrote an `address_links` row joining the sender's `osmo1` to the victim's `tnam1` (or the other way round from Namada), each attempt under a fresh hash, for the cost of a fee. The checksum guard from the review stopped garbage strings, not real addresses.
- **Fix:** A link is created only from the receiving chain's record of a crossing, the record that exists only when NAM arrived: on Osmosis the `recv_packet` whose `fungible_token_packet` says `success`, on Namada the `ibc_in` transfer (escrow to account) paired with its `recv_packet`. Both keep the checksum guard, and the Namada side never names the shielded pool. A send still writes its `ibc_out` flow and its alert (the send did happen; the alert key dedupes the same amount within ten minutes), and no link. The history backfill's link rule counts `ibc_in` rows only. What a row now means: this `osmo1` address and this `tnam1` address are the two ends of a crossing that completed; `transfers` and `volume_num` count completed crossings.
- **Rebuild, once, by the owner:** the existing rows counted each crossing twice (once from the send, once from the receive) and hold sender-chosen pairs. After deploying this commit, run `npm run db:apply -- scripts/rebuild-address-links.sql`: it empties `address_links` and refills it from `flows WHERE kind='ibc_in'` with the parsers' rule; it is safe to run again, and its header gives the count query to record before and after. It was not run as part of this change.
- **Rebuild run on 2026-10-20** right after deploying version `bbb9c567`: `address_links` went from 252 rows (1,074 transfers, 181,467,889 NAM) to 114 rows (590 transfers, 147,466,838 NAM), each completed crossing counted once. The first attempt failed because `scripts/d1-apply.ts` passed the file's leading comment lines to `wrangler --command`, whose option parser read the `--`; the script now drops comment-only lines.
- **Tests:** `test/parsers.test.ts`: the send fixtures (Osmosis `ibc_transfer`, Namada `ibc_out`), a timed-out send, a send to a garbage receiver and a refused receive link nothing; the receive fixtures link exactly once.

### C1. Cache and limiter bypasses

- **Where:** `worker/src/http.ts:46-47, :86, :89`.
- **Exploit:** confirmed live on the cheapest route: `GET /api/alerts/rules` with any `Authorization` header, `HEAD`, and `GET /api/%61lerts/rules` all came back uncached, while a plain second GET was a cache hit. The router matches the decoded path and the rules saw the raw one, so `/api/%73earch` and `/api/%61ddress/…` ran with no limit either. Rated low because `?at=` already busted the cache (C14) and the limiter is per address; fixed because the fix is small.
- **Fix:** a `/api/` path with a percent sign is not found; `HEAD` is answered from the GET's own cache entry with no body (the first proposal, to cache HEAD itself, would have let one HEAD every 15 s store an empty body for every visitor); an `Authorization` header no longer skips the cache (no cached route reads a session, and a test now pins that).
- **Review 3 (2026-10-20), percent-encoded parameter names:** the key and the limiters read the query with `URLSearchParams` (names decoded, first occurrence), the routes with Hono's `c.req.query` (the first literal `name=`, encoded names skipped). `?%6bind=sell&kind=buy` was keyed and limited as `kind=sell` and answered as `kind=buy`: one request every 15 s stored a false list under the visitors' key (confirmed live on `/api/alerts/rules`, `cf-cache-status: HIT` with the attacker's value) and slipped past every `get()`-based limit (search, page, size, series day). Fix: a query whose parameter names carry a `%` is not found (`http.ts` hasEncodedName), and a cacheable route now runs on the key's own URL, so it reads exactly the parameters the key holds, each once, as the key decoded them.
- **Tests:** `C1` block; `C1/C14 (review 3)` block.

### A3, A4, A5, A6, B4, A13

- **A3** (`auth.ts:88-100`): the signature is checked before the indexer is asked, and the indexer read is one 3 s attempt; a garbage signature costs no outside call. The auth tests no longer reach the live indexer.
- **A4** (`auth.ts:48-52, 289-291`): a nonce or pair code is read, then deleted, and only the caller whose delete removed the row goes on (two logins racing on one nonce yield one session; tested).
- **A5** (`auth.ts:278-293`): making a code retires the device's earlier codes; the row is inserted with `INSERT OR IGNORE` and a colliding draw is drawn again (three tries, then a plain 503), so another device's live code is never overwritten; the claim route shares the sign-in rate limit.
- **A6**: every JSON route reads its body through `jsonObject()` (`null`, arrays, bad JSON read as `{}`); `app.onError` answers every failure in the API's JSON shape.
- **B4**: `?page=` above 100,000 is refused with a 400 (the offset must stay an integer SQLite accepts).
- **A13**: `shared/login.ts` holds the sign-in message; the browser refuses to sign anything but that exact message for a valid address and nonce.

### HYG

- `HttpError` redacts the URL it keeps (a logged error object no longer carries the Keplr key).
- Every API answer is `nosniff`; every answer that is not a public cached read is `Cache-Control: no-store`; robots.txt, sitemap.xml and the asset 404 carry the site headers too.
- Alert claim rows older than 30 days are swept; the sweeps use key ranges the primary key answers instead of `LIKE` prefixes that scanned the table (session and user lookups too).
- A value with a line break is written to generated .sql as a `char(10)` concatenation (same bytes; `scripts/d1-apply.ts` splits on `;` + newline); `scripts/task-tests.ts` only interpolates bech32-shaped addresses.
- A 401 clears the stored token and signs the app out (`nt:session-ended`); the address path and explorer links are URL-encoded; the settings hash is decoded inside a try.

## Accepted, with the reason

| Id | Severity | Finding | Why accepted |
|---|---|---|---|
| A8 | medium (dormant) | The `ACCESS_AUD` middleware checks that the `Cf-Access-Jwt-Assertion` header is present, never that it is valid (`api.ts:41-48`) | Unset in production and inert when unset. Access itself is enforced at Cloudflare's edge before the Worker; the check adds nothing on hosts Access does not cover. The comments now say exactly that; never enable it as a sign-in gate. |
| D3 | low | The `workers.dev` origin serves the whole app (no `workers_dev: false`) | Kept for previews by the owner's decision in `index.ts`; same D1, bearer tokens scoped to that origin, no HSTS there (the zone is preloaded). Set `"workers_dev": false` or redirect it when previews are no longer needed. |
| C11 | low | The cron's quote-service reads ignore the tick deadline, and a D1 error mid-tick skips the later phases (`cron.ts:328-343`) | Bounded by the 90 s lock; a later tick repeats the work. Worth threading the tick signal into `sqsGet` in a follow-up. |
| C13 | low | The Osmosis catch-up search can run for minutes after an outage (up to 800 transactions, a `/block` read each) | A cap would spread the catch-up over more sweeps; the alarm is single-flight and the clamp bounds the loss. |
| E2 policy | low | A user tag on an address blocks a later curated label for it, and the owner has no removal tool | Policy. Before launch, keep this statement at hand for `wrangler d1 execute --remote`: `DELETE FROM labels WHERE source='user' AND author=?`. |
| A9 | info | An API key may delete the account and revoke sessions (only pairing and key minting are session-only) | **Changed 2026-10-21:** a leaked key could end each device session its owner signed in with and so keep the owner from revoking it. A key can now end API keys only, and deleting the account needs a signed-in device (`FULL_SESSION_ONLY` in `worker/src/api.ts`). |
| A11 | info | An unknown bearer token costs one delete of the legacy row shape | Intended until one production sweep has run; remove then. |
| A12 | info | The signed message has no site or time binding (a phishing page can relay a freshly signed login within five minutes) | Inherent to signed-message login; the message names the site. Adding `uri:` and `issued at:` lines is a later improvement. |
| D4 | info | `npm audit`: vite, esbuild, vitest and tinypool advisories | Dev tool-chain only; `npm audit --omit=dev` is clean. Both are major upgrades; not a launch blocker. |
| C6 residue | info | `allDeliverable` reads at most 500 users | Logged when reached (`DELIVERABLE_MAX`); raise when the site has that many. |

## Checked and found sound

- Address binding: the implicit address is derived from the key and compared exactly; Keplr's address from the compressed key; a nonce issued for one address fails for another; signature malleability buys nothing with a single-use nonce.
- Sessions: 256-bit tokens, SHA-256 at rest with no token in the row, legacy plaintext rows refused and deleted, expiry per request, revocation scoped by address, API keys cannot pair or mint keys.
- No IDOR: every `/api/me/*` read and write is keyed by the session's address; settings are AES-256-GCM; the webhook URL never leaves the server and must match `https://discord(app).com/api/webhooks/<id>/<token>` (no SSRF).
- SQL: every request value is a bound parameter; dynamic fragments come from whitelists; the JSON `LIKE` rules cannot be satisfied from a string value (`JSON.stringify` escapes the quote); `IN (…)` builders stay under the 100-parameter cap; the search's word conditions too (review 3: 35 or more short words passed it and answered 500; a statement now selects by at most 8 distinct words within the cap, the longest first, and every typed word is still checked on the rows found, `holders.ts` sqlWordKeys); generated .sql cannot escape a literal.
- The borsh reader (`parse/namada-tx.ts`): every read is bounds-checked, hostile lengths throw without allocating, loops end at end of input, the varint loop ends on truncated input; per-section and per-transaction errors are caught.
- Client: no raw-HTML sink, every outside string is a text node, explorer links have fixed prefixes, `safeHttpUrl` admits http(s) only, no open redirect, the token travels only in the `Authorization` header to same-origin paths, CSP is enforced with script hashes, the QR is a PNG data URL.
- Headers: CSP with `frame-ancestors 'none'`, `X-Frame-Options`, Permissions-Policy, HSTS on the custom domain, nosniff, Referrer-Policy; CORS is `*` without credentials, which is right for a public read API with bearer tokens and no cookies.
- Writes: no HTTP route writes flows, holders, metrics, checks, stakes, links, curated labels or `donation.config`; those come from the cron, the Durable Object and the operator's scripts; the HTTP cron trigger is gone; the live feed relays nothing a client sends.
- Secrets: nothing in history or the tree; the Keplr key appears only in URLs built in `config.ts`, and every error message and health note that could carry one goes through `redact()`.

## Before deploying

1. `wrangler deploy` picks up the new `REPLAY_LIMITER` binding; no migration, no secret change.
2. In the dashboard, confirm no Cache Rule marks `namada.trade/api/*` as eligible for cache (the Worker runs first and uses only its own cache), and consider one zone rate-limiting rule on `/api/*`.
3. After the deploy, run the one-time `address_links` rebuild from E1 (`npm run db:apply -- scripts/rebuild-address-links.sql`). Decide the user-tag precedence policy (`E2 policy` below): a one-line change plus a backfill, the owner's call.
4. Run the Playwright suite once before the deploy (`npm run e2e`): the pairing spec changed and was not run here.
