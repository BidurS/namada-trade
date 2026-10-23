// Security review (2026-10-22), sender text in bridge rows: an IBC packet's memo, receiver and sender are text the
// sending chain's user chose (ibc-go takes a 32 KiB memo and a 2,048-byte receiver; Namada bounds neither below its
// transaction size), and a flow row kept them whole. A memo of control characters is six times longer once escaped,
// so one dust send stored about 197 KB, and every reader of the rows loaded it whole: the moves export (up to 5,000
// rows), a moves page read by address start (up to 2,001 rows) and the cron's 14-day bridge read (no limit), so a few
// hundred sends would take each past the isolate's memory. Now the parsers (and stmt.flow, for any other writer) keep
// at most FLOW_MEMO_MAX units of a memo and FLOW_ADDRESS_MAX of an address, end a cut one with '…', and name each cut
// field's whole length in meta.textCut; real addresses and short memos are kept as they were, and a crossing cut on
// both chains still pairs.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { testD1 } from './d1-sqlite';
import { app } from '../worker/src/api';
import { runBatch, stmt } from '../worker/src/db';
import { normFromTxSearch, parseOsmosisTx, osmoAssets, type OsmoCtx } from '../worker/src/parse/osmosis';
import { parseNamadaBlock } from '../worker/src/parse/namada';
import { unpairedCrossings } from '../worker/src/cron';
import { FLOW_ADDRESS_MAX, FLOW_MEMO_MAX, boundFlowText } from '../worker/src/util';
import { NAM } from '../worker/src/config';
import type { Flow } from '../shared/types';

const fx = (n: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures', n), 'utf8'));
const ctx: OsmoCtx = { poolAddrs: new Map(), priceUsd: null, assets: osmoAssets() };
/** ibc-go's longest memo, of characters JSON writes as six (\u0001). */
const MEMO = '\u0001'.repeat(32768);
/** ibc-go's longest receiver. */
const RECEIVER = 'tnam1' + 'q'.repeat(2043);
/** The 14-day Osmosis bridge read of the cron (cron.ts), as written. */
const CRON_OSMOSIS_BRIDGE_SQL = `SELECT id, kind, ts, from_addr, to_addr, amount_num, meta FROM flows WHERE chain='osmosis' AND kind IN ('ibc_in','ibc_out') AND ts >= ?`;

/** The Osmosis bridge send of osmo_ibc_send.json with its memo and receiver set, under its own hash, at `ts`. */
function osmoSend(memo: string, receiver: string, hash?: string, ts = Date.now()) {
  const raw = fx('osmo_ibc_send.json')[0];
  if (hash) raw.hash = hash;
  for (const e of raw.tx_result.events) if (e.type === 'ibc_transfer') for (const a of e.attributes) {
    if (a.key === 'memo') a.value = memo;
    if (a.key === 'receiver') a.value = receiver;
  }
  return parseOsmosisTx(normFromTxSearch(raw, ts), ctx);
}
/** The Osmosis receive of osmo_ibc_recv.json (Namada block 8261880's send, sequence 8548) with its packet's receiver and memo set. */
function osmoRecv(receiver: string | null, memo: string | null, ts: number) {
  const raw = fx('osmo_ibc_recv.json')[0];
  for (const e of raw.tx_result.events) if (e.type === 'recv_packet') for (const a of e.attributes) if (a.key === 'packet_data') {
    const pd = JSON.parse(a.value);
    if (receiver != null) pd.receiver = receiver;
    if (memo != null) pd.memo = memo;
    a.value = JSON.stringify(pd);
  }
  return parseOsmosisTx(normFromTxSearch(raw, ts), ctx);
}
/** Namada block 8261880 (1 NAM to osmo137zw…, sequence 8548) with its packet's receiver set, at `ts`. */
function namadaSend(receiver: string | null, ts: number) {
  const events = fx('namada_block_8261880.json').result.end_block_events.map((e: any) => (e.type !== 'send_packet' || receiver == null ? e : {
    ...e, attributes: e.attributes.map((a: any) => (a.key !== 'packet_data' ? a : { ...a, value: JSON.stringify({ ...JSON.parse(a.value), receiver }) })),
  }));
  return parseNamadaBlock({ height: 8261880, ts, events }, null);
}
const storedMeta = (f: Flow) => String(stmt.flow(f).params[14] ?? '');

describe('sender text in bridge rows', () => {
  it('an Osmosis send with a 32 KiB memo and a 2,048-character receiver keeps their starts, and says it cut them', () => {
    const p = osmoSend(MEMO, RECEIVER);
    const f = p.flows.find((x) => x.kind === 'ibc_out')!;
    expect(f).toBeTruthy();
    expect(f.to).toHaveLength(FLOW_ADDRESS_MAX);
    expect(f.to).toBe(`${RECEIVER.slice(0, FLOW_ADDRESS_MAX - 1)}…`);
    expect(f.meta!.memo).toBe(`${MEMO.slice(0, FLOW_MEMO_MAX - 1)}…`);
    expect(f.meta!.textCut).toEqual({ memo: 32768, to: 2048 });
    // the packet's identity is the bridge check's, and is kept
    expect(f.meta!.channel).toBe(NAM.osmoChannel);
    expect(f.meta!.packetSequence).toBeTruthy();
    expect(f.amount).toBeGreaterThan(0);
    expect(p.links).toHaveLength(0);
    // what D1 stores: at most six units a memo character, whatever the sender wrote
    expect(storedMeta(f).length).toBeLessThan(6 * FLOW_MEMO_MAX + 200);
    expect(stmt.flow(f).params[7]).toBe(f.to);
  });

  it('real addresses and short memos are kept as they were; a long real memo is cut and says so', () => {
    const send = parseOsmosisTx(normFromTxSearch(fx('osmo_ibc_send.json')[0], 1), ctx).flows.find((x) => x.kind === 'ibc_out')!;
    expect(send.from).toBe('osmo137zwfeku64lzfg4laedyg628qnepqpgkahqyk3');
    expect(send.to).toBe('tnam1qr4wemkpjfycn7ts7297e8qecg2t6pf2vq2wulsa');
    expect(send.meta).toEqual({ memo: '', channel: NAM.osmoChannel, packetSequence: expect.any(String) });
    const recv = osmoRecv(null, null, 1);
    const ibcIn = recv.flows.find((x) => x.kind === 'ibc_in')!;
    expect(ibcIn.meta!.memo).toBe('Namadillo 5ElementsNodes');
    expect(ibcIn.meta!.textCut).toBeUndefined();
    expect(recv.links[0]).toMatchObject({ osmo: 'osmo137zwfeku64lzfg4laedyg628qnepqpgkahqyk3', namada: 'tnam1qr4wemkpjfycn7ts7297e8qecg2t6pf2vq2wulsa' });
    // A receive with a long memo: the memo is cut, the two real accounts are linked as before.
    const fat = osmoRecv(null, MEMO, 1);
    expect(fat.flows.find((x) => x.kind === 'ibc_in')!.meta!.textCut).toEqual({ memo: 32768 });
    expect(fat.links).toEqual(recv.links);
    // Namadillo's shielding memo (about 2,400 characters of a MASP transaction) is cut too; the pool address is kept.
    const masp = parseOsmosisTx(normFromTxSearch(fx('osmo_ibc_send_masp.json'), 1), ctx).flows.find((x) => x.kind === 'ibc_out')!;
    expect(masp.to).toBe('tnam1pcqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzmefah');
    expect(masp.meta!.memo).toHaveLength(FLOW_MEMO_MAX);
    expect(masp.meta!.textCut).toEqual({ memo: 2356 });
    // Namada's own record of the send: the packet's receiver as it was.
    const n = namadaSend(null, 1).flows.find((x) => x.kind === 'ibc_out')!;
    expect(n.to).toBe('osmo137zwfeku64lzfg4laedyg628qnepqpgkahqyk3');
    expect(n.meta!.textCut).toBeUndefined();
  });

  it('a Namada send to a receiver of a megabyte is stored with its start only', () => {
    const big = 'osmo1' + 'q'.repeat(1_000_000);
    const p = namadaSend(big, 1);
    const f = p.flows.find((x) => x.kind === 'ibc_out')!;
    expect(f.to).toBe(`${big.slice(0, FLOW_ADDRESS_MAX - 1)}…`);
    expect(f.meta!.textCut).toEqual({ to: big.length });
    expect(f.amount).toBe(1);
    expect(p.links).toHaveLength(0);
  });

  it('the same text is cut the same way on both chains, so the crossing still pairs', () => {
    const odd = 'osmo1' + 'z'.repeat(400);
    const ts = Date.now() - 3_600_000;
    const n = namadaSend(odd, ts).flows.find((x) => x.kind === 'ibc_out')!;
    const o = osmoRecv(odd, null, ts + 60_000).flows.find((x) => x.kind === 'ibc_in')!;
    expect(n.to).toHaveLength(FLOW_ADDRESS_MAX);
    expect(o.to).toBe(n.to);
    const row = (f: Flow) => ({ id: f.id, kind: f.kind, ts: f.ts, from_addr: f.from, to_addr: f.to, amount_num: f.amount });
    const u = unpairedCrossings([row(n)], [row(o)], Date.now());
    expect(u.namadaOnly).toHaveLength(0);
    expect(u.osmosisOnly).toHaveLength(0);
    // cutting again changes nothing
    expect(boundFlowText(n)).toEqual(n);
  });

  it('stmt.flow stores a row bounded whichever writer gives it (the backfill scripts write rows of their own)', async () => {
    const db = testD1();
    const f: Flow = {
      id: `osmosis:${'B'.repeat(64)}:ibc_out:0`, chain: 'osmosis', height: 1, ts: Date.now(), txHash: 'B'.repeat(64), kind: 'ibc_out',
      from: 'osmo19v0z78d8gv02t4cfqvmtklppu4rmpp5ek3q9a8', to: RECEIVER, amount: 0.000001, priceUsd: null, valueUsd: null,
      meta: { memo: MEMO, channel: NAM.osmoChannel },
    };
    await runBatch(db as any, [stmt.flow(f)]);
    const r = db.raw.prepare('SELECT length(meta) n, to_addr, from_addr, meta FROM flows').get() as any;
    expect(r.to_addr).toHaveLength(FLOW_ADDRESS_MAX);
    expect(r.from_addr).toBe(f.from);
    expect(r.n).toBeLessThan(6 * FLOW_MEMO_MAX + 200);
    expect(JSON.parse(r.meta)).toMatchObject({ channel: NAM.osmoChannel, textCut: { memo: 32768, to: 2048 } });
  });

  it('boundFlowText: a cut never leaves half a character, and a row without meta gets one naming the cut', () => {
    const s = 'a'.repeat(FLOW_ADDRESS_MAX - 2) + '\u{1F600}' + 'b'.repeat(10);
    const f = boundFlowText({ from: s, to: 'tnam1qr4wemkpjfycn7ts7297e8qecg2t6pf2vq2wulsa', meta: null } as any) as any;
    expect(f.from).toBe(`${'a'.repeat(FLOW_ADDRESS_MAX - 2)}…`);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(f.from)).toBe(false);
    expect(f.to).toBe('tnam1qr4wemkpjfycn7ts7297e8qecg2t6pf2vq2wulsa');
    expect(f.meta).toEqual({ textCut: { from: s.length } });
    const same = { from: 'osmo1x', to: null, meta: { memo: 'short' } };
    expect(boundFlowText(same as any)).toBe(same);
  });

  it('the readers load a bounded row: the export, a moves page by address start and the cron bridge read', async () => {
    const run = async (n: number) => {
      const db = testD1();
      const now = Date.now();
      const flows = Array.from({ length: n }, (_, i) => osmoSend(MEMO, RECEIVER, String(i).padStart(64, 'A'), now - i * 1000).flows).flat();
      expect(flows.filter((f) => f.kind === 'ibc_out')).toHaveLength(n);
      await runBatch(db as any, flows.map(stmt.flow));
      const exp = await app.request('/api/export/flows?format=json&limit=100', {}, { DB: db } as any);
      const page = await app.request('/api/flows?addr=tnam1qqqqqqqq&limit=100', {}, { DB: db } as any);
      const cron = db.raw.prepare(CRON_OSMOSIS_BRIDGE_SQL).all(0) as any[];
      return { exp: exp.status, expBody: await exp.text(), page: page.status, pageBody: await page.text(), cron };
    };
    const a = await run(10);
    const b = await run(20);
    for (const r of [a, b]) { expect(r.exp).toBe(200); expect(r.page).toBe(200); }
    const row = JSON.parse(b.expBody).flows[0];
    expect(row.to).toHaveLength(FLOW_ADDRESS_MAX);
    expect(row.meta.textCut).toEqual({ memo: 32768, to: 2048 });
    expect(JSON.parse(b.pageBody).flows).toHaveLength(20);
    // about 199 KB a row before; now a few KB at most
    expect((b.expBody.length - a.expBody.length) / 10).toBeLessThan(3000);
    expect((b.pageBody.length - a.pageBody.length) / 10).toBeLessThan(3000);
    expect(b.cron).toHaveLength(20);
    expect(b.cron.reduce((s, r) => s + r.meta.length + r.to_addr.length, 0)).toBeLessThan(20 * 2000);
  });
});
