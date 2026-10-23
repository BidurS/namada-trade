// The Osmosis data API (https://data.app.osmosis.zone, run by Numia for app.osmosis.zone; no key), the one outside
// source the screener plan adds (docs/design/screener-plan.md 2.11, fetch rules 5.4). Answer shapes as read on
// 2026-10-20 (fixtures: test/fixtures/osmosis-pair-summary.json, osmosis-pair-chart.json):
//
//   /pairs/v2/summary   { data: [{ pool_id, base_address, quote_address, base_symbol, quote_symbol, price,
//                         base_volume_24h, quote_volume_24h, volume_24h, volume_7d, liquidity, liquidity_atom, … }],
//                         last_update_at: <unix s> }        2.3 MB, 4,422 pairs, 27 of them hold NAM
//   /pairs/v1/historical/<pool>/chart?asset_in=<NAM>&asset_out=<USDC>&range=7d|1mo|1y|all&asset_type=denom
//                       [{ time: <unix s, start of the hour>, open, high, low, close }]  in units of asset_in per one
//                       asset_out (NAM per USDC: close 878.98 = $0.0011377); `[]` for a pool it has no series for (3008)
//
// Caveats the figures carry: the summary's dollar volumes and liquidity count the priced leg only (Osmosis no longer
// prices NAM itself); the chart is the pool's spot price, not executions, and has no volume; an hour with no trade
// reads open = high = low = close (`flat`). Nothing here is ever turned into a 0: a missing or malformed number is null.
import { NAM, OSMOSIS } from '../config';
import { fetchText } from '../util';

export const OSMOSIS_DATA = 'https://data.app.osmosis.zone';
/** Source word for provenance (plain word in the UI: "Osmosis app data"). */
export const OSMOSIS_DATA_SOURCE = 'Osmosis data API';
/** 5.4: 10 s per request, one attempt (a failure keeps the last stored values; the health row says so). */
export const OSMOSIS_DATA_TIMEOUT_MS = 10_000;
/**
 * The most an answer may be: the summary of every Osmosis pair was 2.3 MB on 2026-10-20 and grows with the pairs
 * listed. An answer announced or streamed past this is cut off and counts as a failed read (a Worker isolate has
 * 128 MB, and the parsed summary costs several times its bytes).
 */
export const OSMOSIS_DATA_MAX_BYTES = 8 * 1024 * 1024;

/** One GET of the data API, capped at OSMOSIS_DATA_MAX_BYTES, parsed as JSON. */
async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const r = await fetchText(url, { timeoutMs: OSMOSIS_DATA_TIMEOUT_MS, maxBytes: OSMOSIS_DATA_MAX_BYTES, signal });
  return JSON.parse(r.text);
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
};

export interface PairSummaryRow {
  poolId: string;
  base: string; quote: string;
  baseSymbol: string | null; quoteSymbol: string | null;
  /** the summary's `price` as given (units of base per one quote), never converted */
  price: number | null;
  volume24hUsd: number | null;
  volume7dUsd: number | null;
  liquidityUsd: number | null;
}

export interface PairSummary {
  /** the summary's own update time (unix ms), null when the answer lacks it */
  at: number | null;
  /** the pairs with NAM on one side, by pool id */
  pairs: PairSummaryRow[];
  /** sums over those pairs of the figures that are known; null when no pair has the figure */
  volume24hUsd: number | null;
  volume7dUsd: number | null;
  liquidityUsd: number | null;
}

const sumKnown = (xs: (number | null)[]) => (xs.some((x) => x != null) ? xs.reduce<number>((a, x) => a + (x ?? 0), 0) : null);

/** The NAM pairs of a /pairs/v2/summary answer. Throws on an answer that is not the documented shape. */
export function parsePairSummary(json: unknown, namDenom: string = NAM.osmoDenom): PairSummary {
  const data = (json as { data?: unknown })?.data;
  if (!Array.isArray(data)) throw new Error('Osmosis pair summary: no data list in the answer');
  const lu = num((json as { last_update_at?: unknown }).last_update_at);
  const pairs: PairSummaryRow[] = [];
  for (const p of data as any[]) {
    if (!p || (p.base_address !== namDenom && p.quote_address !== namDenom)) continue;
    const poolId = p.pool_id != null ? String(p.pool_id) : '';
    if (!/^\d+$/.test(poolId)) continue;
    pairs.push({
      poolId, base: String(p.base_address), quote: String(p.quote_address),
      baseSymbol: typeof p.base_symbol === 'string' ? p.base_symbol : null, quoteSymbol: typeof p.quote_symbol === 'string' ? p.quote_symbol : null,
      price: num(p.price), volume24hUsd: num(p.volume_24h), volume7dUsd: num(p.volume_7d), liquidityUsd: num(p.liquidity),
    });
  }
  pairs.sort((a, b) => Number(a.poolId) - Number(b.poolId));
  return {
    at: lu != null && lu > 0 ? lu * 1000 : null, pairs,
    volume24hUsd: sumKnown(pairs.map((p) => p.volume24hUsd)), volume7dUsd: sumKnown(pairs.map((p) => p.volume7dUsd)), liquidityUsd: sumKnown(pairs.map((p) => p.liquidityUsd)),
  };
}

export interface PairChartPoint {
  /** start of the UTC hour (unix ms) */
  t: number;
  /** as the API gives them: NAM per USDC */
  raw: { open: number; high: number; low: number; close: number };
  /** USDC per NAM (1 / raw; high and low swap places) */
  usd: { open: number; high: number; low: number; close: number };
  /** open = high = low = close: no trade moved the pool that hour (drawn as a flat tick, never a candle) */
  flat: boolean;
}

/**
 * A /pairs/v1/historical/<pool>/chart answer as hourly points, oldest first. `null` for `[]`: the API has no series for
 * that pool, which is "no series", not an empty chart. A point with a missing or non-positive price is left out, and
 * so is one whose dollar price is not finite (a price under about 5.6e-309 NAM per USDC: 1 / it is Infinity, which the
 * database cannot store).
 */
export function parsePairChart(json: unknown): PairChartPoint[] | null {
  if (!Array.isArray(json)) throw new Error('Osmosis pair chart: the answer is not a list');
  if (json.length === 0) return null;
  const out: PairChartPoint[] = [];
  for (const p of json as any[]) {
    const t = num(p?.time), o = num(p?.open), h = num(p?.high), l = num(p?.low), c = num(p?.close);
    if (t == null || !o || !h || !l || !c) continue;
    const usd = { open: 1 / o, high: 1 / l, low: 1 / h, close: 1 / c };
    if (!Number.isFinite(usd.open) || !Number.isFinite(usd.high) || !Number.isFinite(usd.low) || !Number.isFinite(usd.close)) continue;
    out.push({ t: t * 1000, raw: { open: o, high: h, low: l, close: c }, usd, flat: o === h && h === l && l === c });
  }
  return out.sort((a, b) => a.t - b.t);
}

export const pairSummaryUrl = () => `${OSMOSIS_DATA}/pairs/v2/summary`;
export const pairChartUrl = (poolId: string, range: '7d' | '1mo' | '1y' | 'all') =>
  `${OSMOSIS_DATA}/pairs/v1/historical/${poolId}/chart?asset_in=${encodeURIComponent(NAM.osmoDenom)}&asset_out=${encodeURIComponent(OSMOSIS.usdcDenom)}&range=${range}&asset_type=denom`;

export async function fetchPairSummary(signal?: AbortSignal): Promise<PairSummary> {
  return parsePairSummary(await getJson(pairSummaryUrl(), signal));
}

/** The reference pool's hourly pool price over the last 7 days (169 points). */
export async function fetchPairChart(poolId: string = OSMOSIS.refPoolId, range: '7d' | '1mo' | '1y' | 'all' = '7d', signal?: AbortSignal): Promise<PairChartPoint[] | null> {
  return parsePairChart(await getJson(pairChartUrl(poolId, range), signal));

}
