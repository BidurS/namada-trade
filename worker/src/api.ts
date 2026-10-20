import { explorerHashOf } from '../../shared/flow-rules';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './util';
import type {
  Overview, Holder, AddressReport, SearchResult, Check, IntelResponse, DonationConfig, SourceHealth, Provenance, Sourced,
  AlertsRecentResponse, HoldersResponse, FlowsResponse,
} from '../../shared/types';
import { fetchNamPools, fetchNamPrice, quoteNamTrade, quoteSlippageCurve } from './sources/sqs';
import { namBalance, namadaEpoch, delegationsAt, QUICK, type ReadOpts } from './sources/namada';
import { fetchIntel } from './sources/intel';
import { sendDiscordTestAlert } from './sources/discord';
import { stmt, kvGet, kvSet, kvGetJson } from './db';
import { toNam, chainOf } from './util';
import { OSMOSIS, INTERNAL_LABELS } from './config';
import { flowsWhere, flowsFilterFromQuery, FLOWS_ORDER } from './flows-query';
import { HOLDERS_UNION, HOLDER_COUNTS_SQL, NAMADA_TOP10_SQL, OSMOSIS_TOP10_SQL, LIQUID_STALE_MS, holderStatus, liquidChanges, chunks } from './holders';
import { label_plain, category_plain, labelSearchTerms, labelAuthorShort, tagByline } from './labels';
import { counterpartiesOf } from '../../shared/flow-rules';
import {
  FLOW_SELECT, rowToFlow, safeParseJson, provAt, metricAt, coverageOf, pressure, blindSpot, alertsBetween, lastAlertBefore, metricSeries, osmosisNetIbc,
} from './analytics';
import { NAM_AMOUNT, NOT_LEGACY_TWIN as NOT_TWIN } from './flows-query';
import { INTERNAL_ADDRESSES } from '../../shared/alerts';
import { alertRules, DEFAULT_THRESHOLDS, type AlertThresholds } from '../../shared/alerts';
import { issueNonce, login, logout, sessionFromRequest, createPairCode, claimPairCode, listSessions, revokeSession, revokeAllSessions, createSession } from './auth';
import { loadSettings, saveSettings, deleteSettings, defaultPrefs, publicView, applyUpdate, requireKey, type StoredSettings } from './settings';

/** A check that has not run for this long is served as 'stale': its last result is kept, but it no longer counts as
 *  passing (on 2026-10-19 the supply check kept a green "Passes" for 3.5 h after its source went quiet). */
export const CHECK_STALE_MS = 15 * 60_000;
export const checkOf = (r: any, now: number): Check => ({
  key: r.key, status: now - Number(r.checked_at) > CHECK_STALE_MS ? 'stale' : r.status, title: r.title, detail: safeParseJson(r.detail), checkedAt: r.checked_at,
});

export const app = new Hono<{ Bindings: Env }>();

app.use('*', cors());

// Cloudflare Access verification middleware (if ACCESS_AUD is configured)
app.use('/api/*', async (c, next) => {
  const aud = c.env.ACCESS_AUD;
  if (aud) {
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
  const [osmoStats, netIbc, namadaStats, heights, refPriceRow, cov, holderCounts, top10Osmo, top10Nam] = await Promise.all([
    db.prepare(`SELECT COUNT(*) total_flows,
          SUM(CASE WHEN kind='buy' THEN 1 ELSE 0 END) buys, SUM(CASE WHEN kind='sell' THEN 1 ELSE 0 END) sells,
          SUM(CASE WHEN kind='buy' THEN amount_num ELSE 0 END) buy_nam, SUM(CASE WHEN kind='sell' THEN amount_num ELSE 0 END) sell_nam
         FROM flows WHERE chain='osmosis' AND ts >= ? AND ts < ? AND (meta IS NULL OR meta NOT LIKE '%"arb":true%')`).bind(dayAgo, asOf).first<any>().catch(() => null),
    // Bridged in minus bridged out, sends that timed out and were refunded left out (their NAM never left Osmosis).
    osmosisNetIbc(db, dayAgo, asOf).catch(() => null),
    // Into / out of the shielded pool: shielding, and bridge crossings straight into or out of it; NAM only, each transfer once.
    db.prepare(`SELECT COUNT(*) total_flows,
          SUM(CASE WHEN kind='bond' THEN amount_num ELSE 0 END) bonded, SUM(CASE WHEN kind='withdraw' THEN amount_num ELSE 0 END) withdrawn,
          SUM(CASE WHEN kind IN ('shield','ibc_in') AND to_addr = ? AND ${NAM_AMOUNT} THEN amount_num ELSE 0 END) shielded,
          SUM(CASE WHEN kind IN ('unshield','ibc_out') AND from_addr = ? AND ${NAM_AMOUNT} THEN amount_num ELSE 0 END) unshielded
         FROM flows f WHERE chain='namada' AND ts >= ? AND ts < ? AND ${NOT_TWIN}`).bind(MASP, MASP, dayAgo, asOf).first<any>().catch(() => null),
    db.prepare(`SELECT (SELECT MAX(height) FROM flows WHERE chain='osmosis' AND ts <= ?) osmo_h, (SELECT MAX(height) FROM flows WHERE chain='namada' AND ts <= ?) nam_h,
                       (SELECT value FROM kv WHERE key='namada.cursor') nam_cursor`).bind(asOf, asOf).first<any>().catch(() => null),
    db.prepare(`SELECT value FROM metrics WHERE key='price.usd' AND ts >= ? AND ts <= ? ORDER BY ts ASC LIMIT 1`).bind(dayAgo, asOf).first<{ value: number }>().catch(() => null),
    coverageOf(db, asOf, replay),
    // Same definition as the holder list: spendable or staked, protocol and pool accounts excluded.
    db.prepare(HOLDER_COUNTS_SQL).first<{ namada: number | null; osmosis: number | null; namada_at: number | null; osmosis_at: number | null }>(),
    db.prepare(OSMOSIS_TOP10_SQL).first<{ s: number; at: number | null }>(),
    db.prepare(NAMADA_TOP10_SQL).first<{ s: number; at: number | null }>(),
  ]);

  // Price: live SQS when available; otherwise the last stored value, honestly marked stale.
  let priceUsd: Sourced<number>;
  if (priceLive?.usd) priceUsd = { value: priceLive.usd, prov: { source: 'Osmosis SQS', at: priceLive.at, status: 'live' } };
  else if (mv('price.usd') != null) {
    // A live fetch just failed: the stored value is at best "old", however recent it is, and the note says why.
    // Rewound: the stored price is the price as of that time (the rewound banner says so; no note needed).
    const base = replay ? { source: 'Osmosis SQS (stored)', at: mt('price.usd'), status: 'live' as const } : provAt('Osmosis SQS (stored)', mt('price.usd'), now, 0, { note: priceLive?.error ?? 'The live price could not be fetched.' });
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
      namadaProv: holderFiguresProv(top10Nam?.at, holderCounts?.namada_at, now),
      osmosisProv: holderFiguresProv(top10Osmo?.at, holderCounts?.osmosis_at, now),
    },
    checks,
    sources: Object.values(health ?? {}).sort((a, b) => a.name.localeCompare(b.name)),
  };
  return c.json(overview);
});

/**
 * The stamp of one chain's holder figures (overview.concentration.namadaProv / osmosisProv): the older of the oldest
 * reading among the ten biggest holders (NAMADA_TOP10_SQL / OSMOSIS_TOP10_SQL `at`) and the newest write of the
 * chain's holder rows (HOLDER_COUNTS_SQL `namada_at` / `osmosis_at`, what the count is as of). Old past 6 hours, as a
 * holder row is (owner decision 7). Holder balances are current readings: under Rewind too, the stamp is their age.
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
  const days = Math.min(30, Math.max(1, parseInt(c.req.query('days') || '7', 10)));
  return c.json(await pressure(c.env.DB, asOf, replay, days));
});

app.get('/api/blindspot', async (c) => {
  const { asOf, replay } = asOfParam(c);
  return c.json(await blindSpot(c.env.DB, asOf, replay));
});

app.get('/api/alerts/rules', (c) => c.json({ rules: alertRules(thresholdsParam(c)), defaults: DEFAULT_THRESHOLDS }));

// Hits in [since, until) plus `last`, the most recent hit before `until` of any age (W5).
app.get('/api/alerts/recent', async (c) => {
  const { asOf } = asOfParam(c);
  const sinceQ = Number(c.req.query('since'));
  const since = Number.isFinite(sinceQ) && sinceQ > 0 ? sinceQ : asOf - D;
  const th = thresholdsParam(c);
  const hits = await alertsBetween(c.env.DB, since, asOf, th);
  // A failed or abandoned search omits `last` (not known), so the client runs its own 30-day read instead of
  // reading it as "none on record".
  const last = hits.length ? hits[0] : await lastAlertBefore(c.env.DB, asOf, th).catch(() => undefined);
  const res: AlertsRecentResponse = { since, until: asOf, hits, ...(last === undefined ? {} : { last }) };
  return c.json(res);
});

// ---------------------------------------------------------------- holder list query (shared by /api/holders and its export)
// Namada rows are the union of liquid holders and bonded stakers; Osmosis rows have no stake.
// Module accounts (PoS, PGF, MASP, IBC escrow, governance, the Osmosis transfer module) are not holders.
const HOLDERS_BASE = `
    SELECT x.chain, x.address, COALESCE(h.balance_num, 0) balance_num, h.address IS NOT NULL has_row, h.updated_at, h.verified_at,
           s.bonded_num, s.estimated_num, s.verified_at bonded_verified_at,
           COALESCE(h.balance_num, 0) + COALESCE(s.bonded_num, s.estimated_num, 0) total_num, l.label, l.category,
           l.source label_source, l.author label_author
    FROM (${HOLDERS_UNION}) x
    LEFT JOIN holders h ON h.chain = x.chain AND h.address = x.address
    LEFT JOIN stakes s ON x.chain = 'namada' AND s.address = x.address
    LEFT JOIN labels l ON l.address = x.address`;

/**
 * WHERE and ORDER BY for the holder list. `category`: a raw category (genesis, foundation, backer…), or `none`
 * for rows without a label; anything else that is not a plain word is ignored. `by`: total, liquid or bonded.
 */
function holdersWhere(chain: string, search: string, category: string, by: 'total' | 'liquid' | 'bonded') {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (chain !== 'all') { conds.push('x.chain = ?'); params.push(chain); }
  if (search) {
    const terms = labelSearchTerms(search);
    conds.push(`(x.address LIKE ? OR ${terms.map(() => 'l.label LIKE ?').join(' OR ')})`);
    params.push(`%${search}%`, ...terms.map((t) => `%${t}%`));
  }
  const cat = category.trim().toLowerCase();
  if (cat === 'none') conds.push('l.label IS NULL');
  else if (/^[a-z_]{1,24}$/.test(cat)) { conds.push('LOWER(l.category) = ?'); params.push(cat); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const order = by === 'liquid' ? 'balance_num DESC' : by === 'bonded' ? 'COALESCE(s.bonded_num, s.estimated_num, 0) DESC' : 'total_num DESC';
  return { where, params, order };
}
const holdersBy = (v: string | undefined) => (['total', 'liquid', 'bonded'].includes(v || '') ? v : 'total') as 'total' | 'liquid' | 'bonded';
/** `?chain=` is one of these or the request is refused (the value also names the export file). */
const HOLDER_CHAINS = ['all', 'namada', 'osmosis'] as const;
const holderChain = (v: string | undefined): (typeof HOLDER_CHAINS)[number] | null => {
  const c = (v || 'all').trim().toLowerCase();
  return (HOLDER_CHAINS as readonly string[]).includes(c) ? (c as (typeof HOLDER_CHAINS)[number]) : null;
};
/** Where a label came from, and for a user tag the start of its author's address ("Tag by tnam1qxyz…"). */
const labelOrigin = (source: string | null | undefined, author: string | null | undefined) => ({
  label_source: source ?? null,
  label_author: labelAuthorShort(source, author),
});

// ---------------------------------------------------------------- GET /api/holders
// ?chain=all|namada|osmosis &by=total|liquid|bonded &category=<raw category>|none &search= &page= &limit= (10…100)
// Current balances only: no `at` (balances were not recorded over time before W13). Each row carries a
// server status (owner decision 7), real 24 h / 7 d changes or null, and plain label words (owner decision 6).
app.get('/api/holders', async (c) => {
  const db = c.env.DB;
  const chain = holderChain(c.req.query('chain'));
  if (!chain) return c.json({ error: 'chain must be all, namada or osmosis' }, 400);
  const search = (c.req.query('search') || '').trim();
  const by = holdersBy(c.req.query('by'));
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10) || 1);
  const limit = Math.min(100, Math.max(10, parseInt(c.req.query('limit') || '50', 10) || 50));
  const offset = (page - 1) * limit;

  const base = HOLDERS_BASE;
  const { where, params, order } = holdersWhere(chain, search, c.req.query('category') || '', by);

  const now = Date.now();
  const [totalRes, rows, supplyRow] = await Promise.all([
    db.prepare(`SELECT COUNT(*) total FROM (${base} ${where})`).bind(...params).first<{ total: number }>(),
    db.prepare(`${base} ${where} ORDER BY ${order}, x.address LIMIT ? OFFSET ?`).bind(...params, limit, offset).all<any>(),
    metricAt(db, 'supply.total', now),
  ]);
  const rawHolders = rows.results || [];

  const linksMap = new Map<string, string[]>();
  const changes = new Map<string, { d24: number | null; d7: number | null }>();
  if (rawHolders.length > 0) {
    const addrs = rawHolders.map((r: any) => r.address);
    const byChain = (ch: string) => new Map<string, number | null>(rawHolders.filter((r: any) => r.chain === ch).map((r: any) => [r.address, r.has_row ? r.balance_num : null]));
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
  const holders: Holder[] = rawHolders.map((r: any, i: number) => {
    const fallback = INTERNAL_LABELS[r.address];
    const label = r.label || fallback?.label || null;
    const category = r.category || fallback?.category || null;
    const source = r.label ? r.label_source ?? null : fallback ? 'auto' : null;
    // Owner decision 7: the chain read of the stake is authoritative when it exists.
    const bonded = r.chain === 'namada' ? (r.bonded_num ?? r.estimated_num ?? null) : null;
    const st = holderStatus({
      chain: r.chain, verifiedAt: r.verified_at ?? null, hasLiquidRow: !!r.has_row,
      bondedRead: r.bonded_num ?? null, bondedVerifiedAt: r.bonded_verified_at ?? null, bondedEstimated: r.estimated_num ?? null,
    }, now);
    const ch = changes.get(r.address);
    return {
      rank: offset + i + 1, chain: r.chain, address: r.address, balance: r.balance_num,
      bonded, bondedEstimated: r.estimated_num ?? null, bondedVerifiedAt: r.bonded_verified_at ?? null,
      total: r.total_num,
      pctSupply: supplyTotal ? (r.total_num / supplyTotal) * 100 : null,
      change24h: ch?.d24 ?? null, change7d: ch?.d7 ?? null,
      label, category, label_plain: label_plain(label, r.address, source), category_plain: category_plain(category, label),
      ...labelOrigin(source, r.label_author),
      linked: [...new Set(linksMap.get(r.address) || [])], updatedAt: r.updated_at ?? null, verifiedAt: r.verified_at ?? null,
      status: st.status, statusNote: st.statusNote,
    };
  });
  const res: HoldersResponse = { total: totalRes?.total || 0, page, limit, holders };
  return c.json(res);
});

// ---------------------------------------------------------------- GET /api/flows
// ?chain= &kind= &whale=true &minNam=<n> &arb=false &pairs=one &search= &at= &page= &limit= (10…100). Newest first. (W1)
app.get('/api/flows', async (c) => {
  const db = c.env.DB;
  const { asOf } = asOfParam(c);
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10) || 1);
  const limit = Math.min(100, Math.max(10, parseInt(c.req.query('limit') || '50', 10) || 50));
  const offset = (page - 1) * limit;
  const { where, params } = flowsWhere(flowsFilterFromQuery((k) => c.req.query(k), asOf));

  const [totalRes, rows] = await Promise.all([
    db.prepare(`SELECT COUNT(*) total FROM flows f ${where}`).bind(...params).first<{ total: number }>(),
    db.prepare(`${FLOW_SELECT} ${where} ${FLOWS_ORDER} LIMIT ? OFFSET ?`).bind(...params, limit, offset).all<any>(),
  ]);
  const res: FlowsResponse = { total: totalRes?.total || 0, page, limit, flows: (rows.results || []).map(rowToFlow) };
  return c.json(res);
});

// ---------------------------------------------------------------- trade (D1)
app.get('/api/pools', async (c) => {
  const r = await fetchNamPools();
  const prov: Provenance = r.pools.length ? { source: 'Osmosis SQS pools', at: r.at, status: 'live' } : { source: 'Osmosis SQS pools', at: null, status: 'missing', note: r.error };
  return c.json({ pools: r.pools, prov });
});

app.get('/api/quote', async (c) => {
  const amount = parseFloat(c.req.query('amount') || '1000');
  const side = (c.req.query('side') || 'sell') as 'buy' | 'sell';
  if (!(amount > 0)) return c.json({ quote: null, error: 'Enter an amount above zero.' }, 400);
  return c.json(await quoteNamTrade(amount, side));
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
  const [labelRow, holder] = await Promise.all([
    db.prepare('SELECT * FROM labels WHERE address = ?').bind(addr).first<any>(),
    db.prepare('SELECT * FROM holders WHERE chain = ? AND address = ?').bind(chain, addr).first<any>(),
  ]);

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
      balance = { value: holder?.balance_num ?? null, prov: provAt('D1 index (RPC failed)', holder?.updated_at ?? null, now, 30 * 60000, { height: holder?.updated_height, note: 'The live read from the chain failed, so this is the last indexed balance.' }) };
    }
  } else {
    balance = { value: holder?.balance_num ?? null, prov: provAt(holder?.verified_src ? `Keplr Osmosis REST (${holder.verified_src})` : 'D1 index', holder?.verified_at ?? holder?.updated_at ?? null, now, 15 * 60000, { height: holder?.updated_height }) };
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
          prov: stakeRow.bonded_num != null ? provAt(`stakes table (${stakeRow.verified_src}, epoch ${stakeRow.verified_epoch})`, stakeRow.verified_at, now, 12 * H, { note: 'The live read from the chain failed, so this is the last stored reading.' })
            : { source: 'bond/unbond history (estimate)', at: null, status: 'stale', note: 'Estimated from staking history; not read from the chain yet.' } };
      }
    }
  }

  let rank: number | null = null;
  if (liveBal > 0) {
    const rk = await db.prepare('SELECT COUNT(*) + 1 rk FROM holders WHERE chain = ? AND balance_num > ?').bind(chain, liveBal).first<{ rk: number }>().catch(() => null);
    rank = rk?.rk ?? null;
  }

  const [links, totalFlowsRow, flowRows] = await Promise.all([
    db.prepare(`SELECT osmo_addr, namada_addr, transfers, volume_num, last_seen FROM address_links WHERE osmo_addr = ? OR namada_addr = ? ORDER BY volume_num DESC`).bind(addr, addr).all<any>(),
    db.prepare(`SELECT COUNT(*) c FROM flows f WHERE (f.from_addr = ? OR f.to_addr = ?) AND ${NOT_TWIN}`).bind(addr, addr).first<{ c: number }>().catch(() => ({ c: 0 })),
    db.prepare(`${FLOW_SELECT} WHERE (f.from_addr = ? OR f.to_addr = ?) AND ${NOT_TWIN} ORDER BY f.ts DESC, f.height DESC LIMIT 300`).bind(addr, addr).all<any>(),
  ]);

  const flows = (flowRows.results || []).map(rowToFlow);

  // 24 h / 7 d changes: the balance now (the live read, else the indexed one) minus the recorded chain read
  // at the start of each window; null when no reading covers it.
  const ch = (await liquidChanges(db, chain, new Map([[addr, balance.value ?? null]]), now)).get(addr);

  const report: AddressReport = {
    address: addr, chain, label, balance,
    indexedBalance: holder?.balance_num ?? null, staking, rank,
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
app.get('/api/intel', async (c) => {
  const db = c.env.DB;
  if (c.req.query('refresh') !== 'true') {
    const cached = await kvGetJson<IntelResponse>(db, 'intel.cache');
    if (cached && Date.now() - (cached.fetchedAt || 0) < 90_000) return c.json(cached);
  }
  const intel = await fetchIntel();
  if (intel.topics.length > 0 || intel.proposals.length > 0) await kvSet(db, 'intel.cache', JSON.stringify(intel)).catch(() => {});
  return c.json(intel);
});

// ---------------------------------------------------------------- GET /api/search
app.get('/api/search', async (c) => {
  const q = (c.req.query('q') || '').trim();
  if (!q) return c.json({ results: [] });
  const results: SearchResult[] = [];
  const db = c.env.DB;

  if (q.startsWith('osmo1') || q.startsWith('tnam1')) {
    const chain = q.startsWith('osmo1') ? 'osmosis' : 'namada';
    const row = await db.prepare('SELECT label, category, source FROM labels WHERE address = ?').bind(q).first<{ label: string; category: string; source: string }>();
    const raw = row?.label ?? INTERNAL_LABELS[q]?.label ?? null;
    const plain = label_plain(raw, q, row?.source);
    results.push({
      type: 'address', chain, value: q, title: plain ? `${plain} (${q.slice(0, 10)}…)` : q, subtitle: `${chain === 'osmosis' ? 'Osmosis' : 'Namada'} address`,
      label: raw, label_plain: plain, category_plain: category_plain(row?.category ?? INTERNAL_LABELS[q]?.category ?? null, raw),
    });
  }
  if (q.length >= 16 && /^[A-Fa-f0-9]+$/.test(q)) {
    const upperQ = q.toUpperCase();
    const flow = await db.prepare('SELECT chain, height, kind, amount_num, tx_hash, meta FROM flows WHERE tx_hash = ? OR tx_hash LIKE ? LIMIT 1').bind(upperQ, `${upperQ}%`).first<any>();
    if (flow) results.push({ type: 'tx', chain: flow.chain, value: explorerHashOf({ txHash: flow.tx_hash, meta: safeParseJson(flow.meta, null) }), title: `${flow.kind} ${Math.round(flow.amount_num).toLocaleString()} NAM`, subtitle: `block ${flow.height} on ${flow.chain} · ${flow.tx_hash.slice(0, 12)}…` });
  }
  if (/^\d+$/.test(q)) results.push({ type: 'pool', chain: 'osmosis', value: q, title: `Osmosis pool #${q}`, subtitle: 'pool depth and reserves' });
  const terms = labelSearchTerms(q);
  const labelMatches = await db.prepare(`SELECT address, chain, label, category, source, author FROM labels WHERE ${terms.map(() => 'label LIKE ?').join(' OR ')} LIMIT 6`).bind(...terms.map((t) => `%${t}%`)).all<any>();
  for (const l of labelMatches.results || []) {
    const plain = label_plain(l.label, l.address, l.source);
    const cat = l.source === 'user' ? tagByline(l.source, labelAuthorShort(l.source, l.author)) : category_plain(l.category, l.label);
    results.push({ type: 'label', chain: l.chain, value: l.address, title: plain ?? l.label, subtitle: `${cat ? `${cat} · ` : ''}${l.address.slice(0, 12)}…`, label: l.label, label_plain: plain, category_plain: cat });
  }
  return c.json({ results });
});

// ---------------------------------------------------------------- auth (signed-message login, sessions, pairing)
app.post('/api/auth/nonce', async (c) => {
  const body = await c.req.json<any>().catch(() => ({}));
  const address = String(body.address || '').trim();
  if (!address.startsWith('tnam1') && !address.startsWith('osmo1')) return c.json({ error: 'address must be tnam1… or osmo1…' }, 400);
  return c.json(await issueNonce(c.env.DB, address));
});

app.post('/api/auth/login', async (c) => {
  const body = await c.req.json<any>().catch(() => ({}));
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
 * device gets a full session, which can make keys). Otherwise a leaked key could make fresh keys and sessions that
 * outlive revoking it. One rule, in one place; everything else accepts a key ("same rights as a session").
 */
export const FULL_SESSION_ONLY = {
  pair: 'an API key cannot pair a device',
  apikey: 'an API key cannot mint API keys',
} as const;
async function requireFullSession(c: any, action: keyof typeof FULL_SESSION_ONLY): Promise<Awaited<ReturnType<typeof sessionFromRequest>> | Response> {
  const s = await sessionFromRequest(c.env.DB, c.req.raw);
  if (!s) return c.json({ error: 'sign in first' }, 401);
  if (s.via === 'api') return c.json({ error: FULL_SESSION_ONLY[action] }, 403);
  return s;
}

app.post('/api/auth/pair', async (c) => {
  const s = await requireFullSession(c, 'pair');
  if (s instanceof Response) return s;
  return c.json(await createPairCode(c.env.DB, s!));
});

app.post('/api/auth/pair/claim', async (c) => {
  const body = await c.req.json<any>().catch(() => ({}));
  const r = await claimPairCode(c.env.DB, String(body.code || ''));
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

app.get('/api/me/settings', async (c) => {
  const r = await me(c); if (r instanceof Response) return r;
  return c.json({ settings: publicView(await settingsOrDefault(c.env.DB, r.key, r.s!.address)) });
});

app.put('/api/me/settings', async (c) => {
  const r = await me(c); if (r instanceof Response) return r;
  const body = await c.req.json<any>().catch(() => ({}));
  const cur = await settingsOrDefault(c.env.DB, r.key, r.s!.address);
  const next = applyUpdate(cur, body);
  if (typeof next === 'string') return c.json({ error: next }, 400);
  await saveSettings(c.env.DB, r.key, next);
  return c.json({ settings: publicView(next) });
});

app.post('/api/me/settings/test', async (c) => {
  const r = await me(c); if (r instanceof Response) return r;
  const cur = await settingsOrDefault(c.env.DB, r.key, r.s!.address);
  const url = cur.channels.discord.webhookUrl;
  if (!url) return c.json({ error: 'no Discord webhook saved' }, 400);
  return c.json({ success: await sendDiscordTestAlert(url, cur) });
});

app.get('/api/me/sessions', async (c) => {
  const s = await sessionFromRequest(c.env.DB, c.req.raw);
  if (!s) return c.json({ error: 'sign in first' }, 401);
  return c.json({ sessions: await listSessions(c.env.DB, s.address, s.token) });
});

app.delete('/api/me/sessions/:id', async (c) => {
  const s = await sessionFromRequest(c.env.DB, c.req.raw);
  if (!s) return c.json({ error: 'sign in first' }, 401);
  return c.json({ success: await revokeSession(c.env.DB, s.address, c.req.param('id')) });
});

/** A long-lived bearer token for scripts: same rights as a session, shown once. */
app.post('/api/me/apikey', async (c) => {
  const s = await requireFullSession(c, 'apikey');
  if (s instanceof Response) return s;
  const k = await createSession(c.env.DB, s!.address, s!.chain, 'api');
  if ('error' in k) return c.json({ error: k.error }, 409);
  return c.json({ token: k.token, expiresAt: k.expiresAt });
});

/** Everything stored about the user, as JSON (secrets masked). */
app.get('/api/me/export', async (c) => {
  const r = await me(c); if (r instanceof Response) return r;
  const cur = await settingsOrDefault(c.env.DB, r.key, r.s!.address);
  const sessions = await listSessions(c.env.DB, r.s!.address, r.s!.token);
  return c.json({ exportedAt: Date.now(), address: r.s!.address, settings: publicView(cur), sessions, note: 'The Discord webhook URL is stored encrypted and is not included.' });
});

/** Delete everything: settings (incl. webhook), all sessions and API keys. */
app.delete('/api/me', async (c) => {
  const s = await sessionFromRequest(c.env.DB, c.req.raw);
  if (!s) return c.json({ error: 'sign in first' }, 401);
  await deleteSettings(c.env.DB, s.address);
  await revokeAllSessions(c.env.DB, s.address);
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
const exportHeaders = (type: string, filename: string, total: number, count: number) => ({
  'Content-Type': type,
  'Content-Disposition': `attachment; filename="${filename}"`,
  'X-Total-Count': String(total),
  'X-Truncated': count < total ? 'true' : 'false',
  'Access-Control-Expose-Headers': 'X-Total-Count, X-Truncated',
});

app.get('/api/export/holders', async (c) => {
  const db = c.env.DB;
  const chain = holderChain(c.req.query('chain'));
  if (!chain) return c.json({ error: 'chain must be all, namada or osmosis' }, 400);
  const format = (c.req.query('format') || 'csv').toLowerCase();
  if (format !== 'csv' && format !== 'json') return c.json({ error: 'format must be csv or json' }, 400);
  const by = holdersBy(c.req.query('by'));
  const limit = Math.min(HOLDER_EXPORT_MAX, Math.max(100, parseInt(c.req.query('limit') || String(HOLDER_EXPORT_MAX), 10) || HOLDER_EXPORT_MAX));
  const { where, params, order } = holdersWhere(chain, (c.req.query('search') || '').trim(), c.req.query('category') || '', by);
  const [rows, totalRes, supplyRow] = await Promise.all([
    db.prepare(`${HOLDERS_BASE} ${where} ORDER BY ${order}, x.address LIMIT ?`).bind(...params, limit).all<any>(),
    db.prepare(`SELECT COUNT(*) total FROM (${HOLDERS_BASE} ${where})`).bind(...params).first<{ total: number }>(),
    metricAt(db, 'supply.total', Date.now()),
  ]);
  const matching = totalRes?.total ?? 0;
  const total = supplyRow?.value ?? null;
  const list = (rows.results || []).map((r: any, idx: number) => {
    const label = r.label || INTERNAL_LABELS[r.address]?.label || null;
    const category = r.category || INTERNAL_LABELS[r.address]?.category || null;
    const source = r.label ? r.label_source ?? null : INTERNAL_LABELS[r.address] ? 'auto' : null;
    const staked = r.chain === 'namada' ? (r.bonded_num ?? r.estimated_num ?? null) : null;
    return {
      rank: idx + 1, chain: r.chain, address: r.address,
      spendableNam: r.balance_num, stakedNam: staked, stakedIsEstimate: r.chain === 'namada' && r.bonded_num == null && r.estimated_num != null,
      totalNam: r.total_num, pctTotalSupply: total ? ((r.total_num / total) * 100).toFixed(6) : '',
      label: label_plain(label, r.address, source) ?? '', category: category_plain(category, label) ?? '',
      labelSource: source ?? '',
      spendableCheckedAt: isoOrBlank(r.verified_at), stakeCheckedAt: isoOrBlank(r.bonded_verified_at),
    };
  });
  const cut = list.length < matching;
  const name = `namada-trade-holders-${chain}-${cut ? `first-${list.length}-of-${matching}-` : ''}${Date.now()}`;
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
  const { where, params } = flowsWhere(flowsFilterFromQuery((k) => c.req.query(k), asOf));
  const [rows, totalRes] = await Promise.all([
    db.prepare(`${FLOW_SELECT} ${where} ${FLOWS_ORDER} LIMIT ?`).bind(...params, limit).all<any>(),
    db.prepare(`SELECT COUNT(*) total FROM flows f ${where}`).bind(...params).first<{ total: number }>(),
  ]);
  const flows = (rows.results || []).map(rowToFlow);
  const matching = totalRes?.total ?? flows.length;
  const cut = flows.length < matching;
  if (format === 'json') return c.json({ count: flows.length, total: matching, truncated: cut, asOf, flows }, 200, { 'X-Total-Count': String(matching), 'X-Truncated': String(cut) });
  const meta = (f: { meta?: Record<string, unknown> | null }, k: string) => (f.meta && typeof f.meta[k] === 'string' ? (f.meta[k] as string) : '');
  const csv = csvOf(
    ['time_utc', 'chain', 'kind', 'nam', 'value_usd', 'price_usd', 'from', 'from_label', 'to', 'to_label', 'tx_hash', 'time_source', 'price_source'],
    flows.map((f) => [isoOrBlank(f.ts), f.chain, f.kind, f.amount, f.valueUsd ?? '', f.priceUsd ?? '', f.from ?? '', f.fromLabelPlain ?? '', f.to ?? '', f.toLabelPlain ?? '', f.txHash, meta(f, 'tsSource') || 'block', meta(f, 'priceSource')]),
  );
  return new Response(csv, { headers: exportHeaders('text/csv; charset=utf-8', `namada-trade-moves-${cut ? `newest-${flows.length}-of-${matching}-` : ''}${Date.now()}.csv`, matching, flows.length) });
});

// ---------------------------------------------------------------- integrity, cron, labels, metrics
app.get('/api/integrity', async (c) => {
  const rows = await c.env.DB.prepare('SELECT * FROM checks ORDER BY checked_at DESC').all<any>().catch(() => ({ results: [] }));
  const checks: Check[] = (rows.results || []).map((r: any) => checkOf(r, Date.now()));
  const health = (await kvGetJson<Record<string, SourceHealth>>(c.env.DB, 'source.health')) ?? {};
  return c.json({ checks, sources: Object.values(health), at: Date.now() });
});

// No HTTP trigger for the cron: it ran the whole tick for anyone who asked (hundreds of node and Keplr requests,
// and an overlapping Osmosis sync). Local runs use `wrangler dev --test-scheduled` and /__scheduled.

/** The categories a user tag may have: words about the tagger's own view, never curated ones (exchange, team…). */
export const USER_TAG_CATEGORIES = ['watch', 'whale', 'bot', 'other'] as const;

app.post('/api/labels', async (c) => {
  const sess = await sessionFromRequest(c.env.DB, c.req.raw);
  if (!sess) return c.json({ error: 'sign in first' }, 401);
  const body = await c.req.json<any>().catch(() => ({}));
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
  const s = stmt.userTag(address, chain, label, category, sess.address, note, Date.now());
  const r = await c.env.DB.prepare(s.sql).bind(...s.params).run();
  if (!Number(r?.meta?.changes ?? 0)) {
    const cur = await c.env.DB.prepare('SELECT source, author FROM labels WHERE address = ?').bind(address).first<{ source: string; author: string | null }>().catch(() => null);
    return c.json({ error: cur?.source === 'user' ? 'This address already has a tag by another wallet.' : 'This address has a curated name, which a tag cannot replace.' }, 409);
  }
  return c.json({ success: true });
});

/**
 * Bucket size for a metric history: minutes up to 2 days; hours up to 14 days, and up to 31 days for prices (at
 * most 744 points, so 30 days of hourly swap medians come back one point per hour); 6 hours beyond.
 */
export function historyBucketMs(key: string, hours: number): number {
  if (hours <= 48) return 60000;
  if (hours <= 24 * 14 || (key.startsWith('price.') && hours <= 24 * 31)) return H;
  return 6 * H;
}

// Each point is the LAST reading of its bucket (value, at ts), with the bucket's lowest and highest reading (lo, hi)
// and how many readings it holds (n); `bucketMs` says how long a bucket is.
app.get('/api/metrics/history', async (c) => {
  const key = c.req.query('key') || 'price.usd';
  const hours = Math.min(24 * 400, Math.max(1, parseInt(c.req.query('hours') || '24', 10) || 24));
  const { asOf } = asOfParam(c);
  const bucket = historyBucketMs(key, hours);
  const history = await metricSeries(c.env.DB, key, asOf - hours * H, asOf, bucket);
  return c.json({ key, bucketMs: bucket, history });
});

// Compact for `kvGet` import to stay used by future routes
void kvGet;
