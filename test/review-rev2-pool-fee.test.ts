// Review 2 of 7f1dd3c..50cb1ca, Namada parser: the shielded pool's fee is the gas payer's leg, never a recipient's.
//
// Before: when the pool was a transfer's only source, its smallest target was taken as the pool's fee whenever it
// was at most MASP_FEE_CAP_NAM and could pay gas. The smallest target is not always the gas payer: in block 4,349,059
// the pool paid 0.0625 NAM to the gas payer (an account that held exactly that afterwards) and 0.000001 NAM to an
// account that already held NAM, and the parser wrote one flow, "unshield 0.0625 to the gas payer" with
// maspFeeNam 0.000001: the recipient had no flow (no history row, no watcher alert) and the gas payer stood as the
// recipient. Seven blocks of the 70,908 cached ones have that shape (2,455,167, 2,692,029, 2,734,171, 2,993,508,
// 3,738,724, 4,349,059, 4,351,518).
//
// Now: the wrapper's header names its fee payer (the key the fee is charged to; no event names it), and the live scan
// reads it from the block's tx bytes for a block whose pool fee the events alone would have to read; the fee is that
// account's leg. Without the wrapper, the smallest target is the fee only when it is the one target that can be:
// when another can too, every leg is a flow of its own.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseNamadaBlock } from '../worker/src/parse/namada';
import { decodeNamadaTx, decodeUnbond, feePayersOf, txBytesFromBase64 } from '../worker/src/parse/namada-tx';
import { dayAggregates, type DayFlowRow } from '../worker/src/series';
import { NAM, NAMADA } from '../worker/src/config';
import { testD1 } from './d1-sqlite';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { LiveHub } from '../worker/src/live-hub';
import { HubQuote } from '../worker/src/live-quote';

const MASP = NAMADA.internal.masp;
const NAMT = NAM.namadaToken;
const OSMO = 'tnam1p5z8ruwyu7ha8urhq2l0dhpk2f5dv3ts7uyf2n75';
const fx = (n: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures', n), 'utf8'));
const txsOf = (h: number) => fx(`namada_block_${h}_txs.json`).result.block.data.txs as string[];
afterEach(() => vi.unstubAllGlobals());

type L = [string, string, string]; // account, token, base units
const acct = ([a, t, n]: L) => [[`internal-address/${a}`, t], n];
const ev = (hash: string, inner: string, src: L[], dst: L[], post: L[] = []) => ({
  type: 'token/transfer',
  attributes: [
    { key: 'hash', value: hash },
    { key: 'inner-tx-hash', value: inner },
    { key: 'source-accounts', value: JSON.stringify(src.map(acct)) },
    { key: 'target-accounts', value: JSON.stringify(dst.map(acct)) },
    { key: 'post-balances', value: JSON.stringify(post.map(acct)) },
    { key: 'token-event-descriptor', value: 'transfer-from-wasm' },
  ],
});
const rowsOf = (flows: ReturnType<typeof parseNamadaBlock>['flows']): DayFlowRow[] =>
  flows.map((f) => ({ id: f.id, chain: f.chain, ts: f.ts, kind: f.kind, from_addr: f.from, to_addr: f.to, amount_num: f.amount, value_usd: f.valueUsd, meta: JSON.stringify(f.meta) }));
const poolOut = (p: ReturnType<typeof parseNamadaBlock>) => -p.moves.filter((m) => m.address === MASP && m.delta < 0).reduce((s, m) => s + m.delta, 0);

// Block 4,349,059 as the chain wrote it (scripts/out/history/masp_blocks/4349059.json).
const W4349059 = '1E02975A6263D59C7B9EFE35B3F58284440BEDA42495113B05A6A54BDB3DB0C7';
const GAS4349059 = 'tnam1qr4l8egaskk09460llz0qctac7sgemynpu8c7vvd'; // 62,500 in, 62,500 after
const RCPT4349059 = 'tnam1qr8x5rly5mj8wly2ph0zqjkcqkju0g5jkggjn9k3'; // 1 in, 66,667 after
const block4349059 = () => ev(W4349059, '388F36167A8C4A93C0819D41CD9C3F9A3728669F1ECB957BB32F24B540033E16',
  [[MASP, NAMT, '62501']], [[GAS4349059, NAMT, '62500'], [RCPT4349059, NAMT, '1']],
  [[MASP, NAMT, '45157338112900'], [GAS4349059, NAMT, '62500'], [RCPT4349059, NAMT, '66667']]);

// The wrapper of mainnet block 6,957,587 (test/fixtures/namada_block_6957587_txs.json): its fee payer's key gives
// PAYER, the account that unbonded in it. An event under that wrapper hash is a transfer that wrapper paid gas for.
const W6957587 = '0F8F36AAE1B3428B0EF85E71E7535B92017FC464695C0698F186706CD49DFC55';
const PAYER = 'tnam1qp2wt2gjjcqwey2esvae46g6nr9ullzc8v9ydaq8';
const payers = () => feePayersOf(txsOf(6957587));

describe('without the wrapper, a fee is read only when one target can be it', () => {
  it('block 4,349,059: the recipient of 0.000001 NAM has its flow, the gas payer\'s 0.0625 is a flow of its own, no leg is the fee', () => {
    const p = parseNamadaBlock({ height: 4349059, ts: 1, events: [block4349059()] }, null);
    expect(p.flows.map((f) => [f.id, f.kind, f.from, f.to, f.amount])).toEqual([
      [`namada:${W4349059}:0`, 'unshield', MASP, GAS4349059, 0.0625],
      [`namada:${W4349059}:0:1`, 'unshield', MASP, RCPT4349059, 0.000001],
    ]);
    expect(p.flows.some((f) => f.meta?.maspFeeNam != null)).toBe(false);
    // the pool's outflow stays whole, and the wrapper is noted as one whose fee payer would settle the reading
    expect(dayAggregates(rowsOf(p.flows), []).metrics['masp.out_daily']).toBeCloseTo(poolOut(p), 9);
    expect(p.feePayerWanted).toEqual([W4349059]);
  });

  it('block 2,692,029: the account that already held 200,000 NAM is credited with its 0.035424 NAM', () => {
    const W = '207E8A8D0ADCA357A2317C63BB7998E506E6B5662C605241F89908E17D560CB7';
    const gas = 'tnam1qqy86du2673ue9hmesjzmezkllg5lrl5yvns2g84';
    const rcpt = 'tnam1qzpl026lpzugcukkrjam6n48vl9ycmp4zqdmrwvc';
    const p = parseNamadaBlock({ height: 2692029, ts: 1, events: [ev(W, '35DD75449FDD6812235EDCBC1EC18BFC149CD81CBBA0C53954078AED899D737D',
      [[MASP, NAMT, '97924']], [[gas, NAMT, '62500'], [rcpt, NAMT, '35424']], [[gas, NAMT, '62500'], [rcpt, NAMT, '200000000000']])] }, null);
    expect(p.flows.find((f) => f.to === rcpt)).toMatchObject({ kind: 'unshield', from: MASP, amount: 0.035424 });
    expect(p.flows.find((f) => f.to === gas)).toMatchObject({ kind: 'unshield', amount: 0.0625 });
    expect(p.flows.some((f) => f.meta?.maspFeeNam != null)).toBe(false);
  });

  it('the one target that can be the fee is still the fee (block 8,288,955 shape), and the wrapper is noted', () => {
    const W = 'AD23E068E0773BED14D517AD31570B3B03F991284E4B7A3FFB05466C152E7B9B';
    const p = parseNamadaBlock({ height: 8288955, ts: 1, events: [ev(W, 'C'.repeat(64), [[MASP, NAMT, '14700144159']],
      [['tnam1qq6wus66shjjwhe48c3udfyrh05vq62s0ysy3flp', NAMT, '14700000000'], ['tnam1qrx2535e248p02ha8n7w2n76y4xjacu2ncucqhvw', NAMT, '144159']])] }, null);
    expect(p.flows).toHaveLength(1);
    expect(p.flows[0]).toMatchObject({ kind: 'unshield', amount: 14700, meta: { maspFeeNam: 0.144159 } });
    expect(p.feePayerWanted).toEqual([W]);
  });

  it('a pool transfer with no target that can be the fee wants no wrapper', () => {
    const p = parseNamadaBlock({ height: 1, ts: 1, events: [ev('AB'.repeat(32), 'C'.repeat(64), [[MASP, NAMT, '300000000']],
      [['tnam1qq6wus66shjjwhe48c3udfyrh05vq62s0ysy3flp', NAMT, '200000000'], ['tnam1qrx2535e248p02ha8n7w2n76y4xjacu2ncucqhvw', NAMT, '100000000']])] }, null);
    expect(p.flows).toHaveLength(2);
    expect(p.feePayerWanted).toEqual([]);
  });
});

describe('the wrapper names the fee payer', () => {
  it('the header\'s fee payer key gives the account that unbonded or withdrew in each wrapper on record', () => {
    const unbonders = (h: number) => txsOf(h).flatMap((b64) => [...decodeNamadaTx(txBytesFromBase64(b64)).data.values()]
      .flatMap((d) => { try { return [decodeUnbond(d).source]; } catch { return []; } }));
    expect(txsOf(6957587).map((b) => decodeNamadaTx(txBytesFromBase64(b)).feePayer)).toEqual([PAYER]);
    expect(new Set(unbonders(6957587))).toEqual(new Set([PAYER]));
    const s8300328 = 'tnam1qzt66rwk0uvqz3egqqeslsaw0rh9zpwccs8an36t';
    expect(txsOf(8300328).map((b) => decodeNamadaTx(txBytesFromBase64(b)).feePayer)).toEqual([s8300328]);
    expect(new Set(unbonders(8300328))).toEqual(new Set([s8300328]));
    // block 8,251,377: two stake withdrawals paid to PAYER (pos-withdraw-token targets), its wrapper signed by PAYER's key
    expect(txsOf(8251377).map((b) => decodeNamadaTx(txBytesFromBase64(b)).feePayer)).toEqual([PAYER]);
    expect(payers()).toEqual(new Map([[W6957587, PAYER]]));
    expect(feePayersOf(['AAAA', 'not base64'])).toEqual(new Map());
  });

  it('the 4,349,059 shape under a wrapper whose fee payer took the 0.0625 NAM: that leg is the fee, the recipient keeps its unshield', () => {
    const e = ev(W6957587, 'C'.repeat(64), [[MASP, NAMT, '62501']], [[PAYER, NAMT, '62500'], [RCPT4349059, NAMT, '1']]);
    const p = parseNamadaBlock({ height: 1, ts: 1, events: [e] }, null, payers());
    expect(p.flows.map((f) => [f.id, f.kind, f.from, f.to, f.amount, f.meta?.maspFeeNam])).toEqual([
      [`namada:${W6957587}:0`, 'unshield', MASP, RCPT4349059, 0.000001, 0.0625],
    ]);
    expect(dayAggregates(rowsOf(p.flows), []).metrics['masp.out_daily']).toBeCloseTo(poolOut(p), 9);
    expect(p.feePayerWanted).toEqual([]);
  });

  it('a small second target that is not the fee payer is a flow of its own (the fee was paid from elsewhere)', () => {
    const B = 'tnam1qrx2535e248p02ha8n7w2n76y4xjacu2ncucqhvw';
    const e = ev(W6957587, 'C'.repeat(64), [[MASP, NAMT, '101000000']], [['tnam1qq6wus66shjjwhe48c3udfyrh05vq62s0ysy3flp', NAMT, '100000000'], [B, NAMT, '1000000']]);
    const p = parseNamadaBlock({ height: 1, ts: 1, events: [e] }, null, payers());
    expect(p.flows.map((f) => [f.to, f.amount])).toEqual([['tnam1qq6wus66shjjwhe48c3udfyrh05vq62s0ysy3flp', 100], [B, 1]]);
    expect(p.flows.some((f) => f.meta?.maspFeeNam != null)).toBe(false);
    // the same next to another coin: NAM from the pool to someone other than the fee payer is NAM that moved
    const osmo = ev(W6957587, 'C'.repeat(64), [[MASP, NAMT, '84159'], [MASP, OSMO, '20000000']], [['tnam1qq6wus66shjjwhe48c3udfyrh05vq62s0ysy3flp', OSMO, '20000000'], [B, NAMT, '84159']]);
    const q = parseNamadaBlock({ height: 1, ts: 1, events: [osmo] }, null, payers());
    expect(q.flows.find((f) => f.meta?.tokenSymbol)!.meta).not.toHaveProperty('maspFeeNam');
    expect(q.flows.find((f) => !f.meta?.tokenSymbol)).toMatchObject({ kind: 'unshield', from: MASP, to: B, amount: 0.084159 });
    // and paid to the fee payer, it is the pool's fee for that transfer
    const paid = parseNamadaBlock({ height: 1, ts: 1, events: [ev(W6957587, 'C'.repeat(64), [[MASP, NAMT, '84159'], [MASP, OSMO, '20000000']],
      [['tnam1qq6wus66shjjwhe48c3udfyrh05vq62s0ysy3flp', OSMO, '20000000'], [PAYER, NAMT, '84159']])] }, null, payers());
    expect(paid.flows).toHaveLength(1);
    expect(paid.flows[0].meta).toMatchObject({ tokenSymbol: 'OSMO', maspFeeNam: 0.084159 });
  });

  it('the fee payer\'s leg above MASP_FEE_CAP_NAM is a flow, not a fee', () => {
    const e = ev(W6957587, 'C'.repeat(64), [[MASP, NAMT, '106000000']], [['tnam1qq6wus66shjjwhe48c3udfyrh05vq62s0ysy3flp', NAMT, '100000000'], [PAYER, NAMT, '6000000']]);
    const p = parseNamadaBlock({ height: 1, ts: 1, events: [e] }, null, payers());
    expect(p.flows.map((f) => [f.to, f.amount])).toEqual([['tnam1qq6wus66shjjwhe48c3udfyrh05vq62s0ysy3flp', 100], [PAYER, 6]]);
  });
});

describe('the live scan reads the fee payer from the block for such a block', () => {
  const H = 9_000_001;
  const TIME = '2026-10-21T08:00:00Z';
  function scan(block: () => Response | Promise<Response>, events: any[], quote = new HubQuote(async () => null, async () => null)) {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      const url = String(u);
      urls.push(url);
      // the node's status as a node at the head gives it (sources/namada.ts chainHead): its chain, and a newest block from now
      if (url.endsWith('/status')) return Response.json({ result: { node_info: { network: NAMADA.chainId }, sync_info: { latest_block_height: String(H), latest_block_time: new Date().toISOString(), catching_up: false, earliest_block_height: '1' } } });
      if (url.includes('/blockchain?')) return Response.json({ result: { block_metas: [{ header: { chain_id: NAMADA.chainId, height: String(H), time: TIME }, num_txs: '1' }] } });
      if (url.includes('/block_results?')) return Response.json({ result: { end_block_events: events } });
      if (url.includes('/block?height=')) return block();
      throw new Error(`unexpected ${url}`);
    }));
    const db = testD1();
    const hub: any = Object.assign(Object.create(LiveHub.prototype), { env: { DB: db }, sessions: new Set(), lastPriceUsd: null, namadaHeight: 0, quote });
    const flows = () => db.raw.prepare('SELECT id, kind, to_addr, amount_num, meta FROM flows ORDER BY id').all()
      .map((r: any) => [r.id, r.kind, r.to_addr, r.amount_num, JSON.parse(r.meta).maspFeeNam ?? null]);
    const cursor = () => db.raw.prepare("SELECT value FROM kv WHERE key = 'namada.cursor'").get()?.value;
    const prices = () => db.raw.prepare('SELECT price_usd FROM flows ORDER BY id').all().map((r: any) => r.price_usd);
    return { run: () => hub.scanNamada(), urls, flows, cursor, prices };
  }
  const shape = () => [ev(W6957587, 'C'.repeat(64), [[MASP, NAMT, '62501']], [[PAYER, NAMT, '62500'], [RCPT4349059, NAMT, '1']])];

  it('writes the reading tied to the wrapper\'s fee payer', async () => {
    const s = scan(() => Response.json({ result: { block: { data: { txs: txsOf(6957587) } } } }), shape());
    await s.run();
    expect(s.urls.filter((u) => u.includes('/block?height='))).toHaveLength(1);
    expect(s.flows()).toEqual([[`namada:${W6957587}:0`, 'unshield', RCPT4349059, 0.000001, 0.0625]]);
    expect(s.cursor()).toBe(String(H));
  });

  it('tx bytes that cannot be fetched leave the events-only reading, and the scan moves on', async () => {
    const s = scan(() => new Response('down', { status: 502 }), shape());
    await s.run();
    expect(s.flows()).toEqual([
      [`namada:${W6957587}:0`, 'unshield', PAYER, 0.0625, null],
      [`namada:${W6957587}:0:1`, 'unshield', RCPT4349059, 0.000001, null],
    ]);
    expect(s.cursor()).toBe(String(H));
  });

  // review of the live quote, 2026-10-22: a block the scan reaches late is priced at the quote stored for its own
  // minute, never the hub's current one; a stored quote that cannot be read holds the block for the next tick.
  const plain = () => [ev('AB'.repeat(32), 'C'.repeat(64), [['tnam1qq6wus66shjjwhe48c3udfyrh05vq62s0ysy3flp', NAMT, '1000000']], [[PAYER, NAMT, '1000000']])];
  it('a block behind the head is priced at its own minute\'s stored quote', async () => {
    const at = Date.parse(TIME);
    const quote = new HubQuote(async () => 0.0008, async (ts) => (ts >= at - 30_000 ? { usd: 0.0011, at: at - 30_000 } : null));
    await quote.refresh(Date.now());
    const s = scan(() => { throw new Error('not asked'); }, plain(), quote);
    await s.run();
    expect(s.prices()).toEqual([0.0011]);
    expect(s.cursor()).toBe(String(H));
  });
  it('a stored quote that cannot be read holds the block: nothing written, the cursor stays below it', async () => {
    const quote = new HubQuote(async () => null, async () => { throw new Error('D1_ERROR: Network connection lost.'); });
    const s = scan(() => { throw new Error('not asked'); }, plain(), quote);
    await s.run();
    expect(s.flows()).toEqual([]);
    expect(s.cursor() === undefined || Number(s.cursor()) < H).toBe(true);
  });

  it('a block with no pool fee to read costs no extra call', async () => {
    const s = scan(() => { throw new Error('not asked'); }, [ev('AB'.repeat(32), 'C'.repeat(64), [['tnam1qq6wus66shjjwhe48c3udfyrh05vq62s0ysy3flp', NAMT, '1000000']], [[PAYER, NAMT, '1000000']])]);
    await s.run();
    expect(s.urls.some((u) => u.includes('/block?height='))).toBe(false);
    expect(s.flows()).toHaveLength(1);
  });
});

