// Security review (2026-10-22), live scan head over hours: (1) with the indexer down, a lying node held more than 100
// blocks above the honest one served 50 blocks above the real head on every tick the honest node's status timed out,
// and the real blocks there were never read; after two nodes disagree, a node alone is now followed no higher than the
// lower node has had time to reach. (2) After an honest stretch on one node, the first agreement re-read the stretch
// and then jumped it, noting hours of scanned blocks as not scanned; (3) with the indexer back, the same stretch was
// read again from the same node. Blocks read on one node's word are now read again only when the nodes disagreed
// meanwhile, only from a node they were not read from, and a re-read jumps no block.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { LiveHub } from '../worker/src/live-hub';
import { HubQuote } from '../worker/src/live-quote';
import { NAMADA } from '../worker/src/config';
import { headBound } from '../worker/src/sources/namada';
import { testD1, type TestD1 } from './d1-sqlite';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const X = 'tnam1qr4wemkpjfycn7ts7297e8qecg2t6pf2vq2wulsa';
const OSMO = 'osmo19v0z78d8gv02t4cfqvmtklppu4rmpp5ek3q9a8';
const recvEvents = () => JSON.parse(readFileSync(join(__dirname, 'fixtures', 'namada_block_7153723.json'), 'utf8')).result.end_block_events
  .map((e: any) => ({ ...e, attributes: e.attributes.map((a: any) => ({ ...a, value: String(a.value).split(NAMADA.internal.masp).join(X) })) }));

interface NodeSpec { height: number; down?: boolean; events?: Record<number, any[]> }
function chain(spec: { five: NodeSpec; papa: NodeSpec }, calls: string[]) {
  vi.stubGlobal('fetch', vi.fn(async (u: string) => {
    const url = new URL(String(u));
    const who = url.host.includes('5elementsnodes') ? 'five' : 'papa';
    const n = spec[who];
    calls.push(`${who} ${url.pathname}${url.search}`);
    if (n.down) throw new Error('refused');
    if (url.pathname === '/status') {
      return Response.json({ result: { node_info: { network: NAMADA.chainId }, sync_info: { latest_block_height: String(n.height), latest_block_time: new Date().toISOString(), catching_up: false, earliest_block_height: '1' } } });
    }
    if (url.pathname === '/blockchain') {
      const lo = Number(url.searchParams.get('minHeight')), hi = Math.min(Number(url.searchParams.get('maxHeight')), n.height);
      if (lo > hi) return Response.json({ error: { code: -32603, message: 'Internal error' } });
      const metas = [];
      for (let h = hi; h >= lo; h--) metas.push({ header: { chain_id: NAMADA.chainId, height: String(h), time: new Date().toISOString() }, num_txs: '0' });
      return Response.json({ result: { last_height: String(n.height), block_metas: metas } });
    }
    if (url.pathname === '/block_results') {
      const h = Number(url.searchParams.get('height'));
      if (h > n.height) return Response.json({ error: { code: -32603, message: 'Internal error' } });
      return Response.json({ result: { height: String(h), end_block_events: n.events?.[h] ?? [] } });
    }
    throw new Error(`unexpected ${url}`);
  }));
}
const hubOf = (db: TestD1) => Object.assign(Object.create(LiveHub.prototype), {
  env: { DB: db }, sessions: new Set(), lastPriceUsd: null, namadaHeight: 0, quote: new HubQuote(async () => null, async () => null),
}) as any;
const cursor = (db: TestD1) => Number((db.raw.prepare("SELECT value FROM kv WHERE key = 'namada.cursor'").get() as any)?.value);
const setCursor = (db: TestD1, v: number) => db.raw.prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES ('namada.cursor', ?, 0)").run(String(v));
const notes = (db: TestD1) => JSON.parse((db.raw.prepare("SELECT value FROM kv WHERE key='namada.scan'").get() as any)?.value ?? '{"failures":[]}').failures.map((f: any) => `${f.height}: ${f.note}`);
const headRow = (db: TestD1) => (db.raw.prepare("SELECT value FROM kv WHERE key='namada.head'").get() as any)?.value;
/** checks 'indexer_lag' exactly as cron.ts writes it: lagBlocks = max(answering nodes) - the indexer's height. */
const cronVote = (db: TestD1, indexerHeight: number, maxNodeHeight: number, at = Date.now()) =>
  db.raw.prepare("INSERT OR REPLACE INTO checks (key, status, title, detail, checked_at) VALUES ('indexer_lag', 'ok', 'indexer', ?, ?)")
    .run(JSON.stringify({ indexerHeight, rpcHeight: maxNodeHeight, lagBlocks: maxNodeHeight - indexerHeight }), at);
/** heights whose block_results was asked of `who` */
const readHeights = (calls: string[], who: string) => new Set(calls.filter((c) => c.startsWith(`${who} /block_results`)).map((c) => Number(new URL('http://x' + c.split(' ')[1]).searchParams.get('height'))));

const H = 8_300_000;
const TICK_MS = 6500, BLOCK_MS = 6800;

function sim(opts: { indexer: (tick: number) => 'up' | 'down'; indexerLag?: number }) {
  vi.useFakeTimers({ toFake: ['Date'] });
  const t0 = Date.UTC(2026, 9, 22, 12, 0, 0);
  vi.setSystemTime(t0);
  const real = () => H + Math.floor((Date.now() - t0) / BLOCK_MS);
  const db = testD1();
  setCursor(db, H);
  const spec = { five: { height: H, events: {} } as NodeSpec, papa: { height: H, events: {} } as NodeSpec };
  const hub = hubOf(db);
  const calls: string[] = [];
  let tick = 0, lastCron = -Infinity;
  const step = async (set: (real: number) => void) => {
    tick++;
    vi.setSystemTime(t0 + tick * TICK_MS);
    set(real());
    if (opts.indexer(tick) === 'up' && Date.now() - lastCron >= 60_000) {
      lastCron = Date.now();
      const answering = [...(spec.five.down ? [] : [spec.five.height]), ...(spec.papa.down ? [] : [spec.papa.height])];
      cronVote(db, real() - (opts.indexerLag ?? 1), Math.max(...answering));
    }
    chain(spec, calls);
    await hub.scanNamada();
  };
  return { db, spec, hub, calls, step, real, tick: () => tick };
}

describe('(1) a lying node with the indexer down: every 1-tick status timeout of the honest node', () => {
  for (const [every, idx] of [[60, 'down'], [140, 'down'], [60, 'up']] as const) {
    it(`timeouts every ${every} ticks over 3 h, indexer ${idx}: real blocks after the first outage are all read from the honest node`, async () => {
      const s = sim({ indexer: () => idx });
      // both honest for 5 ticks (read is set), the liar's claim then held at headBound - 2 of the last head two nodes agreed on
      for (let i = 0; i < 5; i++) await s.step((r) => { s.spec.five.height = r; s.spec.papa.height = r; });
      // the liar tracks the hub's last agreed head (it can: it sees the honest head and when both answered within 100)
      // just under the bound, but never within 100 of the honest node (that would agree and reset the bound): on a tick
      // the bound allows no such claim, a claim above the bound (not followed, nothing agrees)
      const claim = () => { const b = headBound(s.hub.lastAgreed, Date.now())! - 1; return b - s.real() > 100 ? b : b + 50; };
      // a 5-tick outage of the honest node (about 33 s) breaks the agreement
      for (let i = 0; i < 5; i++) await s.step((r) => { s.spec.five.down = true; s.spec.papa.height = claim(); });
      const firstReal = s.real();
      // receipts in real blocks the honest node serves, one every 100 blocks from 200 blocks after its return
      const receipts: number[] = [];
      for (let h = firstReal + 200; h < firstReal + 1500; h += 100) { (s.spec.five.events as any)[h] = recvEvents(); receipts.push(h); }
      const N = Math.round(3 * 3600_000 / TICK_MS);
      for (let i = 0; i < N; i++) {
        await s.step((r) => { s.spec.five.height = r; s.spec.five.down = i % every === every - 1; s.spec.papa.height = claim(); });
      }
      const end = s.real();
      const five = readHeights(s.calls, 'five');
      let missed = 0;
      for (let h = firstReal + 200; h <= end - 50; h++) if (!five.has(h)) missed++;
      const linked = (s.db.raw.prepare('SELECT transfers FROM address_links WHERE osmo_addr = ? AND namada_addr = ?').get(OSMO, X) as any)?.transfers ?? 0;
      const reread = notes(s.db).filter((n: string) => /read again/.test(n)).length;
      console.log(`(1) every ${every} indexer ${idx}: real ${firstReal + 200}..${end - 50} (${end - 50 - firstReal - 199} blocks), never read from the honest node ${missed}; receipts ${receipts.length}, linked ${linked}; cursor ${cursor(s.db)} real ${end} papa ${s.spec.papa.height}; re-read notes ${reread}; namada.head ${headRow(s.db)}`);
      expect(missed).toBe(0);
    }, 120_000);
  }
});

describe('(2) honest producers: Papadritta down 2 h with the indexer down, back 2 blocks behind 5ElementsNodes', () => {
  it('records no "not scanned" note for blocks the scan read', async () => {
    const s = sim({ indexer: (t) => (t <= 5 ? 'up' : 'down') });
    for (let i = 0; i < 5; i++) await s.step((r) => { s.spec.five.height = r; s.spec.papa.height = r; });
    const N = Math.round(2 * 3600_000 / TICK_MS);
    for (let i = 0; i < N; i++) await s.step((r) => { s.spec.five.height = r; s.spec.papa.down = true; });
    const before = { cursor: cursor(s.db), real: s.real() };
    const callsBefore = s.calls.length;
    const cursors: number[] = [];
    for (let i = 0; i < 3; i++) { await s.step((r) => { s.spec.five.height = r; s.spec.papa.down = false; s.spec.papa.height = r - 2; }); cursors.push(cursor(s.db)); }
    const fiveReads = s.calls.slice(callsBefore).filter((c) => c.includes('/block_results')).length;
    const ns = notes(s.db);
    console.log('(2) before papa returns', JSON.stringify(before), 'cursors after', JSON.stringify(cursors), 'block_results after return', fiveReads, 'notes', JSON.stringify(ns));
    expect(ns.filter((n: string) => /not scanned/.test(n))).toEqual([]);
  }, 120_000);
});

describe('(3) honest producers: Papadritta down, the indexer out for 1 h then back (a few blocks behind), Papadritta still down', () => {
  for (const [lag, hours] of [[1, 1], [3, 1], [3, 6]] as const) it(`indexer ${lag} behind after ${hours} h: reads no block twice from the same node, and a block made just after the indexer returns is read within a minute`, async () => {
    let back = Infinity;
    const s = sim({ indexer: (t) => (t <= 5 || t >= back ? 'up' : 'down'), indexerLag: lag });
    for (let i = 0; i < 5; i++) await s.step((r) => { s.spec.five.height = r; s.spec.papa.height = r; });
    const N = Math.round(hours * 3600_000 / TICK_MS);
    for (let i = 0; i < N; i++) await s.step((r) => { s.spec.five.height = r; s.spec.papa.down = true; });
    const before = { cursor: cursor(s.db), real: s.real() };
    const callsBefore = s.calls.length;
    back = s.tick() + 1;
    const receiptAt = s.real() + 2;
    (s.spec.five.events as any)[receiptAt] = recvEvents();
    const cursors: number[] = [];
    let readAt = -1;
    for (let i = 0; i < 100; i++) {
      await s.step((r) => { s.spec.five.height = r; });
      cursors.push(cursor(s.db));
      const linked = (s.db.raw.prepare('SELECT transfers FROM address_links WHERE osmo_addr = ? AND namada_addr = ?').get(OSMO, X) as any)?.transfers ?? 0;
      if (linked && readAt < 0) readAt = i + 1;
    }
    const again = s.calls.slice(callsBefore).filter((c) => c.startsWith('five /block_results')).map((c) => Number(new URL('http://x' + c.split(' ')[1]).searchParams.get('height'))).filter((h) => h <= before.cursor).length;
    console.log(`(3) lag ${lag}, ${hours} h: before the indexer returns`, JSON.stringify(before), 'cursors after', JSON.stringify(cursors.slice(0, 15)), 'blocks read again from the same node', again, 'receipt read after ticks', readAt, 'notes', JSON.stringify(notes(s.db)));
    expect(again).toBe(0);
    expect(readAt).toBeGreaterThan(0);
    expect(readAt).toBeLessThanOrEqual(10);
  }, 120_000);
});
