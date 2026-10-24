// Live bonds: the live scan had no decoder for bond requests, so no bond after the indexer import (the last at block
// 8,301,075) was stored, for example the two 13,000 NAM bonds of blocks 8,351,607 and 8,351,621. A bond moves NAM to
// the staking account with no token/transfer event; it is now decoded from the block's tx bytes as unbonds are
// (parse/namada-bond.ts, parse/namada-pos.ts), into the row the indexer import writes for a bond. The fixture is
// mainnet block 8,351,607 as both configured nodes answered it on 2026-10-23 (block_results and /block identical).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '@noble/hashes/sha2.js';
import { base64, hex } from '@scure/base';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { decodeBond, decodeNamadaTx, decodeUnbond, txBytesFromBase64, unwrapTxBytes } from '../worker/src/parse/namada-tx';
import { appliedBonds, blockHasBond, parseNamadaBonds, BOND_CODE_HASHES } from '../worker/src/parse/namada-bond';
import { blockHasUnbond, parseNamadaUnbonds } from '../worker/src/parse/namada-unbond';
import type { NamadaBlock } from '../worker/src/parse/namada';
import { LiveHub, LATE_SCAN_MS } from '../worker/src/live-hub';
import { buildFlowDiscordBody } from '../worker/src/sources/discord';
import { HubQuote } from '../worker/src/live-quote';
import { NAMADA } from '../worker/src/config';
import { testD1, type TestD1 } from './d1-sqlite';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const fx = (n: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures', n), 'utf8'));
const POS = NAMADA.internal.pos;
const H = 8351607;
const WRAPPER = '0CB1EEDDA9D8F82DEA3E6ECED81EDC9BB0ED3505CDFA8E006DE8D818FF061810';
const INNER = '49E6CB93123C4F4D1288450107D271896BE9AB6F5CB2CC595AB8597A68B86298';
const DELEGATOR = 'tnam1qp0zhplft7kn54606vwll4kl0tat3lp04c4g5z4q';
const VALIDATOR = 'tnam1q8e4mk446hs3jjaj0ymmurn59fz6ylktd52v9yn3';
const BOND_CODE = '490CF419BDBFFE616C6AA6C72D38064E350EE65FB04D92472CCF285AEC6844B6';
const UNBOND_CODE = '36E774350B865752C9D309D518223ABF0A60374BAE15A1F73DFE4721B5887048';

const eventsOf = (r: any) => [...(r.begin_block_events ?? []), ...(r.end_block_events ?? []), ...(r.finalize_block_events ?? []), ...((r.txs_results ?? []) as any[]).flatMap((t) => t.events ?? [])];
function block(h: number): NamadaBlock {
  const r = fx(`namada_block_${h}.json`).result;
  return { height: h, ts: Date.parse(fx(`namada_block_${h}_txs.json`).result.block.header.time), events: eventsOf(r) };
}
const txsOf = (h: number) => fx(`namada_block_${h}_txs.json`).result.block.data.txs as string[];

describe('the bond decoder on block 8,351,607', () => {
  it('derives the wrapper and inner hashes the chain reports, and the tx_bond.wasm code', () => {
    const tx = decodeNamadaTx(txBytesFromBase64(txsOf(H)[0]));
    expect(tx.wrapperHash).toBe(WRAPPER);
    expect(tx.commitments.map((c) => c.innerHash)).toEqual([INNER]);
    const c = tx.commitments[0];
    expect(tx.codes.get(c.codeHash)).toEqual({ tag: 'tx_bond.wasm', codeHash: BOND_CODE });
    expect(tx.stoppedAt).toBeNull();
    expect([...BOND_CODE_HASHES]).toEqual([BOND_CODE]);
  });

  it('decodes Bond { validator, amount, source } as indexer.namada.net reports it (13000000000 base units)', () => {
    const tx = decodeNamadaTx(txBytesFromBase64(txsOf(H)[0]));
    const data = tx.data.get(tx.commitments[0].dataHash)!;
    expect(decodeBond(data)).toEqual({ validator: VALIDATOR, amount: 13_000_000_000n, source: DELEGATOR });
    expect(() => decodeBond(new Uint8Array([0, 1, 2]))).toThrow();
    expect(() => decodeBond(new Uint8Array([...data, 0]))).toThrow(/trailing bytes after Bond/);
  });

  it('the block wrote the bond key of that pair, and no unbond key', () => {
    const b = block(H);
    expect(blockHasBond(b)).toBe(true);
    expect(appliedBonds(b)).toEqual([{ wrapperHash: WRAPPER, innerHash: INNER, keys: [{ source: DELEGATOR, validator: VALIDATOR }] }]);
    expect(blockHasUnbond(b)).toBe(false);
    expect(parseNamadaUnbonds(b, txsOf(H), null).flows).toEqual([]);
  });

  it('gives the row the indexer import writes for a bond: delegator → PoS, id namada:<inner>:pos, the exact block time', () => {
    const b = block(H);
    expect(b.ts).toBe(Date.parse('2026-10-20T17:38:17.113464949Z'));
    const p = parseNamadaBonds(b, txsOf(H), 0.001);
    expect(p.undecoded).toEqual([]);
    expect(p.skipped).toEqual({});
    expect(p.flows).toEqual([{
      id: `namada:${INNER}:pos`, chain: 'namada', height: H, ts: b.ts, txHash: INNER, kind: 'bond',
      from: DELEGATOR, to: POS, amount: 13000, priceUsd: 0.001, valueUsd: 13,
      meta: { source: 'namada-rpc', txKind: 'bond', validator: VALIDATOR, wrapper: WRAPPER, tsSource: 'block', code: BOND_CODE, priceSource: 'spot' },
    }]);
    // no quote for its minute: no value invented
    const np = parseNamadaBonds(b, txsOf(H), null);
    expect(np.flows[0]).toMatchObject({ priceUsd: null, valueUsd: null });
    expect(np.flows[0].meta).not.toHaveProperty('priceSource');
  });

  it('an unbond writes bond keys too, and is never read as a bond (block 8,300,328; block 6,957,587\'s two)', () => {
    for (const [h, n] of [[8300328, 1], [6957587, 2]] as const) {
      const b = block(h);
      expect(blockHasBond(b)).toBe(true);
      const p = parseNamadaBonds(b, txsOf(h), null);
      expect(p.flows).toEqual([]);
      expect(p.undecoded).toEqual([]);
      expect(p.skipped).toEqual({ 'tx_unbond.wasm': n });
      expect(parseNamadaUnbonds(b, txsOf(h), null).flows).toHaveLength(n);
    }
  });

  it('an inner tx that was not applied (Err) gives no row; a decoded pair the changed keys do not name is reported', () => {
    const b = block(H);
    const ev = b.events.find((e) => e.type === 'tx/applied')!;
    const batchAttr = ev.attributes.find((x) => x.key === 'batch')!;
    const orig = batchAttr.value;
    batchAttr.value = JSON.stringify({ [INNER]: { Err: 'rejected' } });
    expect(parseNamadaBonds(b, txsOf(H), null)).toEqual({ flows: [], undecoded: [], skipped: {} });
    batchAttr.value = orig.split(VALIDATOR).join('tnam1q9pt4hukg0ga362jq2slhg4tuf692zqqngzzz54k');
    const p = parseNamadaBonds(b, txsOf(H), null);
    expect(p.flows).toEqual([]);
    expect(p.undecoded[0].reason).toMatch(/does not match changed keys/);
  });

  it('a request a validity predicate rejected is not applied, though its result is Ok: no bond row (block 7,852,270), no unbond row', () => {
    // Block 7,852,270: five batches of a rewards claim and a bond. Two bonds ran out of gas (Err), two were applied,
    // and the delegator's VP rejected the 214.659543 NAM bond of the fifth, which indexer.namada.net files as rejected:
    // its result is Ok and its changed keys are listed all the same.
    const b = block(7852270);
    const bond = '61FB20A84B7113A0';
    const ev = b.events.filter((e) => e.type === 'tx/applied').map((e) => JSON.parse(e.attributes.find((a) => a.key === 'batch')!.value));
    const res = Object.entries(ev.find((x) => Object.keys(x).some((k) => k.startsWith(bond)))!).find(([k]) => k.startsWith(bond))![1] as any;
    expect(res.Ok.vps_result.rejected_vps).toHaveLength(1);
    expect(res.Ok.changed_keys.some((k: any) => k.segments[1]?.StringSeg === 'bond')).toBe(true);
    expect(appliedBonds(b).map((w) => w.innerHash.slice(0, 12))).toEqual(['249C2315550B', '9D36839BC180']);
    const p = parseNamadaBonds(b, txsOf(7852270), null);
    expect(p.flows.map((f) => [f.txHash.slice(0, 12), f.amount])).toEqual([['249C2315550B', 129.238232], ['9D36839BC180', 14.755961]]);
    expect(p.undecoded).toEqual([]);
    // the same verdict on an unbond: block 8,300,328's unbond with a VP rejecting it gives no row
    const u = block(8300328);
    const attr = u.events.find((e) => e.type === 'tx/applied')!.attributes.find((a) => a.key === 'batch')!;
    const batch = JSON.parse(attr.value);
    for (const v of Object.values<any>(batch)) v.Ok.vps_result.rejected_vps = ['tnam1qzt66rwk0uvqz3egqqeslsaw0rh9zpwccs8an36t'];
    attr.value = JSON.stringify(batch);
    expect(blockHasUnbond(u)).toBe(false);
    expect(parseNamadaUnbonds(u, txsOf(8300328), null).flows).toEqual([]);
  });

  it('the tx bytes of another block leave the bond undecoded, never guessed', () => {
    const p = parseNamadaBonds(block(H), txsOf(8300328), null);
    expect(p.flows).toEqual([]);
    expect(p.undecoded).toEqual([{ wrapperHash: WRAPPER, innerHash: INNER, reason: 'inner hash not found in block txs' }]);
  });

  it('a token/transfer event naming the same inner tx: no second row of the same tokens, and it is reported', () => {
    const b = block(H);
    b.events.push({ type: 'token/transfer', attributes: [{ key: 'hash', value: WRAPPER }, { key: 'inner-tx-hash', value: INNER.toLowerCase() }] });
    const p = parseNamadaBonds(b, txsOf(H), null);
    expect(p.flows).toEqual([]);
    expect(p.undecoded[0].reason).toMatch(/token\/transfer event/);
  });
});

// ---- The real tx re-encoded: its Code section's tag and checksum, or its Data section, replaced, every hash that
// names the old section (the header commitments, the signatures' targets) rewritten, as review-c-unbond-code does.
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((s, x) => s + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const find = (b: Uint8Array, n: Uint8Array) => { for (let i = 0; i + n.length <= b.length; i++) if (n.every((v, k) => b[i + k] === v)) return i; return -1; };
const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const tagBytes = (tag: string | null) => (tag === null ? new Uint8Array([0]) : cat(new Uint8Array([1]), u32(tag.length), new TextEncoder().encode(tag)));
const raw = () => unwrapTxBytes(txBytesFromBase64(txsOf(H)[0]));
const swapHash = (tx: Uint8Array, from: Uint8Array, to: Uint8Array) => {
  if (hex.encode(from) !== hex.encode(to)) for (let i = find(tx, from); i >= 0; i = find(tx, from)) tx.set(to, i);
  return tx;
};

function recode(tag: string | null, code: string = BOND_CODE): string {
  const tx = raw();
  const old = cat(hex.decode(BOND_CODE.toLowerCase()), tagBytes('tx_bond.wasm'));
  const at = find(tx, old);
  expect(tx[at - 10]).toBe(2); // Section::Code, then salt(8) and Commitment::Hash
  const salt = tx.slice(at - 9, at - 1);
  const next = cat(hex.decode(code.toLowerCase()), tagBytes(tag));
  const out = cat(tx.slice(0, at), next, tx.slice(at + old.length));
  return base64.encode(swapHash(out, sha256(cat(new Uint8Array([2]), salt, old)), sha256(cat(new Uint8Array([2]), salt, next))));
}
function redata(data: Uint8Array): string {
  const tx = raw();
  const d = decodeNamadaTx(tx);
  const old = d.data.get(d.commitments[0].dataHash)!;
  const at = find(tx, cat(u32(old.length), old));
  expect(tx[at - 9]).toBe(0); // Section::Data, then salt(8)
  const sec = (x: Uint8Array) => cat(tx.slice(at - 9, at), u32(x.length), x);
  const out = cat(tx.slice(0, at - 9), sec(data), tx.slice(at + 4 + old.length));
  return base64.encode(swapHash(out, sha256(sec(old)), sha256(sec(data))));
}
/** block_results for a re-encoded tx: its wrapper and inner hash, applied, with the bond key of its decoded pair. */
function blockFor(b64: string, pair?: { source: string; validator: string }): NamadaBlock {
  const tx = decodeNamadaTx(txBytesFromBase64(b64));
  const c = tx.commitments[0];
  const u = decodeBond(tx.data.get(c.dataHash)!);
  const { source, validator } = pair ?? { source: u.source ?? u.validator, validator: u.validator };
  const key = { segments: [{ AddressSeg: POS }, { StringSeg: 'bond' }, { AddressSeg: source }, { AddressSeg: validator }, { StringSeg: 'lazy_map' }] };
  const ok = { changed_keys: [key], vps_result: { accepted_vps: [POS], rejected_vps: [], errors: [], status_flags: '' } };
  return { height: H, ts: block(H).ts, events: [{ type: 'tx/applied', attributes: [{ key: 'hash', value: tx.wrapperHash }, { key: 'batch', value: JSON.stringify({ [c.innerHash]: { Ok: ok } }) }] }] };
}

describe('a live bond is decided by the code it ran', () => {
  it('harness control: the tag it has gives the bond of the chain', () => {
    const b64 = recode('tx_bond.wasm');
    expect(b64).toBe(base64.encode(raw()));
    expect(parseNamadaBonds(blockFor(b64), [b64], null).flows.map((f) => [f.from, f.amount])).toEqual([[DELEGATOR, 13000]]);
  });
  it('the bond checksum with no tag, or with an unbond\'s tag, is still a bond, and no unbond', () => {
    for (const tag of [null, 'tx_unbond.wasm']) {
      const b64 = recode(tag);
      const p = parseNamadaBonds(blockFor(b64), [b64], null);
      expect(p.flows.map((f) => [f.kind, f.from, f.to, f.amount, f.meta?.code])).toEqual([['bond', DELEGATOR, POS, 13000, BOND_CODE]]);
      expect(parseNamadaUnbonds(blockFor(b64), [b64], null).flows).toEqual([]);
    }
  });
  it('the unbond checksum tagged tx_bond.wasm is not a bond: the checksum decides', () => {
    const b64 = recode('tx_bond.wasm', UNBOND_CODE);
    const p = parseNamadaBonds(blockFor(b64), [b64], null);
    expect(p.flows).toEqual([]);
    expect(p.skipped).toEqual({ 'tx_unbond.wasm': 1 });
  });
  it('untagged code no list knows is reported, never decoded on a guess', () => {
    const b64 = recode(null, hex.encode(sha256(new TextEncoder().encode('not tx_bond.wasm'))).toUpperCase());
    const p = parseNamadaBonds(blockFor(b64), [b64], null);
    expect(p.flows).toEqual([]);
    expect(p.undecoded[0].reason).toMatch(/untagged code .* is not a known tx_bond\.wasm checksum/);
  });
  it('a validator\'s bond of its own tokens (no source): from the validator, meta.selfBond', () => {
    const tx = decodeNamadaTx(raw());
    const data = tx.data.get(tx.commitments[0].dataHash)!;
    const self = cat(data.slice(0, 21 + 32), new Uint8Array([0])); // validator, amount, source: None
    expect(decodeBond(self)).toEqual({ validator: VALIDATOR, amount: 13_000_000_000n, source: null });
    const b64 = redata(self);
    const p = parseNamadaBonds(blockFor(b64), [b64], null);
    expect(p.flows.map((f) => [f.from, f.to, f.amount, f.meta?.selfBond])).toEqual([[VALIDATOR, POS, 13000, true]]);
    expect(decodeUnbond(self)).toEqual(decodeBond(self)); // the same layout, which is why the code decides
  });
});

// ---- The live scan over the fixture: both nodes serve block 8,351,607 as the chain gave it.
function nodes(head: number, opts: { results?: (h: number) => any; time?: (h: number) => string; abortAt?: { height: number; ctl: AbortController }; txsDown?: () => boolean } = {}) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (u: string) => {
    const url = new URL(String(u));
    const who = url.host.includes('5elementsnodes') ? 'five' : 'papa';
    calls.push(`${who} ${url.pathname}${url.search}`);
    if (url.pathname === '/status') return Response.json({ result: { node_info: { network: NAMADA.chainId }, sync_info: { latest_block_height: String(head), latest_block_time: new Date().toISOString(), catching_up: false, earliest_block_height: '1' } } });
    if (url.pathname === '/blockchain') {
      const lo = Number(url.searchParams.get('minHeight')), hi = Number(url.searchParams.get('maxHeight'));
      const metas = [];
      for (let h = hi; h >= lo; h--) metas.push({ header: { chain_id: NAMADA.chainId, height: String(h), time: opts.time?.(h) ?? (h === H ? fx(`namada_block_${H}_txs.json`).result.block.header.time : new Date().toISOString()) }, num_txs: '0' });
      return Response.json({ result: { last_height: String(head), block_metas: metas } });
    }
    if (url.pathname === '/block_results') {
      const h = Number(url.searchParams.get('height'));
      if (opts.abortAt && h === opts.abortAt.height) opts.abortAt.ctl.abort('alarm deadline');
      if (opts.abortAt?.ctl.signal.aborted) throw new Error('The operation was aborted');
      return Response.json(opts.results?.(h) ?? (h === H ? fx(`namada_block_${H}.json`) : { result: { height: String(h), end_block_events: [] } }));
    }
    if (url.pathname === '/block' && opts.txsDown?.()) return new Response('down', { status: 502 });
    if (url.pathname === '/block' && Number(url.searchParams.get('height')) === H) return Response.json(fx(`namada_block_${H}_txs.json`));
    throw new Error(`unexpected ${url}`);
  }));
  return calls;
}
const hubOf = (db: TestD1, alerts: any[][] = []) => Object.assign(Object.create(LiveHub.prototype), {
  env: { DB: db }, sessions: new Set(), lastPriceUsd: null, namadaHeight: 0, quote: new HubQuote(async () => null, async () => null),
  alertFlows: async (flows: any[]) => { alerts.push(flows); },
}) as any;
const kv = (db: TestD1, key: string) => (db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(key) as any)?.value ?? null;
const setCursor = (db: TestD1, v: number) => db.raw.prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES ('namada.cursor', ?, 0)").run(String(v));
const notes = (db: TestD1): string[] => JSON.parse(kv(db, 'namada.scan') ?? '{"failures":[]}').failures.map((f: any) => f.note);

describe('the live scan writes a bond block\'s row', () => {
  it('block 8,351,607: the bond row, its outcome in kv namada.bonds.live, the block\'s tx bytes read once', async () => {
    // Read as a scan keeping up reads it: seconds after the block (the fixture's block is days old by the real clock).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(block(H).ts + 7000);
    const db = testD1();
    setCursor(db, H - 1);
    const calls = nodes(H);
    await hubOf(db).scanNamada();
    expect(kv(db, 'namada.cursor')).toBe(String(H));
    const rows = db.raw.prepare('SELECT id, chain, height, ts, tx_hash, kind, from_addr, to_addr, amount_num, price_usd, value_usd, meta FROM flows').all();
    expect(rows).toEqual([{
      id: `namada:${INNER}:pos`, chain: 'namada', height: H, ts: block(H).ts, tx_hash: INNER, kind: 'bond', from_addr: DELEGATOR, to_addr: POS,
      amount_num: 13000, price_usd: null, value_usd: null,
      meta: JSON.stringify({ source: 'namada-rpc', txKind: 'bond', validator: VALIDATOR, wrapper: WRAPPER, tsSource: 'block', code: BOND_CODE }),
    }]);
    expect(JSON.parse(kv(db, 'namada.bonds.live'))).toMatchObject({ decoded: 1, lastHeight: H, failures: [], firstHeight: H });
    // no unbond key written: no unbond read, and the unbond decoder's row only says where it started
    expect(JSON.parse(kv(db, 'namada.unbonds.live'))).toEqual({ decoded: 0, failures: [], firstHeight: H });
    expect(calls.filter((c) => c.includes('/block?height=')).length).toBe(1);
    expect(notes(db)).toEqual([]);
  });

  it('an unbond block: the unbond row only, both decoders\' outcomes recorded, its tx bytes read once', async () => {
    const U = 8300328;
    const db = testD1();
    setCursor(db, U - 1);
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      const url = new URL(String(u));
      calls.push(url.pathname);
      if (url.pathname === '/status') return Response.json({ result: { node_info: { network: NAMADA.chainId }, sync_info: { latest_block_height: String(U), latest_block_time: new Date().toISOString(), catching_up: false } } });
      if (url.pathname === '/blockchain') return Response.json({ result: { block_metas: [{ header: { chain_id: NAMADA.chainId, height: String(U), time: fx(`namada_block_${U}_txs.json`).result.block.header.time }, num_txs: '1' }] } });
      if (url.pathname === '/block_results') return Response.json(fx(`namada_block_${U}.json`));
      if (url.pathname === '/block') return Response.json(fx(`namada_block_${U}_txs.json`));
      throw new Error(`unexpected ${url}`);
    }));
    await hubOf(db).scanNamada();
    expect(db.raw.prepare('SELECT kind, COUNT(*) AS n FROM flows GROUP BY kind').all()).toEqual([{ kind: 'unbond', n: 1 }]);
    expect(JSON.parse(kv(db, 'namada.unbonds.live'))).toMatchObject({ decoded: 1, failures: [] });
    expect(JSON.parse(kv(db, 'namada.bonds.live'))).toMatchObject({ decoded: 0, lastHeight: U, failures: [] });
    expect(calls.filter((c) => c === '/block').length).toBe(1);
  });

  it('a bond block whose tx bytes no node gives is held, the failure recorded, and written whole by the next scan', async () => {
    const db = testD1();
    setCursor(db, H - 1);
    let down = true;
    nodes(H, { txsDown: () => down });
    const hub = hubOf(db);
    await hub.scanNamada();
    expect(kv(db, 'namada.cursor')).toBe(String(H - 1));
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM flows').get()).toEqual({ n: 0 });
    expect(JSON.parse(kv(db, 'namada.bonds.live')).failures).toHaveLength(1);
    down = false;
    await hub.scanNamada();
    expect(kv(db, 'namada.cursor')).toBe(String(H));
    expect(db.raw.prepare('SELECT id FROM flows').all()).toEqual([{ id: `namada:${INNER}:pos` }]);
    expect(JSON.parse(kv(db, 'namada.bonds.live')).decoded).toBe(1);
  });
});

const B0 = 8_300_000;
/** block_results of a block holding one 20,000 NAM transfer. */
const whale = (h: number) => ({
  result: { height: String(h), end_block_events: [{
    type: 'token/transfer',
    attributes: [
      { key: 'hash', value: `${String(h).padStart(8, '0')}`.padEnd(64, 'A') },
      { key: 'inner-tx-hash', value: `${String(h).padStart(8, '0')}`.padEnd(64, 'B') },
      { key: 'source-accounts', value: JSON.stringify([[['internal-address/tnam1qr4l8egaskk09460llz0qctac7sgemynpu8c7vvd', 'tnam1q9gr66cvu4hrzm0sd5kmlnjje82gs3xlfg3v6nu7'], '20000000000']]) },
      { key: 'target-accounts', value: JSON.stringify([[['internal-address/tnam1qq6wus66shjjwhe48c3udfyrh05vq62s0ysy3flp', 'tnam1q9gr66cvu4hrzm0sd5kmlnjje82gs3xlfg3v6nu7'], '20000000000']]) },
      { key: 'post-balances', value: '[]' },
      { key: 'token-event-descriptor', value: 'transfer-from-wasm' },
    ],
  }] },
});
const metaOf = (db: TestD1, h: number) => JSON.parse((db.raw.prepare('SELECT meta FROM flows WHERE height = ?').get(h) as any).meta);

describe('Security review (2026-10-22), live scan lag: a scan behind reads on and never jumps', () => {

  it('200 blocks behind on two agreeing nodes: every block read once, in order, both moves stored, no skip noted', async () => {
    const db = testD1();
    setCursor(db, B0);
    const calls = nodes(B0 + 200, { results: (h) => (h === B0 + 30 || h === B0 + 190 ? whale(h) : { result: { height: String(h), end_block_events: [] } }) });
    await hubOf(db).scanNamada();
    expect(kv(db, 'namada.cursor')).toBe(String(B0 + 200));
    const read = calls.filter((c) => c.includes('/block_results')).map((c) => Number(c.split('height=')[1]));
    expect(read).toEqual(Array.from({ length: 200 }, (_, i) => B0 + 1 + i));
    expect(db.raw.prepare('SELECT height FROM flows ORDER BY height').all()).toEqual([{ height: B0 + 30 }, { height: B0 + 190 }]);
    expect(notes(db)).toEqual([]);
  });

  it('the alarm\'s deadline stops the reading: the next scan goes on from that block, and nothing is jumped', async () => {
    const db = testD1();
    setCursor(db, B0);
    const ctl = new AbortController();
    const results = (h: number) => (h === B0 + 150 ? whale(h) : { result: { height: String(h), end_block_events: [] } });
    nodes(B0 + 200, { results, abortAt: { height: B0 + 120, ctl } });
    const hub = hubOf(db);
    await hub.scanNamada(ctl.signal);
    expect(kv(db, 'namada.cursor')).toBe(String(B0 + 119));
    const calls = nodes(B0 + 200, { results });
    await hub.scanNamada(new AbortController().signal);
    expect(kv(db, 'namada.cursor')).toBe(String(B0 + 200));
    expect(calls.filter((c) => c.includes('/block_results')).map((c) => Number(c.split('height=')[1]))[0]).toBe(B0 + 120);
    expect(db.raw.prepare('SELECT height FROM flows').all()).toEqual([{ height: B0 + 150 }]);
    expect(notes(db)).toEqual([]);
  });

  it('a move older than LATE_ALERT_MAX_AGE_MS read on after an outage is stored and not alerted; a recent one is', async () => {
    const db = testD1();
    setCursor(db, B0);
    const old = new Date(Date.now() - 30 * 3600_000).toISOString();
    nodes(B0 + 100, {
      results: (h) => (h === B0 + 10 || h === B0 + 95 ? whale(h) : { result: { height: String(h), end_block_events: [] } }),
      time: (h) => (h <= B0 + 50 ? old : new Date().toISOString()),
    });
    const alerts: any[][] = [];
    await hubOf(db, alerts).scanNamada();
    expect(db.raw.prepare('SELECT height FROM flows ORDER BY height').all()).toEqual([{ height: B0 + 10 }, { height: B0 + 95 }]);
    expect(alerts.flat().map((f) => f.height)).toEqual([B0 + 95]);
    // the old move is stored as found late; the one read on time is not
    expect(metaOf(db, B0 + 10).via).toBe('late scan');
    expect(metaOf(db, B0 + 95)).not.toHaveProperty('via');
  });

});

describe('moves the live scan reads late are alerted as found late (owner decision 14)', () => {
  it('the bond of block 8,351,607 read 3 hours after its block: stored and alerted with "Found late" and its time', async () => {
    const db = testD1();
    setCursor(db, H - 100);
    const NOW = Date.now();
    const late = NOW - 3 * 3600_000;
    // two nodes agree on head H + 5; blocks up to H are 3 hours old (7 s apart), H + 3 holds a transfer made now
    nodes(H + 5, {
      time: (h) => new Date(h <= H ? late - (H - h) * 7000 : NOW).toISOString(),
      results: (h) => (h === H ? fx(`namada_block_${H}.json`) : h === H + 3 ? whale(h) : { result: { height: String(h), end_block_events: [] } }),
    });
    const alerts: any[][] = [];
    await hubOf(db, alerts).scanNamada();
    expect(kv(db, 'namada.cursor')).toBe(String(H + 5));
    const sent = alerts.flat();
    expect(sent.map((f) => [f.kind, f.amount, f.meta?.via ?? null])).toEqual([['bond', 13000, 'late scan'], ['transfer', 20000, null]]);
    // the stored row carries the mark too
    expect(metaOf(db, H).via).toBe('late scan');
    const field = (f: any) => buildFlowDiscordBody(f, {}).embeds[0].fields.find((x) => x.name === 'Found late');
    const t = Math.floor(late / 1000);
    expect(field(sent[0])?.value).toBe(`The live scan was behind and read this move late; it happened <t:${t}:f> (<t:${t}:R>).`);
    expect(field(sent[1])).toBeUndefined();
  });

  it('a block read just inside LATE_SCAN_MS is not found late', async () => {
    const db = testD1();
    setCursor(db, H - 1);
    nodes(H, { time: () => new Date(Date.now() - LATE_SCAN_MS + 30_000).toISOString() });
    const alerts: any[][] = [];
    await hubOf(db, alerts).scanNamada();
    expect(alerts.flat().map((f) => [f.kind, f.meta?.via ?? null])).toEqual([['bond', null]]);
    expect(metaOf(db, H)).not.toHaveProperty('via');
  });
});

describe('each live decoder records the first block it read', () => {
  it('a fresh store: both rows name the block after the cursor, whether or not it held a request, and keep it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(block(H).ts + 7000);
    const db = testD1();
    setCursor(db, H - 10);
    nodes(H);
    const hub = hubOf(db);
    await hub.scanNamada();
    expect(JSON.parse(kv(db, 'namada.bonds.live'))).toMatchObject({ decoded: 1, lastHeight: H, firstHeight: H - 9 });
    expect(JSON.parse(kv(db, 'namada.unbonds.live'))).toEqual({ decoded: 0, failures: [], firstHeight: H - 9 });
    // a later scan of the same rows changes no first block
    setCursor(db, H - 1);
    db.raw.prepare("DELETE FROM flows").run();
    await hubOf(db).scanNamada();
    expect(JSON.parse(kv(db, 'namada.bonds.live'))).toMatchObject({ decoded: 2, firstHeight: H - 9 });
  });

  it('a row made before first blocks were recorded is never given one: a later block is not where the decoder started', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(block(H).ts + 7000);
    const db = testD1();
    setCursor(db, H - 1);
    db.raw.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('namada.unbonds.live', ?, 0), ('namada.bonds.live', ?, 0)")
      .run(JSON.stringify({ decoded: 6, failures: [] }), JSON.stringify({ decoded: 0, failures: [] }));
    nodes(H);
    await hubOf(db).scanNamada();
    expect(JSON.parse(kv(db, 'namada.unbonds.live'))).toEqual({ decoded: 6, failures: [] });
    const bonds = JSON.parse(kv(db, 'namada.bonds.live'));
    expect(bonds).toMatchObject({ decoded: 1, lastHeight: H });
    expect(bonds).not.toHaveProperty('firstHeight');
  });

  it('when the rows could not be made before the scan, the decoder\'s own first read makes its row with that block', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(block(H).ts + 7000);
    const db = testD1();
    setCursor(db, H - 3);
    nodes(H);
    const hub = hubOf(db);
    hub.notePosStarts = async () => { throw new Error('D1 unavailable'); };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await hub.scanNamada();
    err.mockRestore();
    expect(JSON.parse(kv(db, 'namada.bonds.live'))).toMatchObject({ decoded: 1, firstHeight: H });
    expect(kv(db, 'namada.unbonds.live')).toBeNull();
  });
});
