import { explorerHashOf } from '../../shared/flow-rules';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import type { Env } from './util';
import type {
  Overview, Holder, AddressReport, SearchResult, Check, IntelResponse, DonationConfig, SourceHealth, Provenance, Sourced,
  AlertsRecentResponse, HoldersResponse, FlowsResponse, HolderCountsKv, SearchGroup, SearchMatch, SearchResponse, Chain, Flow,
} from '../../shared/types';
import { fetchNamPools, fetchNamPrice, quoteNamTrade, quoteSlippageCurve, priceSourceName } from './sources/sqs';
import { PRICE_HOW_KEY, livePriceProv, priceHowAt, storedPriceNote, storedPriceSource, type PriceHowLog } from './price-how';
import { namBalance, namadaEpoch, delegationsAt, QUICK, type ReadOpts } from './sources/namada';
import { fetchIntel } from './sources/intel';
import { alertsOn, sendDiscordPreview, sendDiscordTestPost, testExample, testPostHeld, INVALID_WINDOW_MS, type TestPostAnswer, type WebhookPost } from './sources/discord';
import { previewPosts } from './digest/deliver';
import { forgetTelegramUsers, sendFollowing, sendsTelegram, tgSend, testMessages, chatGone } from './sources/telegram';
import { createLinkCode, handleUpdate, revokeLinkCode, secretMatches, WEBHOOK_MAX_BYTES } from './telegram-bot';
import { fmtAddr } from '../../shared/format';
import { stmt, TAGS_PER_AUTHOR, TAGS_PER_DAY, kvGet, kvSet, kvGetJson } from './db';
import { toNam, chainOf, publicNote } from './util';
import { OSMOSIS, INTERNAL_LABELS } from './config';
import {
  flowsFilterFromQuery, flowsFilterError, flowsMode, flowsPageSql, flowsRowsSql, flowsCountSql, flowsLastSql, flowOrder, afterPosition,
  FEW_ROWS, FIRST_TS_SQL, HASH_COLUMNS, searchCanMatch, scanFloorSql, type FlowsFilter,
} from './flows-query';
import {
  LIQUID_STALE_MS, BALANCE_LISTING_SRC, BOND_LISTING_SRC, holderStatus, liquidChanges, chunks, listingTimes, confirmedAt,
  holderFigureValues, readHolderCounts, readChainMarks, placeOn, walkCountSql, walkCategorySql, holderPageSql, holderCandidatesSql, holderOrder, holderAfter,
  labelWords, wordKeys, wordCond, labelMatches, labelMatch, SORT_COL, CANDIDATES_MAX, sqlWordKeys, wordCondCost, D1_MAX_PARAMS, HOLDER_CHAINS_OF,
  type ListingTimes, type HolderBaseRow, type HolderChain, type HolderSort, type HolderWalk, type WordKeys,
} from './holders';
import { label_plain, category_plain, labelAuthorShort, tagByline } from './labels';
import { counterpartiesOf, priceAtOf, priceBasisWords, priceHowOf } from '../../shared/flow-rules';
import { settleUsd } from '../../shared/settle';
import {
  FLOW_SELECT, flowSelect, rowToFlow, safeParseJson, provAt, metricAt, coverageOf, pressure, blindSpot, alertsBetween, lastAlertBefore, metricSeries, withSettles, metricSeriesRolled, type HistoryPoint, osmosisNetIbc, orderflowSeries,
} from './analytics';
import { NAM_AMOUNT, NOT_LEGACY_TWIN as NOT_TWIN } from './flows-query';
import { INTERNAL_ADDRESSES } from '../../shared/alerts';
import { alertRules, DEFAULT_THRESHOLDS, type AlertThresholds } from '../../shared/alerts';
import { issueNonce, login, logout, sessionFromRequest, createPairCode, claimPairCode, listSessions, revokeSession, revokeAllSessions, createSession, tokenHash } from './auth';
import { loadSettings, saveSettings, deleteSettings, defaultPrefs, publicView, applyUpdate, requireKey, refusalOf, noteSettingsRefused, hookOkStmt, linkProven, channelsFull, stopChannelStmt, telegramOf, telegramUpdate, telegramChatsOther, unlinkChat, SETTINGS_FULL, CHANNELS_FULL, TELEGRAM_CHATS_MAX, TELEGRAM_FULL, type StoredSettings } from './settings';
import { clampLimit, prefixRange, decodeHolderCursor, encodeHolderCursor, encodeFlowCursor, parseBeforeParam, type HolderCursor, type BeforeParam, type FlowCursor } from '../../shared/paging';
import { parse, isWholeAddress, INPUT_MAX, type Parsed } from '../../shared/search-grammar';
import { EXPLORERS, NAMADA as NAMADA_SHARED } from '../../shared/config';
import { seriesApp } from './api-series';
import { depthApp } from './api-depth';
import { ROLLUP_KEYS } from './series-sql';
import { DAY_HOURS, HISTORY_ALL_DAYS } from '../../shared/history';
import { SINGLE_POOL_USDC_SWAP } from './cron';

/** A check that has not run for this long is served as 'stale': its last result is kept, but it no longer counts as
 *  passing (on 2026-10-19 the supply check kept a green "Passes" for 3.5 h after its source went quiet). */
export const CHECK_STALE_MS = 15 * 60_000;
export const checkOf = (r: any, now: number): Check => ({
  key: r.key, status: now - Number(r.checked_at) > CHECK_STALE_MS ? 'stale' : r.status, title: r.title, detail: safeParseJson(r.detail), checkedAt: r.checked_at,
});

/**
 * The stored source health as an answer may carry it: each note in words safe to publish (util.ts publicNote), so a
 * note stored before probe() wrote them that way, or by a writer that does not, never serves an upstream's answer, a
 * URL or a key.
 */
export const publicSources = (health: Record<string, SourceHealth> | null | undefined): SourceHealth[] =>
  Object.values(health ?? {}).map((h) => (h.note ? { ...h, note: publicNote(h.note) } : h));

export const app = new Hono<{ Bindings: Env }>();

app.use('*', cors());

/** A request body is at most this long (the largest legitimate one, a settings update with a full watchlist, is under 7 KB). */
export const MAX_BODY_BYTES = 16 * 1024;
// A longer body is refused before it is read into memory or parsed.
const apiBodyLimit = bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: 'Request body too large.' }, 413) });
// Telegram's updates have a limit of their own (telegram-bot.ts WEBHOOK_MAX_BYTES): a long message in another script
// is larger than 16 KB as JSON, and an update refused would be sent again.
const webhookBodyLimit = bodyLimit({ maxSize: WEBHOOK_MAX_BYTES, onError: (c) => c.json({ ok: true }) });
app.use('/api/*', (c, next) => (c.req.path === '/api/telegram/webhook' ? webhookBodyLimit(c, next) : apiBodyLimit(c, next)));
// Every failure answers in the API's own JSON shape (the UI parses each answer as JSON), with nothing from the error itself.
app.onError((e, c) => {
  console.error(e);
  return c.json({ error: 'Something went wrong on our side.' }, 500);
});

// Cloudflare Access: a presence check only (the header is never verified against Access's keys). Access itself is
// enforced at Cloudflare's edge before a request reaches this Worker; this check adds nothing on a host Access does
// not cover (workers.dev), so ACCESS_AUD must never be relied on as a sign-in gate (docs/security-review.md A8).
app.use('/api/*', async (c, next) => {
  const aud = c.env.ACCESS_AUD;
  // Telegram's updates carry no Access token; the webhook checks its own secret.
  if (aud && c.req.path !== '/api/telegram/webhook') {
    const jwt = c.req.header('Cf-Access-Jwt-Assertion');
    if (!jwt) return c.json({ error: 'Unauthorized: Cloudflare Access JWT required' }, 401);
  }
  await next();
});

const H = 3600000, D = 86400000;
/** The note on a figure that was not recorded at a rewound time (plain words: the provenance sheet prints it). */
const NOT_RECORDED = 'Not recorded at that time.';

/** `?at=<unix ms>` switches any decision endpoint into replay mode. */
function asOfParam(c: any): { asOf: number; replay: boolean } {
  const raw = c.req.query('at');
  const at = raw ? Number(raw) : NaN;
  const now = Date.now();
  return Number.isFinite(at) && at > 0 && at < now ? { asOf: at, replay: true } : { asOf: now, replay: false };
}

function thresholdsParam(c: any): AlertThresholds {
  const th = { ...DEFAULT_THRESHOLDS };
  for (const k of Object.keys(th) as (keyof AlertThresholds)[]) {
    const v = Number(c.req.query(k));
    if (Number.isFinite(v) && v > 0) th[k] = v;
  }
  return th;
}

/**
 * The JSON object of a request body. Anything else (no body, malformed JSON, `null`, an array) reads as an empty
 * object, which every route then checks field by field: a bad body gets the route's own answer, never a 500.
 */
async function jsonObject(c: any): Promise<Record<string, any>> {
  const v: unknown = await c.req.json().catch(() => null);
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {};
}

/** The last page a list can be asked for: the offset must stay an integer SQLite accepts (beyond is refused, not guessed). */
export const PAGE_MAX = 100_000;
/** `?page=`: 1 by default and for anything that is not a number; above PAGE_MAX the request is refused. */
function pageParam(c: any): number | Response {
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10) || 1);
  return page > PAGE_MAX ? c.json({ error: `page must be between 1 and ${PAGE_MAX.toLocaleString('en-US')}` }, 400) : page;
}

// ---------------------------------------------------------------- GET /api/overview
app.get('/api/overview', async (c) => {
  const db = c.env.DB;
  const { asOf, replay } = asOfParam(c);
  const now = Date.now();
  const dayAgo = asOf - D;

  const [priceLive, poolsLive, checksRes, health] = replay
    ? [null, null, { results: [] as any[] }, null]
    : await Promise.all([
        fetchNamPrice(),
        fetchNamPools(),
        db.prepare('SELECT * FROM checks').all<any>().catch(() => ({ results: [] as any[] })),
        kvGetJson<Record<string, SourceHealth>>(db, 'source.health'),
      ]);

  const checks: Check[] = (checksRes.results || []).map((r: any) => checkOf(r, Date.now()));

  // Latest stored metrics as of `asOf`
  // supply.pos_bonded is the staking account's balance; supply.total_stake is what is staked (the chain's figure).
  const keys = ['price.usd', 'price.swap_1h', 'dex.pool_count', 'supply.total', 'supply.pos_bonded', 'supply.total_stake', 'supply.pgf', 'supply.masp_shielded', 'supply.ibc_escrow', 'supply.osmosis', 'supply.liquid', 'epoch', 'dex.liquidity_usd', 'dex.ref_pool_liquidity_usd'];
  const metricRows = await Promise.all(keys.map((k) => metricAt(db, k, asOf)));
  const m = new Map(keys.map((k, i) => [k, metricRows[i]]));
  const mv = (k: string) => m.get(k)?.value ?? null;
  const mt = (k: string) => m.get(k)?.ts ?? null;

  const MASP = INTERNAL_ADDRESSES.masp;
  // When the chain listings last confirmed every Namada balance and bond: the holder figures are as of then.
  const listed = await listingTimes(db);
  const [osmoStats, netIbc, namadaStats, heights, refPriceRow, cov, holderFig, priceHow] = await Promise.all([
    db.prepare(`SELECT COUNT(*) total_flows,
          SUM(CASE WHEN kind='buy' THEN 1 ELSE 0 END) buys, SUM(CASE WHEN kind='sell' THEN 1 ELSE 0 END) sells,
          SUM(CASE WHEN kind='buy' THEN amount_num ELSE 0 END) buy_nam, SUM(CASE WHEN kind='sell' THEN amount_num ELSE 0 END) sell_nam
         FROM flows INDEXED BY flows_ts WHERE chain='osmosis' AND ts >= ? AND ts < ? AND (meta IS NULL OR meta NOT LIKE '%"arb":true%')`).bind(dayAgo, asOf).first<any>().catch(() => null),

    // Bridged in minus bridged out, sends that timed out and were refunded left out (their NAM never left Osmosis).
    osmosisNetIbc(db, dayAgo, asOf).catch(() => null),
    // Into / out of the shielded pool: shielding, and bridge crossings straight into or out of it; NAM only, each transfer once.
    // The day's range on flows_ts (86 rows read on 2026-10-20): the planner otherwise walks every Namada flow on
    // flows_chain_height (52,463 rows).
    db.prepare(`SELECT COUNT(*) total_flows,
          SUM(CASE WHEN kind='bond' THEN amount_num ELSE 0 END) bonded, SUM(CASE WHEN kind='withdraw' THEN amount_num ELSE 0 END) withdrawn,
          SUM(CASE WHEN kind IN ('shield','ibc_in') AND to_addr = ? AND ${NAM_AMOUNT} THEN amount_num ELSE 0 END) shielded,
          SUM(CASE WHEN kind IN ('unshield','ibc_out') AND from_addr = ? AND ${NAM_AMOUNT} THEN amount_num ELSE 0 END) unshielded
         FROM flows f INDEXED BY flows_ts WHERE chain='namada' AND ts >= ? AND ts < ? AND ${NOT_TWIN}`).bind(MASP, MASP, dayAgo, asOf).first<any>().catch(() => null),
    db.prepare(`SELECT (SELECT MAX(height) FROM flows WHERE chain='osmosis' AND ts <= ?) osmo_h, (SELECT MAX(height) FROM flows WHERE chain='namada' AND ts <= ?) nam_h,
                       (SELECT value FROM kv WHERE key='namada.cursor') nam_cursor`).bind(asOf, asOf).first<any>().catch(() => null),
    db.prepare(`SELECT value FROM metrics WHERE key='price.usd' AND ts >= ? AND ts <= ? ORDER BY ts ASC LIMIT 1`).bind(dayAgo, asOf).first<{ value: number }>().catch(() => null),
    coverageOf(db, asOf, replay),
    // Same definition as the holder list: spendable or staked, protocol and pool accounts excluded. Stored by the
    // cron after each complete listing (holders.ts holderFigureValues, one kv row); the queries only without it.
    holderFigureValues(db, now, listed),
    // how each stored price was read (price-how.ts): the price list, or the route's spot from a time on
    kvGetJson<PriceHowLog>(db, PRICE_HOW_KEY).catch(() => null),
  ]);
  const { counts: holderCounts, top10Osmosis: top10Osmo, top10Namada: top10Nam, dust } = holderFig;

  // Price: live SQS when available; otherwise the last stored value, honestly marked stale. Each names how it was
  // read: the price list ('Osmosis SQS') or the spot of the route the router quotes for 1,000 NAM, with its pools.
  let priceUsd: Sourced<number>;
  if (priceLive?.usd) priceUsd = { value: priceLive.usd, prov: livePriceProv(priceLive) };
  else if (mv('price.usd') != null) {
    // A live fetch just failed: the stored value is at best "old", however recent it is, and the note says why.
    // Rewound: the stored price is the price as of that time (the rewound banner says so; no note needed but the route's).
    const how = priceHowAt(priceHow, mt('price.usd'));
    const source = storedPriceSource(how), routeWords = storedPriceNote(how);
    const base = replay
      ? { source, at: mt('price.usd'), status: 'live' as const, ...(routeWords ? { note: routeWords } : {}) }
      : provAt(source, mt('price.usd'), now, 0, { note: [priceLive?.error ?? 'The live price could not be fetched.', routeWords].filter(Boolean).join(' ') });
    priceUsd = { value: mv('price.usd'), prov: base };
  }
  else priceUsd = { value: null, prov: { source: 'Osmosis SQS', at: null, status: 'missing', note: priceLive?.error ?? 'no price recorded' } };

  const swap1h: Sourced<number> = { value: mv('price.swap_1h'), prov: provAt('executed NAM/USDC swaps (hourly median)', mt('price.swap_1h'), asOf, 6 * H) };
  // Before 2026-10-15 only executed-swap prices exist: in replay, use them as the price rather than show nothing.
  if (replay && priceUsd.value == null && swap1h.value != null) priceUsd = { value: swap1h.value, prov: { ...swap1h.prov, note: 'The quoted price was not recorded at that time, so this is the price real trades paid.' } };
  const change24h = refPriceRow?.value && priceUsd.value ? ((priceUsd.value - refPriceRow.value) / refPriceRow.value) * 100 : null;

  const supplyAt = mt('supply.total');
  // Under Rewind a reading is as of that time (no note); one that was not recorded then says so in plain words.
  const replayProv = (source: string, at: number | null): Provenance => (at ? { source, at, status: 'live' } : { source, at: null, status: 'missing', note: NOT_RECORDED });
  const supplyProv: Provenance = replay ? replayProv('Namada RPC abci_query', supplyAt) : provAt('Namada RPC abci_query', supplyAt, now, 5 * 60000);
  const osmoSupplyProv: Provenance = replay ? replayProv('Keplr Osmosis bank/supply', mt('supply.osmosis')) : provAt('Keplr Osmosis bank/supply', mt('supply.osmosis'), now, 5 * 60000);

  const pools = poolsLive?.pools ?? [];
  const liquidityUsd = pools.length ? pools.reduce((a, p) => a + p.liquidityUsd, 0) : mv('dex.liquidity_usd');
  const refPoolLiquidityUsd = pools.length ? pools.find((p) => p.id === OSMOSIS.refPoolId)?.liquidityUsd ?? null : mv('dex.ref_pool_liquidity_usd');
  const dexProv: Provenance = pools.length
    ? { source: 'Osmosis SQS pools', at: poolsLive!.at, status: 'live' }
    : mv('dex.liquidity_usd') != null
    ? (replay ? replayProv('Osmosis SQS pools (stored)', mt('dex.liquidity_usd')) : provAt('Osmosis SQS pools (stored)', mt('dex.liquidity_usd'), asOf, 10 * 60000, { note: poolsLive?.error }))
    : { source: 'Osmosis SQS pools', at: null, status: 'missing', note: replay ? 'Pool depth was not recorded before 16 Oct 2026.' : poolsLive?.error ?? 'The Osmosis pool list is not answering.' };

  const rpcCheck = checks.find((k) => k.key === 'rpc_consensus');
  const rpcHeight = Math.max(0, ...(((rpcCheck?.detail as any)?.statuses ?? []) as any[]).map((s) => Number(s.height) || 0));
  const namHead = Math.max(rpcHeight, Number(heights?.nam_cursor || 0), Number(heights?.nam_h || 0)) || null;
  const osmoHead = Math.max(Number(heights?.osmo_h || 0), replay ? 0 : cov.state.osmosisSweep?.height ?? 0, replay ? 0 : cov.state.osmosisLive?.height ?? 0) || null;

  const totalSupply = mv('supply.total');
  const osmoSupply = mv('supply.osmosis');
  // Staked = the chain's total stake. What else the staking account holds (unstaking, withdrawable, unclaimed
  // rewards) is its own figure, from the same reading only (never a balance and a stake from different ticks).
  const posBalance = mv('supply.pos_bonded');
  const totalStake = mv('supply.total_stake');
  const unstaking = posBalance != null && totalStake != null && mt('supply.pos_bonded') === mt('supply.total_stake') ? Math.max(0, posBalance - totalStake) : null;
  const overview: Overview = {
    generatedAt: now,
    asOf: replay ? asOf : null,
    price: { usd: priceUsd, swap1h, change24h },
    supply: {
      total: totalSupply, bonded: totalStake, posBalance, unstaking, pgf: mv('supply.pgf'), shielded: mv('supply.masp_shielded'),
      ibcEscrow: mv('supply.ibc_escrow'), osmosis: osmoSupply, transparentLiquid: mv('supply.liquid'),
      prov: supplyProv, osmosisProv: osmoSupplyProv,
    },
    heads: {
      osmosis: { value: osmoHead, prov: cov.osmosis },
      namada: { value: namHead, prov: rpcCheck ? provAt('Namada RPC status', rpcCheck.checkedAt, now, 5 * 60000) : cov.namada },
      epoch: mv('epoch'),
    },
    dex: {
      pools: pools.length || Math.round(mv('dex.pool_count') ?? 0),
      liquidityUsd, refPoolLiquidityUsd,
      holders: holderCounts?.osmosis ?? null,
      volume24hNam: (osmoStats?.buy_nam || 0) + (osmoStats?.sell_nam || 0),
      volume24hUsd: priceUsd.value != null ? ((osmoStats?.buy_nam || 0) + (osmoStats?.sell_nam || 0)) * priceUsd.value : null,
      buys24h: osmoStats?.buys || 0, sells24h: osmoStats?.sells || 0,
      buyNam24h: osmoStats?.buy_nam || 0, sellNam24h: osmoStats?.sell_nam || 0,
      netIbc24h: netIbc,
      prov: dexProv,
      coverage: cov.osmosis,
    },
    namada: {
      holders: holderCounts?.namada ?? null,
      holdersUnder1Nam: dust?.n ?? null,
      flows24h: namadaStats?.total_flows || 0,
      bonded24h: namadaStats?.bonded || 0, withdrawn24h: namadaStats?.withdrawn || 0,
      shielded24h: namadaStats?.shielded || 0, unshielded24h: namadaStats?.unshielded || 0,
      coverage: cov.namada,
    },
    concentration: {
      osmosisTop10Pct: osmoSupply ? ((top10Osmo?.s || 0) / osmoSupply) * 100 : null,
      namadaTop10Pct: totalSupply ? ((top10Nam?.s || 0) / totalSupply) * 100 : null,
      // One stamp per chain for its holder figures (the count and the top-10 share), so every screen gives them the
      // same age: the time the balances behind them were read, never this answer's time (owner decision 7).
      // The Namada count is as of the last complete balance listing (every address compared then), else the newest row write.
      namadaProv: holderFiguresProv(top10Nam?.at, listed.balance ?? holderCounts?.namada_at, now),
      osmosisProv: holderFiguresProv(top10Osmo?.at, holderCounts?.osmosis_at, now),
    },
    checks,
    sources: publicSources(health).sort((a, b) => a.name.localeCompare(b.name)),
  };
  return c.json(overview);
});

/**
 * The stamp of one chain's holder figures (overview.concentration.namadaProv / osmosisProv): the older of the oldest
 * reading among the ten biggest holders (NAMADA_TOP10_SQL / OSMOSIS_TOP10_SQL `at`) and what the count is as of (for
 * Namada the last complete balance listing, kv balance.listing, else the newest write of its holder rows; for Osmosis
 * the oldest reading among the holders it counts, holders.ts OSMOSIS_READ_AT_SQL, so a holder the bank's list has not
 * re-read for 6 hours makes the count old). The Osmosis times are also held no later than the start of the last pass
 * of the bank's list that added up to its supply (holders.ts osmosisStamp), and are null while none has, so a pass
 * that does not add up never makes them current. Old past 6 hours, as a holder row is (owner decision 7). Holder
 * balances are current readings: under Rewind too, the stamp is their age.
 */
export function holderFiguresProv(top10At: number | null | undefined, countAt: number | null | undefined, now: number): Provenance {
  const ats = [top10At, countAt].filter((t): t is number => t != null && Number.isFinite(t) && t > 0);
  const source = 'NamadaTrade holder index';
  if (!ats.length) return { source, at: null, status: 'missing', note: 'No balance readings are recorded for this chain yet, so how old these figures are is not known.' };
  const at = Math.min(...ats);
  return now - at > LIQUID_STALE_MS
    ? { source, at, status: 'stale', note: 'The oldest balance reading behind these figures is older than 6 hours.' }
    : { source, at, status: 'live' };
}

// ---------------------------------------------------------------- decision endpoints
app.get('/api/pressure', async (c) => {
  const { asOf, replay } = asOfParam(c);
  const days = Math.min(365, Math.max(1, parseInt(c.req.query('days') || '7', 10)));
  return c.json(await pressure(c.env.DB, asOf, replay, days));
});

app.get('/api/blindspot', async (c) => {
  const { asOf, replay } = asOfParam(c);
  return c.json(await blindSpot(c.env.DB, asOf, replay));
});

app.get('/api/orderflow', async (c) => {
  const { asOf, replay } = asOfParam(c);
  const hours = Math.min(24 * 1500, Math.max(1, parseInt(c.req.query('hours') || '720', 10) || 720));
  return c.json(await orderflowSeries(c.env.DB, asOf, replay, hours));
});

app.get('/api/alerts/rules', (c) => c.json({ rules: alertRules(thresholdsParam(c)), defaults: DEFAULT_THRESHOLDS }));

/**
 * How far back /api/alerts/recent reads: the widest window the app asks for (web/src/api.ts LAST_WINDOW_MS, 30
 * days) and a day for a client clock off. An older `since` reads from here, and the answer's `since` says so (the
 * Alerts page prints it): since=1 read every alert-kind flow (47,743 rows on 2026-10-22), 30 days 2,092.
 */
export const ALERTS_SINCE_MAX_MS = 31 * D;
const THRESHOLD_KEYS = Object.keys(DEFAULT_THRESHOLDS) as (keyof AlertThresholds)[];

// Hits in [since, until) plus `last`, the most recent hit before `until` of any age (W5).
app.get('/api/alerts/recent', async (c) => {
  // The site's own alert sizes only (no page sends one): a size above every move made the search for `last` walk
  // every flow (56,402 rows on 2026-10-22), each value a cache entry of its own. Refused, so never cached.
  if (THRESHOLD_KEYS.some((k) => c.req.query(k) !== undefined)) {
    return c.json({ error: `Alerts are read at the site's own sizes; leave out ${THRESHOLD_KEYS.join(', ')}.` }, 400);
  }
  const { asOf } = asOfParam(c);
  const sinceQ = Number(c.req.query('since'));
  const since = Number.isFinite(sinceQ) && sinceQ > 0 ? Math.max(sinceQ, asOf - ALERTS_SINCE_MAX_MS) : asOf - D;
  const th = DEFAULT_THRESHOLDS;
  const hits = await alertsBetween(c.env.DB, since, asOf, th);
  // A failed or abandoned search omits `last` (not known), so the client runs its own 30-day read instead of
  // reading it as "none on record".
  const last = hits.length ? hits[0] : await lastAlertBefore(c.env.DB, asOf, th).catch(() => undefined);
  const res: AlertsRecentResponse = { since, until: asOf, hits, ...(last === undefined ? {} : { last }) };
  return c.json(res);
});

// ---------------------------------------------------------------- the holder list (shared by /api/holders and its export)
// One population: Namada rows hold spendable or staked NAM (a stake is the chain's figure, or the flow estimate only
// while no bond listing has gone through: holders.ts stakeNum, stored per row since migration 0008), Osmosis rows
// spendable NAM; module accounts (PoS, PGF, MASP, IBC escrow, governance, the Osmosis transfer module) and pools are
// not holders. Every page walks the stored totals' index of its order (holders.ts walkKeysSql); a search or a small
// category reads the few rows it names on their own index and puts them in order here.

/**
 * `?by=`: total (also when left out), liquid or bonded; anything else is refused (400), never read as the default: a
 * value the route ignored would be one more cached copy of the same list under a key of its own (a 400 is never cached).
 */
const HOLDER_SORTS = ['total', 'liquid', 'bonded'] as const;
const holdersBy = (v: string | undefined): HolderSort | null => (v == null || v === '' ? 'total' : (HOLDER_SORTS as readonly string[]).includes(v) ? (v as HolderSort) : null);
/** `?chain=` is exactly one of these (all when left out) or the request is refused (the value also names the export file). */
const HOLDER_CHAINS = ['all', 'namada', 'osmosis'] as const;
const holderChain = (v: string | undefined): (typeof HOLDER_CHAINS)[number] | null => {
  const c = v == null || v === '' ? 'all' : v;
  return (HOLDER_CHAINS as readonly string[]).includes(c) ? (c as (typeof HOLDER_CHAINS)[number]) : null;
};
/** `?category=`: a raw category in lower case, or `none` (no label); anything else is ignored, as it always was. */
const holderCategory = (v: string | undefined): string | null => {
  const c = (v || '').trim().toLowerCase();
  return c === 'none' || /^[a-z_]{1,24}$/.test(c) ? c : null;
};
/** Eight or more bech32 data characters (the alphabet after `tnam1` / `osmo1`). */
const ADDRESS_RUN = /^[02-9ac-hj-np-z]{8,}$/;
/** A stored count by category: own keys only (`?category=constructor` must not read Object's own members). */
const countOf = (byCategory: Record<string, number> | undefined, category: string): number | undefined =>
  byCategory && Object.hasOwn(byCategory, category) ? byCategory[category] : undefined;
/** `?min=` / `?max=`: NAM on the sort's figure. A value that is not an amount is refused, never dropped (a size asked for is a filter the reader sees). */
function holderSize(raw: string | undefined, name: string): number | null | { error: string } {
  if (raw == null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : { error: `${name} must be an amount of NAM (a number of 0 or more).` };
}
/**
 * The stake a holder row shows: the chain's figure; the flow estimate only while no bond listing has gone through
 * (the same rule as the stored stake, holders.ts stakeNum). The estimate itself is always carried beside it.
 */
const stakeShown = (r: { chain: string; bonded_num: number | null; estimated_num: number | null }, listed: ListingTimes) =>
  r.chain === 'namada' ? r.bonded_num ?? (listed.bond == null ? r.estimated_num : null) ?? null : null;
/**
 * A Namada holder with no spendable reading after a complete balance listing (a staker with no spendable NAM: since
 * migration 0008 it has a row with no reading, before it had none): the listing read every balance on the chain and
 * had none for it, so its spendable balance is a confirmed 0 as of the listing, not "not read yet" (M1, 2026-10-20).
 */
const listedWithNoNam = (r: { chain: string; has_row: unknown }, listed: ListingTimes) => r.chain === 'namada' && !r.has_row && listed.balance != null;
const NO_NAM_NOTE = 'The chain lists no spendable NAM for this address.';
/** Where a label came from, and for a user tag the start of its author's address ("Tag by tnam1qxyz…"). */
const labelOrigin = (source: string | null | undefined, author: string | null | undefined) => ({
  label_source: source ?? null,
  label_author: labelAuthorShort(source, author),
});

/** A category with at most this many labels is read from its labels (labels_cat) and put in order here; a larger one is walked on the sort's index. */
export const SMALL_CATEGORY = 2000;
/** The categories the chips count when the stored counts are not there to name them. */
const DEFAULT_CATEGORIES = ['genesis', 'backer', 'foundation', 'validator', 'watch', 'whale', 'bot', 'other'];
const maxOf = (a: number | null, b: number | null) => (a == null ? b : b == null ? a : Math.max(a, b));
const minOf = (a: number | null, b: number | null) => (a == null ? b : b == null ? a : Math.min(a, b));

interface HolderAsk { chain: HolderChain; by: HolderSort; category: string | null; search: string; min: number | null; max: number | null }
interface HolderSelection {
  /** the page's rows, in the list's order */
  rows: HolderBaseRow[];
  /** the rank of rows[0] */
  firstRank: number;
  /** the page these rows fall on */
  page: number;
  total: number;
  next: string | null;
  countsAt: number | null;
  categories: HoldersResponse['categories'];
}

/** The chips' counts from a tally: every category, 'none' for no label, `total` all of them. */
const categoriesOf = (total: number, tally: Record<string, number>): NonNullable<HoldersResponse['categories']> => ({
  total, counts: Object.entries(tally).filter(([, n]) => n > 0).map(([category, n]) => ({ category, n })).sort((a, b) => b.n - a.n || (a.category < b.category ? -1 : 1)),
});

/**
 * The rows of one page of the holder list, its count and its chips' counts. The search text is read with the search
 * grammar (shared/search-grammar.ts, list 'holders'): an address start or end and words of a name select rows; a chain,
 * a group ("foundation") and sizes (">100k") narrow, joined with the parameters (a conflict selects nothing).
 */
async function selectHolders(db: D1Database, ask: HolderAsk, pg: { page: number; limit: number; after: HolderCursor | null }, now: number): Promise<HolderSelection | { error: string }> {
  const none = (): HolderSelection => ({ rows: [], firstRank: 1, page: pg.page, total: 0, next: null, countsAt: null, categories: { total: 0, counts: [] } });
  const p = ask.search ? parse(ask.search, { list: 'holders', now }) : null;
  let chain = ask.chain;
  let category = ask.category;
  let empty = false;
  if (p?.chain) { if (chain === 'all') chain = p.chain; else if (chain !== p.chain) empty = true; }
  if (p?.what) { if (category && category !== p.what) empty = true; else category = p.what; }
  const address = p?.address ?? null;
  const tail = p?.tail ?? null;
  if (address) {
    const ac = address.startsWith('osmo1') ? 'osmosis' : 'namada';
    if (chain === 'all') chain = ac; else if (chain !== ac) empty = true;
  }
  const min = maxOf(ask.min, p?.min ?? null);
  const max = minOf(ask.max, p?.max ?? null);
  if (min != null && max != null && min > max) empty = true;
  if (empty) return none();
  const words = (p?.text ?? []).flatMap((t) => labelWords(t));
  const keys = words.map(wordKeys);
  const col = SORT_COL[ask.by];
  const order = holderOrder(ask.by);
  const counts = await readHolderCounts(db, now);
  const sized = min != null || max != null;
  const inSize = (r: Record<string, any>) => (min == null || Number(r[col]) >= min) && (max == null || Number(r[col]) <= max);
  const catOf = (r: HolderBaseRow) => (r.label ? (r.category ?? '').toLowerCase() || 'none' : 'none');

  // ---- a narrow selection: the rows it names, on their own index, put in order here
  const hasIdents = !!address || !!tail || keys.length > 0;
  let smallCategory = false;
  if (!hasIdents && category && category !== 'none') {
    const known = countOf(counts?.byChain.all.byCategory, category);
    const n = known ?? (await db.prepare('SELECT COUNT(*) n FROM labels INDEXED BY labels_cat WHERE category = ?').bind(category).first<{ n: number }>())?.n ?? 0;
    smallCategory = n <= SMALL_CATEGORY;
  }
  if (hasIdents || smallCategory) {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (address) {
      if (isWholeAddress(address)) { conds.push('h.address = ?'); params.push(address); }
      else { const [lo, hi] = prefixRange(address)!; conds.push('h.address >= ? AND h.address < ?'); params.push(lo, hi); }
    }
    if (tail) { conds.push('substr(h.address, -4) = ? AND substr(h.address, ?) = ?'); params.push(tail.slice(-4), -tail.length, tail); }
    if (smallCategory) { conds.push('h.address IN (SELECT l1.address FROM labels l1 WHERE l1.category = ?)'); params.push(category); }
    const reads: { sql: string; params: unknown[]; byText: boolean }[] = [];
    // the words the statement selects by, within D1's bound parameters (the chains and the LIMIT come after them)
    const sqlKeys = sqlWordKeys(keys, D1_MAX_PARAMS - params.length - HOLDER_CHAINS_OF[chain].length - 1, wordCondCost);
    const named = sqlKeys.map((k) => wordCond(k, 'h.address'));
    reads.push({ ...holderCandidatesSql([...conds, ...named.map((n) => n.sql)].join(' AND ') || '1 = 1', [...params, ...named.flatMap((n) => n.params)], chain), byText: false });
    // A run of 8 or more address characters that is not an address start: anywhere in an address (a pass over the
    // holder index's addresses, the slow path, rate-limited with the searches). Only text that could be part of an
    // address: the bech32 data characters (never b, i, o or 1) with a digit in it, so a name ("knowable",
    // "everstake") never walks every holder for a match it cannot have.
    if (words.length === 1 && ADDRESS_RUN.test(words[0]) && /\d/.test(words[0]) && !address && !tail) {
      reads.push({ ...holderCandidatesSql([...conds, 'h.address LIKE ?'].join(' AND '), [...params, `%${words[0]}%`], chain), byText: true });
    }
    const got = await Promise.all(reads.map((r) => db.prepare(r.sql).bind(...r.params).all<HolderBaseRow>().then((x) => ({ rows: x.results || [], byText: r.byText }))));
    if (got.some((g) => g.rows.length > CANDIDATES_MAX)) return { error: 'This search matches too many holders; type more of the address or the name.' };
    const seen = new Map<string, HolderBaseRow>();
    for (const g of got) for (const r of g.rows) {
      const ok = g.byText ? r.address.includes(words[0]) : !keys.length || labelMatches(r.label, r.address, r.label_source, keys);
      if (ok) seen.set(`${r.chain}:${r.address}`, r);
    }
    const sizedRows = [...seen.values()].filter(inSize);
    const tally: Record<string, number> = Object.create(null);
    for (const r of sizedRows) tally[catOf(r)] = (tally[catOf(r)] ?? 0) + 1;
    const all = (category && !smallCategory ? sizedRows.filter((r) => catOf(r) === category) : sizedRows).sort(order);
    let start = (pg.page - 1) * pg.limit;
    if (pg.after) { const i = all.findIndex((r) => holderAfter(ask.by, r, pg.after!)); start = i < 0 ? all.length : i; }
    const rows = all.slice(start, start + pg.limit);
    const last = rows[rows.length - 1];
    let categories: HoldersResponse['categories'] = categoriesOf(sizedRows.length, tally);
    // A category on its own: the chips are the chain's (the stored counts, or a pass over the size range).
    if (smallCategory) categories = sized ? await walkCategories(db, { chain, by: ask.by, min, max }, counts) : storedCategories(counts, chain);
    return {
      rows, firstRank: start + 1, page: Math.floor(start / pg.limit) + 1, total: all.length,
      next: last && start + rows.length < all.length ? encodeHolderCursor({ value: Number(last[col as keyof HolderBaseRow]) || 0, address: last.address, rank: start + rows.length }) : null,
      countsAt: null, categories,
    };
  }

  // ---- a walk of the sort's index (the default list, 'none', a large category, a size range)
  const w: HolderWalk = { chain, by: ask.by, min, max, category };
  let rankBase = (pg.page - 1) * pg.limit;
  if (pg.after) {
    // The cursor's position is read again on the index (rows at or ahead of it), so a rank is never taken from the URL.
    rankBase = (await db.prepare(walkCountSql(w, pg.after).sql).bind(...walkCountSql(w, pg.after).params).first<{ n: number }>())?.n ?? 0;
  }
  const pageSql = holderPageSql(w, { after: pg.after, limit: pg.limit + 1, offset: pg.after ? 0 : rankBase });
  const stored = counts && !sized ? counts.byChain[chain] : null;
  const [rowsRes, countRes, categories] = await Promise.all([
    db.prepare(pageSql.sql).bind(...pageSql.params).all<HolderBaseRow>(),
    stored ? Promise.resolve(null) : db.prepare(walkCountSql(w).sql).bind(...walkCountSql(w).params).first<{ n: number }>(),
    stored ? Promise.resolve(storedCategories(counts, chain)) : walkCategories(db, { chain, by: ask.by, min, max }, counts),
  ]);
  const got = (rowsRes.results || []).sort(order);
  const rows = got.slice(0, pg.limit);
  const total = stored ? (category === 'none' ? stored.none : category ? countOf(stored.byCategory, category) ?? 0 : stored.all) : Number(countRes?.n ?? 0);
  const last = rows[rows.length - 1];
  return {
    rows, firstRank: rankBase + 1, page: Math.floor(rankBase / pg.limit) + 1, total,
    next: last && got.length > pg.limit ? encodeHolderCursor({ value: Number(last[col as keyof HolderBaseRow]) || 0, address: last.address, rank: rankBase + rows.length }) : null,
    countsAt: stored ? counts!.at : null, categories,
  };
}

/** The chips' counts of a chain from the stored counts (null without them). */
function storedCategories(counts: HolderCountsKv | null, chain: HolderChain): HoldersResponse['categories'] {
  const c = counts?.byChain[chain];
  return c ? categoriesOf(c.all, { ...c.byCategory, none: c.none }) : null;
}
/** The chips' counts over a walk (a size range, or no stored counts): one pass, one sum per category. */
async function walkCategories(db: D1Database, w: HolderWalk, counts: HolderCountsKv | null): Promise<HoldersResponse['categories']> {
  const cats = Object.keys(counts?.byChain.all.byCategory ?? {}).filter((c) => /^[a-z_]{1,24}$/.test(c));
  const list = cats.length ? cats : DEFAULT_CATEGORIES;
  const q = walkCategorySql(w, list);
  const rows = (await db.prepare(q.sql).bind(...q.params).all<Record<string, number>>()).results || [];
  const tally: Record<string, number> = Object.assign(Object.create(null), { none: 0 });
  let total = 0;
  for (const r of rows) {
    total += Number(r.n ?? 0);
    tally.none += Number(r.c_none ?? 0);
    list.forEach((c, i) => { tally[c] = (tally[c] ?? 0) + Number(r[`c${i}`] ?? 0); });
  }
  return categoriesOf(total, tally);
}

/** A list row as the API sends it. */
function holderOut(r: HolderBaseRow, rank: number, listed: ListingTimes, supplyTotal: number | null, now: number, changes: Map<string, { d24: number | null; d7: number | null }>, links: Map<string, string[]>): Holder {
  const fallback = INTERNAL_LABELS[r.address];
  const label = r.label || fallback?.label || null;
  const category = r.category || fallback?.category || null;
  const source = r.label ? r.label_source ?? null : fallback ? 'auto' : null;
  // Owner decision 7: the chain read of the stake is authoritative when it exists. A reading a chain listing
  // confirmed (its source, unchanged since) is as fresh as the last complete listing (holders.ts confirmedAt).
  const bonded = stakeShown(r, listed);
  const noNam = listedWithNoNam(r, listed);
  const verifiedAt = noNam ? listed.balance : r.has_row ? confirmedAt(r.verified_at, r.liquid_src, BALANCE_LISTING_SRC, listed.balance) : null;
  const bondedVerifiedAt = confirmedAt(r.bonded_verified_at, r.bonded_src, BOND_LISTING_SRC, listed.bond);
  const st = holderStatus({
    chain: r.chain, verifiedAt, hasLiquidRow: !!r.has_row || noNam,
    bondedRead: r.bonded_num ?? null, bondedVerifiedAt, bondedEstimated: r.estimated_num ?? null,
  }, now);
  if (noNam) st.statusNote = st.statusNote ? `${NO_NAM_NOTE} ${st.statusNote}` : NO_NAM_NOTE;
  const ch = changes.get(r.address);
  return {
    rank, chain: r.chain as Holder['chain'], address: r.address, balance: r.balance_num,
    bonded, bondedEstimated: r.estimated_num ?? null, bondedVerifiedAt,
    total: r.total_num,
    pctSupply: supplyTotal ? (r.total_num / supplyTotal) * 100 : null,
    change24h: ch?.d24 ?? null, change7d: ch?.d7 ?? null,
    label, category, label_plain: label_plain(label, r.address, source), category_plain: category_plain(category, label),
    ...labelOrigin(source, r.label_author),
    linked: [...new Set(links.get(r.address) || [])], updatedAt: r.updated_at ?? null, verifiedAt,
    status: st.status, statusNote: st.statusNote,
  };
}

// ---------------------------------------------------------------- GET /api/holders
// ?chain=all|namada|osmosis &by=total|liquid|bonded &category=<raw category>|none &search= &min= &max= &page= &after= &limit= (10…100)
// Current balances only: no `at` (balances were not recorded over time before W13). Each row carries a
// server status (owner decision 7), real 24 h / 7 d changes or null, and plain label words (owner decision 6).
// The count and the chips' counts come from the stored counts (kv holders.counts, `countsAt`) unless the request
// narrows by a search or a size, when they are counted here (`countsAt` null). `asOf`: when the order was read.
app.get('/api/holders', async (c) => {
  const db = c.env.DB;
  const chain = holderChain(c.req.query('chain'));
  if (!chain) return c.json({ error: 'chain must be all, namada or osmosis' }, 400);
  const by = holdersBy(c.req.query('by'));
  if (!by) return c.json({ error: 'by must be total, liquid or bonded' }, 400);
  const page = pageParam(c);
  if (page instanceof Response) return page;
  const min = holderSize(c.req.query('min'), 'min');
  const max = holderSize(c.req.query('max'), 'max');
  for (const v of [min, max]) if (v && typeof v === 'object') return c.json({ error: v.error }, 400);
  // A cursor that is not one of ours is ignored (the page by number is served), never guessed at.
  const after = decodeHolderCursor(c.req.query('after'));
  const limit = clampLimit(c.req.query('limit'));
  const now = Date.now();
  const ask: HolderAsk = { chain, by, category: holderCategory(c.req.query('category')), search: (c.req.query('search') || '').trim(), min: min as number | null, max: max as number | null };
  const [sel, supplyRow, listed] = await Promise.all([
    selectHolders(db, ask, { page, limit, after }, now),
    metricAt(db, 'supply.total', now),
    listingTimes(db),
  ]);
  if ('error' in sel) return c.json({ error: sel.error }, 400);
  const raw = sel.rows;

  const linksMap = new Map<string, string[]>();
  const changes = new Map<string, { d24: number | null; d7: number | null }>();
  if (raw.length > 0) {
    const addrs = raw.map((r) => r.address);
    const byChain = (ch: string) => new Map<string, number | null>(raw.filter((r) => r.chain === ch).map((r) => [r.address, r.has_row ? r.balance_num : null]));
    // D1 takes at most 100 bound parameters per query: the address list is split to fit.
    const [linkParts, namCh, osmoCh] = await Promise.all([
      Promise.all(chunks(addrs, 0, 2).map((part) => {
        const ph = part.map(() => '?').join(',');
        return db.prepare(`SELECT osmo_addr, namada_addr FROM address_links WHERE osmo_addr IN (${ph}) OR namada_addr IN (${ph})`).bind(...part, ...part).all<any>().catch(() => ({ results: [] as any[] }));
      })),
      liquidChanges(db, 'namada', byChain('namada'), now),
      liquidChanges(db, 'osmosis', byChain('osmosis'), now),
    ]);
    for (const [a, v] of [...namCh, ...osmoCh]) changes.set(a, v);
    for (const l of linkParts.flatMap((p) => p.results || [])) {
      (linksMap.get(l.osmo_addr) ?? linksMap.set(l.osmo_addr, []).get(l.osmo_addr)!).push(l.namada_addr);
      (linksMap.get(l.namada_addr) ?? linksMap.set(l.namada_addr, []).get(l.namada_addr)!).push(l.osmo_addr);
    }
  }
  const supplyTotal = supplyRow?.value ?? null;
  const holders = raw.map((r, i) => holderOut(r, sel.firstRank + i, listed, supplyTotal, now, changes, linksMap));
  const res: HoldersResponse = { total: sel.total, page: sel.page, limit, holders, next: sel.next, asOf: now, countsAt: sel.countsAt, categories: sel.categories };
  return c.json(res);
});

// ---------------------------------------------------------------- GET /api/flows
// ?chain= &kind= &whale=true &minNam=<n> &arb=false &pairs=one &search= &since= &addr= &hash= &height= &at= &before= &page= &limit= (10…100)
// &count=none. Newest first (FLOWS_ORDER), keyset paged: `next` is the cursor for the older rows, sent back as
// `?before=`; `?before=<unix ms>` jumps to a date. The count (`total`) is taken on the head page only (no `before`),
// and not at all with `count=none` (Home's latest moves and the live feed's first rows show rows, not a count);
// behind a cursor it is null (the head page said it). `?page=` still pages by offset for links made before (W1).
// `search=` (address or record contains the text, no index serves it): text no address or record can hold answers an
// empty page at once; any other text reads at most SEARCH_SCAN moves a request, is never counted by a second walk,
// and pages by cursor only (`page=` past the first without `before` is refused).
const flowSelectOf = (hint: string) => flowSelect(hint);
interface FlowsRead { flows: Flow[]; total: number | null; next: string | null; rows: number; over?: number }

/**
 * `countWide`: count an address start that matches more than FEW_ROWS moves too (the export, under HEAVY_LIMITER).
 * The list does not: that count reads every stored move on flows_ts (56,402 rows for the MASP's start on 2026-10-22),
 * so its head page says "more than FEW_ROWS" (`over`), which the rows read here already show.
 */
async function readFlows(db: D1Database, f: FlowsFilter, before: BeforeParam | null, limit: number, offset: number, count: boolean, scan = false, countWide = false): Promise<FlowsRead> {
  // text no address or record can hold selects nothing: no walk
  if (f.search && !searchCanMatch(f.search)) return { flows: [], total: count ? 0 : null, next: null, rows: 0 };
  let mode = flowsMode(f);
  let wide = false;
  if (mode === 'rows') {
    const q = flowsRowsSql(flowSelectOf, f);
    const all = (await db.prepare(q.sql).bind(...q.params).all<any>()).results || [];
    // An address start that matches too many rows for this is walked in time order instead (below).
    if (!(all.length > FEW_ROWS && f.addr)) {
      const ordered = all.sort(flowOrder).filter((r) => afterPosition(r, before));
      const shown = ordered.slice(offset, offset + limit);
      const last = shown[shown.length - 1];
      return {
        flows: shown.map(rowToFlow), total: count ? all.length : null, rows: all.length,
        next: last && ordered.length > offset + limit ? encodeFlowCursor({ ts: last.ts, height: last.height, id: last.id }) : null,
      };
    }
    mode = 'time';
    wide = true;
  }
  // A text search (`LIKE '%…%'`, no index serves it) with `scan`: the page reads at most SEARCH_SCAN entries of its
  // index, up to the window's end (scanFloorSql), and `next` goes on from there when it found fewer than a page.
  const text = !!f.search;
  const endQ = text && scan && (mode === 'time' || mode === 'kind') ? scanFloorSql(f, mode, before) : null;
  const ends = endQ ? (await db.prepare(endQ.sql).bind(...endQ.params).all<FlowCursor>()).results || [] : [];
  const floor = ends.length === 2 ? ends[0] : null;
  const pageQ = flowsPageSql(flowSelectOf, f, mode, before, limit + 1, offset, floor);
  // a text search is never counted by a second walk: its count is the page's own rows when the walk read every match
  const countQ = count && !text && (!wide || countWide) ? flowsCountSql(f, mode) : null;
  const [rowsRes, countRes] = await Promise.all([
    db.prepare(pageQ.sql).bind(...pageQ.params).all<any>(),
    countQ ? db.prepare(countQ.sql).bind(...countQ.params).first<{ total: number }>() : Promise.resolve(null),
  ]);
  const got = rowsRes.results || [];
  const shown = got.slice(0, limit);
  const last = shown[shown.length - 1];
  const full = got.length > limit;
  return {
    flows: shown.map(rowToFlow), rows: got.length,
    ...(count && wide && !countQ ? { over: FEW_ROWS } : {}),
    total: countQ ? Number(countRes?.total ?? 0) : count && text && !full && !floor ? offset + got.length : null,
    next: last && full ? encodeFlowCursor({ ts: last.ts, height: last.height, id: last.id }) : floor ? encodeFlowCursor(floor) : null,
  };
}

app.get('/api/flows', async (c) => {
  const db = c.env.DB;
  const { asOf } = asOfParam(c);
  const page = pageParam(c);
  if (page instanceof Response) return page;
  const limit = clampLimit(c.req.query('limit'));
  const bad = flowsFilterError((k) => c.req.query(k));
  if (bad) return c.json({ error: bad }, 400);
  const f = flowsFilterFromQuery((k) => c.req.query(k), asOf);
  // A cursor that is not one of ours, or a time out of range, is the head page (shared/paging.ts parseBeforeParam).
  const before = parseBeforeParam(c.req.query('before'));
  const head = before == null;
  // `count` is `none` or left out: any other value would be read as "count" and stored as a copy of its own
  const countQ = c.req.query('count');
  if (countQ != null && countQ !== '' && countQ !== 'none') return c.json({ error: 'count must be none (rows only), or left out.' }, 400);
  const count = head && countQ !== 'none';
  // A text search pages by cursor only: an offset counts matches, and a window can end before it is reached.
  if (f.search && head && page > 1) return c.json({ error: 'A search by text is paged with before=<next>, not page=.' }, 400);
  const r = await readFlows(db, f, before, limit, head ? (page - 1) * limit : 0, count, true);
  await withSettles(db, r.flows);
  const res: FlowsResponse = { total: r.total, ...(r.over != null ? { totalOver: r.over } : {}), page: head ? page : 1, limit, flows: r.flows, next: r.next, asOf };
  // The oldest move for this chain filter (for "The flow index starts on …"), on the head page and on a date jump.
  if (head || before?.kind === 'time') {
    const chains: ('namada' | 'osmosis')[] = f.chain === 'namada' || f.chain === 'osmosis' ? [f.chain] : ['namada', 'osmosis'];
    const fr = await db.prepare(`SELECT MIN(t) t FROM (${chains.map((ch) => `SELECT ${FIRST_TS_SQL(ch)} t`).join(' UNION ALL ')})`).first<{ t: number | null }>().catch(() => null);
    res.firstTs = fr?.t ?? null;
  }
  // An empty head page: the newest move that matches every filter but the time window, of any age.
  if (head && page === 1 && !r.flows.length) {
    // A text search does not look further back than its window: no move holds text it cannot match; otherwise "none at
    // any time" only when it read to the oldest move (no `next`), and no lookup past a time window.
    if (f.search) { if (!searchCanMatch(f.search) || (f.since == null && !r.next)) res.last = null; }
    else if (f.since == null) res.last = null;
    else {
      const q = flowsLastSql(f, flowsMode(f));
      const rows = ((await db.prepare(q.sql).bind(...q.params).all<{ id: string; ts: number; chain: Chain; height: number }>().catch(() => null))?.results ?? []).sort(flowOrder);
      res.last = rows[0] ? { id: rows[0].id, ts: rows[0].ts, chain: rows[0].chain } : null;
    }
  }
  return c.json(res);
});

// ---------------------------------------------------------------- trade (D1)
app.get('/api/pools', async (c) => {
  const r = await fetchNamPools();
  const prov: Provenance = r.pools.length ? { source: 'Osmosis SQS pools', at: r.at, status: 'live' } : { source: 'Osmosis SQS pools', at: null, status: 'missing', note: r.error };
  return c.json({ pools: r.pools, prov });
});

/** Far above all NAM in existence (about 1.15 billion): a larger size is refused before any quote service is asked. */
export const QUOTE_MAX_NAM = 1e12;
/**
 * The SQS calls every visitor's quotes may make together: QUOTE_LIMITER (wrangler.jsonc, 10 per 10 s) under one fixed
 * key. Its counters are per Cloudflare location, as is the outbound address the quote service limits, which the size
 * table, the overview and the cron share: no burst wider than the size table's own 6 at once, whoever asks and from
 * however many addresses. Past it a quote answers 'busy' and the ticket shows the size table; a repeat within 10 s is
 * the stored answer and spends nothing. Not bound (tests): no budget, as the other limiters.
 */
export const QUOTE_BUDGET_KEY = 'all:/api/quote';
const quoteBudget = (env: Env) => async () =>
  !env.QUOTE_LIMITER || (await env.QUOTE_LIMITER.limit({ key: QUOTE_BUDGET_KEY }).catch(() => ({ success: true }))).success;
app.get('/api/quote', async (c) => {
  const amount = parseFloat(c.req.query('amount') || '1000');
  const side = c.req.query('side') || 'sell';
  if (!(amount > 0)) return c.json({ quote: null, error: 'Enter an amount above zero.' }, 400);
  if (!(amount <= QUOTE_MAX_NAM)) return c.json({ quote: null, error: 'Enter an amount below one trillion NAM.' }, 400);
  if (side !== 'buy' && side !== 'sell') return c.json({ quote: null, error: 'side must be buy or sell.' }, 400);
  // The spot the quote is measured against: the Osmosis quote the cron stored in the last two minutes (said with its own
  // time in the quote's note), so a visitor's quote asks the quote service for the route only.
  // The quote's note names how that minute's price was read (price-how.ts): the price list, or the route's spot.
  const [stored, priceHow] = await Promise.all([
    c.env.DB.prepare(`SELECT ts, value FROM metrics WHERE key = 'price.usd' AND ts >= ? ORDER BY ts DESC LIMIT 1`).bind(Date.now() - 120_000).first<{ ts: number; value: number }>().catch(() => null),
    kvGetJson<PriceHowLog>(c.env.DB, PRICE_HOW_KEY).catch(() => null),
  ]);
  const spot = stored && Number(stored.value) > 0 ? { usd: Number(stored.value), at: Number(stored.ts) } : null;
  return c.json(await quoteNamTrade(amount, side, spot?.usd, quoteBudget(c.env), spot?.at, spot ? priceSourceName(priceHowAt(priceHow, spot.at)) : undefined));
});

app.get('/api/quote/curve', async (c) => c.json(await quoteSlippageCurve()));

// ---------------------------------------------------------------- GET /api/address/:addr
/** How long the address report waits for the chain's live answers in all before it uses the stored readings. */
export const ADDRESS_LIVE_MS = 12_000;
app.get('/api/address/:addr', async (c) => {
  const addr = c.req.param('addr').trim();
  const db = c.env.DB;
  const chain = chainOf(addr);
  if (!chain) return c.json({ error: 'Invalid Osmosis or Namada address' }, 400);

  const now = Date.now();
  const [labelRow, holderRow] = await Promise.all([
    db.prepare('SELECT * FROM labels WHERE address = ?').bind(addr).first<any>(),
    db.prepare('SELECT * FROM holders WHERE chain = ? AND address = ?').bind(chain, addr).first<any>(),
  ]);
  // A row with no reading is a staker's place on the stored totals (migration 0008), not a spendable balance.
  const holder = holderRow && (holderRow.updated_at != null || holderRow.verified_at != null) ? holderRow : null;

  const fallbackInternal = INTERNAL_LABELS[addr];
  const resolvedLabel = labelRow
    ? { address: labelRow.address, chain: labelRow.chain, label: labelRow.label, category: labelRow.category, source: labelRow.source, note: labelRow.note }
    : fallbackInternal ? { address: addr, chain, label: fallbackInternal.label, category: fallbackInternal.category, source: 'auto', note: null } : null;
  const label = resolvedLabel ? { ...resolvedLabel, label_plain: label_plain(resolvedLabel.label, addr, resolvedLabel.source), category_plain: category_plain(resolvedLabel.category, resolvedLabel.label), ...labelOrigin(resolvedLabel.source, labelRow?.author) } : null;

  // Live balance where the chain lets us; otherwise the indexed one with its own timestamp. The live reads are quick
  // (one attempt per node, 8 s) and share a 12 s limit, so a node that hangs costs seconds, not a minute and more,
  // before the sheet gets the stored reading with its own date.
  const live: ReadOpts = { ...QUICK, signal: AbortSignal.timeout(ADDRESS_LIVE_MS) };
  let balance: Sourced<number>;
  if (chain === 'namada') {
    try {
      const res = await namBalance(addr, live);
      balance = { value: toNam(res.balance), prov: { source: `Namada RPC ${res.provider}`, at: now, height: res.height, status: 'live' } };
    } catch (e) {
      const listedAt = holder ? null : (await listingTimes(db)).balance;
      balance = listedAt != null
        // no row after a complete listing of every balance: the chain listed none for this address
        ? { value: 0, prov: provAt(`chain balance listing (${BALANCE_LISTING_SRC})`, listedAt, now, LIQUID_STALE_MS, { note: `The live read from the chain failed. ${NO_NAM_NOTE}` }) }
        : { value: holder?.balance_num ?? null, prov: provAt('D1 index (RPC failed)', holder?.updated_at ?? null, now, 30 * 60000, { height: holder?.updated_height, note: 'The live read from the chain failed, so this is the last indexed balance.' }) };
    }
  } else {
    balance = { value: holder?.balance_num ?? null, prov: provAt(holder?.verified_src ? (holder.verified_src === 'osmosis_public_rest' ? 'Osmosis public REST (osmosis_public_rest)' : `Keplr Osmosis REST (${holder.verified_src})`) : 'D1 index', holder?.verified_at ?? holder?.updated_at ?? null, now, 15 * 60000, { height: holder?.updated_height }) };
  }

  const liveBal = balance.value ?? 0;
  let staking: AddressReport['staking'] = null;
  if (chain === 'namada') {
    const stakeRow = await db.prepare('SELECT bonded_num, estimated_num, delegations, verified_at, verified_epoch, verified_src FROM stakes WHERE address = ?').bind(addr).first<any>().catch(() => null);
    const names = new Map(((await kvGetJson<IntelResponse>(db, 'intel.cache'))?.validators ?? []).map((v) => [v.address, v]));
    const toDelegations = (list: { validator: string; amountNam: number }[]) =>
      list.map((d) => ({ validatorAddress: d.validator, validatorName: names.get(d.validator)?.name ?? null, amountNam: d.amountNam, commission: names.get(d.validator)?.commission ?? 0, state: names.get(d.validator)?.state ?? 'unknown', avatar: names.get(d.validator)?.avatar ?? null }))
        .sort((a, b) => b.amountNam - a.amountNam);
    try {
      const epoch = await namadaEpoch(live);
      const d = await delegationsAt(addr, epoch, live);
      staking = { bondedNam: d.bondedNam, unbondingNam: 0, totalPositionNam: liveBal + d.bondedNam, delegations: toDelegations(d.delegations), estimatedNam: stakeRow?.estimated_num ?? null,
        prov: { source: `Namada RPC ${d.provider} (vp/pos/delegations_at, epoch ${epoch})`, at: now, height: d.height, status: 'live' } };
    } catch (e) {
      if (stakeRow) {
        const list = safeParseJson(stakeRow.delegations, []) as { validator: string; amountNam: number }[];
        const v = stakeRow.bonded_num ?? stakeRow.estimated_num ?? 0;
        staking = { bondedNam: v, unbondingNam: 0, totalPositionNam: liveBal + v, delegations: toDelegations(list), estimatedNam: stakeRow.estimated_num ?? null,
          prov: stakeRow.bonded_num != null ? provAt(`stakes table (${stakeRow.verified_src}, epoch ${stakeRow.verified_epoch})`, confirmedAt(stakeRow.verified_at, stakeRow.verified_src, BOND_LISTING_SRC, (await listingTimes(db)).bond), now, 12 * H, { note: 'The live read from the chain failed, so this is the last stored reading.' })
            : { source: 'bond/unbond history (estimate)', at: null, status: 'stale', note: 'Estimated from staking history; not read from the chain yet.' } };
      }
    }
  }

  // Its places in the holder list's two orders, as the list ranks it (the stored row, protocol accounts and pools
  // left out): from the nearest place mark the cron keeps (holders.ts placeOn), a walk of at most RANK_WALK_MAX index
  // entries. An address the list does not hold yet is placed by its live spendable balance (no total: its stake is not
  // on the index). A place the walk does not reach is not given, and then neither is the other ("Not ranked" would be false).
  const onList = !!holderRow && Number(holderRow.total_num) > 0 && !INTERNAL_LABELS[addr] && labelRow?.category !== 'pool';
  const unlisted = !onList && liveBal > 0 && !INTERNAL_LABELS[addr] && labelRow?.category !== 'pool';
  let rank: number | null = null;
  let rankTotal: number | null = null;
  if (onList || unlisted) {
    const marks = await readChainMarks(db, chain, now);
    if (onList) {
      const spendable = Number(holderRow.balance_num) > 0;
      const [t, l] = await Promise.all([
        placeOn(db, chain, 'total', { value: Number(holderRow.total_num), address: addr }, marks),
        spendable ? placeOn(db, chain, 'liquid', { value: Number(holderRow.balance_num), address: addr }, marks) : Promise.resolve(null),
      ]);
      if (t != null && (l != null || !spendable)) { rankTotal = t; rank = l; }
    } else {
      // the holders with more spendable NAM: an address of '' is ahead of every address of the same balance
      const more = await placeOn(db, chain, 'liquid', { value: liveBal, address: '' }, marks);
      rank = more == null ? null : more + 1;
    }
  }

  // Its newest 300 moves and their count: a whole address reads its sending rows on flows_from and its receiving
  // rows on flows_to, each in the feed's order, merged (at most 301 rows a side; before, every move of the address was
  // read and sorted: thousands for the busiest accounts). Any other address form keeps the plain read.
  const [links, moves] = await Promise.all([
    db.prepare(`SELECT osmo_addr, namada_addr, transfers, volume_num, last_seen FROM address_links WHERE osmo_addr = ? OR namada_addr = ? ORDER BY volume_num DESC`).bind(addr, addr).all<any>(),
    isWholeAddress(addr)
      ? readFlows(db, { asOf: now, addr }, null, 300, 0, true)
      : Promise.all([
          db.prepare(`SELECT COUNT(*) c FROM flows f WHERE (f.from_addr = ? OR f.to_addr = ?) AND ${NOT_TWIN}`).bind(addr, addr).first<{ c: number }>().catch(() => ({ c: 0 })),
          db.prepare(`${FLOW_SELECT} WHERE (f.from_addr = ? OR f.to_addr = ?) AND ${NOT_TWIN} ORDER BY f.ts DESC, f.height DESC LIMIT 300`).bind(addr, addr).all<any>(),
        ]).then(([n, r]) => ({ flows: (r.results || []).map(rowToFlow), total: n?.c ?? null })),
  ]);
  const flows = await withSettles(db, moves.flows);
  const totalFlowsRow = { c: moves.total ?? flows.length };

  // 24 h / 7 d changes: the balance now (the live read, else the indexed one) minus the recorded chain read
  // at the start of each window; null when no reading covers it.
  const ch = (await liquidChanges(db, chain, new Map([[addr, balance.value ?? null]]), now)).get(addr);

  const report: AddressReport = {
    address: addr, chain, label, balance,
    indexedBalance: holder?.balance_num ?? null, staking, rank, rankTotal,
    change24h: ch?.d24 ?? null, change7d: ch?.d7 ?? null,
    links: (links.results || []).map((l: any) => ({ address: addr === l.osmo_addr ? l.namada_addr : l.osmo_addr, chain: (addr === l.osmo_addr ? 'namada' : 'osmosis') as any, transfers: l.transfers, volume: l.volume_num, lastSeen: l.last_seen })),
    totalFlowsCount: totalFlowsRow?.c ?? flows.length,
    flows,
    // NAM only, each bridge crossing once (both chains record it): the same rule as the moves the sheet lists.
    counterparties: counterpartiesOf(flows, addr),
  };
  return c.json(report);
});

// ---------------------------------------------------------------- GET /api/intel
// The copy the cron keeps (refreshed every minute, stamped with its own fetch time). A visitor never makes the forum
// and the indexer answer: an old copy shows its age, and the live read runs only when there is no copy at all.
app.get('/api/intel', async (c) => {
  const db = c.env.DB;
  const cached = await kvGetJson<IntelResponse>(db, 'intel.cache');
  if (cached) return c.json(cached);
  const intel = await fetchIntel();
  if (intel.topics.length > 0 || intel.proposals.length > 0) await kvSet(db, 'intel.cache', JSON.stringify(intel)).catch(() => {});
  return c.json(intel);
});

// ---------------------------------------------------------------- GET /api/search
// ?q=<text>&limit=<1…10, default 6>. Current data, grouped (SearchGroup order: addresses, records, names, pools,
// blocks), at most `limit` per group, best first inside a group (exact, then the start of the value, then its end,
// then a word start). The text is read with the search grammar (shared/search-grammar.ts): an address start of 8 or
// more characters, an address end, a record's hash start, a block height, a pool number and words of a name. Every
// group reads one index range: the holder rows by address (primary key) or by their last four characters
// (holders_tail), records on the three hash indexes, names on label_tokens, blocks on flows_chain_height; validator
// names come from the stored validator list (kv validators.names, one row) and the protocol accounts' names from
// config. Pages, views and glossary words are found in the app itself. Edge-cached on (q, limit).
export const SEARCH_LIMIT = 6;
export const SEARCH_LIMIT_MAX = 10;
/** Candidates a group reads before it ranks them (the biggest holders first among equal matches). */
const SEARCH_CANDIDATES = 50;
/** The addresses of one start or end read before they are ranked by what they hold (searchAddresses). */
const ADDRESS_CANDIDATES = 1000;
/** The labels a name's words select in key order (nameRows); a word that matches more also reads the biggest holders among them. */
const NAME_CANDIDATES = SEARCH_CANDIDATES * 2;
/**
 * The names' holdings read (nameRows): the matches it takes, and the deepest it walks the stored totals' index (the
 * largest holders; No. 2,000 held about 6,500 NAM on 2026-10-20), whatever it finds.
 */
const NAME_WALK_TAKE = SEARCH_LIMIT_MAX * 2;
const NAME_WALK_MAX = 2000;

const H_MS = 3_600_000;
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const utcWords = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTH[d.getUTCMonth()]} ${d.getUTCFullYear()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
};
/** An amount in words for a subtitle ("1.2 million", "12,345", "0.5"). */
/** " · 50.0 million NAM, 12.0 million of it staked" from the stored totals; nothing when it holds none. */
const holdsWords = (total: number | null | undefined, stake: number | null | undefined) =>
  total != null && total > 0 ? ` · ${namWords(total)} NAM${stake != null && stake > 0 ? `, ${namWords(stake)} of it staked` : ''}` : '';
const namWords = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} billion` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} million` : n >= 1 ? Math.round(n).toLocaleString('en-US') : String(Number(n.toFixed(6))));
const chainWord = (c: string) => (c === 'osmosis' ? 'Osmosis' : 'Namada');
const shortAddr = (a: string) => (a.length <= 18 ? a : `${a.slice(0, 10)}…${a.slice(-5)}`);
/** What a move is, in the site's words. */
const KIND_WORDS: Record<string, string> = {
  buy: 'Bought', sell: 'Sold', transfer: 'Sent', ibc_in: 'Bridged in', ibc_out: 'Bridged out', bond: 'Staked', unbond: 'Unstaking',
  withdraw: 'Unlocked', rewards: 'Staking rewards', shield: 'Shielded', unshield: 'Unshielded', lp_add: 'Added to a pool', lp_remove: 'Removed from a pool',
  pgf: 'Public funding', pos_balance: 'Staking account transfer', other: 'Other move',
};
const MATCH_RANK: Record<SearchMatch, number> = { exact: 0, start: 1, end: 2, word: 3, contains: 4 };
/** Where a name came from, as a stamp (the label's source; a name states no figure). */
const LABEL_SOURCE_WORDS: Record<string, string> = { genesis: 'Namada genesis file', valopers: 'Validator list', auto: 'NamadaTrade labels', user: 'A signed-in wallet\'s tag' };

/** label_tokens is absent until migration 0008 runs: the names group then reads the labels with LIKE (once per isolate the absence is noted). */
let labelTokensMissing = false;

type Hit = SearchResult & { rankKey: number[] };
function grouped(group: SearchGroup, hits: Hit[], limit: number): { list: SearchResult[]; meta: { group: SearchGroup; n: number; more: boolean } } {
  const list = hits.sort((a, b) => { for (let i = 0; i < Math.max(a.rankKey.length, b.rankKey.length); i++) { const d = (a.rankKey[i] ?? 0) - (b.rankKey[i] ?? 0); if (d) return d; } return 0; })
    .slice(0, limit).map(({ rankKey, ...r }) => r);
  return { list, meta: { group, n: list.length, more: hits.length > limit } };
}

/** Holder rows the addresses group reads (an address start, an address end, or both), with their label. */
interface AddrRow { chain: string; address: string; balance_num: number; stake_num: number; total_num: number; updated_at: number | null; verified_at: number | null; verified_src: string | null; label: string | null; category: string | null; source: string | null; author: string | null }
const ADDR_COLS = `h.chain, h.address, h.balance_num, h.stake_num, h.total_num, h.updated_at, h.verified_at, h.verified_src, l.label, l.category, l.source, l.author`;

async function searchAddresses(db: D1Database, p: Parsed, limit: number, listed: ListingTimes, now: number): Promise<Hit[]> {
  const hits: Hit[] = [];
  const stampOf = (r: AddrRow): Provenance | null => {
    if (!(r.total_num > 0)) return null;
    const read = r.updated_at != null || r.verified_at != null ? confirmedAt(r.verified_at ?? r.updated_at, r.verified_src, BALANCE_LISTING_SRC, listed.balance) : listed.balance;
    return read == null ? { source: 'NamadaTrade holder index', at: null, status: 'missing', note: 'Not read from the chain yet.' }
      : { source: 'NamadaTrade holder index', at: read, status: now - read > LIQUID_STALE_MS ? 'stale' : 'live' };
  };
  const hitOf = (r: AddrRow | null, address: string, match: SearchMatch): Hit => {
    const chain = (address.startsWith('osmo1') ? 'osmosis' : 'namada') as Chain;
    const raw = r?.label ?? INTERNAL_LABELS[address]?.label ?? null;
    const source = r?.label ? r.source : INTERNAL_LABELS[address] ? 'auto' : null;
    const plain = label_plain(raw, address, source);
    const cat = source === 'user' ? tagByline(source, labelAuthorShort(source, r?.author)) : category_plain(r?.category ?? INTERNAL_LABELS[address]?.category ?? null, raw);
    const holds = r ? holdsWords(r.total_num, r.stake_num) : '';
    return {
      type: 'address', group: 'addresses', kind: 'address', match, chain, value: address,
      title: plain ? `${plain} (${shortAddr(address)})` : address, subtitle: `${chainWord(chain)} address${cat ? ` · ${cat}` : ''}${holds}`,
      label: raw, label_plain: plain, category_plain: cat, href: `/holders?addr=${address}`, external: null, stamp: stampOf(r ?? ({ total_num: 0 } as AddrRow)),
      rankKey: [MATCH_RANK[match], -(r?.total_num ?? 0)],
    };
  };
  const a = p.address;
  if (a && isWholeAddress(a)) {
    const chain = a.startsWith('osmo1') ? 'osmosis' : 'namada';
    const r = await db.prepare(`SELECT ${ADDR_COLS} FROM holders h LEFT JOIN labels l ON l.address = h.address WHERE h.chain = ? AND h.address = ?`).bind(chain, a).first<AddrRow>();
    const lab = r ? null : await db.prepare('SELECT label, category, source, author FROM labels WHERE address = ?').bind(a).first<any>();
    // A whole address is always a result: its sheet reads it from the chain even when this site has no row for it.
    hits.push(hitOf(r ?? (lab ? ({ ...lab, total_num: 0, stake_num: 0 } as AddrRow) : null), a, 'exact'));
    return hits;
  }
  const conds: string[] = [];
  const params: unknown[] = [];
  if (a) {
    const [lo, hi] = prefixRange(a)!;
    conds.push('h.chain = ? AND h.address >= ? AND h.address < ?');
    params.push(a.startsWith('osmo1') ? 'osmosis' : 'namada', lo, hi);
  }
  if (p.tail) {
    conds.push('substr(h.address, -4) = ? AND substr(h.address, ?) = ?');
    params.push(p.tail.slice(-4), -p.tail.length, p.tail);
    if (p.chain && !a) { conds.push('h.chain = ?'); params.push(p.chain); }
  }
  if (!conds.length) return hits;
  // Every address of the start or end (up to ADDRESS_CANDIDATES, in key order), ranked here by what each holds: the
  // biggest holders first is then true for any start of 8 characters (the largest bucket on 2026-10-20, tnam1qqx,
  // held 565 addresses; it is read whole, 565 rows). No sort in SQL: the key order is the index's own.
  const rows = (await db.prepare(`SELECT ${ADDR_COLS} FROM holders h LEFT JOIN labels l ON l.address = h.address WHERE ${conds.join(' AND ')} LIMIT ?`).bind(...params, ADDRESS_CANDIDATES).all<AddrRow>()).results || [];
  for (const r of rows) hits.push(hitOf(r, r.address, a ? 'start' : 'end'));
  return hits;
}

async function searchRecords(db: D1Database, p: Parsed, limit: number): Promise<Hit[]> {
  if (!p.hash) return [];
  const [lo, hi] = prefixRange(p.hash)!;
  // One range on each hash index; a record found under two of its hashes is one result.
  const rows = (await Promise.all(HASH_COLUMNS.map((col) =>
    db.prepare(`SELECT f.id, f.chain, f.height, f.ts, f.kind, f.amount_num, f.tx_hash, f.meta FROM flows f WHERE ${col} >= ? AND ${col} < ? LIMIT ?`).bind(lo, hi, limit + 1).all<any>().then((r) => r.results || [])))).flat();
  const by = new Map<string, any>();
  for (const r of rows) by.set(r.id, r);
  return [...by.values()].map((r): Hit => {
    const meta = safeParseJson(r.meta, null) as Record<string, unknown> | null;
    const hashes = [r.tx_hash, meta?.wrapper, meta?.innerTxHash].filter((h): h is string => typeof h === 'string').map((h) => h.toUpperCase());
    const match: SearchMatch = hashes.includes(p.hash!) ? 'exact' : 'start';
    const value = explorerHashOf({ txHash: r.tx_hash, meta });
    const otherCoin = typeof meta?.tokenSymbol === 'string' ? meta.tokenSymbol : null;
    return {
      type: 'tx', group: 'records', kind: 'record', match, chain: r.chain, value,
      title: `${KIND_WORDS[r.kind] ?? 'Move'} ${namWords(r.amount_num)} ${otherCoin ?? 'NAM'}`,
      subtitle: `Block ${Number(r.height).toLocaleString('en-US')} on ${chainWord(r.chain)} · ${utcWords(r.ts)} · ${value.slice(0, 12)}…`,
      href: `/activity?q=${value}`, external: r.chain === 'osmosis' ? EXPLORERS.osmoTx(value) : NAMADA_SHARED.explorerTx(value),
      stamp: { source: 'NamadaTrade flow index', at: r.ts, status: 'live' },
      rankKey: [MATCH_RANK[match], -r.ts],
    };
  });
}

interface NameRow { address: string; chain: string; label: string; category: string; source: string; author: string | null; updated_at: number | null; total_num: number | null; stake_num: number | null }

/**
 * Labels whose words start with every typed word (label_tokens), or by LIKE before migration 0008.
 *
 * Cost per call: the token range of each word read into a list once (a few dozen entries for a specific name; about
 * 5,300 to 5,900 for the broadest starts, "gen", "pub", "all", "com", "genesis", on the 2026-10-20 label mix), then
 * the labels found by primary key, at most NAME_CANDIDATES. When a word matches more labels than that (thousands of
 * genesis allocations share their words), the first NAME_CANDIDATES in key order say nothing about who holds the most,
 * so the biggest Namada holders among the matches are read too: a walk of the stored totals' index, largest first
 * (index entries only), that stops at the NAME_WALK_TAKE-th match and never goes past the NAME_WALK_MAX largest
 * holders, whatever it finds (at production's proportions: about 100 entries for "genesis", the cap for a word whose
 * labels hold little). Both reads are merged; the ranking is searchNames' (match tier, then holdings).
 */
async function nameRows(db: D1Database, keys: WordKeys[]): Promise<NameRow[]> {
  // what each named address holds, by primary key (one row per name found), so six "Anoma Foundation" wallets differ
  const cols = 'l.address, l.chain, l.label, l.category, l.source, l.author, l.updated_at, h.total_num, h.stake_num';
  const from = 'labels l LEFT JOIN holders h ON h.chain = l.chain AND h.address = l.address';
  if (!labelTokensMissing) {
    // the words the statement selects by, within D1's bound parameters (the LIMIT after them); the caller checks every word
    const sqlKeys = sqlWordKeys(keys, D1_MAX_PARAMS - 1, wordCondCost);
    if (!sqlKeys.length) return [];
    const conds = sqlKeys.map((k) => wordCond(k, 'l.address'));
    try {
      const r = await db.prepare(`SELECT ${cols} FROM ${from} WHERE ${conds.map((c) => c.sql).join(' AND ')} LIMIT ?`).bind(...conds.flatMap((c) => c.params), NAME_CANDIDATES).all<NameRow>();
      const byLabel = r.results || [];
      if (byLabel.length < NAME_CANDIDATES) return byLabel;
      const walk = sqlKeys.map((k) => wordCond(k, 'k.address'));
      const big = await db.prepare(`SELECT ${cols} FROM (SELECT h2.address FROM holders h2 INDEXED BY holders_total WHERE h2.chain = 'namada' AND +h2.total_num > 0
          ORDER BY h2.total_num DESC, h2.address LIMIT ${NAME_WALK_MAX}) k CROSS JOIN labels l ON l.address = k.address
          LEFT JOIN holders h ON h.chain = l.chain AND h.address = l.address WHERE ${walk.map((c) => c.sql).join(' AND ')} LIMIT ?`)
        .bind(...walk.flatMap((c) => c.params), NAME_WALK_TAKE).all<NameRow>();
      const out = new Map<string, NameRow>();
      for (const row of [...(big.results || []), ...byLabel]) if (!out.has(row.address)) out.set(row.address, row);
      return [...out.values()];
    } catch (e) {
      if (!/no such table/i.test(String(e))) throw e;
      labelTokensMissing = true;
    }
  }
  // each word, or one of the raw fragments it stands for, anywhere in the label (labelMatches keeps the word starts)
  const terms = sqlWordKeys(keys, D1_MAX_PARAMS - 1, (k) => 1 + k.fragments.length).map((k) => [k.word, ...k.fragments]);
  const like = terms.map((t) => `(${t.map(() => 'l.label LIKE ?').join(' OR ')})`);
  if (!terms.length) return [];
  const r = await db.prepare(`SELECT ${cols} FROM ${from} WHERE ${like.join(' AND ')} LIMIT ?`).bind(...terms.flat().map((t) => `%${t}%`), NAME_CANDIDATES * 2).all<NameRow>();
  return r.results || [];
}

/**
 * The words a name is searched by, in the order typed: the text with every identifier, size and date the grammar read
 * left out. The words it read as a kind, a chain or a holder group stay ("shielded pool" is a filter for the lists and
 * also the name of the shielded pool's account).
 */
const NAME_FIELDS = new Set(['text', 'kind', 'chain', 'what', 'bots', 'crossings']);
function nameWordsOf(q: string, p: Parsed): string[] {
  // the spans are UTF-16 offsets into the input, as split('') indexes it
  const text = q.slice(0, INPUT_MAX).split('');
  for (const ch of p.chips) if (ch.fields.some((f) => !NAME_FIELDS.has(f))) for (let i = ch.span[0]; i < ch.span[1]; i++) text[i] = ' ';
  return labelWords(text.join(''));
}

async function searchNames(db: D1Database, q: string, p: Parsed, now: number): Promise<{ names: Hit[]; pools: Hit[] }> {
  const words = nameWordsOf(q, p);
  const names: Hit[] = [];
  const pools: Hit[] = [];
  const poolHit = (r: { address: string; label: string; updated_at?: number | null }, match: SearchMatch): Hit | null => {
    const id = /#(\d+)/.exec(r.label)?.[1];
    if (!id) return null;
    return {
      type: 'pool', group: 'pools', kind: 'pool', match, chain: 'osmosis', value: id, title: r.label.replace(/^Osmosis Pool #/, 'Osmosis pool '),
      subtitle: `An Osmosis pool holding NAM · ${shortAddr(r.address)}`, label: r.label, label_plain: r.label, href: '/trade', external: null,
      stamp: null, rankKey: [MATCH_RANK[match], Number(id)],
    };
  };
  // A pool by its number (1 to 4 digits): the pool labels (28 rows on labels_cat).
  if (p.pool != null) {
    const rows = (await db.prepare(`SELECT address, label, updated_at FROM labels INDEXED BY labels_cat WHERE category = 'pool'`).all<{ address: string; label: string; updated_at: number | null }>()).results || [];
    for (const r of rows) if (new RegExp(`#${p.pool}\\b`).test(r.label)) { const h = poolHit(r, 'exact'); if (h) pools.push(h); }
  }
  if (!words.length) return { names, pools };
  const keys = words.map(wordKeys);
  const text = words.join(' ');
  const seen = new Set<string>();
  for (const r of await nameRows(db, keys)) {
    if (!labelMatches(r.label, r.address, r.source, keys) || seen.has(r.address)) continue;
    seen.add(r.address);
    const match = labelMatch(r.label, r.address, r.source, text);
    if (r.category === 'pool') { const h = poolHit(r, match); if (h) pools.push(h); continue; }
    const plain = label_plain(r.label, r.address, r.source);
    const cat = r.source === 'user' ? tagByline(r.source, labelAuthorShort(r.source, r.author)) : category_plain(r.category, r.label);
    names.push({
      type: 'label', group: 'names', kind: r.category === 'validator' ? 'validator' : 'name', match, chain: r.chain as Chain, value: r.address,
      // the address is not repeated here: every client prints it beside the name (it is `value`)
      title: plain ?? r.label, subtitle: `${cat ? `${cat} · ` : ''}${chainWord(r.chain)} address${holdsWords(r.total_num, r.stake_num)}`,
      label: r.label, label_plain: plain, category_plain: cat, href: `/holders?addr=${r.address}`, external: null,
      stamp: { source: LABEL_SOURCE_WORDS[r.source] ?? r.source, at: r.updated_at ?? null, status: r.updated_at ? 'live' : 'missing', ...(r.updated_at ? {} : { note: 'When this name was written is not recorded.' }) },
      // the names of one account first, then a wallet's own tag, then a shared allocation name (thousands of genesis addresses)
      rankKey: [MATCH_RANK[match], r.source === 'user' ? 1 : r.source === 'genesis' && /^genesis\s*:/i.test(r.label) ? 2 : 0, -(r.total_num ?? 0)],
    });
  }
  // The protocol accounts by the names the site gives them (config.ts), and validators by the stored list's names.
  for (const [address, l] of Object.entries(INTERNAL_LABELS)) {
    const plain = label_plain(l.label, address, 'auto');
    if (seen.has(address) || !labelMatches(plain, address, 'auto', keys)) continue;
    seen.add(address);
    const match = labelMatch(plain ?? l.label, address, 'auto', text);
    names.push({
      type: 'label', group: 'names', kind: 'name', match, chain: (address.startsWith('osmo1') ? 'osmosis' : 'namada') as Chain, value: address,
      title: plain ?? l.label, subtitle: `Protocol account on ${address.startsWith('osmo1') ? 'Osmosis' : 'Namada'}`, label: l.label, label_plain: plain, category_plain: category_plain(l.category, l.label),
      href: `/holders?addr=${address}`, external: null, stamp: { source: 'NamadaTrade labels', at: null, status: 'missing', note: 'A protocol account named in the site\'s configuration.' },
      rankKey: [MATCH_RANK[match], 0],
    });
  }
  const vals = await kvGetJson<{ at: number; validators: { address: string; name: string | null; commission: number | null; state: string | null }[] }>(db, 'validators.names').catch(() => null);
  for (const v of vals?.validators ?? []) {
    if (!v.name || seen.has(v.address)) continue;
    const vw = labelWords(v.name);
    if (!words.every((w) => vw.some((x) => x.startsWith(w)))) continue;
    seen.add(v.address);
    const vt = vw.join(' ');
    const match: SearchMatch = vt === text ? 'exact' : vt.startsWith(text) ? 'start' : 'word';
    names.push({
      type: 'validator', group: 'names', kind: 'validator', match, chain: 'namada', value: v.address, title: v.name,
      subtitle: `Validator${v.state === 'jailed' ? ' (jailed)' : ''} · Namada address`, label: v.name, label_plain: v.name, category_plain: 'Validator',
      href: `/holders?addr=${v.address}`, external: null,
      stamp: { source: 'Namada indexer validator list', at: vals!.at, status: now - vals!.at > 36 * H_MS ? 'stale' : 'live' },
      rankKey: [MATCH_RANK[match], 0],
    });
  }
  return { names, pools };
}

async function searchBlocks(db: D1Database, p: Parsed): Promise<Hit[]> {
  if (p.height == null) return [];
  const rows = (await db.prepare(`SELECT chain, COUNT(*) n, MIN(ts) ts FROM flows INDEXED BY flows_chain_height WHERE chain IN ('namada', 'osmosis') AND height = ? GROUP BY chain`).bind(p.height).all<{ chain: Chain; n: number; ts: number }>()).results || [];
  return rows.filter((r) => r.n > 0 && (!p.chain || r.chain === p.chain)).map((r): Hit => ({
    type: 'block', group: 'blocks', kind: 'block', match: 'exact', chain: r.chain, value: String(p.height),
    title: `Block ${p.height!.toLocaleString('en-US')} on ${chainWord(r.chain)}`, subtitle: `${r.n.toLocaleString('en-US')} ${r.n === 1 ? 'move' : 'moves'} recorded · ${utcWords(r.ts)}`,
    href: `/activity?q=${encodeURIComponent(`block ${p.height}`)}${r.chain ? `&chain=${r.chain}` : ''}`, external: null,
    stamp: { source: 'NamadaTrade flow index', at: r.ts, status: 'live' }, rankKey: [0, r.chain === 'namada' ? 0 : 1],
  }));
}

app.get('/api/search', async (c) => {
  const q = (c.req.query('q') || '').trim().slice(0, INPUT_MAX);
  const lim = Number(c.req.query('limit'));
  const limit = Number.isInteger(lim) && lim >= 1 ? Math.min(SEARCH_LIMIT_MAX, lim) : SEARCH_LIMIT;
  const now = Date.now();
  if (!q) return c.json({ results: [], asOf: now, groups: [] } satisfies SearchResponse);
  const db = c.env.DB;
  const p = parse(q, { now });
  const listed = p.address || p.tail ? await listingTimes(db) : { balance: null, bond: null };
  const [addresses, records, named, blocks] = await Promise.all([
    searchAddresses(db, p, limit, listed, now), searchRecords(db, p, limit), searchNames(db, q, p, now), searchBlocks(db, p),
  ]);
  const groups = [
    grouped('addresses', addresses, limit), grouped('records', records, limit), grouped('names', named.names, limit),
    grouped('pools', named.pools, limit), grouped('blocks', blocks, limit),
  ];
  const res: SearchResponse = { results: groups.flatMap((g) => g.list), asOf: now, groups: groups.map((g) => g.meta) };
  return c.json(res);
});

// ---------------------------------------------------------------- auth (signed-message login, sessions, pairing)
app.post('/api/auth/nonce', async (c) => {
  const body = await jsonObject(c);
  const address = String(body.address || '').trim();
  // A real address shape only (chainOf: bech32 charset, bounded length): the nonce row stores it as given.
  if (!chainOf(address)) return c.json({ error: 'address must be tnam1… or osmo1…' }, 400);
  return c.json(await issueNonce(c.env.DB, address));
});

app.post('/api/auth/login', async (c) => {
  const body = await jsonObject(c);
  const r = await login(c.env.DB, body);
  return r.session ? c.json({ session: r.session }) : c.json({ error: r.error }, 401);
});

app.get('/api/auth/me', async (c) => c.json({ session: await sessionFromRequest(c.env.DB, c.req.raw) }));

app.post('/api/auth/logout', async (c) => {
  const s = await sessionFromRequest(c.env.DB, c.req.raw);
  if (s) await logout(c.env.DB, s.token);
  return c.json({ success: true });
});

/**
 * The requests only a signed-in device may make, never an API key: making API keys and pairing a device (a paired
 * device gets a full session, which can make keys), and deleting the account. Otherwise a leaked key could make
 * fresh keys and sessions that outlive revoking it, or erase the owner's account. A key also cannot end a
 * signed-in or paired device (revokeSession), so the owner can always sign in and revoke a leaked key. Everything
 * else accepts a key.
 */
export const FULL_SESSION_ONLY = {
  pair: 'an API key cannot pair a device',
  apikey: 'an API key cannot mint API keys',
  deleteAll: 'an API key cannot delete the account; do it from a signed-in device',
  revokeDevice: 'an API key can end API keys only; end a device from a signed-in device',
} as const;
async function requireFullSession(c: any, action: keyof typeof FULL_SESSION_ONLY): Promise<Awaited<ReturnType<typeof sessionFromRequest>> | Response> {
  const s = await sessionFromRequest(c.env.DB, c.req.raw);
  if (!s) return c.json({ error: 'sign in first' }, 401);
  if (s.via === 'api') return c.json({ error: FULL_SESSION_ONLY[action] }, 403);
  return s;
}

// A pair code's row is keyed by an HMAC under SETTINGS_KEY (auth.ts pairKey): without the secret, no code.
app.post('/api/auth/pair', async (c) => {
  const s = await requireFullSession(c, 'pair');
  if (s instanceof Response) return s;
  let key: string;
  try { key = requireKey(c.env); } catch (e) { return c.json({ error: String((e as Error).message) }, 503); }
  const r = await createPairCode(c.env.DB, s!, key);
  return 'error' in r ? c.json({ error: r.error }, 503) : c.json(r);
});

app.post('/api/auth/pair/claim', async (c) => {
  const body = await jsonObject(c);
  let key: string;
  try { key = requireKey(c.env); } catch (e) { return c.json({ error: String((e as Error).message) }, 503); }
  const r = await claimPairCode(c.env.DB, String(body.code || ''), key);
  return r.session ? c.json({ session: r.session }) : c.json({ error: r.error }, 400);
});

// ---------------------------------------------------------------- /api/me — the signed-in user's settings, devices, keys, data
async function me(c: any): Promise<{ s: Awaited<ReturnType<typeof sessionFromRequest>>; key: string } | Response> {
  const s = await sessionFromRequest(c.env.DB, c.req.raw);
  if (!s) return c.json({ error: 'sign in first' }, 401);
  let key: string;
  try { key = requireKey(c.env); } catch (e) { return c.json({ error: String((e as Error).message) }, 503); }
  return { s, key };
}

async function settingsOrDefault(db: D1Database, key: string, address: string): Promise<StoredSettings> {
  return (await loadSettings(db, key, address)) ?? { address, notifications: defaultPrefs(), channels: { discord: { enabled: false, webhookUrl: null } }, createdAt: Date.now(), updatedAt: Date.now() };
}

/**
 * The row's public view. The note of a connection notice that did not reach the channel (`notice`, set by PUT
 * /api/me/settings) is shown only while no post to the link has succeeded (the row's okAt, settings.ts linkProven):
 * the first alert or test post Discord takes proves the link, and the note goes. Rows without the note read nothing.
 */
async function viewOf(db: D1Database, key: string, s: StoredSettings) {
  const url = s.channels.discord.webhookUrl;
  const proven = !!(s.channels.discord.notice && url) && (await linkProven(db, key, s.address, url!));
  return publicView(s, proven);
}

app.get('/api/me/settings', async (c) => {
  const r = await me(c); if (r instanceof Response) return r;
  return c.json({ settings: await viewOf(c.env.DB, r.key, await settingsOrDefault(c.env.DB, r.key, r.s!.address)) });
});

/** One test post or connection notice per wallet every 30 s: each is an outbound Discord call the caller chooses the target of. */
export const WEBHOOK_TEST_COOLDOWN_MS = 30_000;
/** A settings row saved within this long is a fresh one: its test post goes once a window even when the shared test budget is spent (sources/discord.ts testPostHeld). */
export const FRESH_ROW_MS = 24 * 3_600_000;
/** What a wallet is told when its link is paused here (it failed, asked to wait or is gone). */
export const TEST_LINK_PAUSED = 'Test posts to this link are paused for a few minutes. Try again later.';
/** What a wallet is told when test posts are held site-wide (the window's ceiling or the test posts' budget is spent): its link is not blamed. */
export const TEST_SITE_BUSY = 'Test posts are paused site-wide for a few minutes: too many links were answered invalid in this window. Your link is not at fault; try again later.';
/** What a wallet is told while it waits for the next window after an invalid answer (`min`: how long). */
export const testWalletWaits = (min: number) => `Discord answered that the link tested last from this wallet is invalid, so test posts from this wallet wait for the next 10-minute window (about ${min} min). Check the link in Discord first.`;
/** What a wallet is told when the save that would turn a link on cannot post the connection notice because this Worker sends no alerts. */
export const SAVE_ALERTS_OFF = 'Alerts are off on this server, so a Discord channel cannot be turned on: nothing was posted to the link, and nothing was saved.';
/** What a wallet is told when the link it saves is paused here (it failed lately, or Discord said it is gone or its token is wrong): nothing is saved. */
export const SAVE_LINK_PAUSED = 'Posts to this link are paused here: it failed lately, or Discord said it is gone or its token is wrong. Nothing was saved; paste a new link from Discord, or try again later.';
/** What a wallet is told when the link is in Discord's short Retry-After pause here (its bucket is full for a few seconds): nothing is saved. */
export const SAVE_LINK_SHORT_PAUSE = 'Discord asked for a short pause on this link; try again in a few seconds. Nothing was saved.';
export const TEST_LINK_SHORT_PAUSE = 'Discord asked for a short pause on this link; try again in a few seconds.';
/** What a wallet is told when the link is held for the window as kept rate-limited (sources/discord.ts RATE_LIMITED_HOLD_AFTER): nothing is saved. */
export const SAVE_LINK_RATE_LIMITED = 'Discord has answered posts to this link rate-limited several times in a few minutes, its limit filled by posts from elsewhere, so posts to it wait for the next 10-minute window; nothing was saved. If another service posts to the same webhook, make one for this site alone.';
export const TEST_LINK_RATE_LIMITED = 'Discord has answered posts to this link rate-limited several times in a few minutes, its limit filled by posts from elsewhere, so posts to it wait for the next 10-minute window. If another service posts to the same webhook, make one for this site alone.';
/** What a wallet is told while it waits for the next window because its last post went out past the spent test budget on a fresh row's allowance (`min`: how long): its link is not blamed. */
export const testWalletOver = (min: number) => `The site's budget for test posts is spent for this window, and this wallet's last post went out past it on a new row's allowance, so posts from this wallet wait for the next 10-minute window (about ${min} min). The link is not at fault.`;
/** The words for a link whose post is held (sources/discord.ts testPostHeld), by what holds it, for the save and for the test button. */
const heldWords = (held: 'link' | 'limited' | 'pause' | 'site', what: 'test' | 'save') =>
  held === 'site' ? TEST_SITE_BUSY
    : held === 'pause' ? (what === 'save' ? SAVE_LINK_SHORT_PAUSE : TEST_LINK_SHORT_PAUSE)
    : held === 'limited' ? (what === 'save' ? SAVE_LINK_RATE_LIMITED : TEST_LINK_RATE_LIMITED)
    : what === 'save' ? SAVE_LINK_PAUSED : TEST_LINK_PAUSED;
/** Why a wallet waits for the next window (waitForWindow): its last post was answered invalid, or went out past the spent test budget. */
type WaitWhy = 'invalid' | 'over';
/** What a wallet is told when its post waits for its cooldown (`wait`: how long is left), or for the window (`why`). */
const cooldownWords = (wait: number, what: 'test' | 'save', why: WaitWhy | null) => {
  if (wait > WEBHOOK_TEST_COOLDOWN_MS) {
    const min = Math.max(1, Math.ceil(wait / 60_000));
    return why === 'over' ? testWalletOver(min) : testWalletWaits(min);
  }
  return what === 'test' ? 'Wait 30 seconds before sending another test alert.' : 'A message was posted to a channel from this wallet less than 30 seconds ago. Wait 30 seconds, then save again; nothing was saved.';
};

/**
 * Takes the wallet's post cooldown at `now` by one statement, which writes only over a cooldown that has run out, so
 * posts the same wallet sends at once pass it once: how long is left (`wait`, 0 when taken) and, for a wait until the
 * next window, why (waitForWindow keeps the reason after the time, as "<time>:<why>"; the statement reads the time as
 * the value's integer prefix).
 */
async function takeCooldown(db: D1Database, address: string, now: number): Promise<{ wait: number; why: WaitWhy | null }> {
  const coolKey = `webhook_test:${address}`;
  const took = await db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at WHERE CAST(kv.value AS INTEGER) <= ?4`,
  ).bind(coolKey, String(now), now, now - WEBHOOK_TEST_COOLDOWN_MS).run();
  if (Number(took.meta?.changes ?? 0)) return { wait: 0, why: null };
  const row = await db.prepare('SELECT value FROM kv WHERE key = ?').bind(coolKey).first<{ value: string }>().catch(() => null);
  const [from, why] = String(row?.value ?? '').split(':');
  const v = Number(from);
  return {
    wait: Math.max(1, from !== '' && Number.isFinite(v) ? v + WEBHOOK_TEST_COOLDOWN_MS - now : WEBHOOK_TEST_COOLDOWN_MS),
    why: why === 'invalid' || why === 'over' ? why : null,
  };
}
/** Gives back the cooldown taken at `now`: nothing was posted. */
const giveBackCooldown = (db: D1Database, address: string, now: number) =>
  db.prepare('DELETE FROM kv WHERE key = ? AND value = ?').bind(`webhook_test:${address}`, String(now)).run().catch(() => {});
/**
 * After an invalid answer (the link is gone, its token wrong, or Discord refused the address), or a post that went
 * past the spent test budget on a fresh row's allowance: this wallet's next post waits until the next window, so a
 * few wallets cannot spend the shared budget by posting to made-up links every 30 s. The row's value is the time the
 * cooldown counts from, set so it runs out when the window turns, with the reason after it (`why`), so the wallet is
 * told the right thing when it comes back (cooldownWords).
 */
const waitForWindow = (db: D1Database, address: string, now: number, why: WaitWhy) => {
  const windowEnd = (Math.floor(now / INVALID_WINDOW_MS) + 1) * INVALID_WINDOW_MS;
  return db.prepare('UPDATE kv SET value = ? WHERE key = ? AND value = ?').bind(`${windowEnd - WEBHOOK_TEST_COOLDOWN_MS}:${why}`, `webhook_test:${address}`, String(now)).run().catch(() => {});
};
/** The answer of a post that did not happen (no answer). */
const NO_POST: TestPostAnswer = { ok: false, status: 0, invalid: false, blames: false, dead: false, over: false };
/**
 * An answer to the connection notice that says nothing of the link itself: no answer (0), a 5xx, or a 429 that is not
 * the link's own (of shared or global scope, with none of Discord's headers, or of user scope that the site's own
 * posts caused: sources/discord.ts blamesLink). A 400, 401, 403, 404 or a 429 of user scope that posts from elsewhere
 * caused is the link's own.
 */
const noticeTransient = (a: TestPostAnswer) => !a.ok && !a.blames && (a.status === 0 || a.status >= 500 || a.status === 429);
/**
 * Whether an answer keeps the wallet waiting for the next window (waitForWindow): an invalid answer, unless it is a
 * 429 that blames nothing of the link (a limit on the site's address, or the site's own posts filling the bucket),
 * which no made-up link can draw.
 */
const chargesWallet = (a: TestPostAnswer) => a.invalid && (a.status !== 429 || a.blames);
/** The connection notice is posted once more this long after an answer that says nothing of the link, inside the request. */
export const NOTICE_RETRY_MS = 1000;

app.put('/api/me/settings', async (c) => {
  const r = await me(c); if (r instanceof Response) return r;
  const body = await jsonObject(c);
  const address = r.s!.address;
  const cur = await settingsOrDefault(c.env.DB, r.key, address);
  const next = applyUpdate(cur, body);
  if (typeof next === 'string') return c.json({ error: next }, 400);
  // A save that turns a link on (a new link, or the row's link off and now on) proves it first, unless the row already
  // records a successful post to that link (settings.ts linkProven: an earlier save, a test post or an alert): the
  // connection notice (the test post's body, sources/discord.ts sendDiscordTestPost) is posted to the link inside this
  // request, under the test posts' budget (a fresh row's post goes once a window even when it is spent) and the
  // wallet's cooldown. Discord taking it turns the channel on, with the success recorded (hookOkStmt, after the save,
  // which keeps `okAt` only for the same link). An answer that blames the link (it is gone, its token is wrong, a 400,
  // a 429 of user scope that posts from elsewhere caused) leaves the row saved with the channel off and says why
  // (`stopped`: Discord's answer that the link is dead, or `reason` 'notice' with its status), so the Settings page
  // shows the reason beside the switch. An answer that says nothing of the link (none, a 5xx, a 429 of shared or
  // global scope or with none of Discord's headers) has the notice posted once more after a short wait, and when that
  // fails too the channel is saved on with a note (`notice`) the page shows until a post succeeds: a Discord blip at
  // the save costs the subscriber nothing. Such a row is on trial: the row being fresh (no okAt) the dispatcher holds
  // its link once the invalid-answer budget is spent, its first post (or a test post) Discord takes proves it, the
  // first answer that blames the link turns it off (sources/discord.ts stopTrialHooks), and one no post reaches within
  // a day has the notice posted again by the cron's tick, once a day, whose answer proves or stops it the same way,
  // the channel being turned off after three days of answers that say nothing either (sources/discord.ts
  // sweepNoticeChannels). So a row with Discord on is a link that took a post, or one that answered nothing against
  // itself every time and is on its trial. A site with every channel taken
  // posts nothing: the save below is refused by the cap and the row saved off.
  const url = next.channels.discord.webhookUrl;
  const turnsOn = !!url && next.channels.discord.enabled && !(cur.channels.discord.enabled && cur.channels.discord.webhookUrl === url);
  const now = Date.now();
  let sent: TestPostAnswer = NO_POST;
  if (turnsOn && !(await linkProven(c.env.DB, r.key, address, url)) && !(await channelsFull(c.env.DB, r.key, address, url))) {
    if (!alertsOn()) return c.json({ error: SAVE_ALERTS_OFF }, 503);
    if ((await refusalOf(c.env.DB, next)) === 'rows') { await noteSettingsRefused(c.env.DB, now, 'rows'); return c.json({ error: SETTINGS_FULL }, 503); }
    const held = await testPostHeld(url, c.env.DB, false, true);
    if (held) return c.json({ error: heldWords(held, 'save') }, 429);
    const { wait, why } = await takeCooldown(c.env.DB, address, now);
    if (wait) return c.json({ error: cooldownWords(wait, 'save', why) }, 429);
    const post = async (): Promise<TestPostAnswer | 'held'> => {
      try { return await sendDiscordTestPost(url, next, c.env.DB, false, true); } catch (e) { console.error('settings: the connection notice could not be posted', e); return NO_POST; }
    };
    let answer = await post();
    if (answer === 'held') { await giveBackCooldown(c.env.DB, address, now); return c.json({ error: TEST_SITE_BUSY }, 429); }
    let over = answer.over;
    if (noticeTransient(answer)) {
      // Once more, after a short wait. A retry the link's own Retry-After pause holds back is not made, and the first
      // answer stands.
      await new Promise((resolve) => setTimeout(resolve, NOTICE_RETRY_MS));
      const again = await post();
      if (again !== 'held') { answer = again; over = over || again.over; }
    }
    sent = answer;
    if (chargesWallet(sent) || over) await waitForWindow(c.env.DB, address, now, chargesWallet(sent) ? 'invalid' : 'over');
    if (!sent.ok) {
      if (noticeTransient(sent)) next.channels.discord.notice = { status: sent.status, at: now };
      else {
        next.channels.discord.enabled = false;
        next.channels.discord.stopped = sent.dead ? { status: sent.status, at: now } : { status: sent.status, at: now, reason: 'notice' };
      }
    }
  }
  // The Telegram chat as stored now, with this save's own change (pause, resume, disconnect) applied to it: the bot may
  // have linked or unlinked it while this request ran (the connection notice above can take seconds), and the save must
  // not put back a chat it read earlier, nor resume one that sent /stop. A chat resumed here takes a place under
  // TELEGRAM_CHATS_MAX as a new link does (telegram-bot.ts): past it the row is saved with sending still paused (409).
  const fresh = await loadSettings(c.env.DB, r.key, address).catch(() => null);
  if (fresh) {
    const tg = body.channels?.telegram ? telegramUpdate(telegramOf(fresh), body.channels.telegram) : fresh.channels.telegram;
    if (typeof tg === 'string') return c.json({ error: tg }, 400);
    next.channels.telegram = tg;
  }
  const tgWas = telegramOf(fresh ?? cur);
  const tgNow = telegramOf(next);
  let tgFull = false;
  if (tgNow.enabled && tgNow.chatId != null && !(tgWas.enabled && tgWas.chatId === tgNow.chatId)
    && (await telegramChatsOther(c.env.DB, r.key, tgNow.chatId)) >= TELEGRAM_CHATS_MAX) {
    next.channels.telegram = { ...tgNow, enabled: false };
    tgFull = true;
  }
  // Refused when the save would give a new address a row past USER_ROWS_MAX (503: nothing of the wallet is stored),
  // or turn Discord on while the site already has DELIVERABLE_MAX channels on (409: the row is saved with the channel
  // off, so the link and the other changes are kept, and the owner is told, instead of a channel that would never be
  // read). Either is recorded for the health row.
  let full = false;
  if (!(await saveSettings(c.env.DB, r.key, next))) {
    const cap = await refusalOf(c.env.DB, next);
    await noteSettingsRefused(c.env.DB, now, cap);
    if (cap === 'rows') return c.json({ error: SETTINGS_FULL }, 503);
    full = true;
    next.channels.discord.enabled = false;
    if (!(await saveSettings(c.env.DB, r.key, next))) return c.json({ error: SETTINGS_FULL }, 503);
  }
  // A notice Discord took is a successful post to the saved link, on or off: the row records it, so the link needs no
  // post of its own when the channel is next turned on.
  if (sent.ok) await hookOkStmt(c.env.DB, r.key, address, url!, now).run().catch((e) => console.error('settings: the connection notice was not recorded', e));
  // A Telegram chat disconnected here is told so, once (it may be shared by another wallet's row, whose alerts go on);
  // one the bot unlinked meanwhile is not.
  const wasChat = tgWas.chatId;
  if (wasChat != null && telegramOf(next).chatId == null) {
    forgetTelegramUsers(c.env.DB);
    if (sendsTelegram(c.env)) await tgSend(c.env.TELEGRAM_BOT_TOKEN!, wasChat, { html: `NamadaTrade alerts for <code>${fmtAddr(address)}</code> were disconnected from this chat in Settings.` }).catch(() => {});
  } else if (telegramOf(next).enabled !== tgWas.enabled) forgetTelegramUsers(c.env.DB);
  const view = await viewOf(c.env.DB, r.key, next);
  return full || tgFull ? c.json({ error: full ? CHANNELS_FULL : TELEGRAM_FULL, settings: view }, 409) : c.json({ settings: view });
});

/** What the preview of the digest answers when the digest could not be built: nothing was posted. */
export const PREVIEW_NOT_BUILT = 'The digest could not be built just now, so nothing was posted. Try again in a few minutes.';

app.post('/api/me/settings/test', async (c) => {
  const r = await me(c); if (r instanceof Response) return r;
  // { preview: 'digest' } posts the daily digest as built now, with this wallet's watchlist, in place of the test
  // message, under the same checks, cooldown and test budget; any other body sends the test message.
  const asked = await c.req.json().catch(() => null) as { preview?: unknown } | null;
  const preview = asked?.preview === 'digest';
  // A Worker that does not send alerts (its SEND_ALERTS secret is not yes) says so plainly: nothing is posted, the
  // user's settings are not read, the cooldown is not started, and the user's link is not blamed.
  if (!alertsOn()) return c.json({ error: 'Alerts are off on this server' }, 503);
  const address = r.s!.address;
  const cur = await settingsOrDefault(c.env.DB, r.key, address);
  const url = cur.channels.discord.webhookUrl;
  if (!url) return c.json({ error: 'no Discord webhook saved' }, 400);
  const now = Date.now();
  // A link with a recorded success (settings.ts linkProven) tests without a unit of the shared test budget; a row
  // saved today tests once a window even when that budget is spent (its wallet then waits for the next window).
  const proven = await linkProven(c.env.DB, r.key, address, url);
  const fresh = cur.updatedAt > now - FRESH_ROW_MS;
  // A link that is paused here (it failed, is in a short Retry-After pause, is held as kept rate-limited, or is gone),
  // and any link not proven once the window's ceiling of invalid Discord answers is spent or the test posts' own
  // budget is (sources/discord.ts testPostHeld): nothing is posted and the cooldown is not started. Each hold says what
  // it is; one that is the site's says so, not the link.
  const paused = (why: 'link' | 'limited' | 'pause' | 'site') => c.json({ error: heldWords(why, 'test') }, 429);
  const held = await testPostHeld(url, c.env.DB, proven, fresh);
  if (held) return paused(held);
  const { wait, why } = await takeCooldown(c.env.DB, address, now);
  if (wait) return c.json({ error: cooldownWords(wait, 'test', why) }, 429);
  // the test message: the rules as saved and, as its example, the newest move on record that matches them; or the
  // digest's preview, built before any unit of the test budget is taken (no claim, no delivery record)
  let sent: 'held' | TestPostAnswer;
  if (preview) {
    let posts: WebhookPost[];
    try { posts = await previewPosts(c.env.DB, cur, now); } catch (e) {
      console.error('settings: the digest preview could not be built', e);
      await giveBackCooldown(c.env.DB, address, now);
      return c.json({ error: PREVIEW_NOT_BUILT }, 503);
    }
    sent = await sendDiscordPreview(url, posts, c.env.DB, proven, fresh);
  } else sent = await sendDiscordTestPost(url, cur, c.env.DB, proven, fresh, 'test');
  if (sent === 'held') {
    // Another test post took the budget's last unit meanwhile: nothing was posted, so the cooldown is given back.
    await giveBackCooldown(c.env.DB, address, now);
    return paused('site');
  }
  if (chargesWallet(sent) || sent.over) await waitForWindow(c.env.DB, address, now, chargesWallet(sent) ? 'invalid' : 'over');
  // A test post Discord took is a successful post to the saved link: the row records it (hookOkStmt), so turning
  // the channel on needs no post of its own. The test is a plain re-check: it changes nothing else, but for a channel
  // on trial (saved on with the connection notice's note, no success recorded) whose link the answer blames: that
  // channel is turned off as the dispatcher's first post would turn it off (sources/discord.ts stopTrialHooks), with
  // Discord's answer, written only while the row is as it was read and still records no success.
  if (sent.ok) await hookOkStmt(c.env.DB, r.key, address, url, now).run().catch((e) => console.error('settings: a test post was not recorded', e));
  else if (sent.blames && cur.channels.discord.enabled && cur.channels.discord.notice && !proven) {
    const stop = await stopChannelStmt(c.env.DB, r.key, cur, sent.status, now, sent.dead ? undefined : 'notice');
    await stop.run().catch((e) => console.error('settings: a channel on trial was not turned off', e));
  }
  return c.json({ success: sent.ok });
});

app.get('/api/me/sessions', async (c) => {
  const s = await sessionFromRequest(c.env.DB, c.req.raw);
  if (!s) return c.json({ error: 'sign in first' }, 401);
  return c.json({ sessions: await listSessions(c.env.DB, s.address, s.token) });
});

app.delete('/api/me/sessions/:id', async (c) => {
  const s = await sessionFromRequest(c.env.DB, c.req.raw);
  if (!s) return c.json({ error: 'sign in first' }, 401);
  const r = await revokeSession(c.env.DB, s.address, c.req.param('id'), s.via === 'api');
  return r === 'forbidden' ? c.json({ error: FULL_SESSION_ONLY.revokeDevice }, 403) : c.json({ success: r });
});

/** A long-lived bearer token for scripts: the rights of a session except FULL_SESSION_ONLY, shown once. */
app.post('/api/me/apikey', async (c) => {
  const s = await requireFullSession(c, 'apikey');
  if (s instanceof Response) return s;
  // made from this device's session: a revoke that ends it while this request runs ends the new key too
  const k = await createSession(c.env.DB, s!.address, s!.chain, 'api', null, tokenHash(s!.token));
  if ('error' in k) return c.json({ error: k.error }, 409);
  return c.json({ token: k.token, expiresAt: k.expiresAt });
});

/** Everything stored about the user, as JSON (secrets masked). */
app.get('/api/me/export', async (c) => {
  const r = await me(c); if (r instanceof Response) return r;
  const cur = await settingsOrDefault(c.env.DB, r.key, r.s!.address);
  const sessions = await listSessions(c.env.DB, r.s!.address, r.s!.token);
  return c.json({ exportedAt: Date.now(), address: r.s!.address, settings: await viewOf(c.env.DB, r.key, cur), sessions, note: 'The Discord webhook URL and the Telegram chat are stored encrypted and are not included.' });
});

// ---------------------------------------------------------------- Telegram (worker/src/telegram-bot.ts, sources/telegram.ts)

/** What a wallet is told when this Worker sends nothing to Telegram (alerts off, or no bot token). */
export const TELEGRAM_OFF = 'Telegram alerts are off on this server, so a chat cannot be connected or tested.';
/** One Telegram test message per wallet every 30 s. */
export const TELEGRAM_TEST_COOLDOWN_MS = 30_000;

/** A one-time link that opens the bot and connects the chat (or a group) where Start is pressed. */
app.post('/api/me/telegram/link', async (c) => {
  const r = await me(c); if (r instanceof Response) return r;
  if (!sendsTelegram(c.env)) return c.json({ error: TELEGRAM_OFF }, 503);
  const now = Date.now();
  const k = await createLinkCode(c.env.DB, r.key, r.s!.address, tokenHash(r.s!.token), now);
  // `now`: the server's time, which the page compares the link's time with (a browser's clock may be off)
  return c.json({ chat: k.chat, group: k.group, expiresAt: k.expiresAt, now });
});

/** Cancel on the page: the open connect link links nothing any more. */
app.delete('/api/me/telegram/link', async (c) => {
  const r = await me(c); if (r instanceof Response) return r;
  await revokeLinkCode(c.env.DB, r.s!.address);
  return c.json({ success: true });
});

/** The test: the rules as saved and an example card, to the linked chat; a chat Telegram says is gone is unlinked. */
app.post('/api/me/telegram/test', async (c) => {
  const r = await me(c); if (r instanceof Response) return r;
  if (!sendsTelegram(c.env)) return c.json({ error: TELEGRAM_OFF }, 503);
  const address = r.s!.address;
  const cur = await settingsOrDefault(c.env.DB, r.key, address);
  const chat = telegramOf(cur).chatId;
  if (chat == null) return c.json({ error: 'Connect a Telegram chat first.' }, 400);
  const now = Date.now();
  const took = await c.env.DB.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?1, ?2, ?2)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at WHERE CAST(kv.value AS INTEGER) <= ?3`,
  ).bind(`tg_test:${address}`, now, now - TELEGRAM_TEST_COOLDOWN_MS).run();
  if (!Number(took.meta?.changes ?? 0)) return c.json({ error: 'Wait 30 seconds before sending another test message.' }, 429);
  const example = await testExample(c.env.DB, cur, now).catch(() => 'unread' as const);
  let ok = true;
  let to: number | string = chat;
  for (const m of testMessages(cur, example, now)) {
    const { a, chat: went } = await sendFollowing(c.env, to, m);
    to = went;
    if (a.ok) continue;
    ok = false;
    if (chatGone(a)) {
      await unlinkChat(c.env.DB, r.key, Number(to), a.status === 403 && Number(to) > 0 ? 'blocked' : 'removed', now);
      forgetTelegramUsers(c.env.DB);
      const after = await settingsOrDefault(c.env.DB, r.key, address);
      return c.json({ success: false, error: 'Telegram says this chat no longer takes messages from the bot (it was blocked, or removed from the group), so it was disconnected. Connect again from Settings.', settings: await viewOf(c.env.DB, r.key, after) });
    }
    break;
  }
  return c.json({ success: ok });
});

/**
 * Telegram's updates (setWebhook with secret_token: scripts/telegram-setup.mjs). The secret header is checked first; a
 * Worker without the secret answers 404. Every update is answered 200, even one the bot could not handle, so Telegram
 * never sends it again.
 */
app.post('/api/telegram/webhook', async (c) => {
  if (!c.env.TELEGRAM_WEBHOOK_SECRET || !secretMatches(c.req.header('x-telegram-bot-api-secret-token'), c.env.TELEGRAM_WEBHOOK_SECRET)) return c.json({ error: 'not found' }, 404);
  const update = await jsonObject(c);
  try { await handleUpdate(c.env, update); } catch (e) { console.error('telegram: an update was not handled', e); }
  return c.json({ ok: true });
});

/** Delete everything: settings (incl. webhook), all sessions and API keys. */
app.delete('/api/me', async (c) => {
  const s = await requireFullSession(c, 'deleteAll');
  if (s instanceof Response) return s;
  await deleteSettings(c.env.DB, s!.address);
  await revokeAllSessions(c.env.DB, s!.address);
  return c.json({ success: true });
});

// ---------------------------------------------------------------- donation (read-only; addresses are set with `wrangler d1 execute`, never over HTTP)
// Only what the operator saved in kv `donation.config`; nothing is filled in by default (a default would publish
// an address as the site's, which ties whoever owns it to the site).
app.get('/api/donation', async (c) => {
  const saved = (await kvGetJson<Partial<DonationConfig>>(c.env.DB, 'donation.config').catch(() => null)) ?? {};
  const config: DonationConfig = {
    transparentAddress: saved.transparentAddress ?? null,
    osmosisAddress: saved.osmosisAddress ?? null,
    shieldedAddress: saved.shieldedAddress ?? null,
  };
  return c.json(config);
});

// ---------------------------------------------------------------- GET /api/export/holders
// The holder list as CSV (or ?format=json): the same rows and order as /api/holders (?chain, ?by, ?category, ?search),
// with spendable, staked and total NAM. Every row by default (up to HOLDER_EXPORT_MAX); X-Total-Count says how many
// match and X-Truncated whether the file has fewer.
/** A leading = + - @, tab or CR makes spreadsheets (Excel, Numbers, Google Sheets) read a cell as a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;
/**
 * One CSV cell. Every text cell that starts like a formula gets a leading single quote and is quoted (OWASP), whoever
 * wrote it: labels, but also addresses, as a bridge receiver is free text the sender chose (an IBC packet's
 * receiver is checked only for length). Numbers reach this as numbers, so negative amounts stay numbers.
 */
export const csvCell = (v: unknown) => {
  if (v == null) return '';
  if (typeof v === 'string' && FORMULA_START.test(v)) return `"'${v.replace(/"/g, '""')}"`;
  const t = String(v);
  return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};
/** A text value with the formula guard alone (no CSV quoting); csvCell applies the same guard to every text cell. */
export const csvText = (v: unknown) => {
  const t = v == null ? '' : String(v);
  return FORMULA_START.test(t) ? `'${t}` : t;
};
export const csvOf = (header: string[], rows: unknown[][]) => [header.join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n') + '\n';
const isoOrBlank = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : '');
/** Far above the holder count (about 3,600 in Oct 2026), so a filtered export is never silently cut. */
export const HOLDER_EXPORT_MAX = 10_000;
export const FLOW_EXPORT_MAX = 5_000;
/** `total` null: not counted (a text search); the count header is then left out and `cut` says whether more match. */
const exportHeaders = (type: string, filename: string, total: number | null, count: number, cut = total != null && count < total) => ({
  'Content-Type': type,
  'Content-Disposition': `attachment; filename="${filename}"`,
  ...(total != null ? { 'X-Total-Count': String(total) } : {}),
  'X-Truncated': cut ? 'true' : 'false',
  'Access-Control-Expose-Headers': 'X-Total-Count, X-Truncated',
});

app.get('/api/export/holders', async (c) => {
  const db = c.env.DB;
  const chain = holderChain(c.req.query('chain'));
  if (!chain) return c.json({ error: 'chain must be all, namada or osmosis' }, 400);
  const format = (c.req.query('format') || 'csv').toLowerCase();
  if (format !== 'csv' && format !== 'json') return c.json({ error: 'format must be csv or json' }, 400);
  const by = holdersBy(c.req.query('by'));
  if (!by) return c.json({ error: 'by must be total, liquid or bonded' }, 400);
  const limit = Math.min(HOLDER_EXPORT_MAX, Math.max(100, parseInt(c.req.query('limit') || String(HOLDER_EXPORT_MAX), 10) || HOLDER_EXPORT_MAX));
  const min = holderSize(c.req.query('min'), 'min');
  const max = holderSize(c.req.query('max'), 'max');
  for (const v of [min, max]) if (v && typeof v === 'object') return c.json({ error: v.error }, 400);
  const now = Date.now();
  // The same rows and order as /api/holders: the first `limit` of the list, one walk of the sort's index.
  const ask: HolderAsk = { chain, by, category: holderCategory(c.req.query('category')), search: (c.req.query('search') || '').trim(), min: min as number | null, max: max as number | null };
  const [sel, supplyRow, listed] = await Promise.all([
    selectHolders(db, ask, { page: 1, limit, after: null }, now),
    metricAt(db, 'supply.total', now),
    listingTimes(db),
  ]);
  if ('error' in sel) return c.json({ error: sel.error }, 400);
  const matching = sel.total;
  const total = supplyRow?.value ?? null;
  const list = sel.rows.map((r, idx) => {
    const label = r.label || INTERNAL_LABELS[r.address]?.label || null;
    const category = r.category || INTERNAL_LABELS[r.address]?.category || null;
    const source = r.label ? r.label_source ?? null : INTERNAL_LABELS[r.address] ? 'auto' : null;
    const staked = stakeShown(r, listed);
    return {
      rank: idx + 1, chain: r.chain, address: r.address,
      spendableNam: r.balance_num, stakedNam: staked, stakedIsEstimate: r.chain === 'namada' && r.bonded_num == null && staked != null,
      totalNam: r.total_num, pctTotalSupply: total ? ((r.total_num / total) * 100).toFixed(6) : '',
      label: label_plain(label, r.address, source) ?? '', category: category_plain(category, label) ?? '',
      labelSource: source ?? '',
      spendableCheckedAt: isoOrBlank(listedWithNoNam(r, listed) ? listed.balance : r.has_row ? confirmedAt(r.verified_at, r.liquid_src, BALANCE_LISTING_SRC, listed.balance) : null),
      stakeCheckedAt: isoOrBlank(confirmedAt(r.bonded_verified_at, r.bonded_src, BOND_LISTING_SRC, listed.bond)),
    };
  });
  const cut = list.length < matching;
  const name = `namada-trade-holders-${chain}-${cut ? `first-${list.length}-of-${matching}-` : ''}${now}`;
  if (format === 'json') return c.json({ count: list.length, total: matching, truncated: cut, supplyTotal: total, by, holders: list }, 200, { 'X-Total-Count': String(matching), 'X-Truncated': String(cut) });
  const csv = csvOf(
    ['rank', 'chain', 'address', 'spendable_nam', 'staked_nam', 'staked_is_estimate', 'total_nam', 'pct_total_supply', 'label', 'category', 'label_source', 'spendable_checked_at', 'stake_checked_at'],
    list.map((r) => [r.rank, r.chain, r.address, r.spendableNam, r.stakedNam ?? '', r.stakedIsEstimate ? 'yes' : '', r.totalNam, r.pctTotalSupply, r.label, r.category, r.labelSource, r.spendableCheckedAt, r.stakeCheckedAt]),
  );
  return new Response(csv, { headers: exportHeaders('text/csv; charset=utf-8', `${name}.csv`, matching, list.length) });
});

// ---------------------------------------------------------------- GET /api/export/flows
// Moves as CSV (or ?format=json), with the same filters as /api/flows (?chain ?kind ?whale ?minNam ?arb=false ?pairs=one
// ?search ?at). Newest first, up to 5,000 rows (?limit, default 5,000). X-Total-Count says how many match; when the
// file has fewer, X-Truncated is true and the file name says "newest-N-of-M".
app.get('/api/export/flows', async (c) => {
  const db = c.env.DB;
  const { asOf } = asOfParam(c);
  const format = (c.req.query('format') || 'csv').toLowerCase();
  if (format !== 'csv' && format !== 'json') return c.json({ error: 'format must be csv or json' }, 400);
  const limit = Math.min(FLOW_EXPORT_MAX, Math.max(100, parseInt(c.req.query('limit') || String(FLOW_EXPORT_MAX), 10) || FLOW_EXPORT_MAX));
  const bad = flowsFilterError((k) => c.req.query(k));
  if (bad) return c.json({ error: bad }, 400);
  // The same rows and order as the moves list's head page (readFlows: the index its filters walk), newest first.
  const r = await readFlows(db, flowsFilterFromQuery((k) => c.req.query(k), asOf), null, limit, 0, true, false, true);
  const flows = r.flows;
  // null: a text search, not counted (one walk); `next` then says whether more match than the file holds
  const matching = r.total;
  const cut = matching != null ? flows.length < matching : r.next != null;
  await withSettles(db, flows);
  if (format === 'json') return c.json({ count: flows.length, total: matching, truncated: cut, asOf, flows }, 200, { ...(matching != null ? { 'X-Total-Count': String(matching) } : {}), 'X-Truncated': String(cut) });
  const meta = (f: { meta?: Record<string, unknown> | null }, k: string) => (f.meta && typeof f.meta[k] === 'string' ? (f.meta[k] as string) : '');
  const csv = csvOf(
    // each label with where it came from and, for a wallet's tag ('user'), who wrote it, as the JSON export sends them;
    // price_basis says how the price was set in the moves list's words (shared/flow-rules.ts priceBasisWords)
    ['time_utc', 'chain', 'kind', 'nam', 'value_usd', 'price_usd', 'from', 'from_label', 'from_label_source', 'from_label_author', 'to', 'to_label', 'to_label_source', 'to_label_author', 'tx_hash', 'time_source', 'price_source', 'settle_usd_per_nam', 'settle_usd', 'price_basis'],
    flows.map((f) => [isoOrBlank(f.ts), f.chain, f.kind, f.amount, f.valueUsd ?? '', f.priceUsd ?? '', f.from ?? '', f.fromLabelPlain ?? '', f.fromLabelSource ?? '', f.fromLabelAuthor ?? '', f.to ?? '', f.toLabelPlain ?? '', f.toLabelSource ?? '', f.toLabelAuthor ?? '', f.txHash, meta(f, 'tsSource') || 'block', meta(f, 'priceSource'),
      f.settle?.usdPerNam ?? '', f.settle ? settleUsd(f.settle) : '', priceBasisWords(priceHowOf(f), priceAtOf(f))]),
  );
  return new Response(csv, { headers: exportHeaders('text/csv; charset=utf-8', `namada-trade-moves-${cut ? `newest-${flows.length}-${matching != null ? `of-${matching}-` : ''}` : ''}${Date.now()}.csv`, matching, flows.length, cut) });
});

// ---------------------------------------------------------------- integrity, cron, labels, metrics
app.get('/api/integrity', async (c) => {
  const rows = await c.env.DB.prepare('SELECT * FROM checks ORDER BY checked_at DESC').all<any>().catch(() => ({ results: [] }));
  const checks: Check[] = (rows.results || []).map((r: any) => checkOf(r, Date.now()));
  const health = (await kvGetJson<Record<string, SourceHealth>>(c.env.DB, 'source.health')) ?? {};
  return c.json({ checks, sources: publicSources(health), at: Date.now() });
});

// No HTTP trigger for the cron: it ran the whole tick for anyone who asked (hundreds of node and Keplr requests,
// and an overlapping Osmosis sync). Local runs use `wrangler dev --test-scheduled` and /__scheduled.

/** The categories a user tag may have: words about the tagger's own view, never curated ones (exchange, team…). */
export const USER_TAG_CATEGORIES = ['watch', 'whale', 'bot', 'other'] as const;
/** Tags one wallet may hold in all, and new tags the site takes in a day (worker/src/db.ts, where the insert counts them). */
export { TAGS_PER_AUTHOR, TAGS_PER_DAY };
/** A tag is a name, never a place to send people: text that reads as a link is refused. */
const TAG_LINK = /:\/\/|www\.|\.[a-z]{2,}\//i;
/** Control and format characters (zero-width joiners, direction marks) hide or reshape text. */
const TAG_HIDDEN = /[\p{Cc}\p{Cf}]/u;

app.post('/api/labels', async (c) => {
  const sess = await sessionFromRequest(c.env.DB, c.req.raw);
  if (!sess) return c.json({ error: 'sign in first' }, 401);
  const body = await jsonObject(c);
  const address = String(body.address || '').trim();
  const label = String(body.label || '').trim().slice(0, 64);
  const category = String(body.category || 'watch').trim().toLowerCase();
  if (!address || !label) return c.json({ error: 'Address and label required' }, 400);
  const chain = chainOf(address);
  if (!chain) return c.json({ error: 'Invalid address' }, 400);
  if (!(USER_TAG_CATEGORIES as readonly string[]).includes(category)) return c.json({ error: `category must be one of ${USER_TAG_CATEGORIES.join(', ')}` }, 400);
  // A tag cannot start like a spreadsheet formula (the exports also guard it).
  if (/^[=+\-@\t\r]/.test(label)) return c.json({ error: 'A tag cannot start with =, +, -, @ or a tab.' }, 400);
  const note = body.note ? String(body.note).slice(0, 160) : null;
  if (TAG_LINK.test(label) || (note && TAG_LINK.test(note))) return c.json({ error: 'A tag cannot hold a link.' }, 400);
  if (TAG_HIDDEN.test(label) || (note && TAG_HIDDEN.test(note))) return c.json({ error: 'A tag cannot hold hidden characters.' }, 400);
  if (INTERNAL_LABELS[address]) return c.json({ error: 'This address has a curated name, which a tag cannot replace.' }, 409);
  // The caps (a wallet's other tags, the site's new tags in 24 h) are counted by the insert itself (stmt.userTag), so
  // concurrent posts cannot pass them together; editing one's own tag is never counted. A failed count fails the
  // write (500), never an admission.
  const now = Date.now();
  const s = stmt.userTag(address, chain, label, category, sess.address, note, now);
  const r = await c.env.DB.prepare(s.sql).bind(...s.params).run();
  if (!Number(r?.meta?.changes ?? 0)) {
    // why nothing changed, in this order: another's row on the address, then the wallet's cap, then the day's
    const q = stmt.userTagRefusal(address, sess.address, now);
    const why = await c.env.DB.prepare(q.sql).bind(...q.params).first<{ source: string | null; author: string | null; own: number; today: number }>();
    if (why?.source && !(why.source === 'user' && why.author === sess.address)) {
      return c.json({ error: why.source === 'user' ? 'This address already has a tag by another wallet.' : 'This address has a curated name, which a tag cannot replace.' }, 409);
    }
    if ((why?.own ?? 0) >= TAGS_PER_AUTHOR) return c.json({ error: `A wallet can tag at most ${TAGS_PER_AUTHOR} addresses.` }, 400);
    if ((why?.today ?? 0) >= TAGS_PER_DAY) return c.json({ error: `Tagging is paused for today: the site takes ${TAGS_PER_DAY} new tags a day.` }, 400);
    return c.json({ error: 'The tag was not saved; try again.' }, 503);
  }
  return c.json({ success: true });
});

/**
 * Bucket size for a metric history: minutes up to 2 days; hours up to 14 days, and up to 31 days for prices (at
 * most 744 points, so 30 days of hourly swap medians come back one point per hour); 6 hours up to 400 days; 24 hours beyond.
 */
export function historyBucketMs(key: string, hours: number): number {
  if (hours <= 48) return 60000;
  if (hours <= 24 * 14 || (key.startsWith('price.') && hours <= 24 * 31)) return H;
  if (hours <= 24 * 400) return 6 * H;
  return D;
}

/** The longest metric history one request covers: the app's "All" (shared/history.ts HISTORY_ALL_DAYS, 1,200 days). */
export const HISTORY_MAX_HOURS = HISTORY_ALL_DAYS * DAY_HOURS;
/**
 * The keys the app charts from this route (web/src/api.ts fetchMetricSeries: home/data.ts, trade/data.ts
 * chartFromHistory, supply/Unlocks.tsx); every other stored series is served by /api/series. A minute key among
 * them has hourly rollups (series-sql.ts ROLLUP_KEYS).
 */
export const HISTORY_KEYS: readonly string[] = ['price.swap_1h', 'price.usd', 'supply.total_stake'];
/** A whole number as the app writes it: no sign, no leading zero, no fraction or exponent. */
const WHOLE = /^[1-9]\d{0,14}$/;

// Each point is the LAST reading of its bucket (value, at ts), with the bucket's lowest and highest reading (lo, hi)
// and how many readings it holds (n); `bucketMs` says how long a bucket is. Only HISTORY_KEYS, and a minute key at a
// bucket of an hour or more is read from its rollups (metricSeriesRolled), so a request reads at most 3 rows per hour
// of its window (and the fixed supply.pos_bonded stretch below) whatever the key's age. `hours` and `at` in any other spelling
// than the app's (web/src/api.ts fetchMetricSeries) are refused, so they never become cache entries of their own.
app.get('/api/metrics/history', async (c) => {
  const key = c.req.query('key') || 'price.usd';
  if (!HISTORY_KEYS.includes(key)) return c.json({ error: 'No such series.', reason: `Served keys: ${HISTORY_KEYS.join(', ')}; every other stored series is at /api/series.` }, 404);
  const rawHours = c.req.query('hours'), rawAt = c.req.query('at');
  if (rawHours != null && !(WHOLE.test(rawHours) && Number(rawHours) <= HISTORY_MAX_HOURS)) return c.json({ error: `hours must be a whole number from 1 to ${HISTORY_MAX_HOURS}.` }, 400);
  if (rawAt != null && !WHOLE.test(rawAt)) return c.json({ error: 'at must be a time in unix milliseconds.' }, 400);
  const hours = rawHours == null ? 24 : Number(rawHours);
  const { asOf } = asOfParam(c);
  const bucket = historyBucketMs(key, hours);
  const from = asOf - hours * H;
  let history: HistoryPoint[] = (ROLLUP_KEYS as readonly string[]).includes(key) && bucket >= H
    ? await metricSeriesRolled(c.env.DB, key, from, asOf, bucket)
    : await metricSeries(c.env.DB, key, from, asOf, bucket);

  // For long-term staked NAM history (>14 days), stitch earlier `supply.pos_bonded` readings before `supply.total_stake` was introduced.
  if (key === 'supply.total_stake' && hours > 24 * 14) {
    const earliest = history[0]?.ts ?? asOf;
    if (earliest > from + D) {
      const older = await metricSeries(c.env.DB, 'supply.pos_bonded', from, earliest - 1, bucket);
      if (older.length) history = [...older.filter((p) => p.ts < earliest), ...history];
    }
  }
  // For long-term price.swap_1h history (>30 days), backfill any earlier swap buckets directly from D1 swap flows if metrics are sparse.
  // Only the swaps price.swap_1h itself is made of (cron.ts SINGLE_POOL_USDC_SWAP: the trusted pool, against USDC), at
  // their own price: a trade priced at the quote, or one in a pool anyone could have created, is not an executed
  // NAM/USDC price.
  if (key === 'price.swap_1h' && hours > 24 * 30) {
    const earliest = history[0]?.ts ?? asOf;
    if (earliest > from + D) {
      const flowRows = await c.env.DB.prepare(
        `SELECT CAST(ts / ? AS INTEGER) * ? AS ts,
                AVG(counter_amount / amount_num) AS value, MIN(counter_amount / amount_num) AS lo, MAX(counter_amount / amount_num) AS hi,
                COUNT(*) AS n
         FROM flows
         WHERE ${SINGLE_POOL_USDC_SWAP} AND ts >= ? AND ts < ?
         GROUP BY CAST(ts / ? AS INTEGER)
         ORDER BY ts ASC`,
      )
        .bind(bucket, bucket, from, earliest, bucket)
        .all<any>()
        .catch(() => ({ results: [] as any[] }));
      const older = (flowRows.results || [])
        .filter((r: any) => r.value != null && r.value > 0 && r.ts < earliest)
        .map((r: any) => ({ ts: Number(r.ts), value: Number(r.value), lo: Number(r.lo ?? r.value), hi: Number(r.hi ?? r.value), n: Number(r.n || 1) }));
      if (older.length) history = [...older, ...history];
    }
  }
  return c.json({ key, bucketMs: bucket, history });
});

app.route('/api/series', seriesApp); // the series and Trade-basics routes (worker/src/api-series.ts, screener-plan 2.12)
app.route('/api/depth', depthApp); // the depth routes (worker/src/api-depth.ts, depth plan section 2)

// Compact for `kvGet` import to stay used by future routes
void kvGet;
