import { OSMOSIS, NAM } from '../config';
import { fetchJson, toNam, HttpError, sleep, isPoolAccount } from '../util';
import type { PoolInfo, PriceQuote, Provenance, QuoteCurveResponse, SafeClipInfo, SlippageCurvePoint } from '../../../shared/types';
import { SIZE_SLICE_JUMP_FROM_ZERO_PCT, SIZE_SLICE_JUMP_MIN_PCT, SIZE_SLICE_JUMP_RATIO } from '../../../shared/size-table';

const SOURCE = 'Osmosis SQS';

export type QuoteErrorCode = 'busy' | 'unavailable' | 'no_route' | 'no_price';

/** Plain-language reason a quote is missing. Never contains a URL or a status line. */
export function quoteErrorText(code: QuoteErrorCode): string {
  return code === 'busy' ? 'The Osmosis quote service is busy right now.'
    : code === 'no_route' ? 'Osmosis found no route for this size.'
    : code === 'no_price' ? 'The Osmosis quote service is not answering, so there is no reference price to quote against.'
    : 'The Osmosis quote service is not answering.';
}

function classify(e: unknown): QuoteErrorCode {
  if (e instanceof HttpError) return e.status === 403 || e.status === 429 ? 'busy' : e.status === 404 || e.status === 400 ? 'no_route' : 'unavailable';
  return 'unavailable';
}

/**
 * SQS answers bursts from one IP with 403/429. Retry those with jittered backoff (up to `tries` attempts in all;
 * a visitor's quote makes one: QuoteBudget); everything else fails fast.
 */
async function sqsGet(url: string, timeoutMs = 12000, tries = 3): Promise<any> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fetchJson(url, { timeoutMs, retries: 0 });
    } catch (e) {
      last = e;
      if (!(e instanceof HttpError) || (e.status !== 403 && e.status !== 429 && e.status < 500)) throw e;
      if (i < tries - 1) await sleep(350 * 2 ** i + Math.floor(Math.random() * 250));
    }
  }
  throw last;
}

async function edgeCached<T>(key: string, ttlSec: number, make: () => Promise<T>, accept: (v: T) => boolean = () => true): Promise<T> {
  try {
    const c = caches.default;
    const req = new Request(`https://namada.trade/__cache/${key}`);
    const hit = await c.match(req);
    if (hit) return (await hit.json()) as T;
    const v = await make();
    if (accept(v)) await c.put(req, new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${ttlSec}` } }));
    return v;
  } catch {
    return make();
  }
}

/**
 * The NAM sell size the router is asked to quote when the price list gives no NAM price (fetchNamPrice): small
 * against the route's liquidity, and large enough that the router takes the main route rather than the dust pools.
 * What SQS answered at 02:24 UTC on 2026-10-24, its price list answering NAM with {} since 16:36 UTC on 23 Oct
 * (test/fixtures/sqs_route_nam_*.json):
 * 1 NAM went through pool 3009 (NAM/OSMO, $17 of liquidity) then pool 3515 ($4), spot 0.000954003607608017;
 * 100 NAM was split in two, half through pools 3005 then 3497 and half through 3009 then 3576 ($30), spot
 * 0.000918592550525163; 1,000 NAM went through pool 3005 (NAM/USDC, $165) then pool 3497 (the allUSDC transmuter,
 * $2,346,179), 0.898521 allUSDC out, price impact 0.44%, spot 0.000903440360921879; 10,000 NAM took the same route at
 * the same spot with a price impact of 2.6%. Every one of these answers gave NAM a liquidity_cap of 0 in its token
 * list. The 1,000 NAM spot is pool 3005's own price: the Osmosis data API's hourly close of that pool was
 * 0.00090344036092204 from 20:00 UTC on 23 Oct.
 */
export const ROUTE_REF_NAM = 1_000;

/** One pool of a route the router quoted, with the liquidity SQS gave it (its liquidity_cap, USD). */
export interface RoutePool { id: string; liquidityUsd: number | null }

/**
 * How fetchNamPrice read the NAM price. 'list': the price list. 'route': the spot price of the route the router quoted
 * for selling `refNam` NAM, with the pools of each route in order and `liquidityUsd`, the liquidity of the thinnest
 * pool on them. The answer's own top-level liquidity_cap is not kept: it is the sum of its pools' (165 + 2,346,179 =
 * 2,346,344 on 2026-10-24), so it says nothing of how deep the NAM side is.
 */
export type NamPriceHow =
  | { how: 'list' }
  | { how: 'route'; refNam: number; routes: RoutePool[][]; liquidityUsd: number | null };

export interface NamPrice {
  usd: number | null;
  osmoUsd?: number | null;
  coinUsd?: Record<string, number>;
  at: number;
  error?: string;
  /** How the price was read; set whenever `usd` is. */
  how?: NamPriceHow;
}

/**
 * The NAM quote in USD, and in the same answer OSMO's (`osmoUsd`, stored each minute as price.osmo_usd so a trade
 * paid in OSMO with no OSMO/USDC swap of its own can be valued at its minute: shared/settle.ts) and the other quoted
 * coins'. When the price list answers but gives NAM no price (it has since 16:36 UTC on 23 Oct 2026, after the 21 Oct
 * sell-off left NAM's pools holding little besides NAM; the service gives no reason), the NAM price is the spot price of the route
 * the router quotes for selling ROUTE_REF_NAM NAM for allUSDC, the coin the list prices in; the coins keep the list's
 * prices. A list that does not answer at all is not followed by the router: the service is then not answering. With a
 * `budget` (a visitor's quote), the router call spends one call of it.
 */
export async function fetchNamPrice(tries = 3, budget?: QuoteBudget): Promise<NamPrice> {
  const at = Date.now();
  let res: any;
  try {
    const denoms = [NAM.osmoDenom, ...Object.values(OSMOSIS.quotedCoins)];
    const url = `${OSMOSIS.sqs}/tokens/prices?base=${denoms.map(encodeURIComponent).join(',')}`;
    res = await sqsGet(url, 10000, tries);
  } catch (e) {
    return { usd: null, at, error: quoteErrorText(classify(e)) };
  }
  const read = (d: string) => { const v = parseFloat(res?.[d]?.[OSMOSIS.allUsdc]); return Number.isFinite(v) && v > 0 ? v : null; };
  // each quoted coin's USD (OSMOSIS.quotedCoins), stored each minute under shared/settle.ts QUOTE_KEYS
  const coinUsd: Record<string, number> = {};
  for (const [symbol, d] of Object.entries(OSMOSIS.quotedCoins)) { const v = read(d); if (v != null) coinUsd[symbol] = v; }
  const osmoUsd = coinUsd.OSMO ?? null;
  const usd = read(NAM.osmoDenom);
  if (usd) return { usd, osmoUsd, coinUsd, at, how: { how: 'list' } };
  // only the price list's own answer (an object of coins) that leaves NAM out is followed by the router; anything else
  // (null, an array) is not the list answering
  if (!res || typeof res !== 'object' || Array.isArray(res)) return { usd: null, osmoUsd, coinUsd, at, error: quoteErrorText('no_price') };
  if (budget && !(await budget())) return { usd: null, osmoUsd, coinUsd, at, error: quoteErrorText('busy') };
  try {
    const r = routeSpot(await sqsGet(routeSpotUrl(), 12000, tries));
    if (r && 'usd' in r) return { usd: r.usd, osmoUsd, coinUsd, at, how: r.how };
    return { usd: null, osmoUsd, coinUsd, at, error: r ? routeOtherPoolsText(r.otherPools) : routeNoSpotText() };
  } catch (e) {
    return { usd: null, osmoUsd, coinUsd, at, error: quoteErrorText(classify(e)) };
  }
}

/**
 * The technical source name of a NAM price read `how`: 'Osmosis SQS' for the price list, 'Osmosis SQS route spot,
 * 1,000 NAM' for the route (web/src/lib/prov.ts plainSource says each in plain words).
 */
export function priceSourceName(how: NamPriceHow | null | undefined): string {
  return how?.how === 'route' ? `${SOURCE} route spot, ${how.refNam.toLocaleString('en-US')} NAM` : SOURCE;
}

/** The router quote fetchNamPrice asks when the price list gives no NAM price: ROUTE_REF_NAM NAM for allUSDC. */
export const routeSpotUrl = () =>
  `${OSMOSIS.sqs}/router/quote?tokenIn=${BigInt(ROUTE_REF_NAM) * 10n ** BigInt(NAM.decimals)}${encodeURIComponent(NAM.osmoDenom)}&tokenOutDenom=${encodeURIComponent(OSMOSIS.allUsdc)}`;

/** The allUSDC transmuter (Noble USDC to allUSDC one for one, no fee): the router's last hop from pool 3005 to allUSDC. */
export const ALLUSDC_TRANSMUTER_POOL = '3497';

/**
 * A route the NAM price may be read from: the reference pool (OSMOSIS.refPoolId, the only pool whose price the site
 * takes: config.ts pricePoolIds), then at most the allUSDC transmuter. Anyone can make a pool with any price, and the
 * router sends a small sale through whichever pool pays most (1 NAM went through pools 3009 and 3515, $17 and $4, at a
 * spot 5.6% above pool 3005's on 2026-10-24), so a route through any other pool gives no price.
 */
const isPriceRoute = (r: RoutePool[]) => r.length > 0 && r[0].id === OSMOSIS.refPoolId && r.slice(1).every((p) => p.id === ALLUSDC_TRANSMUTER_POOL);

const LIST_GIVES_NO_NAM = 'The Osmosis quote service\'s price list gives NAM no price';
/** The price row's note when the router's answer has no spot price above zero. */
export const routeNoSpotText = () => `${LIST_GIVES_NO_NAM}, and its router's quote for selling ${ROUTE_REF_NAM.toLocaleString('en-US')} NAM gave no spot price.`;
/** The price row's note when the router's answer went through a pool other than the reference pool and the transmuter. */
export const routeOtherPoolsText = (ids: string[]) =>
  `${LIST_GIVES_NO_NAM}, and its router's quote for selling ${ROUTE_REF_NAM.toLocaleString('en-US')} NAM went through ${ids.length ? `pool${ids.length > 1 ? 's' : ''} ${ids.join(', ')}` : 'no pool'} instead of pool ${OSMOSIS.refPoolId} alone, so no price is taken from it.`;

/**
 * The NAM price in a router answer: its in_base_out_quote_spot_price, in allUSDC base units per NAM base unit, which
 * is USD per NAM as both have 6 decimals. Null for an answer with no spot, or one that is not a finite number above
 * zero; `otherPools` for an answer whose route is not pool 3005 then the transmuter (isPriceRoute).
 */
function routeSpot(res: any): { usd: number; how: Extract<NamPriceHow, { how: 'route' }> } | { otherPools: string[] } | null {
  const usd = parseFloat(res?.in_base_out_quote_spot_price);
  if (!(Number.isFinite(usd) && usd > 0)) return null;
  const cap = (v: unknown) => { const n = parseFloat(String(v)); return Number.isFinite(n) && n >= 0 ? n : null; };
  const routes: RoutePool[][] = (Array.isArray(res.route) ? res.route : []).map((r: any) =>
    (Array.isArray(r?.pools) ? r.pools : []).map((p: any) => ({ id: String(p?.id ?? ''), liquidityUsd: cap(p?.liquidity_cap) })));
  if (!routes.length || !routes.every(isPriceRoute)) {
    return { otherPools: [...new Set(routes.flat().map((p) => p.id))].filter((id) => id !== OSMOSIS.refPoolId && id !== ALLUSDC_TRANSMUTER_POOL) };
  }
  const caps = routes.flat().map((p) => p.liquidityUsd).filter((v): v is number => v != null);
  return { usd, how: { how: 'route', refNam: ROUTE_REF_NAM, routes, liquidityUsd: caps.length ? Math.min(...caps) : null } };
}

/**
 * The NAM pools the quote service lists. `refused` counts the pools whose address was left out because it is not
 * shaped like an Osmosis pool account (util.ts isPoolAccount): such a pool keeps its figures with no address, so it
 * is never labelled a pool (cron.ts) nor taken by the live parser as one (live-hub.ts).
 */
export async function fetchNamPools(): Promise<{ pools: PoolInfo[]; at: number; error?: string; refused?: number }> {
  const at = Date.now();
  try {
    const denom = encodeURIComponent(NAM.osmoDenom);
    const url = `${OSMOSIS.sqs}/pools?filter[denom]=${denom}`;
    const res = await sqsGet(url, 15000);
    const list: any[] = Array.isArray(res) ? res : res.data || [];
    const pools: PoolInfo[] = [];
    let refused = 0;

    for (const p of list) {
      const cm = p.chain_model || {};
      // CosmWasm pools name these fields pool_id and contract_address (pool 3008, the NAM transmuter).
      const id = String(cm.id || cm.pool_id || p.id || '');
      // The address becomes a pool label that leaves it out of every holder list, and a pool the live parser books
      // liquidity against, so the answer's word is taken only for an address shaped like a pool account: a Namada
      // address, an Osmosis wallet or a string with a bad checksum is left out and counted.
      const named = cm.address || cm.contract_address || '';
      const addr = named && isPoolAccount(named) ? (named as string) : '';
      if (named && !addr) refused++;
      const balances = p.balances || [];
      const namBal = balances.find((b: any) => b.denom === NAM.osmoDenom);
      const counterBal = balances.find((b: any) => b.denom !== NAM.osmoDenom);

      let counterSymbol = 'UNKNOWN';
      if (counterBal) {
        if (counterBal.denom === 'uosmo') counterSymbol = 'OSMO';
        else if (counterBal.denom.includes('USDC') || counterBal.denom === OSMOSIS.usdcDenom) counterSymbol = 'USDC';
        else if (counterBal.denom.startsWith('ibc/')) counterSymbol = counterBal.denom.slice(0, 10) + '…';
        else counterSymbol = counterBal.denom;
      }

      const typeMap: Record<number, string> = { 0: 'balancer', 1: 'stableswap', 2: 'concentrated', 3: 'cosmwasm' };

      pools.push({
        id,
        type: typeMap[p.type] || String(p.type),
        address: addr,
        pair: `NAM / ${counterSymbol}`,
        counterDenom: counterBal?.denom || '',
        counterSymbol,
        namReserve: namBal ? toNam(namBal.amount) : 0,
        counterReserve: counterBal ? Number(counterBal.amount) / 1e6 : 0,
        liquidityUsd: parseFloat(p.liquidity_cap || '0'),
        spreadFactor: parseFloat(p.spread_factor || '0'),
        volume24hUsd: p.fees_data?.volume_24h ? parseFloat(p.fees_data.volume_24h) : null,
      });
    }

    pools.sort((a, b) => b.liquidityUsd - a.liquidityUsd);
    return refused ? { pools, at, refused } : { pools, at };
  } catch (e) {
    return { pools: [], at, error: quoteErrorText(classify(e)) };
  }
}

/**
 * Route quote for a NAM trade. Returns null (with a reason) when the router or the spot price is
 * unavailable: the UI shows "no quote", never an invented one.
 */
/**
 * Route quote for a NAM trade of `amountNam` NAM. Sell: what that many NAM fetch in USDC. Buy: the USDC that buys
 * that many NAM (`quoteBuyFor`). Returns null (with a reason) when the router or the spot price is unavailable:
 * the UI shows "no quote", never an invented one.
 */
export async function quoteNamTrade(
  amountNam: number,
  side: 'buy' | 'sell' = 'sell',
  knownSpotUsd?: number | null,
  budget?: QuoteBudget,
  knownSpotAt?: number,
  knownSpotSource?: string,
): Promise<{ quote: PriceQuote | null; error?: string; code?: QuoteErrorCode }> {
  // The same quote asked within 10 s (typing, preset clicks, two tabs, the home page's and the Trade page's opening
  // 5,000 NAM) is the stored answer, before anything is asked of SQS: the spot price included.
  const key = `quote2-${side}-${Math.round(amountNam)}`;
  return edgeCached(key, 10, async () => {
    // With a budget each attempt spends one call of it, and a call refused (a 403, a 5xx) is asked again after a
    // growing pause, up to QUOTE_TRIES in all, as sqsGet does: the quote service refused about half the asks from a
    // location at times (2026-10-22), so one or two attempts left a visitor's quote 'busy' half the time.
    const call: typeof routerQuote = async (inBase, inDenom, outDenom) => {
      if (!budget) return routerQuote(inBase, inDenom, outDenom);
      for (let a = 0; ; a++) {
        if (!(await budget())) throw new HttpError(429, 'quote budget', '');
        try {
          return await routerQuote(inBase, inDenom, outDenom, 1);
        } catch (e) {
          if (a >= QUOTE_TRIES - 1 || !(e instanceof HttpError) || (e.status !== 403 && e.status !== 429 && e.status < 500)) throw e;
          await sleep(350 * 2 ** a + Math.floor(Math.random() * 250));
        }
      }
    };
    let spotUsd = knownSpotUsd ?? null;
    let spotAt = knownSpotUsd != null && knownSpotAt != null ? knownSpotAt : Date.now();
    // where the spot came from, as the price's own source name says it (priceSourceName)
    let spotFrom = (knownSpotUsd != null && knownSpotSource) || SOURCE;
    if (spotUsd == null) {
      let pr: NamPrice = { usd: null, at: Date.now() };
      for (let a = 0; a < (budget ? QUOTE_TRIES : 1) && pr.usd == null; a++) {
        if (budget && !(await budget())) return { quote: null, error: quoteErrorText('busy'), code: 'busy' as const };
        if (a) await sleep(350 * 2 ** (a - 1) + Math.floor(Math.random() * 250));
        pr = await fetchNamPrice(budget ? 1 : 3, budget);
      }
      spotUsd = pr.usd;
      spotAt = pr.at;
      if (spotUsd == null) return { quote: null, error: pr.error ?? quoteErrorText('no_price'), code: 'no_price' as const };
      spotFrom = priceSourceName(pr.how);
    }
    return side === 'sell' ? quoteSell(amountNam, spotUsd, spotAt, call, spotFrom) : quoteBuyFor(amountNam, spotUsd, spotAt, call, spotFrom);
  }, (v) => !!v.quote);
}

/**
 * A visitor's quote (the /api/quote route) asks this before each SQS call it makes, and makes each call once: true
 * spends one call of the budget, false means it is spent (the answer is 'busy'). The size table, the cron and the
 * live hub pass none and keep their retries.
 */
export type QuoteBudget = () => Promise<boolean>;
/** Attempts per quote-service call of a visitor's quote, each one call of its budget (as sqsGet's three). */
export const QUOTE_TRIES = 3;

type Raw = { inBase: string; out: number; impactPct: number; feePct: number; route: string[] };

/** One exact-in router call: `inBase` base units of `inDenom` for `outDenom`. */
async function routerQuote(inBase: string, inDenom: string, outDenom: string, tries = 3): Promise<Raw> {
  const url = `${OSMOSIS.sqs}/router/quote?tokenIn=${inBase}${encodeURIComponent(inDenom)}&tokenOutDenom=${encodeURIComponent(outDenom)}`;
  const res = await sqsGet(url, 12000, tries);
  const route: string[] = [];
  for (const r of res.route || []) for (const pool of r.pools || []) route.push(`Pool #${pool.id} (${pool.type === 2 ? 'CL' : 'AMM'})`);
  return {
    inBase,
    out: Number(res.amount_out) / 1e6,
    impactPct: Math.abs(parseFloat(res.price_impact || '0') * 100),
    feePct: parseFloat(res.effective_fee || '0') * 100,
    route: Array.from(new Set(route)),
  };
}

function quoteOf(amountNam: number, side: 'buy' | 'sell', inAmount: number, outAmount: number, raw: Raw, spotUsd: number, spotAt: number, extraNote = '', spotFrom = SOURCE): PriceQuote {
  const effectivePriceUsd = side === 'sell' ? outAmount / inAmount : inAmount / outAmount;
  // SQS reports 0 impact on some multi-hop routes; fall back to realised impact vs spot.
  const derivedImpact = Math.abs(((effectivePriceUsd - spotUsd) / spotUsd) * 100);
  return {
    amountNam, side, inAmount,
    inSymbol: side === 'sell' ? 'NAM' : 'USDC',
    outAmount,
    outSymbol: side === 'sell' ? 'USDC' : 'NAM',
    spotPriceUsd: spotUsd,
    effectivePriceUsd,
    usdcValue: side === 'sell' ? outAmount : inAmount,
    priceImpactPct: raw.impactPct > 0.001 ? raw.impactPct : derivedImpact,
    effectiveFeePct: raw.feePct,
    route: raw.route,
    prov: { source: `${SOURCE} router`, at: Date.now(), status: 'live', note: `spot from ${spotFrom} at ${new Date(spotAt).toISOString()}${extraNote}` },
  };
}

async function quoteSell(amountNam: number, spotUsd: number, spotAt: number, call: typeof routerQuote = routerQuote, spotFrom = SOURCE): Promise<{ quote: PriceQuote | null; error?: string; code?: QuoteErrorCode }> {
  const namBase = BigInt(Math.max(1, Math.round(amountNam * 10 ** NAM.decimals))).toString();
  try {
    const raw = await call(namBase, NAM.osmoDenom, OSMOSIS.usdcDenom);
    if (!(raw.out > 0)) return { quote: null, error: quoteErrorText('no_route'), code: 'no_route' };
    return { quote: quoteOf(amountNam, 'sell', amountNam, raw.out, raw, spotUsd, spotAt, '', spotFrom) };
  } catch (e) {
    const code = classify(e);
    return { quote: null, error: quoteErrorText(code), code };
  }
}

/** A buy quote is for `amountNam` NAM when the NAM out is this close to it. */
export const BUY_TOLERANCE = 0.005;
/** Router calls per buy quote at most (the first guess plus corrections). */
export const BUY_MAX_CALLS = 4;

/**
 * The USDC that buys `amountNam` NAM. The router only answers "what does X USDC buy", so X is adjusted until
 * the NAM out is within BUY_TOLERANCE of `amountNam`: first X = amount × spot, then a step in proportion, then
 * secant steps between the last two answers (at most BUY_MAX_CALLS calls). The answer is always one real quote:
 * the attempt whose NAM out came closest, with its own USDC and NAM. (The router's exact-out quotes were not
 * used: on 2026-10-17 they priced 100,000 NAM below spot, contradicting its own exact-in answers.)
 */
export async function quoteBuyFor(amountNam: number, spotUsd: number, spotAt: number, call: typeof routerQuote = routerQuote, spotFrom = SOURCE): Promise<{ quote: PriceQuote | null; error?: string; code?: QuoteErrorCode }> {
  const tries: { usdc: number; nam: number; raw: Raw }[] = [];
  let usdc = amountNam * spotUsd;
  try {
    for (let k = 0; k < BUY_MAX_CALLS; k++) {
      const base = BigInt(Math.max(1, Math.round(usdc * 1e6))).toString();
      const raw = await call(base, OSMOSIS.usdcDenom, NAM.osmoDenom);
      const nam = raw.out;
      if (!(nam > 0)) break;
      tries.push({ usdc: Number(base) / 1e6, nam, raw });
      if (Math.abs(nam - amountNam) / amountNam <= BUY_TOLERANCE) break;
      const a = tries[tries.length - 2], b = tries[tries.length - 1];
      let next = b.usdc * (amountNam / b.nam);
      if (a && b.nam !== a.nam) {
        const sec = b.usdc + ((amountNam - b.nam) * (b.usdc - a.usdc)) / (b.nam - a.nam);
        if (Number.isFinite(sec) && sec > 0) next = sec;
      }
      usdc = Math.min(Math.max(next, b.usdc / 10), b.usdc * 10);
    }
  } catch (e) {
    if (!tries.length) {
      const code = classify(e);
      return { quote: null, error: quoteErrorText(code), code };
    }
  }
  if (!tries.length) return { quote: null, error: quoteErrorText('no_route'), code: 'no_route' };
  const best = [...tries].sort((x, y) => Math.abs(x.nam - amountNam) - Math.abs(y.nam - amountNam))[0];
  const exact = Math.abs(best.nam - amountNam) / amountNam <= BUY_TOLERANCE;
  const note = `; ${tries.length} router quote${tries.length > 1 ? 's' : ''} to find the USDC for ${amountNam} NAM: ${best.usdc} USDC buys ${best.nam.toFixed(6)} NAM${exact ? '' : ' (the closest the router came)'}`;
  return { quote: quoteOf(amountNam, 'buy', best.usdc, best.nam, best.raw, spotUsd, spotAt, note, spotFrom) };
}

export async function quoteSlippageCurve(): Promise<QuoteCurveResponse> {
  return edgeCached('curve2', 60, buildCurve, (c) => c.curve.length > 0 && c.curve.every((p) => p.sellImpactPct != null && p.buyImpactPct != null));
}

/**
 * The largest size whose worse-side price move stays under `targetPct`: linear between the two quoted sizes
 * around the limit, the largest size ("at least") when no size reaches it, and null when even the smallest size
 * moves the price more (no quote supports a smaller figure; the UI says "under <smallest> NAM").
 */
export function safeClip(curve: SlippageCurvePoint[], targetPct: number): SafeClipInfo | null {
  const pts = curve.filter((c) => c.sellImpactPct != null && c.buyImpactPct != null).sort((a, b) => a.amountNam - b.amountNam);
  if (!pts.length) return null;
  const imp = (p: SlippageCurvePoint) => Math.max(p.sellImpactPct!, p.buyImpactPct!);
  const smallest = { smallestNam: pts[0].amountNam, smallestImpactPct: imp(pts[0]) };
  for (let i = 0; i < pts.length; i++) {
    const v = imp(pts[i]);
    if (v >= targetPct) {
      if (i === 0) return { nam: null, how: 'below_smallest', ...smallest };
      const prev = pts[i - 1];
      const prevImp = imp(prev);
      const ratio = Math.min(1, Math.max(0, (targetPct - prevImp) / Math.max(0.01, v - prevImp)));
      return { nam: Math.round(prev.amountNam + ratio * (pts[i].amountNam - prev.amountNam)), how: 'interpolated', ...smallest };
    }
  }
  return { nam: pts[pts.length - 1].amountNam, how: 'at_least', ...smallest };
}

/**
 * Annotate a slippage ladder with marginal slice pricing (ΔUSDC / ΔNAM between adjacent tiers) and detect
 * Concentrated Liquidity tick-boundary cliffs where marginal slippage jumps by the rule in shared/size-table.ts.
 * `cliffNote` is operator text for API readers; the site never prints it (it composes its own sentence from fields).
 */
export function annotateSlippageCurve(
  curve: SlippageCurvePoint[],
  spotUsd: number | null,
): { curve: SlippageCurvePoint[]; liquidityCliffNam: number | null; cliffNote: string | null } {
  const sorted = [...curve].sort((a, b) => a.amountNam - b.amountNam);
  let liquidityCliffNam: number | null = null;
  let cliffNote: string | null = null;
  let prevNam = 0;
  // The sell-side baseline (NAM and USDC) moves only on rungs that have a sell quote, so a rung without one (the
  // quote service refused that tier) does not make the next slice look wider than it is.
  let prevSellNam = 0;
  let prevSellUsdc = 0;
  let prevBuyUsdc = 0;
  let prevBuyNam = 0;
  let prevMarginalImpact = 0;

  const annotated = sorted.map((p, idx) => {
    const dSellNam = p.amountNam - prevSellNam;
    let marginalSellUsd: number | null = null;
    let marginalSellImpactPct: number | null = null;
    let marginalBuyUsd: number | null = null;

    if (dSellNam > 0 && p.sellOutUsdc != null) {
      const dUsdc = p.sellOutUsdc - prevSellUsdc;
      marginalSellUsd = Math.max(0, dUsdc / dSellNam);
      if (spotUsd && spotUsd > 0) {
        marginalSellImpactPct = Math.max(0, ((spotUsd - marginalSellUsd) / spotUsd) * 100);
      }
      prevSellUsdc = p.sellOutUsdc;
      prevSellNam = p.amountNam;
    }
    const actualBuyNam = p.buyOutNam ?? p.amountNam;
    const dBuyNam = actualBuyNam - prevBuyNam;
    if (dBuyNam > 0 && p.buyInUsdc != null) {
      const dBuyUsdc = p.buyInUsdc - prevBuyUsdc;
      if (dBuyUsdc > 0) marginalBuyUsd = dBuyUsdc / dBuyNam;
      prevBuyUsdc = p.buyInUsdc;
      prevBuyNam = actualBuyNam;
    }

    if (
      liquidityCliffNam == null &&
      idx > 0 &&
      marginalSellImpactPct != null &&
      // the rule the UI states in its stamp sheet (shared/size-table.ts), one place for both
      marginalSellImpactPct >= SIZE_SLICE_JUMP_MIN_PCT &&
      (prevMarginalImpact > 0 ? marginalSellImpactPct / prevMarginalImpact >= SIZE_SLICE_JUMP_RATIO : marginalSellImpactPct >= SIZE_SLICE_JUMP_FROM_ZERO_PCT)
    ) {
      liquidityCliffNam = prevNam;
      const ratio = prevMarginalImpact > 0 ? (marginalSellImpactPct / prevMarginalImpact).toFixed(1) : '∞';
      cliffNote = `Concentrated Liquidity cliff above ${prevNam.toLocaleString('en-US')} NAM: marginal sell slippage jumps ${ratio}x (${prevMarginalImpact.toFixed(2)}% → ${marginalSellImpactPct.toFixed(2)}%) on the ${prevNam.toLocaleString('en-US')}–${p.amountNam.toLocaleString('en-US')} NAM slice.`;
    }
    if (marginalSellImpactPct != null && marginalSellImpactPct > 0) {
      prevMarginalImpact = marginalSellImpactPct;
    }
    prevNam = p.amountNam;
    return {
      ...p,
      marginalSellUsd,
      marginalSellImpactPct,
      marginalBuyUsd,
    };
  });

  return { curve: annotated, liquidityCliffNam, cliffNote };
}

async function buildCurve(): Promise<QuoteCurveResponse> {
  const [priceRes, poolRes] = await Promise.all([fetchNamPrice(), fetchNamPools()]);
  const pools = poolRes.pools;
  const totalLiquidityUsd = pools.reduce((acc, p) => acc + p.liquidityUsd, 0);
  const refPool = pools.find((p) => p.id === OSMOSIS.refPoolId) ?? null;
  const spotUsd = priceRes.usd;

  // the spot's own source name: the price list, or the route's spot when the list gives NAM no price
  const prov: Provenance = spotUsd
    ? { source: priceSourceName(priceRes.how), at: priceRes.at, status: 'live' }
    : { source: SOURCE, at: null, status: 'missing', note: priceRes.error ?? 'spot price unavailable' };

  const tiers = [1000, 5000, 10000, 25000, 50000, 100000];
  // Three tiers at a time (a sell and a buy each; a buy takes up to BUY_MAX_CALLS calls one after another): more
  // at once is what trips SQS's per-IP limit.
  const curve: SlippageCurvePoint[] = [];
  if (spotUsd) {
    for (let i = 0; i < tiers.length; i += 3) {
      const part = await Promise.all(tiers.slice(i, i + 3).map(async (amountNam) => {
        const [sellQ, buyQ] = await Promise.all([quoteNamTrade(amountNam, 'sell', spotUsd), quoteNamTrade(amountNam, 'buy', spotUsd)]);
        const s = sellQ.quote, b = buyQ.quote;
        return {
          amountNam,
          usdSize: amountNam * spotUsd,
          buyImpactPct: b ? Math.abs(b.priceImpactPct) : null,
          sellImpactPct: s ? Math.abs(s.priceImpactPct) : null,
          buyEffectiveUsd: b?.effectivePriceUsd ?? null,
          sellEffectiveUsd: s?.effectivePriceUsd ?? null,
          sellOutUsdc: s?.outAmount ?? null,
          buyInUsdc: b?.inAmount ?? null,
          buyOutNam: b?.outAmount ?? null,
          buyExact: b ? Math.abs(b.outAmount - amountNam) / amountNam <= BUY_TOLERANCE : false,
        };
      }));
      curve.push(...part);
    }
  }

  const c1 = safeClip(curve, 1), c3 = safeClip(curve, 3);
  const annotated = annotateSlippageCurve(curve, spotUsd);
  return {
    spotUsd,
    poolsCount: pools.length,
    totalLiquidityUsd,
    refPoolLiquidityUsd: refPool?.liquidityUsd ?? null,
    maxSafeClip1PctNam: c1?.nam ?? null,
    maxSafeClip3PctNam: c3?.nam ?? null,
    safeClip1Pct: c1,
    safeClip3Pct: c3,
    liquidityCliffNam: annotated.liquidityCliffNam,
    cliffNote: annotated.cliffNote,
    curve: annotated.curve,
    prov,
  };
}
