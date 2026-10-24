// A sale's Discord card, its "Before this" line: the crossing that brought the NAM is said once when both chains'
// records of it are stored (the Namada sending record and the Osmosis receiving record, as production holds them).
import { describe, it, expect, beforeEach } from 'vitest';
import { testD1, insert, type TestD1 } from './d1-sqlite';
import { readMoveContext, resetContextCache } from '../worker/src/sources/discord-context';
import { buildFlowDiscordBody } from '../worker/src/sources/discord';
import type { Flow } from '../shared/types';

const osmo = (s: string) => `osmo1${s.padEnd(38, 'q')}`;
const tnam = (s: string) => `tnam1${s.padEnd(40, 'q')}`;
const MIN = 60_000;
const T = Date.UTC(2026, 9, 24, 4, 29);
let n = 0;
function row(over: Record<string, unknown> & { kind: string; chain: string; ts: number; amount_num: number }) {
  n += 1;
  const { meta, ...rest } = over as any;
  return { id: `${over.chain}:BTC${n}:0`, height: n, tx_hash: `BTC${n}`, from_addr: null, to_addr: null, price_usd: null, value_usd: null, ...rest, meta: JSON.stringify({ source: 't', ...(meta ?? {}) }) };
}
const flowOf = (r: any): Flow => ({ id: r.id, chain: r.chain, height: r.height, ts: r.ts, txHash: r.tx_hash, kind: r.kind, from: r.from_addr, to: r.to_addr, amount: r.amount_num, priceUsd: r.price_usd, valueUsd: r.value_usd, meta: JSON.parse(r.meta) });

let db: TestD1;
beforeEach(() => { db = testD1(); resetContextCache(); });

describe('the crossing before a sale, stored on both chains', () => {
  it('is said once in Before this', async () => {
    const sender = tnam('sndr'), seller = osmo('sllr');
    const meta = { channel: 'channel-98451', packetSequence: '9001' };
    insert(db, 'flows', [
      row({ chain: 'namada', kind: 'ibc_out', from_addr: sender, to_addr: seller, ts: T - 3 * MIN, amount_num: 979, meta }),
      row({ chain: 'osmosis', kind: 'ibc_in', from_addr: sender, to_addr: seller, ts: T - 3 * MIN + 16_000, amount_num: 979, meta }),
    ]);
    const sale = row({ chain: 'osmosis', kind: 'sell', from_addr: seller, ts: T, amount_num: 974.11 });
    insert(db, 'flows', [sale]);
    const { ctx } = await readMoveContext(db as any, flowOf(sale), T + 5_000);
    const desc = String(buildFlowDiscordBody(flowOf(sale), ctx).embeds[0].description).replace(/ /g, ' ');
    const before = desc.split('\n\n').find((p) => p.startsWith('Before this'))!;
    expect(before.match(/received 979 NAM from Namada/g)?.length).toBe(1);
  });
});
