# Can NamadaTrade be a NAM trading front end? (feasibility, 2026-10-18)

Research only. Nothing was built and no code in this repository was changed. Each claim gives its source. Items marked
**(likely)** are inferred from code and were not observed working. Items marked **(unconfirmed)** could not be checked
against a primary source. Effort figures are estimates.

## 1. Verdict

**Yes, mostly.** Once a trader has signed in, NamadaTrade can let them buy and sell NAM and use most of what Namadillo
offers: staking, voting, transfers and bridging. Both wallets will sign for any website, and the code that builds
transactions is in Heliax's public, MIT-licensed SDK.

- **Start with buys and sells on Osmosis, signed in Keplr.** This step needs no WebAssembly and should need no change
  to the page policy. It should also work on phones inside the Keplr app (not tested).
- **Then add selling NAM that sits on Namada.** This needs three things:
  - the Namada SDK running in the page;
  - Namada Keychain, which runs on desktop browsers only;
  - a looser page policy, best kept to a separate trade page or subdomain.
- **Leave Namadillo's own swap and the other shielded features for last.** The swap (from the shielded pool to the
  shielded pool) has not been able to finish on mainnet since Namada v201.0.10 (2026-09-11). The other shielded
  features are heavy: each browser downloads 88.8 MB of proving files.

Your idea of connecting Keplr and Namada Keychain at the same time is right, and Namadillo already does it. It should
be one sign-in plus a second wallet that is connected only when a trade needs it, not two sign-ins. Before the first
button that moves money goes live, get a lawyer's view and put terms and sanctions blocking in place.

> **Fact-check, 2026-10-19 (by hand; the automated fact-check stopped at a usage limit).** Confirmed against primary
> sources: github.com/anoma/namada-interface answers 301 to namada-net/namada-interface; `npm view @namada/sdk` and
> `@namada/sdk-multicore` give MIT, 0.23.1; the v201.0.10 release (2026-09-11) is "Escrow fixes (backport #5036)";
> namada-net/namada@50d247f `crates/tests/src/e2e/ibc_tests.rs` ignores the packet-forward tests because "the IBC VP now
> rejects any state change only the middleware stack can produce"; rpc.namada.net reports v201.0.12; Skip's
> /v2/info/chains lists 85 chains and none is Namada; the Keychain approves connections per origin
> (`apps/extension/src/background/approvals/service.ts` isDomainApproved), and the owner's own Keychain and Keplr
> sign-ins on namada.trade show both wallets already connect to this site. Not re-checked: phone behaviour, sizes of
> the MASP parameter files, and the legal section (not legal advice).

**Short forms used in citations below.**

| Tag | Source |
|---|---|
| NI | github.com/namada-net/namada-interface at commit 98a2ed9 (2026-09-18), the Namadillo and Keychain repository |
| SDKJS | github.com/namada-net/namada-sdkjs at eafd5a8 (2025-12-18), the JavaScript SDK |
| NAM | github.com/namada-net/namada: main at 50d247f (2026-10-07), tag v201.0.12, or b6bf629 (the revision SDKJS pins) |
| OSMO / OFE | github.com/osmosis-labs/osmosis at e4ae1fc / osmosis-labs/osmosis-frontend at 340e357 |
| NT | this repository (this repository) |

Research clones and raw query outputs are under
(local research clones, not published)
(namadillo-source, wallets-sdk, swap-execution, legal-risk).

### Which GitHub is the real Namadillo

- **The real home is github.com/namada-net/namada-interface.** The old address, github.com/anoma/namada-interface,
  redirects there with a 301. The repository holds three apps: Namadillo (apps/namadillo), Namada Keychain
  (apps/extension) and the faucet. It has 129 forks according to `gh api repos/namada-net/namada-interface` (checked
  2026-10-18).
- **The namada-net organisation is not GitHub-verified.** The old anoma organisation is. namada.net links only to
  namada-net (`gh api orgs/namada-net`; namada.net HTML).
- **Latest releases.** Namadillo namadillo@v1.33.2 (2026-09-18) and Keychain extension@v0.10.1 (2026-04-07), per
  `gh release list`.
- **Look-alikes to avoid.** shield-crypto/namadillo and doodleoo3/namada-namadillo on GitHub (not forks, 0 stars;
  `gh search repos namadillo`), and @harish551/namada-sdk on npm (`npm search @namada/sdk`).
- **The official npm packages** are @namada/sdk, @namada/sdk-multicore and @namada/sdk-node. They are published by
  Heliax maintainers (`npm view @namada/sdk`).

## 2. Feature table

Wallets: **K** = Keplr (Osmosis and other Cosmos chains). **NK** = Namada Keychain (Namada; desktop Chrome and Firefox
only).

Effort, for one experienced developer: **S** = up to 3 days, **M** = 1 to 2 weeks, **L** = 3 weeks or more. Efforts
assume the work of earlier rows is already done.

| Feature | Can NamadaTrade offer it? | Wallet(s) | How | Phone | Effort |
|---|---|---|---|---|---|
| **Buy or sell NAM on Osmosis** (USDC or OSMO in or out) | Yes | K | SQS quote (already in NT worker/src/sources/sqs.ts:145), Osmosis `MsgSwapExactAmountIn` or `MsgSplitRouteSwapExactAmountIn`, Keplr `signDirect` or `signAmino`, then `keplr.sendTx` | Yes, in Keplr Mobile's in-app browser (likely) | M |
| **Buy NAM and deliver it to a Namada address** (one Keplr transaction: swap, then IBC transfer to tnam1 over channel-98451) | Yes | K signs; NK only supplies the tnam1 address (or the user pastes it) | Same as above, plus `MsgTransfer` in the same transaction | Yes (likely) | S, on top of the row above |
| **Sell NAM held on Namada** (bridge to the user's osmo1, then swap) | Yes, with caveats: needs the SDK in the page | NK, then K | `sdk.tx.buildIbcTransfer` over channel-1, signed by NK, then the Osmosis swap above | No | L (most of it is the first SDK integration) |
| **One-click transparent swap** through Namada's Osmosis swap contract | Yes, with caveats: no one has seen it work end to end since 2026-09-11 | NK signs; K supplies the osmo1 recovery address | `sdk.tx.buildOsmosisSwap` with a transparent source and recipient | No | M |
| **Namadillo's shielded swap** (shielded pool to shielded pool) | Not practical now. The return leg is rejected on mainnet since v201.0.10 | NK + K | `buildOsmosisSwap` with a shielded source | No | L, and blocked |
| **Account overview and balances (transparent)** | Yes | none (read-only) | indexer.namada.net, as today | Yes | S |
| **Receive (address and QR code)** | Yes | NK or K | Address from the connected wallet | Yes | S |
| **Transparent NAM transfer** | Yes | NK | `buildTransparentTransfer` (single-thread SDK) | No | S |
| **Staking: bond, unbond, redelegate, withdraw, claim rewards** | Yes | NK | `buildBond`, `buildUnbond`, `buildRedelegate`, `buildWithdraw`, `buildClaimRewards` | No | M |
| **Governance: proposals, vote** | Yes | NK | `buildVoteProposal`; proposal data from the indexer | Reading yes, voting no | S to M |
| **IBC deposit from Cosmos chains to a transparent address** | Yes | K | CosmJS `MsgTransfer` with Keplr's signer; chains Namadillo supports: osmosis, cosmoshub, celestia, nyx, stride, neutron, noble | Yes (likely) | M |
| **IBC withdraw from Namada (transparent)** | Yes | NK | `buildIbcTransfer` | No | S, once the SDK is in |
| **Shielded balances and shielded sync** | Yes, with caveats: heavy, and the viewing key lives in the page | NK | `sdk-multicore`, the MASP indexer and 88.8 MB of proving parameters; needs COOP and COEP headers | No | L |
| **Shield, unshield, shielded transfer** | Yes, with caveats | NK | Shielding, Unshielding and Shielded builders in a Web Worker | No | M, after sync |
| **IBC deposit straight into the shielded pool** | Yes, with caveats (see note 1) | K signs; NK supplies the payment address | SDK `generateIbcShieldingMemo`, then a Keplr `MsgTransfer` to the MASP address | No | M |
| **Shielded rewards** | View and estimate only; the SDK has no claim transaction | NK | `shieldedRewards` and `simulateShieldedRewards` | No | S, after sync |
| **History and transaction detail** | Yes, and NT already has most of it | none | NT flows plus the indexer | Yes | S |
| **Settings** (custom RPC, indexer and MASP indexer; MASP reset) | Yes | none | Browser-side settings | Yes | S |
| **Ledger hardware wallet** | Transparent: yes. Shielded: with caveats | NK (Ledger account) | Signing happens in the Keychain. Shielded Ledger actions also call `sdk.initLedger()` (WebUSB) in the page, which NT's `usb=()` policy blocks | No | S, or M for shielded |
| **Alternative: host a rebranded Namadillo on a subdomain** | Yes, but not recommended as the main path | NK + K | Docker image `ghcr.io/namada-net/namadillo` or a static build, plus config.toml | No | M of operations, and you then own its maintenance |

Sources for the table:
- **Namadillo routes:** NI apps/namadillo/src/App/AppRoutes.tsx:66-152 and src/App/routes.ts:1-51.
- **Transaction builders:**
  - NI apps/namadillo/src/atoms/transfer/services.ts:88-105, src/workers/MaspTxWorker.ts:149-257,
    src/atoms/staking/services.ts:38-150 and src/atoms/proposals/functions.ts:403;
  - SDKJS packages/lib/src/tx/tx.ts:69-362.
- **IBC chains:** NI src/atoms/integrations/functions.ts:121-131.
- **Shielded rewards:** NI src/workers/MaspTxWorker.ts:276-307. **Ledger:** NI src/atoms/transfer/services.ts:130,182.
- **NT's `usb=()` policy:** NT worker/src/index.ts:66.
- **Hosting:** NI apps/namadillo/README.md:54-107 and .github/workflows/docker-namadillo.yml:59.
- **Keplr API:** https://unpkg.com/@keplr-wallet/types@0.13.41/build/wallet/keplr.d.ts lines 50-109 and
  https://docs.keplr.app/api/guide/broadcast-tx.
- **Keplr Mobile:** https://docs.keplr.app/api/mobile/deeplink (likely).

**Note 1.** Plain IBC shielding still sits in Namada's main receive path (NAM@50d247f crates/ibc/src/lib.rs:739-763).
Namada's end-to-end test for it is still enabled (NAM@50d247f crates/tests/src/e2e/ibc_tests.rs:139-140, shielding at
:292-322). But NamadaTrade's own data shows no IBC deposit into the shielded pool after 2026-07-03 (local D1 copy,
flows where kind = ibc_in and to_addr = the MASP address). That fits a pause, but it does not prove one. Test it with a
small amount before offering it **(unconfirmed)**.

**Why Namadillo's swap is blocked.** Since PR #5038 (a backport of #5036), merged 2026-09-11 and released in v201.0.10,
Namada's IBC check replays each packet against the bare transfer module. It rejects any packet that needs Namada's
extra receive-side handlers (NAM tag v201.0.12 crates/ibc/src/vp/mod.rs:259-264,355-356;
https://github.com/namada-net/namada/releases/tag/v201.0.10). The swap's return leg and packet forwarding are such
packets.
- **Namada's own tests for these paths are switched off**, until the fixed handlers come back (NAM@50d247f
  crates/tests/src/e2e/ibc_tests.rs:1846,2152,2587,2717). No date is given.
- **Mainnet runs this version.** rpc.namada.net/abci_info reported v201.0.12 at height 8,319,412 (2026-10-18).
- **Namadillo 1.33.2 still shows Swap in its menu** with no switch to turn it off (NI
  apps/namadillo/src/App/Layout/Navigation.tsx:45-47; AppRoutes.tsx:104). Its users may be sending swaps whose output
  then waits in the Osmosis contract **(likely, not observed)**.

## 3. Buy and sell: the recommended path

Every path below is non-custodial: the user's wallet signs and broadcasts. NamadaTrade never holds keys or funds.

**Know the market before you build.** On 2026-10-18 NAM traded at about $0.001006, and the 28 NAM pools on Osmosis held
about $1,817 in total. Pool 3005 held $819 of that. A sale of 10,000 NAM (about $10) returned 9.779312 USDC, a price
impact of -2.73% (https://sqs.osmosis.zone/tokens/prices, /pools and /router/quote, queried 2026-10-18). The trade
screen must show price impact before anything else.

### Step A: buy and sell on Osmosis with Keplr (do first)

1. **Quote.** Use the SQS `/router/quote` call NamadaTrade already makes (NT worker/src/sources/sqs.ts:145), through the
   Worker as today.
2. **Build the transaction:**
   - one route: `MsgSwapExactAmountIn`; split routes: `MsgSplitRouteSwapExactAmountIn`;
   - set `token_out_min_amount` to the quoted amount times (1 - slippage), as the Osmosis app does (OFE
     packages/tx/src/message-composers/complex/swap.ts:100-105,204-211);
   - both messages have Amino names, so Ledger signing works (OSMO
     proto/osmosis/poolmanager/v1beta1/tx.proto:30-31,58-59).
3. **Fees and gas.** NAM is a registered Osmosis fee token, so a user who bridged only NAM can still pay gas
   (https://osmosis-rest.publicnode.com/osmosis/txfees/v1beta1/fee_tokens, 2026-10-18). The account number, sequence
   and gas estimate come from an Osmosis LCD through a same-origin Worker route.
4. **Sign and broadcast.** Keplr `signDirect` or `signAmino`, then `keplr.sendTx(chainId, tx, mode)`. Keplr broadcasts
   from the extension, so the page itself needs no Osmosis connection
   (https://unpkg.com/@keplr-wallet/types@0.13.41/build/wallet/keplr.d.ts lines 50-109). Sign-in already calls
   `enable('osmosis-1')` (NT web/src/lib/auth.ts:74).
5. **Optional "buy and send to Namada".** Add a `MsgTransfer` of the minimum NAM out to the user's tnam1 address over
   Osmosis channel-98451 in the same transaction. The registry contract maps tnam to that channel (Osmosis LCD smart
   query `get_channel_from_chain_pair`, 2026-10-18).

**Signatures:** one, in Keplr.

**If something fails:**
- **Price moved past the minimum out:** the whole transaction fails and nothing moves except the Osmosis gas fee.
- **IBC leg times out:** the NAM is refunded to the osmo1 address. NamadaTrade's data already holds 10 such refunds,
  cause not determined (local D1 copy, flows where meta.ibcTimeoutRefund).

**Unknowns:**
- **Message encoding.** CosmJS's default registry lacks Osmosis messages, so the code needs Osmosis types (osmojs or
  hand-written protobuf). Their size and licence were not checked **(unconfirmed)**.
- **Keplr Mobile.** Whether its in-app browser supports `signDirect` and `sendTx` was not tested **(unconfirmed)**.

Step A needs no WebAssembly. Its only server additions are Worker routes for the account, simulation and quote. So the
current script and connection policy (NT worker/src/http.ts:136-137) and the N9 same-origin test (NT
web/e2e/gates.spec.ts:604) can stay as they are **(likely)**. The copy lines in section 6 still have to change.

### Step B: sell NAM held on Namada (Keychain, then Keplr)

1. **Bridge.** Build an IBC transfer of NAM from the user's tnam1 address to their own osmo1 address over channel-1
   with `sdk.tx.buildIbcTransfer` (SDKJS packages/lib/src/tx/tx.ts:69-362). Sign it with
   `window.namada.getSigner().sign(txs, owner, checksums)`, the call Namadillo uses (NI
   apps/namadillo/src/lib/query.ts:147-175). Broadcast it to the Namada RPC.
2. **Wait.** Wait until the NAM lands on Osmosis. One observed transfer took 10 to 19 seconds (local D1 copy,
   2026-10-15; a single sample).
3. **Swap.** Run Step A with Keplr. If the user wants USDC back on Namada, add a `MsgTransfer`, as in Step A item 5.

**Signatures:** one in the Keychain and one in Keplr.

**If something fails:**
- **The bridge times out:** the SDK's default timeout is 3,600 s, after which the NAM is refunded on Namada (NAM
  crates/sdk/src/tx.rs:2991-2998).
- **The swap step fails or the user walks away:** the NAM sits in the user's own osmo1 wallet, not in any contract.
  Pick up where the user left off by reading the osmo1 balance.

### Step C: one-click transparent swap (only after a small mainnet test)

1. **Build.** `sdk.tx.buildOsmosisSwap` builds one Namada IBC transfer to Namada's Osmosis swap contract
   osmo14q5zmg3fp774kpz2j8c52q7gqjn0dnm3vcj3guqpj4p9xylqpc7s2ezh0h (code 1367). Its memo tells the contract to swap
   and send the output back (NI apps/namadillo/src/App/Swap/hooks/usePerformOsmosisSwapTx.tsx:35-37,150-172).
2. **Use a transparent source and recipient.** The SDK accepts both (SDKJS crate/src/sdk/args.rs:954-958,1280-1286;
   NAM crates/sdk/src/args.rs:694-697). The return packet then carries an empty memo, so today's rule should accept it
   (OSMO x/ibc-hooks/wasm_hook.go:255-271) **(likely)**.
3. **Quote a single route.** Ask SQS with `singleRoute=true`. The contract executes one route only (OSMO
   cosmwasm/contracts/crosschain-swaps/src/msg.rs:66), and Namadillo's quote can be split
   (usePerformOsmosisSwapTx.tsx:146). With a fixed route and minimum, the SDK skips SQS. It still reads an Osmosis LCD,
   whose address can point at a Worker route (NAM crates/sdk/src/rpc.rs:1834-1836; args.rs:599-600).

**Signatures:** one, in the Keychain. Keplr only supplies the osmo1 recovery address.

**If something fails:**
- **The swap fails:** the transfer is refunded to the tnam1 source.
- **Delivery after the swap fails or times out:** the output stays in the contract (a timeout can take up to 7 days)
  until the recovery address sends `{"recover":{}}`, signed in Keplr (OSMO
  cosmwasm/contracts/crosschain-swaps/README.md:97,108-112; cosmwasm/packages/registry/src/registry.rs:62).
- **Unclaimed funds exist today.** The contract held 34 unclaimed recovery entries on 2026-10-18 (Osmosis LCD contract
  state). NamadaTrade should show a "recover" button for them.

**Trust:** the contract and its registry can be upgraded by one key, osmo18st0wqx84av8y6xdlss9d6m2nepyqwj6n3q7js
(Osmosis LCD /cosmwasm/wasm/v1/contract/osmo14q5z...).

### What not to use

- **Skip Go.** It has no Namada chain and no NAM route (https://api.skip.build/v2/info/chains and /v2/fungible/route,
  2026-10-18).
- **Namadillo's shielded swap.** It is blocked; see section 2.

### Pre-sign preview (required for every step)

- **What to show:** amount in, minimum out, price impact, route pool IDs, receiver (contract or address), recovery
  address, timeout, fees, and which wallet will sign.
- **Why the Keychain's screen is not enough:** it leaves the body empty for IBC transfers, including swaps. The
  minimum-out and recovery fields appear only in a raw JSON view (NI
  apps/extension/src/Approvals/Commitment.tsx:136-138).

## 4. Two wallets at once

**Today.** A session holds one address, tnam1 or osmo1, proved by one signature (NT worker/src/auth.ts:23-33,
237-249). The browser keeps one session in localStorage under `nt.session` (NT web/src/lib/auth.ts:23-35).

`Session.linked` is a guess: the counterpart with the most volume in address_links, which comes from IBC packets the
site has seen (NT worker/src/auth.ts:163-169). A deposit address at an exchange, or a relayer, can show up there.

**What Namadillo shows.** One page can hold a Keychain connection and a Keplr connection at the same time. Namadillo
takes the Namada account from the Keychain and lets Keplr sign the Cosmos side (NI
apps/namadillo/src/App/Ibc/IbcTransfer.tsx:56-92; src/atoms/integrations/services.ts:66-104,123-157). The Keychain
lets any approved site connect; it has no list of allowed front ends (NI apps/extension/src/provider/Proxy.ts:16-20;
src/background/approvals/service.ts:281-300). Keplr does not support Namada at all (chainapsis/keplr-chain-registry
has no Namada entry; https://docs.keplr.app/api/intro).

**Recommended changes:**
1. **Keep one sign-in.** The session stays one wallet and still drives alerts and settings. Trading does not need the
   server session, because the wallets sign in the browser.
2. **Connect the second wallet on the trade screen only.** The trade screen calls `window.namada.connect` or
   `keplr.enable` when a step needs it. It keeps the pair (tnam1 and osmo1) in the browser and shows both addresses in
   the ticket header.
3. **Watch for account changes.** Listen for `namada-account-changed`, `namada-connection-revoked` and
   `keplr_keystorechange` (NI packages/types/src/events.ts:4-15). Stop the ticket if the active account changes
   mid-trade.
4. **Never fill a destination from `linked`.** Every receiving address must come from a connected wallet, or be pasted
   and confirmed by the user.
5. **Keep a proven Namada-to-Osmosis link off the server by default.** Users of a privacy chain will not want the site
   to store which tnam1 and osmo1 they own.
   - The wallets note proposed a `POST /api/auth/link` endpoint for later, if joined positions or alerts need it. It
     would issue a nonce, sign a distinct link message and store the result in its own table.
   - The risk note advises against storing the link.
   - My view: build it later, opt-in, labelled "proven by signature", and kept apart from the IBC-seen guess.
6. **Harden the sign-in message before any transaction exists.** It names neither the domain nor the chain (NT
   worker/src/auth.ts:37-38), so a look-alike site could relay a nonce. Add the domain, chain ID and issue time.
7. **If trading moves to a subdomain, each wallet asks for approval again.** Approvals are per origin. namada.trade is
   already approved for users who signed in (NT web/src/lib/auth.ts:58).
8. **Pairing.** Paired phone sessions cannot sign anything. On a phone, only Keplr Mobile can trade (Step A).

## 5. Architecture changes

**Where to put it.** Put trading in its own document, best on its own origin such as `app.namada.trade`, served by the
same Worker.
- **Why.** The policy and isolation headers are fixed when a page document loads. NamadaTrade is a single-page app and
  sets its security headers only on HTML (NT worker/src/index.ts:61-66). A client-side jump from `/` to `/trade` would
  keep the strict policy.
- **What a separate origin adds.** It keeps the read-only site's policy, its N9 test and its privacy line exactly true.
  It also stops a bad dependency in the trade code from reading the `nt.session` token.

**Page policy (CSP)**, on the trade document only:
- **Add `'wasm-unsafe-eval'` to `script-src`** for Steps B and C and anything else on Namada. Without it, WebAssembly
  is blocked (https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/script-src).
  Do not add `'unsafe-eval'`. Step A needs neither.
- **Keep `connect-src` short.** Two choices:
  - **Proxy through the Worker** (recommended). Same-origin routes for the Namada RPC, the indexer, the MASP indexer,
    the Osmosis LCD and SQS keep `connect-src 'self'` and allow failover. Shielded-sync traffic then also passes
    through the Worker.
  - **List exact origins.** These answered cross-origin requests with ACAO `*` on 2026-10-18: rpc.namada.net,
    indexer.namada.net, masp.namada.net, lcd.osmosis.zone, osmosis-rest.publicnode.com and sqs.osmosis.zone
    (`curl -H 'Origin: https://namada.trade'`).
- **Endpoints to avoid:**
  - rpc-namada.5elementsnodes.com allows only its own Namadillo site;
  - rpc.papadritta.com sends no CORS header;
  - the chain registry's default emberstake endpoints did not resolve (`dig @1.1.1.1`, 2026-10-18);
  - the indexer's `/api/v1/chain/rpc-url` returns an internal URL, so set the RPC explicitly.
- **Keep `worker-src 'self'`.** It already allows the SDK's Web Workers, which start from same-origin URLs (SDKJS
  sdk-multicore workerHelpers.js line 98).

**COOP and COEP**, needed only for shielded work:
- **Why they are needed.** The multicore SDK uses shared memory and a thread pool, so the page must be cross-origin
  isolated. Namadillo sends `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless`
  on every response (SDKJS packages/sdk-multicore/src/init.ts:28-35; NI apps/namadillo/netlify.toml:4-5,
  docker/namadillo/nginx.conf:9-11).
- **What to do.** Set them on the trade document and on its JS and worker files.
- **Browser support.** `credentialless` works in Chrome 96+ and Firefox 119+, not Safari (MDN browser-compat-data,
  Cross-Origin-Embedder-Policy.credentialless). That costs little, because the Keychain is listed only for Chrome and
  Firefox (chromewebstore.google.com/detail/namada-keychain/hnebcbhjpeejiclgbohcijljcnjdofek; addons.mozilla.org, slug
  namada-extension).
- **Wallet popups.** Namadillo runs both wallets under COOP `same-origin` (NI docker/namadillo/nginx.conf:9-11), so
  the wallets' popups should keep working **(likely)**.
- **Transparent work needs none of this.** The single-thread `@namada/sdk` has no shared memory (SDKJS
  packages/sdk/src/initInline.ts).

**SDK loading:**
- **Version.** Use `@namada/sdk` 0.23.1 or later, not Namadillo's 0.23.0, for licence reasons (section 6). Import the
  `/inline` entry: the package root fetches `sdk.namada.wasm` by a relative URL, which would break under path routes
  (SDKJS packages/sdk/src/init.ts:29, initInline.ts:3).
- **Build.** Namadillo's Vite build adds node polyfills and sets `global=globalThis` (NI
  apps/namadillo/vite.config.mjs:35-53).
- **Size.** The WASM is 6,283,743 B (2,065,683 B brotli) and its JS glue 117,158 B (jsDelivr file list for
  @namada/sdk@0.23.1). The whole current site is 928 KB (`du -sh web/dist`).
- **Budget.** Load the SDK only on the trade document. The read-only pages must not grow. For comparison, Namadillo's
  live main bundle is 6,196,050 B plus a 4,900,884 B transaction worker (`curl -I https://app.namada.net/assets/*`).

**MASP proving parameters**, shielded only:
- **The files.** Three files, 88,818,132 B in total: spend 49,848,572, convert 22,570,940 and output 16,398,620. The
  SDK checks each file's length and sha256 and keeps them in IndexedDB `Namada::SDK` (SDKJS crate/src/sdk/mod.ts:2-3,
  24-95; NI apps/namadillo/src/hooks/useSdk.tsx:26,40-51).
- **They cannot be Workers static assets.** Those are capped at 25 MiB per file, and the spend file is 47.5 MiB
  (https://developers.cloudflare.com/workers/platform/limits/).
- **Serve them from R2 through a same-origin `/params/*` Worker route.** R2 objects can be up to about 5 TiB
  (https://developers.cloudflare.com/r2/platform/limits/).
- **Other hosts.** app.namada.net/params allows cross-origin requests, but adds a third-party dependency. The SDK's
  default GitHub source cannot be fetched cross-origin (302 with no ACAO).
- **Sync cost.** Sync state is stored per origin, so users re-sync on a new domain (SDKJS
  crate/src/sdk/masp/masp_web.rs:85-93). Namadillo says sync can take a few minutes (NI
  apps/namadillo/src/App/Common/MaspSyncCover.tsx:35). Bandwidth and storage were not measured **(unconfirmed)**.

**Other limits:**
- **Ledger plus shielded** needs WebUSB in the page, so `usb=()` (NT worker/src/index.ts:66) would have to be relaxed
  on the trade origin only.
- **Viewing keys** for shielded accounts reach the page (NI packages/types/src/account.ts:49-62). They must never be
  sent to the Worker, logged or stored server-side.

**What stays read-only.** All current routes, D1, the cron jobs, alerts and the live stream stay as they are. The
Worker never holds keys, never signs, never custodies funds and never stores viewing keys. Its only new jobs are
relaying public chain reads, serving the parameter files and, if chosen, geo and address screening.

## 6. Licence and legal (not legal advice)

**Licences:**
- **Namadillo and the Keychain.** The repository's root LICENSE is Apache-2.0, and the README says all files are
  Apache-2.0 unless stated otherwise (NI LICENSE:1-3; README.md:233). The package.json files say MIT (NI
  apps/namadillo/package.json:7). Treat the code as Apache-2.0.
  - **What reuse requires:** ship the licence, mark changed files and keep existing notices (NI LICENSE section 4,
    lines 94-111). There is no NOTICE file.
  - **What it does not give:** no duty to publish your source, and no right to the Namada or Namadillo names (NI
    LICENSE section 6, lines 138-141).
- **The SDK.** `@namada/sdk`, `sdk-multicore` and `sdk-node` 0.23.1 are MIT on npm.
  - **The Rust libraries** under them moved from GPL-3.0 to MIT on 2025-11-06 (NAM commit 4985431f68; Cargo.toml:62
    at libs-v0.251.3 vs libs-v0.251.4).
  - **0.23.0 was probably built on the GPL revision** (SDKJS commits 9265b6eed4 and 52eddee8e8) **(likely)**, so use
    0.23.1 or later.
  - **The npm tarballs ship no LICENSE file**, so reproduce the MIT notice yourself.
- **Other packages:**
  - **`@namada/chain-registry` 1.5.2 is GPL-3.0.** Do not bundle it into browser code unless you publish your source;
    read the registry JSON at runtime or keep your own channel list.
  - **`@namada/indexer-client` 4.1.3** says "Unlicense" but points to a placeholder repository; calling the indexer
    directly avoids it.
  - **`@cosmjs/stargate` and `@keplr-wallet/types`** are Apache-2.0.
  - **No AGPL code was found** (`npm view` of each).

**Legal picture**, summarised from the risk note. The operator's country decides what applies, and it is not known
here.

**EU:**
- **The MiCA carve-out may not cover you.** MiCA leaves out services provided in a fully decentralised manner, but an
  identifiable operator may not count (CELEX:32023R1114 recital 22).
- **Execution near analytics raises the risk.** Placing or passing on orders and giving personalised recommendations
  are regulated services (Art 3(1)(23), (24)). A trade button beside "who might sell" analytics (NT shared/site.ts:11)
  makes it more likely the site is treated as one.
- **Privacy-coin rules from 10 July 2027.** AMLR Art 79 bars regulated providers from accounts that allow obfuscation
  (CELEX:32024R1624). It binds regulated providers, not non-custodial software.

**US:**
- **Software vs money transmitter.** FinCEN's 2019 guidance treats unhosted-wallet software as outside money
  transmission. Custody, or fees taken on transfers, moves an operator towards it (FIN-2019-G001 sections 4.2.1, 4.4
  and 4.5.1, pp. 16-20).
- **Precedents:**
  - The CFTC fined Uniswap Labs $175,000 as the maker of a web interface
    (https://www.cftc.gov/PressRoom/PressReleases/8961-24).
  - Roman Storm of Tornado Cash was convicted of an unlicensed-transmitter conspiracy in August 2025, with a retrial
    reported for 2027-04-26 (https://decrypt.co/376577/roman-storms-tornado-cash-retrial-pushed-to-april-2027).
- **What other front ends do.** Uniswap screens addresses (https://blog.uniswap.org/trm). dYdX expects third-party
  front ends to geo-block (https://docs.dydx.xyz/interaction/integration/integration-compliance).
- **Namadillo hosts do none of this.** They publish no terms, geo-blocking or screening in Namadillo's code (grep of NI
  apps/namadillo/src).

**Must-haves before launch:**
1. **A lawyer** in the operator's country reviews the plan.
2. **No interface fee and no custody at launch.**
   - Namada's SDK has a front-end fee (`frontend_sus_fee`), but not for transparent IBC or swaps (NAM
     crates/sdk/src/tx.rs:2903-2953; SDKJS crate/src/sdk/args.rs:1274,1305-1306).
   - Osmosis swap messages have no fee field.
3. **Terms of use and a risk notice**, shown before the first signature. Show protocol status too: Namadillo warned
   that the protocol was unsafe from 2026-07-10 to 2026-09-18 (NI PRs #2365 and #2366), and Namada v201.0.9 fixed ZK
   proof validation (https://github.com/namada-net/namada/releases/tag/v201.0.9). The size of the exploit is press-only
   **(unconfirmed)**.
4. **Geo-blocking and screening.** Block comprehensively sanctioned regions using `request.cf.country`
   (https://developers.cloudflare.com/workers/runtime-apis/request/), and screen addresses against OFAC's list.
5. **Rewrite the copy that becomes untrue:**
   - `SITE.disclaimer`, `SITE.quoteNotOrder` and `SITE.privacy` (NT shared/site.ts:13,19,21);
   - the rule that copy never says what to do (NT shared/copy.ts:11);
   - the "Trade" naming decision, which relied on the never-trades line (NT docs/design/brief.md:60).
6. **A conflict-of-interest note.** Whoever runs a trading front end may also trade NAM, and the site sends whale alerts.
7. **The pre-sign preview** from section 3, with a slippage cap and a price-impact warning.
8. **Supply-chain hygiene:**
   - pin exact versions, install with `npm ci` and review dependency diffs;
   - load no CDN scripts;
   - use hardware-key 2FA on Cloudflare, npm and GitHub;
   - deploy from CI rather than a laptop's `npm run deploy` (NT package.json:11);
   - turn on DNSSEC and a CAA record for namada.trade, which has neither (dig DS/CAA, 2026-10-18);
   - review each SDK update by hand: `@namada/sdk` 0.23.1 has no npm provenance attestation (`npm view`).
9. **An independent security review** of the trade code. No note checked for published audits of the SDK or Namadillo
   **(unconfirmed)**.

## 7. Risks and open questions

- **Protocol risk.** A 2026 exploit led Namadillo to show a "not currently safe" banner for ten weeks. Shielded swaps,
  and packet forwarding into Namada, remain switched off with no date given (section 2).
- **Stale SDK.** The last SDK release was 0.23.1 (2025-12-08; beta 0.24.0-beta.2, 2025-12-19), while mainnet runs
  v201.0.12. Compatibility is inferred only from Namadillo 1.33.2 still shipping 0.23.0 **(likely)**.
- **Thin upstream maintenance.** Only 8 commits reached Namadillo's main branch between 2025-12-01 and 2026-10-17, and
  the 1.34.0 release PR (#2349) is still open (`gh api .../commits?since=2025-12-01`). Expect to fix breakages yourself.
- **Thin market.** About $1,817 of NAM liquidity on Osmosis. A trade button adds convenience, not depth. Is that worth
  the legal and security load?
- **Contract trust.** One key can upgrade Namada's Osmosis swap contracts (section 3, Step C).
- **Wallet screens show little.** Users must trust NamadaTrade's preview, so a tampered bundle could set the minimum
  out to zero. The trust roots are the build machine, the Cloudflare account and npm.
- **Phones.** No Namada signing on phones: the Keychain is desktop-only and no mobile Namada wallet is listed
  (https://namada.net/apps). Phones get Osmosis-side trades only, through Keplr Mobile **(likely)**.
- **Endpoint reliability.** The registry's default infrastructure did not resolve, and some RPCs refuse other sites.
  The Worker proxy should fail over between rpc.namada.net and polkachu.
- **Brand and phishing.** A domain registered on 2026-10-17 (whois) that contains "Namada" and asks for signatures can
  look like phishing. No Namada trademark policy was found **(unconfirmed)**.
- **Questions for the owner:**
  1. Which country are you operating from?
  2. Fee or no fee?
  3. `app.namada.trade`, or a separate document on namada.trade?
  4. Will you ever offer shielded features, given the 88.8 MB download and the viewing keys held in the page?
  5. Should the trade app carry a name without "Namada" in it?

## 8. Suggested phases

| Phase | What | Needs | Effort |
|---|---|---|---|
| 0 | Prerequisites: legal review, terms and risk notice, geo and OFAC blocking, a hardened sign-in message, supply-chain and account hardening, choice of origin, rewritten copy | none | M |
| 1 | Step A: Osmosis buy and sell, plus "buy and send to Namada", signed in Keplr; pre-sign preview; Worker routes for the LCD and simulation | Keplr only. No WASM and no policy change on the main site | M |
| 2 | Single-thread Namada SDK on the trade document (`'wasm-unsafe-eval'`, proxied RPC and indexer); Step B (sell from Namada); transparent transfers and IBC withdraw | Keychain, desktop | L |
| 3 | Staking (bond, unbond, redelegate, withdraw, claim) and governance votes | Keychain, desktop | M |
| 4 | Step C, the one-click transparent swap, after a small-amount mainnet test; a "recover stuck funds" helper for the contract | Keychain plus Keplr's recovery address | M |
| 5 (optional) | Shielded: sync, shield and unshield, IBC deposits into the shielded pool (after a test), views of shielded rewards. Needs COOP and COEP, the multicore SDK, R2 `/params/` and viewing-key handling. Shielded swaps only once Namada re-enables them | Keychain, desktop Chrome and Firefox | L |
| Alternative | Host a rebranded Namadillo fork on a subdomain: every feature at once, including the currently broken swap. You inherit maintenance, Apache notices and no page policy | Docker or a static build plus config.toml | M of operations, ongoing |

Phases 1 to 4 together are roughly two to three months of focused work for one developer. That is an estimate, not a
measurement.
