import { OSMOSIS, NAM } from '../config';
import { fetchJson, toNam, HttpError, sleep } from '../util';
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

/** SQS answers bursts from one IP with 403/429. Retry those with jittered backoff; everything else fails fast. */
async function sqsGet(url: string, timeoutMs = 12000): Promise<any> {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      return await fetchJson(url, { timeoutMs, retries: 0 });
    } catch (e) {
      last = e;
      if (!(e instanceof HttpError) || (e.status !== 403 && e.status !== 429 && e.status < 500)) throw e;
      await sleep(350 * 2 ** i + Math.floor(Math.random() * 250));
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
 * The NAM quote in USD, and in the same answer OSMO's (`osmoUsd`, stored each minute as price.osmo_usd so a trade
 * paid in OSMO with no OSMO/USDC swap of its own can be valued at its minute: shared/settle.ts).
 */
export async function fetchNamPrice(): Promise<{ usd: number | null; osmoUsd?: number | null; at: number; error?: string }> {
  const at = Date.now();
  try {
    const url = `${OSMOSIS.sqs}/tokens/prices?base=${encodeURIComponent(NAM.osmoDenom)},uosmo`;
    const res = await sqsGet(url, 10000);
    const p = res[NAM.osmoDenom]?.[OSMOSIS.allUsdc], o = res.uosmo?.[OSMOSIS.allUsdc];
    const usd = p ? parseFloat(p) : null;
    const osmo = o ? parseFloat(o) : null;
    const osmoUsd = osmo != null && Number.isFinite(osmo) && osmo > 0 ? osmo : null;
    return usd && usd > 0 ? { usd, osmoUsd, at } : { usd: null, osmoUsd, at, error: quoteErrorText('no_price') };
  } catch (e) {
    return { usd: null, at, error: quoteErrorText(classify(e)) };
  }
}

export async function fetchNamPools(): Promise<{ pools: PoolInfo[]; at: number; error?: string }> {
  const at = Date.now();
  try {
    const denom = encodeURIComponent(NAM.osmoDenom);
    const url = `${OSMOSIS.sqs}/pools?filter[denom]=${denom}`;
    const res = await sqsGet(url, 15000);
    const list: any[] = Array.isArray(res) ? res : res.data || [];
    const pools: PoolInfo[] = [];

    for (const p of list) {
      const cm = p.chain_model || {};
      // CosmWasm pools name these fields pool_id and contract_address (pool 3008, the NAM transmuter).
      const id = String(cm.id || cm.pool_id || p.id || '');
      const addr = cm.address || cm.contract_address || '';
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
    return { pools, at };
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
): Promise<{ quote: PriceQuote | null; error?: string; code?: QuoteErrorCode }> {
  let spotUsd = knownSpotUsd ?? null;
  let spotAt = Date.now();
  if (spotUsd == null) {
    const pr = await fetchNamPrice();
    spotUsd = pr.usd;
    spotAt = pr.at;
    if (spotUsd == null) return { quote: null, error: pr.error ?? quoteErrorText('no_price'), code: 'no_price' };
  }
  // The same quote asked within 10 s (typing, preset clicks, two tabs) is served from the edge, not SQS.
  const key = `quote2-${side}-${Math.round(amountNam)}`;
  return edgeCached(key, 10, () => (side === 'sell' ? quoteSell(amountNam, spotUsd!, spotAt) : quoteBuyFor(amountNam, spotUsd!, spotAt)), (v) => !!v.quote);
}

type Raw = { inBase: string; out: number; impactPct: number; feePct: number; route: string[] };

/** One exact-in router call: `inBase` base units of `inDenom` for `outDenom`. */
async function routerQuote(inBase: string, inDenom: string, outDenom: string): Promise<Raw> {
  const url = `${OSMOSIS.sqs}/router/quote?tokenIn=${inBase}${encodeURIComponent(inDenom)}&tokenOutDenom=${encodeURIComponent(outDenom)}`;
  const res = await sqsGet(url, 12000);
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

function quoteOf(amountNam: number, side: 'buy' | 'sell', inAmount: number, outAmount: number, raw: Raw, spotUsd: number, spotAt: number, extraNote = ''): PriceQuote {
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
    prov: { source: `${SOURCE} router`, at: Date.now(), status: 'live', note: `spot from ${SOURCE} at ${new Date(spotAt).toISOString()}${extraNote}` },
  };
}

async function quoteSell(amountNam: number, spotUsd: number, spotAt: number): Promise<{ quote: PriceQuote | null; error?: string; code?: QuoteErrorCode }> {
  const namBase = BigInt(Math.max(1, Math.round(amountNam * 10 ** NAM.decimals))).toString();
  try {
    const raw = await routerQuote(namBase, NAM.osmoDenom, OSMOSIS.usdcDenom);
    if (!(raw.out > 0)) return { quote: null, error: quoteErrorText('no_route'), code: 'no_route' };
    return { quote: quoteOf(amountNam, 'sell', amountNam, raw.out, raw, spotUsd, spotAt) };
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
export async function quoteBuyFor(amountNam: number, spotUsd: number, spotAt: number, call: typeof routerQuote = routerQuote): Promise<{ quote: PriceQuote | null; error?: string; code?: QuoteErrorCode }> {
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
  return { quote: quoteOf(amountNam, 'buy', best.usdc, best.nam, best.raw, spotUsd, spotAt, note) };
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

  const prov: Provenance = spotUsd
    ? { source: SOURCE, at: priceRes.at, status: 'live' }
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
