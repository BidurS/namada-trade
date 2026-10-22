// A visitor's quotes ask the Osmosis quote service within one budget for every visitor of a Cloudflare location, the
// stored answer first and each call once (security review, 2026-10-22).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { app, QUOTE_BUDGET_KEY } from '../worker/src/api';
import { quoteNamTrade } from '../worker/src/sources/sqs';
import { NAM, OSMOSIS } from '../worker/src/config';
import { testD1 } from './d1-sqlite';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const SPOT = 0.000865;
/** A Map-backed caches.default (the 10 s quote memo lives there). */
const edge = () => {
  const store = new Map<string, Response>();
  vi.stubGlobal('caches', { default: { match: async (r: Request) => store.get(r.url)?.clone(), put: async (r: Request, res: Response) => { store.set(r.url, res); } } });
};
/**
 * The quote service. `exact`: a buy's first guess lands within 0.5% after one correction (2 router calls, as on
 * production at 5,000 NAM); otherwise the router never comes within 0.5% (BUY_MAX_CALLS calls). `fail(url, n)`: the
 * status for the n-th call to that URL, or null to answer.
 */
function sqs(opts: { exact?: boolean; fail?: (url: string, n: number) => number | null; delayMs?: number } = {}) {
  const calls: string[] & { maxInFlight?: number } = [];
  const seen = new Map<string, number>();
  let inFlight = 0;
  calls.maxInFlight = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    calls.maxInFlight = Math.max(calls.maxInFlight!, ++inFlight);
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    inFlight--;
    const n = (seen.get(url) ?? 0) + 1;
    seen.set(url, n);
    const st = opts.fail?.(url, n);
    if (st) return new Response('blocked', { status: st });
    if (url.includes('/tokens/prices')) return new Response(JSON.stringify({ [NAM.osmoDenom]: { [OSMOSIS.allUsdc]: String(SPOT) } }));
    const inBase = Number(/tokenIn=(\d+)/.exec(url)![1]);
    const buy = url.includes(`tokenIn=${inBase}${encodeURIComponent(OSMOSIS.usdcDenom)}`);
    const out = buy ? (opts.exact ? (inBase / SPOT) * 0.99 : 1e6) : inBase * SPOT * 0.998;
    return new Response(JSON.stringify({ amount_out: String(Math.floor(out)), price_impact: '-0.001', effective_fee: '0.002', route: [] }));
  }));
  return calls;
}
/** QUOTE_LIMITER as bound in wrangler.jsonc, over one 10 s window: 6 per key. */
function limiter(max = 6) {
  const n: Record<string, number> = {};
  return { n, limit: vi.fn(async ({ key }: { key: string }) => ({ success: (n[key] = (n[key] ?? 0) + 1) <= max })) };
}
const ask = async (q: string, extra: Record<string, unknown> = {}) => {
  const r = await app.request(`/api/quote?${q}`, {}, { DB: testD1(), ...extra } as any);
  return { status: r.status, body: (await r.json()) as any };
};

describe('a visitor\'s quote is bounded in Osmosis calls', () => {
  it('the app\'s own requests answer as before (home: 5,000 sell; Trade: a typed buy), 2 and 3 calls', async () => {
    edge();
    const calls = sqs({ exact: true });
    const home = await ask('amount=5000&side=sell', { QUOTE_LIMITER: limiter() });
    expect(home.status).toBe(200);
    expect(home.body.quote).toMatchObject({ amountNam: 5000, side: 'sell', inSymbol: 'NAM', outSymbol: 'USDC', spotPriceUsd: SPOT });
    expect(calls).toHaveLength(2);
    const trade = await ask('amount=12345.5&side=buy', { QUOTE_LIMITER: limiter() });
    expect(trade.body.quote).toMatchObject({ amountNam: 12345.5, side: 'buy', outSymbol: 'NAM' });
    expect(Math.abs(trade.body.quote.outAmount - 12345.5) / 12345.5).toBeLessThanOrEqual(0.005);
    expect(calls).toHaveLength(5);
  });

  it('the same quote within 10 s is the stored answer and asks nothing, not even the spot price', async () => {
    edge();
    const calls = sqs();
    const a = await ask('amount=1000&side=sell');
    const before = calls.length;
    const b = await ask('amount=1000&side=sell');
    expect(calls.length - before).toBe(0);
    expect(b.body).toEqual(a.body);
  });

  it('every visitor together: at most the budget in SQS calls per window, whatever the amounts; the rest are busy', async () => {
    edge();
    const calls = sqs();
    const QUOTE_LIMITER = limiter();
    const out = [];
    for (let i = 0; i < 30; i++) out.push(await ask(`amount=${1000 + i}&side=buy`, { QUOTE_LIMITER }));
    expect(calls.length).toBeLessThanOrEqual(6); // 150 before: 1 price + 4 router calls each
    expect(QUOTE_LIMITER.limit).toHaveBeenCalledWith({ key: QUOTE_BUDGET_KEY });
    const busy = out.filter((r) => r.body.quote === null);
    expect(busy.length).toBeGreaterThan(0);
    for (const r of busy) {
      expect(r.status).toBe(200);
      expect(r.body.code).toBe('busy');
      expect(r.body.error).not.toMatch(/https?:|HTTP \d|429|budget/i);
    }
    // a busy answer is not kept: once the budget is back, the same amount is asked
    const later = await ask('amount=1029&side=buy', { QUOTE_LIMITER: limiter() });
    expect(later.body.quote).not.toBeNull();
  });

  it('30 at once from one address (or thirty): never more than the budget\'s 6 SQS calls in flight (30 before)', async () => {
    edge();
    const calls = sqs({ delayMs: 20 });
    const QUOTE_LIMITER = limiter();
    await Promise.all(Array.from({ length: 30 }, (_, i) => ask(`amount=${2000 + i}&side=buy`, { QUOTE_LIMITER })));
    expect(calls.maxInFlight).toBeLessThanOrEqual(6);
    expect(calls.length).toBeLessThanOrEqual(6);
  });

  it('a visitor\'s quote asks a refused URL once more and no further: 403 then 200 quotes (2 calls), 403 twice is busy', async () => {
    // the quote service refused about every other first ask from a location (2026-10-22): one retry, each a call of the budget
    vi.useFakeTimers();
    edge();
    const calls = sqs({ fail: (_u, n) => (n <= 1 ? 403 : null) });
    const p = ask('amount=1000&side=sell', { QUOTE_LIMITER: limiter() });
    await vi.runAllTimersAsync();
    const r = await p;
    expect(r.body.quote).not.toBeNull();
    expect(calls.filter((u: string) => u.includes('/router/')).length).toBeLessThanOrEqual(2);
    vi.useFakeTimers();
    edge();
    const refused = sqs({ fail: () => 403 });
    const q = ask('amount=1001&side=sell', { QUOTE_LIMITER: limiter() });
    await vi.runAllTimersAsync();
    const b = await q;
    expect(b.body.quote).toBeNull();
    expect(refused.length).toBeLessThanOrEqual(4); // the price twice and the route twice at most, never the 15 of before
  });

  it('takes its spot from the quote the cron stored in the last two minutes, said with that time: no price call', async () => {
    edge();
    const calls = sqs({ exact: true });
    const db = testD1();
    const at = Date.now() - 30_000;
    db.raw.prepare('INSERT INTO metrics (ts, key, value) VALUES (?, ?, ?)').run(at, 'price.usd', SPOT);
    const r = await app.request('/api/quote?amount=5000&side=sell', {}, { DB: db } as any);
    const body = (await r.json()) as any;
    expect(body.quote).not.toBeNull();
    expect(calls.some((u: string) => u.includes('/tokens/prices'))).toBe(false);
    expect(body.quote.prov.note).toContain(new Date(at).toISOString());
  });

  it('the size table keeps its retries (no budget): 403, 403, 200 on the router still quotes', async () => {
    vi.useFakeTimers();
    edge();
    const calls = sqs({ fail: (u, n) => (u.includes('/router/') && n <= 2 ? 403 : null) });
    const p = quoteNamTrade(1000, 'sell', SPOT);
    await vi.runAllTimersAsync();
    expect((await p).quote).not.toBeNull();
    expect(calls).toHaveLength(3);
  });

  it('with no limiter bound (tests, a binding fault) quotes still answer', async () => {
    edge();
    sqs({ exact: true });
    expect((await ask('amount=5000&side=sell')).body.quote).not.toBeNull();
    const down = { limit: async () => { throw new Error('binding down'); } };
    expect((await ask('amount=6000&side=sell', { QUOTE_LIMITER: down })).body.quote).not.toBeNull();
  });
});
