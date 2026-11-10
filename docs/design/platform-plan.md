# The platform plan: from a good tracker to a platform others build on

Owner, 2026-11-09: "Lets plan it and do it all, push it", after a review of the live site named seven gaps. This
is the plan that answer becomes. It adds to `screener-plan.md` (what the pages show) and `nav-search-plan.md` (how
they are found); it changes neither.

## 1. What is already there, so it is not built twice

Found by reading `integration` at c097f94 before planning:

- The series writers of `screener-plan.md` section 5 already store `flow_edges_daily`, `activity_daily`,
  `validator_daily`, `holder_cohorts_daily` and `unbond_queue` every day. No page reads the first three. The work
  is to serve and draw them, not to collect them.
- `/api/health`, `/api/integrity` and the Sources sheet already say what is failing. There is no page with an
  address of its own that says it.
- `worker/src/http.ts` `CACHE_PARAMS` already lists every public read route with the parameters it reads. The
  API reference is written against that list and a test keeps the two equal.
- The watchlist, seven alert rules, three channels, the digest and the wallet sign-in exist.

## 2. Rules every release keeps

The owner's standing decisions (`owner-decisions.md`) hold: no analytics beacon (5), six tabs and no seventh
(screener-plan 4.1), yellow kept (12), descriptive only, no trade is ever made for a reader, no node. Plain public
facts only. No figure is typed into copy; a reading that failed is said to be missing; every new number has a
source and a time.

Each release is one commit on the public line: typecheck, copy lint, build, the full test run, then an independent
review, then `scripts/deploy-check.sh` from a clean checkout with its smoke lines for the new routes.

## 3. The releases, in order

### A. The API as a product, and the pages a platform is expected to have

- `shared/api-catalog.ts`: the documented read routes, each with what it answers, each parameter and each
  top-level field of its answer. The field lists are typed against the answer's own type (`satisfies Record<keyof T, string>`),
  so a field added or renamed without its line fails the typecheck. A test holds the parameters equal to
  `CACHE_PARAMS`.
- `/developers` ("API"): the reference drawn from that catalog, the per-address limits as the Worker is
  configured with them, and how a stamp (`prov`) is read. `/openapi.json`: the same catalog as an OpenAPI document.
- `/status`: the cross-checks and the sources as `/api/integrity` gives them, and the last completed tick, on a
  page with an address.
- `/methodology`: what each headline figure is, where it is read and how often.
- `/privacy` and `/terms`: what the site stores and does not, in the words the Settings page and the footer
  already use; what the site is and is not.
- The footer's "API" link goes to `/developers`; `llms.txt` lists the new pages.

### B. Every bridge, not only Osmosis

The bridge account holds NAM for every chain Namada has a channel to; the site reads Osmosis only, and its own
cross-check says so. Read the chain's channels and what each holds, show them as one table, and let the bridge
check compare the account's balance with the sum over every channel.

### C. The views on the stored days

- Where NAM moved: `flow_edges_daily` as a flow map between the groups the Home bar already names.
- Validators: `validator_daily` as a table (stake, share, delegators, commission, state) with how few validators
  hold a third and two thirds of the stake, and a page per validator.
- Who was active: `activity_daily` as two series on Activity.
- Votes and public funding: the proposals the site already reads, on a page of their own.

### D. Feeds others can read

Tickers and pairs for the NAM pools, and the shielded pool's balances, in the shapes the price and value
aggregators read. Submitting a feed to a third party stays the owner's step.

### E. Trade and Home on a phone

The cut the depth page got (decision 34): one evidence band at a time under the answer, and every control at
least 44 px tall.

### F. My NAM

For a signed-in wallet: its stake by validator, its unstaking with the day each part unlocks, and alerts on its
own events. Browser notifications as a fourth place alerts can go.

### G. Questions answered by a link, and other languages

The Ask chat answers with a link to the list or page that holds the figure. Home and the guides in other
languages, each checked by a second reading. The chat's flag stays the owner's to turn on.

## 4. What stays the owner's

Turning on the Ask chat; submitting feeds to third parties; the list of languages; the wording of `/terms`.
