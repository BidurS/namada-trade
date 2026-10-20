// The list of IBC packets never delivered (worker/src/ibc-stuck.ts): seeded, re-verified against the indexer
// each tick, dropped when a packet settles, kept with its last status when the indexer cannot be read.
import { describe, it, expect, vi } from 'vitest';
import { reconcileStuckPackets, stuckTotalNam, innerTxOfRow, SEED_STUCK_PACKETS, type StuckList } from '../worker/src/ibc-stuck';

const SEED = SEED_STUCK_PACKETS[0].innerTx;
const NOW = Date.parse('2026-10-19T12:00:00Z');
const unknown = { status: 'unknown', timeout: '2026-06-26T11:33:47.274Z' };
const lookupOf = (answers: Record<string, { status: string; timeout: string | null } | null | Error>) =>
  vi.fn(async (inner: string) => { const a = answers[inner]; if (a instanceof Error) throw a; return a ?? null; });

describe('stuck packets', () => {
  it('starts from the seed, verified at run time, and sums it', async () => {
    const lookup = lookupOf({ [SEED]: unknown });
    const list = await reconcileStuckPackets(null, [], lookup, NOW);
    expect(lookup).toHaveBeenCalledWith(SEED);
    expect(list.packets).toHaveLength(1);
    expect(list.packets[0]).toMatchObject({ innerTx: SEED, nam: 1614, status: 'unknown', verifiedAt: NOW, listedBy: 'seed', sentAt: '2026-06-26T11:13:59Z', timeout: unknown.timeout, channel: 'channel-5', sequence: 1647, counterparty: 'Noble' });
    expect(list.packets[0].stale).toBeUndefined();
    expect(stuckTotalNam(list)).toBe(1614);
  });

  it('drops a packet once the indexer says it timed out (refunded) or was delivered, and records the drop', async () => {
    const prev: StuckList = { at: NOW - 60000, packets: [{ ...SEED_STUCK_PACKETS[0], status: 'unknown', timeout: null, verifiedAt: NOW - 60000, listedAt: 0, listedBy: 'seed' }], dropped: [] };
    const list = await reconcileStuckPackets(prev, [], lookupOf({ [SEED]: { status: 'timeout', timeout: null } }), NOW);
    expect(list.packets).toHaveLength(0);
    expect(stuckTotalNam(list)).toBe(0);
    expect(list.dropped).toEqual([{ innerTx: SEED, nam: 1614, status: 'timeout', at: NOW }]);
    // the seed is not re-added on the next tick: the stored list (empty) is the truth once it has been read
    const again = await reconcileStuckPackets(list, [], lookupOf({ [SEED]: { status: 'success', timeout: null } }), NOW + 60000);
    expect(again.packets).toHaveLength(0);
    expect(again.dropped).toHaveLength(1);
  });

  it('keeps a packet with its last status, marked stale, when the indexer cannot be read', async () => {
    const prev: StuckList = { at: NOW - 60000, packets: [{ ...SEED_STUCK_PACKETS[0], status: 'unknown', timeout: null, verifiedAt: NOW - 3600000, listedAt: 0, listedBy: 'seed' }], dropped: [] };
    const list = await reconcileStuckPackets(prev, [], lookupOf({ [SEED]: new Error('timeout') }), NOW);
    expect(list.packets[0]).toMatchObject({ status: 'unknown', verifiedAt: NOW - 3600000, stale: true });
    expect(stuckTotalNam(list)).toBe(1614);
    const ok = await reconcileStuckPackets(list, [], lookupOf({ [SEED]: unknown }), NOW + 60000);
    expect(ok.packets[0].stale).toBeUndefined();
    expect(ok.packets[0].verifiedAt).toBe(NOW + 60000);
  });

  it('adds a Namada-only send the indexer calls unknown, not one it calls success, and never more than maxReads', async () => {
    const c = (inner: string, nam: number) => ({ innerTx: inner, wrapperTx: null, height: 8300000, sentAt: '2026-10-17T00:00:00.000Z', nam, channel: 'channel-1', sequence: 99, counterparty: null });
    const lookup = lookupOf({ [SEED]: unknown, aaaa: { status: 'unknown', timeout: null }, bbbb: { status: 'success', timeout: null }, cccc: { status: 'unknown', timeout: null } });
    const list = await reconcileStuckPackets(null, [c('aaaa', 10), c('bbbb', 20), c('cccc', 30)], lookup, NOW, 3);
    expect(list.packets.map((p) => [p.innerTx, p.listedBy])).toEqual([[SEED, 'seed'], ['aaaa', 'bridge_records']]);
    expect(lookup).toHaveBeenCalledTimes(3);
    expect(stuckTotalNam(list)).toBe(1624);
    expect(list.packets[1].evidence).toContain('/ibc/aaaa/status');
  });

  it('finds the inner hash of a flows row keyed by inner hash (indexer rows) or by wrapper with meta.innerTxHash (live rows)', () => {
    expect(innerTxOfRow({ id: 'namada:3D4ADA1C1183EE7E1B66E0F89865C01D34A7B4BF201ED357AE58C418DF8180C5:h0', meta: '{"source":"namada-indexer"}' })).toBe(SEED);
    expect(innerTxOfRow({ id: 'namada:DF26C3D0523663005B432B4903B12DE57F4E449335731BADE04CFFF56D1C7CD8:t0', meta: JSON.stringify({ innerTxHash: SEED }) })).toBe(SEED);
    expect(innerTxOfRow({ id: 'osmosis:abc:0', meta: null })).toBeNull();
  });
});
