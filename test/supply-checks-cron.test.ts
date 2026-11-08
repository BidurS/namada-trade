// The supply checks of 2026-11-02, on the D1 stand-in:
// - balances_sum_to_minted (cron.ts listingSumCheck): the balance gate already added every balance in the hourly listing up
//   against the minted key the same answer carries, but kept only the holders' total. Its sum is now a check row of
//   its own, strict ('ok' only at no difference, 'warn' at any), written on every listing read (everyMs: the listing's
//   hour), while the gate keeps applying listings within its tolerance. The tighter forms of the gate's two rules are
//   recorded beside it (shadow), not yet in force.
// - supply_mint_rule (cron.ts mintRuleNext), written every tick by the real runCron, with its state in kv supply.mint_rule.
// - the protocol balances (sources/namada.ts namProtocolBalance): a node answering one without a value is refused, so
//   a tick never stores 0.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseBalanceListing } from '../worker/src/sources/namada';
import { runBalanceListing, runCron, listingSupplyShadow, stakeSplit, BALANCE_LISTING_MS, BOND_LISTING_MS, LISTING_SUM_TOLERANCE, MINT_RULE_KV, MINT_RULE_EVERY_MS, MINT_KEYS_RETRY_MS, type BondListingRecord } from '../worker/src/cron';
import { checkOf } from '../worker/src/api';
import { NAMADA } from '../worker/src/config';
import { testD1, type TestD1 } from './d1-sqlite';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const BAL = JSON.parse(readFileSync(new URL('./fixtures/balance_listing.json', import.meta.url), 'utf8'));
const NOW = Date.UTC(2026, 9, 20, 12, 0);
const H = 3600_000, MIN = 60_000;
const MINTED = BigInt(BAL.expected.minted);
const env = (db: TestD1) => ({ DB: db } as any);
const lister = (over: Record<string, unknown> = {}, height = 8343304, provider = 'TestNode') => async () => ({ ...parseBalanceListing(BAL.value), height, provider, ...over });
const row = (db: TestD1, key: string) => {
  const r = db.raw.prepare('SELECT key, status, title, detail, checked_at FROM checks WHERE key = ?').get(key);
  return r ? { ...r, detail: JSON.parse(r.detail) } : null;
};

describe('balances_sum_to_minted', () => {
  it('an exact listing passes, to the base unit, and the row says its cadence, block and node', async () => {
    const db = testD1();
    await runBalanceListing(env(db), [], NOW, {}, lister(), undefined, { supplyBase: MINTED });
    const r = row(db, 'balances_sum_to_minted')!;
    expect(r.status).toBe('ok');
    expect(r.checked_at).toBe(NOW);
    expect(r.detail).toMatchObject({
      everyMs: BALANCE_LISTING_MS, judged: true, height: 8343304, provider: 'TestNode', applied: true,
      balances: BAL.expected.keys - 1, sumBase: String(MINTED), mintedBase: String(MINTED), diffBase: '0',
      gate: { sumTolerance: LISTING_SUM_TOLERANCE, sumAllowsBase: String((MINTED * 1000n) / 1_000_000_000n) },
      shadow: { sumExact: 'apply', supply: { says: 'apply', matched: 'this tick' } },
    });
    // hourly: still current at 61 minutes, "no recent result" past two hours
    const stored = db.raw.prepare("SELECT * FROM checks WHERE key = 'balances_sum_to_minted'").get();
    expect(checkOf(stored, NOW + 61 * MIN).status).toBe('ok');
    expect(checkOf(stored, NOW + 2 * H + MIN).status).toBe('stale');
  });

  it('one base unit off is a warn, while the gate still applies the listing within its tolerance', async () => {
    const db = testD1();
    const rec = await runBalanceListing(env(db), [], NOW, {}, lister({ minted: String(MINTED + 1n) }));
    expect(rec).toMatchObject({ completeAt: NOW, failures: 0 });
    expect(row(db, 'balances_sum_to_minted')).toMatchObject({ status: 'warn', detail: { judged: true, applied: true, diffBase: '-1', shadow: { sumExact: 'refuse', supply: null } } });
  });

  it('a listing the gate refuses for its sum is still judged; one it refuses before adding up is not', async () => {
    const db = testD1();
    await runBalanceListing(env(db), [], NOW, {}, lister({ minted: '999999999999999999' }));
    expect(row(db, 'balances_sum_to_minted')).toMatchObject({ status: 'warn', detail: { judged: true, applied: false } });
    expect(row(db, 'balances_sum_to_minted')!.detail.note).toMatch(/^the balances in the listing add up to/);
    await runBalanceListing(env(db), [], NOW + H, {}, lister({}, 8340000), undefined, { headHeight: 8343400 });
    expect(row(db, 'balances_sum_to_minted')).toMatchObject({ status: 'idle', checked_at: NOW + H, detail: { judged: false, notJudged: 'not-used', height: 8340000, everyMs: BALANCE_LISTING_MS } });
  });

  it('a listing that could not be read is not read: idle, never a sum of 0', async () => {
    const db = testD1();
    await runBalanceListing(env(db), [], NOW, {}, async () => { throw new Error('5ElementsNodes: timeout; Papadritta: timeout'); });
    const r = row(db, 'balances_sum_to_minted')!;
    expect(r).toMatchObject({ status: 'idle', detail: { judged: false, notJudged: 'not-read', height: null } });
    expect(r.detail.sumBase).toBeUndefined();
  });

  it("the gate's supply rule in its tighter form: equal to this tick's read, or to the minted total before this epoch's step", () => {
    const inflation = 19_961_144_868n;
    expect(listingSupplyShadow(MINTED, MINTED, null)).toEqual({ says: 'apply', matched: 'this tick' });
    expect(listingSupplyShadow(MINTED, MINTED + inflation, MINTED)).toEqual({ says: 'apply', matched: 'the epoch before' });
    // within the gate's 0.1%, but not equal: the tighter rule would refuse it
    expect(listingSupplyShadow(MINTED, MINTED + 1n, null)).toEqual({ says: 'refuse', matched: null });
    expect(listingSupplyShadow(MINTED, null, null)).toBeNull();
  });
});

describe('the NAM in the staking account that is not staked, split by the last bond listing', () => {
  const bond = (over: Partial<BondListingRecord> = {}): BondListingRecord => ({
    at: NOW - 10 * MIN, completeAt: NOW - 10 * MIN, height: 8516000, epoch: 2738, provider: 'A', sources: 0, stakers: 0,
    totalNam: 269_402_168.82, bytes: 0, unbondingNam: 36_653_965.82, written: 0, zeroed: 0, remaining: 0, ticks: 1, durationMs: 0, ...over,
  });
  it("names the listing's unstaking, its bonds waiting to start, and the rest, at the listing's block", () => {
    const s = stakeSplit(343_820_912.48, 269_401_168.82, bond(), NOW) as any;
    expect(s).toMatchObject({ unstakingNam: 36_653_965.82, listingHeight: 8516000, listingAt: NOW - 10 * MIN });
    expect(s.waitingNam).toBeCloseTo(1000, 6);
    expect(s.restNam).toBeCloseTo(37_764_777.84, 4);
  });
  it('counts NAM still in the total stake once: unbonds that count as stake until their pipeline ends are not unstaking twice', () => {
    // this tick's total stake is 2,000 NAM above the listing's bonds: unbonds of the listing that still count as stake
    const s = stakeSplit(343_820_912.48, 269_404_168.82, bond(), NOW) as any;
    expect(s.waitingNam).toBe(0);
    expect(s.unstakingNam).toBeCloseTo(36_653_965.82 - 2000, 4);
    expect(s.restNam).toBeCloseTo(343_820_912.48 - 269_404_168.82 - (36_653_965.82 - 2000), 4);
    // the three parts and the stake make up the account's balance
    expect(269_404_168.82 + s.unstakingNam + s.waitingNam + s.restNam).toBeCloseTo(343_820_912.48, 4);
    // more over the bonds than the listing lists as unstaking: the parts do not fit
    expect(stakeSplit(343_820_912.48, 269_402_168.82 + 36_653_966, bond(), NOW)).toEqual({});
  });
  it('gives no split from a listing three intervals old, without an unbonding figure, or listing more than is not staked', () => {
    expect(stakeSplit(343_820_912.48, 269_401_168.82, bond({ at: NOW - 3 * BOND_LISTING_MS }), NOW)).toEqual({});
    expect(stakeSplit(343_820_912.48, 269_401_168.82, bond({ unbondingNam: undefined }), NOW)).toEqual({});
    expect(stakeSplit(300_000_000, 269_401_168.82, bond(), NOW)).toEqual({});
    expect(stakeSplit(343_820_912.48, 269_401_168.82, null, NOW)).toEqual({});
  });
});

// ---------------------------------------------------------------- the real tick

const u256 = (n: bigint) => { const b = new Uint8Array(32); let v = n; for (let i = 0; i < 32; i++) { b[i] = Number(v & 0xffn); v >>= 8n; } return btoa(String.fromCharCode(...b)); };
const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
const EPOCH = btoa(String.fromCharCode(155, 10, 0, 0, 0, 0, 0, 0)); // 2715

/** The chain at the second tick of the step test: epoch 2716, the minted total grown by the staking inflation the chain recorded. */
interface Chain { epoch: number; minted: bigint; keys?: Record<string, string> }
const u64 = (n: number) => btoa(String.fromCharCode(n & 0xff, (n >> 8) & 0xff, 0, 0, 0, 0, 0, 0));
const asked: string[] = [];

/** Every node at one head (a host other than 5ElementsNodes answers as B); `noValue(node, path)` makes that node answer the key without a value. */
function network(noValue: (node: 'A' | 'B', path: string) => boolean = () => false, chain: Chain = { epoch: 2715, minted: MINTED }) {
  asked.length = 0;
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    asked.push(url);
    const node = url.includes('5elementsnodes') ? 'A' : 'B';
    if (url.includes('/status')) return Promise.resolve(json({ result: { node_info: { network: NAMADA.chainId }, sync_info: { latest_block_height: '8343400', latest_block_time: new Date().toISOString(), catching_up: false, earliest_block_height: '1' } } }));
    if (url.includes('abci_query')) {
      const path = decodeURIComponent((url.split('path=')[1] ?? '').split('&')[0]).replace(/^"|"$/g, '');
      if (noValue(node, path)) return Promise.resolve(json({ result: { response: { code: 0, value: null, info: 'No value found for key', height: '8343400' } } }));
      if (path.includes('/vp/pos/bond/')) return Promise.resolve(json({ result: { response: { code: 1, info: 'Cannot find bond', value: null, height: '1' } } }));
      const key = path.split('/').pop()!;
      if (chain.keys?.[key]) return Promise.resolve(json({ result: { response: { code: 0, value: chain.keys[key], height: new URL(url).searchParams.get('height') ?? '8343400' } } }));
      const value = path.includes('/shell/epoch') ? (chain.epoch === 2715 ? EPOCH : u64(chain.epoch))
        : path.includes('/shell/prefix/') ? BAL.value
        : path.includes('balance/minted') ? u256(chain.minted)
        : path.includes('delegations_at') || path.includes('bonds_and_unbonds') ? null
        : u256(path.includes('total_stake') ? 75_338_381_473_000n : 1_000_000n);
      return Promise.resolve(json({ result: { response: { code: 0, value, height: '8343400' } } }));
    }
    return Promise.resolve(new Response('not here', { status: 404 }));
  }));
}

async function tick(db: TestD1, at: number) {
  vi.useFakeTimers({ now: at, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  let done = false; let err: unknown = null;
  runCron({ DB: db, KEPLR_KEY: 'k' } as any).catch((e) => { err = e; }).finally(() => { done = true; });
  for (let i = 0; !done && i < 4000; i++) await vi.advanceTimersByTimeAsync(250);
  vi.useRealTimers();
  if (err) throw err;
  expect(done).toBe(true);
}
// 22:41:05 UTC: no holder sync, not the first minutes of an hour
const PLAIN = Date.parse('2026-10-17T22:41:05Z');
const metric = (db: TestD1, key: string, ts: number) => db.raw.prepare('SELECT value FROM metrics WHERE key = ? AND ts = ?').get(key, ts)?.value ?? null;
const health = (db: TestD1) => JSON.parse(db.raw.prepare("SELECT value FROM kv WHERE key='source.health'").get().value);

describe('the tick', () => {
  it('writes the mint rule every minute, with its cadence, and keeps its state', async () => {
    const db = testD1();
    network();
    await tick(db, PLAIN);
    expect(row(db, 'supply_mint_rule')).toMatchObject({ status: 'idle', detail: { verdict: 'first', everyMs: MINT_RULE_EVERY_MS, epoch: 2715, height: 8343400, mintedBase: String(MINTED) } });
    await tick(db, PLAIN + MIN);
    expect(row(db, 'supply_mint_rule')).toMatchObject({ status: 'ok', checked_at: PLAIN + MIN, detail: { verdict: 'same', epoch: 2715 } });
    const state = JSON.parse(db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(MINT_RULE_KV).value);
    expect(state.anchor).toMatchObject({ epoch: 2715, mintedBase: String(MINTED), height: 8343400 });
    expect(state.broke).toBeNull();
  });

  it("on the tick that sees a new epoch, the chain's record of the step is read at that tick's block, and the step fits", async () => {
    const db = testD1();
    network();
    await tick(db, PLAIN);
    const inflation = 19_961_144_868n;
    const keys = { last_inflation_amount: u256(inflation), pgf_inflation_rate: u256(0n), steward_inflation_rate: u256(0n), masp_epoch_multiplier: u64(4) };
    network(undefined, { epoch: 2716, minted: MINTED + inflation, keys });
    await tick(db, PLAIN + MIN);
    expect(row(db, 'supply_mint_rule')).toMatchObject({ status: 'ok', detail: { verdict: 'step', lastStep: { epoch: 2716, grewBase: String(inflation), stakingBase: String(inflation), fits: true } } });
    const atHeight = asked.filter((u) => u.includes('&height=8343400'));
    expect(atHeight.map((u) => decodeURIComponent(u.split('path=')[1].split('&')[0]).split('/').pop()!.replace(/"$/, ''))).toEqual(['last_inflation_amount', 'pgf_inflation_rate', 'steward_inflation_rate', 'masp_epoch_multiplier']);
    // the cross-source rule in shadow takes the epoch before's total as an outside source's lag
    const cross = row(db, 'supply_cross_source');
    expect(cross?.detail.shadow).toMatchObject({ mintedBase: String(MINTED + inflation), beforeStepBase: String(MINTED) });
    // the next minute of the new epoch reads nothing more
    network(undefined, { epoch: 2716, minted: MINTED + inflation, keys });
    await tick(db, PLAIN + 2 * MIN);
    expect(asked.some((u) => u.includes('&height='))).toBe(false);
    expect(row(db, 'supply_mint_rule')).toMatchObject({ status: 'ok', detail: { verdict: 'same', epoch: 2716 } });
  });

  it("a step whose record no node answers is read again only after MINT_KEYS_RETRY_MS, not on every minute of the epoch", async () => {
    const db = testD1();
    network();
    await tick(db, PLAIN);
    const inflation = 19_961_144_868n;
    const keys = { last_inflation_amount: u256(inflation), pgf_inflation_rate: u256(0n), steward_inflation_rate: u256(0n), masp_epoch_multiplier: u64(4) };
    // every node answers the inflation amount without a value
    const noInflation = (_: 'A' | 'B', path: string) => path.endsWith('/last_inflation_amount');
    network(noInflation, { epoch: 2716, minted: MINTED + inflation, keys });
    await tick(db, PLAIN + MIN);
    expect(asked.filter((u) => u.includes('&height=')).length).toBe(NAMADA.rpcs.length); // each configured node asked once (three since 2026-11-07)
    // nothing judged yet (the first minute only anchored): idle
    expect(row(db, 'supply_mint_rule')).toMatchObject({ status: 'idle', detail: { verdict: 'not-judged', why: 'step-not-read' } });
    expect(JSON.parse(db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(MINT_RULE_KV).value)).toMatchObject({ keysFailedAt: PLAIN + MIN, anchor: { epoch: 2715 } });
    // the next minutes of the epoch wait
    network(noInflation, { epoch: 2716, minted: MINTED + inflation, keys });
    await tick(db, PLAIN + 2 * MIN);
    expect(asked.some((u) => u.includes('&height='))).toBe(false);
    expect(row(db, 'supply_mint_rule')).toMatchObject({ detail: { verdict: 'not-judged', why: 'step-not-read' } });
    // after the retry time the record is read again, and the step is judged
    network(undefined, { epoch: 2716, minted: MINTED + inflation, keys });
    await tick(db, PLAIN + MIN + MINT_KEYS_RETRY_MS);
    expect(asked.filter((u) => u.includes('&height=')).length).toBe(4);
    expect(row(db, 'supply_mint_rule')).toMatchObject({ status: 'ok', detail: { verdict: 'step', lastStep: { epoch: 2716, fits: true } } });
  });

  it('a protocol balance one node answers without a value is read from the other node', async () => {
    const db = testD1();
    network((node, path) => node === 'A' && path.endsWith(`/balance/#${NAMADA.internal.pos}`));
    await tick(db, PLAIN);
    expect(metric(db, 'supply.pos_bonded', PLAIN)).toBe(1);
    expect(health(db)['Namada RPC (PoS balance)'].ok).toBe(true);
  });

  it('answered without a value by every node, it is not read: no 0 is stored, and nothing is derived from it', async () => {
    const db = testD1();
    network((_, path) => path.endsWith(`/balance/#${NAMADA.internal.masp}`));
    await tick(db, PLAIN);
    expect(metric(db, 'supply.masp_shielded', PLAIN)).toBeNull();
    expect(metric(db, 'supply.liquid', PLAIN)).toBeNull();
    expect(metric(db, 'supply.pos_bonded', PLAIN)).toBe(1);
    expect(db.raw.prepare("SELECT COUNT(*) n FROM holders WHERE address = ?").get(NAMADA.internal.masp).n).toBe(0);
    expect(health(db)['Namada RPC (MASP balance)']).toMatchObject({ ok: false });
    expect(health(db)['Namada RPC (MASP balance)'].note).toMatch(/answered without a value/);
    expect(row(db, 'supply_integrity')).toBeNull();
  });
});
