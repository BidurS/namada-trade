// Review run 2, group C (worker/src/cron.ts:runCron:ibc-conservation-all-channel-escrow-vs-osmosis-supply).
// Namada keeps one IBC escrow for every channel; the bridge check compared it with the Osmosis supply alone and
// judged |escrow - Osmosis - stuck| by size. NAM any holder delivers over another channel stays in the escrow and
// never reaches Osmosis, so 100 NAM sent to another chain made the check warn and 10,000 NAM made it fail, and the
// home page stamped the Osmosis figure as disputed with a note calling the escrow Osmosis's. The check now judges
// the two sides apart (Osmosis over the escrow is a shortfall nothing elsewhere explains; the escrow over Osmosis
// cannot be told apart from NAM on another chain, so it is a look, never a fault and never a pass) and says in its
// title and detail what it compares and what it does not.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { runCron, ibcConservation, IBC_COMPARED, IBC_NOT_COMPARED } from '../worker/src/cron';
import { checkDetail, CHECK_TITLES } from '../web/src/lib/prov';
import { testD1 } from './d1-sqlite';
import type { Check } from '../shared/types';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const ESCROW = 'tnam1qcqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqvtr7x4';
const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
const BAL = fx('balance_listing.json');
const BONDS = fx('bonds_listing.json');
const u256 = (n: bigint) => { const b = new Uint8Array(32); let v = n; for (let i = 0; i < 32; i++) { b[i] = Number(v & 0xffn); v >>= 8n; } return btoa(String.fromCharCode(...b)); };
const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });

/** The chain as test/cron-hang.test.ts stubs it, with the escrow balance and the Osmosis supply given (whole NAM). */
function network(escrowNam: bigint, osmosisNam: bigint) {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    // indexer.namada.net /ibc/{tx}/status: not reachable, so the seeded Noble packet keeps its last status (stale).
    if (url.includes('/ibc/')) return Promise.resolve(new Response('not here', { status: 404 }));
    if (url.includes('/status')) return Promise.resolve(json({ result: { sync_info: { latest_block_height: '8343400', latest_block_time: new Date().toISOString(), catching_up: false, earliest_block_height: '1' } } }));
    if (url.includes('abci_query')) {
      const path = decodeURIComponent(url.split('path=')[1] ?? '');
      if (path.includes('/vp/pos/bond/')) return Promise.resolve(json({ result: { response: { code: 1, info: 'RPC error: Cannot find bond', value: null, height: '1' } } }));
      const value = path.includes('/shell/epoch') ? btoa(String.fromCharCode(155, 10, 0, 0, 0, 0, 0, 0))
        : path.includes('/shell/prefix/') ? BAL.value
        : path.includes('/vp/pos/bonds_and_unbonds/to') ? BONDS.value
        : path.includes('delegations_at') ? null
        : path.includes('balance/minted') ? u256(BigInt(BAL.expected.minted))
        : path.includes(`/balance/#${ESCROW}`) ? u256(escrowNam * 10n ** 6n)
        : u256(path.includes('total_stake') ? 75338381473000n : 1000000n);
      return Promise.resolve(json({ result: { response: { code: 0, value, height: '8343400' } } }));
    }
    if (url.includes('denom_owners')) return Promise.resolve(json({ denom_owners: [], pagination: { next_key: null, total: '0' } }));
    if (url.includes('supply/by_denom')) return Promise.resolve(json({ amount: { denom: 'x', amount: String(osmosisNam * 10n ** 6n) } }));
    return Promise.resolve(new Response('not here', { status: 404 }));
  }));
}

async function tick(env: any, start: number) {
  vi.useFakeTimers({ now: start, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  let done = false;
  let err: unknown = null;
  runCron(env).catch((e) => { err = e; }).finally(() => { done = true; });
  for (let i = 0; !done && i < 4000; i++) await vi.advanceTimersByTimeAsync(250);
  vi.useRealTimers();
  if (err) throw err;
  expect(done).toBe(true);
}

const PLAIN = Date.parse('2026-10-17T22:41:05Z');
const bridgeCheck = (db: any) => {
  const r = db.raw.prepare("SELECT status, title, detail FROM checks WHERE key='ibc_conservation'").get();
  return r ? { ...r, detail: JSON.parse(r.detail) } : null;
};

describe('the bridge check judges the two sides of the gap apart', () => {
  it('NAM held for another channel (10,000 NAM over Osmosis, with the 1,614 NAM Noble packet) is a look, never a fault', async () => {
    const db = testD1();
    network(11_624n, 10n);
    await tick({ DB: db, KEPLR_KEY: 'k' }, PLAIN);
    const c = bridgeCheck(db)!;
    expect(c.status).toBe('warn');
    expect(c.detail).toMatchObject({ namadaIbcEscrow: 11_624, osmosisSupply: 10, rawGapNam: 11_614, stuckNam: 1614, driftNam: 10_000, over: 'escrow', otherChainsNam: null });
    expect(c.detail.compared).toBe(IBC_COMPARED);
    expect(c.detail.notCompared).toBe(IBC_NOT_COMPARED);
    expect(c.title).toMatch(/one for every channel/);
    expect(c.title).toMatch(/no other chain is read/);
    // the stuck-packet list still works: the seed is kept (its status could not be re-read) and subtracted
    expect(c.detail.stuckPackets).toHaveLength(1);
    expect(c.detail.stuckPackets[0]).toMatchObject({ nam: 1614, channel: 'channel-5', stale: true });
  });

  it('100 NAM over Osmosis is a look too (not a pass: it may be NAM stuck for Osmosis)', async () => {
    const db = testD1();
    network(1_724n, 10n);
    await tick({ DB: db, KEPLR_KEY: 'k' }, PLAIN);
    expect(bridgeCheck(db)).toMatchObject({ status: 'warn', detail: { driftNam: 100, over: 'escrow' } });
  });

  it('Osmosis counting more than the whole escrow holds is a shortfall, never explained away by other chains', async () => {
    const db = testD1();
    network(1_624n, 20_000n);
    await tick({ DB: db, KEPLR_KEY: 'k' }, PLAIN);
    expect(bridgeCheck(db)).toMatchObject({ status: 'fail', detail: { driftNam: -19_990, over: 'osmosis' } });
  });

  it('the rule, at its edges', () => {
    expect(ibcConservation(11_624, 10, 1614)).toEqual({ status: 'warn', over: 'escrow', rawGapNam: 11_614, driftNam: 10_000 });
    expect(ibcConservation(1_000_000, 10, 0)).toMatchObject({ status: 'warn', over: 'escrow' }); // never 'fail' on this side
    expect(ibcConservation(1_624 + 99, 10, 1614)).toMatchObject({ status: 'ok', over: null });
    expect(ibcConservation(1_624, 10, 1614)).toMatchObject({ status: 'ok', over: null, driftNam: 0 });
    expect(ibcConservation(1_624 - 99, 10, 1614)).toMatchObject({ status: 'ok', over: null });
    expect(ibcConservation(1_624 - 100, 10, 1614)).toMatchObject({ status: 'warn', over: 'osmosis' });
    expect(ibcConservation(1_624, 10_000 + 10 - 1, 1614)).toMatchObject({ status: 'warn', over: 'osmosis' });
    expect(ibcConservation(1_624, 10_000 + 10, 1614)).toMatchObject({ status: 'fail', over: 'osmosis' });
  });
});

describe('the bridge check says what it compares', () => {
  const c = (detail: Record<string, unknown>, status: Check['status'] = 'warn'): Check => ({ key: 'ibc_conservation', status, title: '', detail, checkedAt: 0 });
  const noble = { nam: 1614, sentAt: '2026-06-26T11:13:59Z', note: 'stuck in a transfer to Noble that was refused and never refunded' };

  it('the title says the bridge locks NAM for every chain', () => {
    expect(CHECK_TITLES.ibc_conservation).toBe('NAM locked at the Namada bridge (for every chain) matches NAM on Osmosis');
  });
  it('the bridge holding more is said as that, with what it may be', () => {
    expect(checkDetail(c({ driftNam: 10_000, stuckNam: 1614, stuckPackets: [noble], over: 'escrow' }))).toBe(
      'The Namada bridge holds 10,000 NAM more than Osmosis counts, counting 1,614 NAM stuck in a transfer to Noble that was refused and never refunded (26 Jun 2026); the bridge holds NAM for every chain and only Osmosis is read, so the difference may be NAM sent to another chain');
    expect(checkDetail(c({ driftNam: 250, stuckNam: 0, stuckPackets: [], over: 'escrow' }))).toBe(
      'The Namada bridge holds 250 NAM more than Osmosis counts; the bridge holds NAM for every chain and only Osmosis is read, so the difference may be NAM sent to another chain');
  });
  it('Osmosis counting more is said as a shortfall, with no other chain offered as the reason', () => {
    expect(checkDetail(c({ driftNam: -19_990, stuckNam: 1614, stuckPackets: [noble], over: 'osmosis' }, 'fail'))).toBe(
      'Osmosis counts 19,990 NAM more than the Namada bridge holds, counting 1,614 NAM stuck in a transfer to Noble that was refused and never refunded (26 Jun 2026)');
  });
  it('a result within the tolerance, and one stored before the sides were told apart, read as before', () => {
    expect(checkDetail(c({ driftNam: 0, stuckNam: 1614, stuckPackets: [noble], over: null }, 'ok'))).toBe('Equal, counting 1,614 NAM stuck in a transfer to Noble that was refused and never refunded (26 Jun 2026)');
    expect(checkDetail(c({ driftNam: 1614 }))).toBe('1,614 NAM apart');
  });
});
