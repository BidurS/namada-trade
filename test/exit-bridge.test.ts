// A bridge send that came straight out of the shielded pool (worker/src/exit-bridge.ts, the rule 'exit_bridge' of
// shared/alerts.ts), on the rows of the seller traced on 2026-10-29 as the site stores them: the unshields to
// tnam1qzdxrdjvkhlxmxqna5c09d3sst6d9mhufcu58su2 and its three sends to Osmosis over channel-1 (heights and
// milliseconds from /api/flows, read 2026-10-30).
import { describe, it, expect } from 'vitest';
import { stampShieldedExits, sendsToStamp, priorUnshields, EXIT_BRIDGE_WINDOW_MS, type UnshieldRow } from '../worker/src/exit-bridge';
import { evaluateFlow, fromShieldedOf, DEFAULT_THRESHOLDS } from '../shared/alerts';
import { alertsBetween, lastAlertBefore } from '../worker/src/analytics';
import { testD1, insert } from './d1-sqlite';
import type { Flow } from '../shared/types';

const SELLER = 'tnam1qzdxrdjvkhlxmxqna5c09d3sst6d9mhufcu58su2';
const MASP = 'tnam1pcqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzmefah';
const OSMO = 'osmo1nn62s9hm7ns4lwqsl70y49xx5tpe0ft45evpvh';
const unshield = (ts: number, amount: number, height: number): Flow => ({ id: `namada:U${height}:0`, chain: 'namada', height, ts, txHash: `U${height}`, kind: 'unshield', from: MASP, to: SELLER, amount });
const send = (ts: number, amount: number, height: number, channel = 'channel-1', from = SELLER): Flow => ({ id: `namada:S${height}:0`, chain: 'namada', height, ts, txHash: `S${height}`, kind: 'ibc_out', from, to: OSMO, amount, meta: { channel } });
const row = (f: Flow): UnshieldRow => ({ to: f.to!, amount: f.amount, ts: f.ts });

// 2026-10-21: 5 NAM at 13:45:28, 1,000 at 13:47:57, 1,600,000 at 13:49:06, then 1,500,000 sent at 13:56:41
const OCT21 = [unshield(1792590328135, 5, 8362231), unshield(1792590477774, 1000, 8362253), unshield(1792590546115, 1600000, 8362263)];
const SEND21 = () => send(1792591001324, 1500000, 8362330);
// 2026-10-25: 1 NAM at 16:18:31, 334,000 at 16:41:58, then 434,000 sent at 16:43:27 (77% of it unshielded in the hour)
const OCT25 = [unshield(1792945111351, 1, 8413947), unshield(1792946518084, 334000, 8414152)];
const SEND25 = () => send(1792946607291, 434000, 8414165);
// 2026-10-29: 800,000 at 05:51:42, then 800,000 sent at 05:53:31
const OCT29 = [unshield(1793253102916, 800000, 8458660)];
const SEND29 = () => send(1793253211149, 800000, 8458676);

describe('a bridge send stamped with its shielded source', () => {
  it('each of the seller’s three sends is stamped from the unshields of the hour before it, and fires the rule with the words of what happened', () => {
    const s21 = SEND21(); stampShieldedExits([s21], OCT21.map(row));
    expect(fromShieldedOf(s21)).toEqual({ nam: 1601005, firstAt: 1792590328135, lastAt: 1792590546115, unshields: 3 });
    const s25 = SEND25(); stampShieldedExits([s25], [...OCT21, ...OCT25].map(row));
    expect(fromShieldedOf(s25)).toEqual({ nam: 334001, firstAt: 1792945111351, lastAt: 1792946518084, unshields: 2 });
    const s29 = SEND29(); stampShieldedExits([s29], OCT29.map(row));
    expect(fromShieldedOf(s29)).toEqual({ nam: 800000, firstAt: 1793253102916, lastAt: 1793253102916, unshields: 1 });
    const hit = evaluateFlow(s29).find((h) => h.ruleId === 'exit_bridge')!;
    expect(hit.title).toBe('800,000 NAM sent to Osmosis from the shielded set');
    expect(hit.detail).toBe('800,000 NAM left the shielded set to tnam1qzdxr…8su2 2 min before; it then sent 800,000 NAM to osmo1nn62s…vpvh');
    expect(hit.address).toBe(SELLER);
    expect(evaluateFlow(s21).find((h) => h.ruleId === 'exit_bridge')!.detail).toBe('1,601,005 NAM left the shielded set to tnam1qzdxr…8su2 in 3 unshields, the last 8 min before; it then sent 1,500,000 NAM to osmo1nn62s…vpvh');
  });

  it('unshields more than an hour before, or under half of the send, or to another address, leave the send unstamped', () => {
    const late = SEND21(); late.ts = OCT21[2].ts + EXIT_BRIDGE_WINDOW_MS + 1; stampShieldedExits([late], OCT21.map(row));
    expect(fromShieldedOf(late)).toBe(null);
    const big = send(1792946607291, 700000, 8414165); stampShieldedExits([big], OCT25.map(row));
    expect(fromShieldedOf(big)).toBe(null); // 334,001 of 700,000 is under half
    const other = send(1793253211149, 800000, 8458676, 'channel-1', 'tnam1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'); stampShieldedExits([other], OCT29.map(row));
    expect(fromShieldedOf(other)).toBe(null);
    const before = SEND29(); stampShieldedExits([before], [{ ...row(OCT29[0]), ts: before.ts + 1 }]);
    expect(fromShieldedOf(before)).toBe(null); // an unshield after the send is not where it came from
    expect(evaluateFlow(late).some((h) => h.ruleId === 'exit_bridge')).toBe(false);
  });

  it('a send to another chain is not stamped; one the shielded pool made itself is stamped direct; the same block’s unshield counts; a stamp in place stays', () => {
    const noble = send(1793253211149, 800000, 8458676, 'channel-5'); stampShieldedExits([noble], OCT29.map(row));
    expect(sendsToStamp([noble])).toEqual([]);
    expect(fromShieldedOf(noble)).toBe(null);
    const direct = send(1793253211149, 200000, 8458676, 'channel-1', MASP); stampShieldedExits([direct], []);
    expect(fromShieldedOf(direct)).toEqual({ nam: 200000, firstAt: 1793253211149, lastAt: 1793253211149, unshields: 0, direct: true });
    expect(evaluateFlow(direct).find((h) => h.ruleId === 'exit_bridge')!.detail).toBe('straight from the shielded set, to osmo1nn62s…vpvh');
    const block = [OCT29[0], { ...SEND29(), height: OCT29[0].height, ts: OCT29[0].ts }];
    stampShieldedExits(block, []);
    expect(fromShieldedOf(block[1])).toMatchObject({ nam: 800000, unshields: 1 });
    expect(evaluateFlow(block[1]).find((h) => h.ruleId === 'exit_bridge')!.detail).toContain('in the same block');
    const kept = SEND29(); kept.meta = { channel: 'channel-1', fromShielded: { nam: 1, firstAt: 1, lastAt: 1, unshields: 1 } }; stampShieldedExits([kept], OCT29.map(row));
    expect(fromShieldedOf(kept)).toEqual({ nam: 1, firstAt: 1, lastAt: 1, unshields: 1 });
  });

  it('under the rule’s size the send is stamped but fires nothing; a send with no stamp never fires the rule', () => {
    const small = send(1793253211149, 50000, 8458676); stampShieldedExits([small], OCT29.map(row));
    expect(fromShieldedOf(small)).not.toBe(null);
    expect(DEFAULT_THRESHOLDS.exitBridge).toBe(100000);
    expect(evaluateFlow(small).some((h) => h.ruleId === 'exit_bridge')).toBe(false);
    expect(evaluateFlow(SEND29()).some((h) => h.ruleId === 'exit_bridge')).toBe(false);
  });

  it('the stored unshields are read in one query, by receiver and window, the shielded pool’s own sends asking nothing', async () => {
    const db = testD1();
    const r = (f: Flow) => ({ id: f.id, chain: f.chain, height: f.height, ts: f.ts, tx_hash: f.txHash, kind: f.kind, from_addr: f.from, to_addr: f.to, amount_num: f.amount, meta: f.meta ? JSON.stringify(f.meta) : null });
    insert(db, 'flows', [...OCT21, ...OCT25, ...OCT29].map(r));
    const got = await priorUnshields(db as any, [SEND25()]);
    expect(got.sort((a, b) => a.ts - b.ts)).toEqual(OCT25.map(row));
    expect(await priorUnshields(db as any, [send(1793253211149, 1, 1, 'channel-1', MASP)])).toEqual([]);
  });

  it('a block read again counts its own unshields once (review of 2026-10-30): the stored rows of the send’s own block are not read, that block’s parse supplies them', async () => {
    const db = testD1();
    const r = (f: Flow) => ({ id: f.id, chain: f.chain, height: f.height, ts: f.ts, tx_hash: f.txHash, kind: f.kind, from_addr: f.from, to_addr: f.to, amount_num: f.amount, meta: null });
    // a 1,000 NAM send with a 300 NAM unshield in the same block, already stored once
    const u = unshield(1793253200000, 300, 8458700), s1 = send(1793253200000, 1000, 8458700);
    insert(db, 'flows', [r(u)]);
    const again = [unshield(1793253200000, 300, 8458700), send(1793253200000, 1000, 8458700)];
    stampShieldedExits(again, await priorUnshields(db as any, [s1]));
    expect(fromShieldedOf(again[1])).toBe(null); // 300 of 1,000, not 600
  });

  it('an unshield in another coin is not NAM (review of 2026-10-30): 60,000 USDC unshielded before a 100,000 NAM send stamps nothing', async () => {
    const db = testD1();
    const usdc = { ...unshield(1793253102916, 60000, 8458660), meta: { tokenSymbol: 'USDC' } };
    insert(db, 'flows', [{ id: usdc.id, chain: 'namada', height: usdc.height, ts: usdc.ts, tx_hash: usdc.txHash, kind: 'unshield', from_addr: MASP, to_addr: SELLER, amount_num: 60000, meta: JSON.stringify(usdc.meta) }]);
    const s = send(1793253211149, 100000, 8458676);
    const prior = await priorUnshields(db as any, [s]);
    expect(prior).toEqual([]);
    stampShieldedExits([usdc, s], prior);
    expect(fromShieldedOf(s)).toBe(null);
  });

  it('the Alerts page’s reads find a stamped send and pass over an unstamped one (review of 2026-10-30)', async () => {
    const db = testD1();
    const stamped = SEND29(); stampShieldedExits([stamped], OCT29.map(row));
    const plain = { ...send(1793253211149 - 60_000, 900000, 8458670), id: 'namada:PLAIN:0', txHash: 'PLAIN' };
    const r = (f: Flow) => ({ id: f.id, chain: f.chain, height: f.height, ts: f.ts, tx_hash: f.txHash, kind: f.kind, from_addr: f.from, to_addr: f.to, amount_num: f.amount, meta: JSON.stringify(f.meta ?? {}) });
    insert(db, 'flows', [r(stamped), r(plain)]);
    const hits = await alertsBetween(db as any, stamped.ts - 3_600_000, stamped.ts + 1, DEFAULT_THRESHOLDS);
    expect(hits.map((h) => [h.ruleId, h.flowId])).toEqual([['exit_bridge', stamped.id]]);
    const last = await lastAlertBefore(db as any, stamped.ts + 1, { ...DEFAULT_THRESHOLDS, ibcInventory: 1e12, unlock: 1e12, bigSwap: 1e12, unshield: 1e12, bond: 1e12 });
    expect(last).toMatchObject({ ruleId: 'exit_bridge', flowId: stamped.id });
    expect(await lastAlertBefore(db as any, stamped.ts, { ...DEFAULT_THRESHOLDS, ibcInventory: 1e12, unlock: 1e12, bigSwap: 1e12, unshield: 1e12, bond: 1e12 })).toBe(null);
  });
});
