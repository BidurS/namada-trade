// Security review (2026-10-22), live scan head: (A) a node that lies just under the bound while the honest node is out
// for a minute or two moved the cursor past the honest node, which, back, was then left out for good; now the scan's
// place is never above where the last agreed head says the honest chain is, so the honest node is followed again, and
// the blocks read on the one node's word are read again from it. (B) With one node down and the indexer answering far
// behind, the indexer's block bounded the honest node below its own height and the scan stopped (then jumped every
// block of the outage); an indexer seen to lag behind the last agreed head now bounds nothing.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { LiveHub } from '../worker/src/live-hub';
import { HubQuote } from '../worker/src/live-quote';
import { NAMADA } from '../worker/src/config';
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
const link = (db: TestD1) => db.raw.prepare('SELECT transfers FROM address_links WHERE osmo_addr = ? AND namada_addr = ?').get(OSMO, X) as any;
const notes = (db: TestD1) => JSON.parse((db.raw.prepare("SELECT value FROM kv WHERE key='namada.scan'").get() as any)?.value ?? '{"failures":[]}').failures.map((f: any) => `${f.height}: ${f.note}`);
const blockReads = (calls: string[], who: string) => calls.filter((c) => c.startsWith(who) && !c.endsWith('/status'));
/** checks 'indexer_lag' exactly as cron.ts:1177-1181 writes it: lagBlocks = max(answering nodes) - the indexer's height. */
const cronVote = (db: TestD1, indexerHeight: number, maxNodeHeight: number, at = Date.now()) =>
  db.raw.prepare("INSERT OR REPLACE INTO checks (key, status, title, detail, checked_at) VALUES ('indexer_lag', 'ok', 'indexer', ?, ?)")
    .run(JSON.stringify({ indexerHeight, rpcHeight: maxNodeHeight, lagBlocks: maxNodeHeight - indexerHeight }), at);

const H = 8_300_000;
const TICK_MS = 6500, BLOCK_MS = 6800;

describe('(A) a lying node just under the bound after a ~90 s outage of the honest node', () => {
  it('the honest node, back, is followed again and its blocks are read', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.UTC(2026, 9, 22, 12, 0, 0);
    vi.setSystemTime(t0);
    const real = () => H + Math.floor((Date.now() - t0) / BLOCK_MS);
    const db = testD1();
    setCursor(db, H);
    const spec = { five: { height: H, events: {} } as NodeSpec, papa: { height: H } as NodeSpec };
    const hub = hubOf(db);
    const calls: string[] = [];
    // tick 0: both honest at H, agreed
    cronVote(db, H, H);
    chain(spec, calls);
    await hub.scanNamada();
    // The liar's claim uses only what it can know: the honest head and time when the other node was last up, moved on
    // at one block per 5 s, plus 100, minus a margin of 2 (headBound - 2).
    const claim = () => H + Math.floor((Date.now() - t0) / 5000) + 100 - 2;
    let tick = 0, lastCron = t0;
    const step = async () => {
      tick++;
      vi.setSystemTime(t0 + tick * TICK_MS);
      if (!spec.five.down) spec.five.height = real();
      spec.papa.height = claim();
      if (Date.now() - lastCron >= 60_000) {
        lastCron = Date.now();
        const answering = [spec.papa.height, ...(spec.five.down ? [] : [spec.five.height])];
        cronVote(db, real(), Math.max(...answering));
      }
      chain(spec, calls);
      await hub.scanNamada();
    };
    spec.five.down = true;
    for (let i = 0; i < 14; i++) await step(); // ~91 s
    const atReturn = { cursor: cursor(db), real: real() };
    spec.five.down = false;
    const receiptAt = real() + 10;
    spec.five.events = { [receiptAt]: recvEvents() };
    const before = calls.length;
    for (let i = 0; i < 60; i++) await step(); // 6.5 min with both nodes up
    const after = calls.slice(before);
    console.log('A at five return', JSON.stringify(atReturn), '| end: cursor', cursor(db), 'five', spec.five.height, 'papa', spec.papa.height,
      '| five block reads after return', blockReads(after, 'five').length, '| papa block reads after return', blockReads(after, 'papa').length,
      '| namada.head', (db.raw.prepare("SELECT value FROM kv WHERE key='namada.head'").get() as any)?.value, '| notes', JSON.stringify(notes(db)));
    expect(blockReads(after, 'five').length).toBeGreaterThan(0);
    expect(cursor(db)).toBeLessThanOrEqual(spec.five.height);
    expect(link(db)?.transfers).toBe(1);
  });
});

describe('(B) honest producers: one node down, the indexer answering ~700 blocks behind', () => {
  it('the scan follows the one honest node through the outage and skips no block', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.UTC(2026, 9, 22, 12, 0, 0);
    vi.setSystemTime(t0);
    const real = () => H + Math.floor((Date.now() - t0) / BLOCK_MS);
    const IDX = H - 700; // the indexer stalled about 80 min ago and still answers block/latest
    const db = testD1();
    setCursor(db, H);
    const receiptAt = H + 30;
    const spec = { five: { height: H, events: { [receiptAt]: recvEvents() } } as NodeSpec, papa: { height: H } as NodeSpec };
    const hub = hubOf(db);
    const calls: string[] = [];
    cronVote(db, IDX, H);
    chain(spec, calls);
    await hub.scanNamada(); // tick 0: both agree on H
    let tick = 0, lastCron = t0;
    const step = async () => {
      tick++;
      vi.setSystemTime(t0 + tick * TICK_MS);
      spec.five.height = real();
      if (!spec.papa.down) spec.papa.height = real();
      if (Date.now() - lastCron >= 60_000) { lastCron = Date.now(); cronVote(db, IDX, spec.five.height); }
      chain(spec, calls);
      await hub.scanNamada();
    };
    spec.papa.down = true;
    for (let i = 0; i < 92; i++) await step(); // ~10 min, ~88 blocks
    const atReturn = { cursor: cursor(db), real: real() };
    spec.papa.down = false;
    for (let i = 0; i < 5; i++) await step();
    console.log('B before papa returns', JSON.stringify(atReturn), '| end: cursor', cursor(db), 'head', real(), '| link', JSON.stringify(link(db)), '| notes', JSON.stringify(notes(db)));
    expect(atReturn.cursor).toBeGreaterThan(H + 40); // followed the honest node while the other was down
    expect(link(db)?.transfers).toBe(1); // the receipt at H + 30 was read
  });
});
