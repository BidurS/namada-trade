// Security review (2026-10-22), the catch-up search's byte budget: a transaction that matches a query but makes no row
// (a non-NAM IBC send on the NAM channel: no flow, no move) is never stored. Before, the search kept it while it was
// above the floor and charged its page to the budget, so about twenty such sends with large memos filled the 24 MiB
// budget on every search: the search never finished, the floor never moved, and a NAM bridge send the stream missed,
// just below them, was never written. Now such a transaction is let go when it is read, and a page is charged only for
// the transactions the search keeps.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { LiveHub } from '../worker/src/live-hub';
import { HubQuote } from '../worker/src/live-quote';
import { NAM } from '../worker/src/config';
import { testD1, type TestD1 } from './d1-sqlite';

afterEach(() => vi.unstubAllGlobals());

const CURSOR = 1_000_000;
const HEAD = 1_000_500;
const hashOf = (p: string, i: number) => `${p}${String(i).padStart(64 - p.length, '0')}`;
/** A send of 1 uosmo to Namada on the NAM channel with a 32 KB-memo-sized payload: matches the send_packet query, makes no row. */
const junk = (i: number) => ({
  hash: hashOf('EE', i), height: String(HEAD - 1 - i), tx: 'A'.repeat(500_000),
  tx_result: { code: 0, events: [
    { type: 'send_packet', attributes: [{ key: 'packet_src_channel', value: NAM.osmoChannel }, { key: 'packet_data', value: 'M'.repeat(500_000) }, { key: 'packet_data_hex', value: 'F'.repeat(500_000) }] },
    { type: 'ibc_transfer', attributes: [{ key: 'sender', value: 'osmo1attacker' }, { key: 'receiver', value: 'tnam1x' }, { key: 'amount', value: '1' }, { key: 'denom', value: 'uosmo' }] },
  ] },
});
/** The real NAM bridge send the stream missed (fixture osmo_ibc_send.json), moved just below the junk. */
const missed = () => {
  const t = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'osmo_ibc_send.json'), 'utf8'))[0];
  return { ...t, hash: hashOf('DD', 0), height: String(HEAD - 40) };
};

function osmosis(sends: any[]) {
  const asked: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (u: string) => {
    const url = new URL(String(u));
    const who = url.host.includes('publicnode') ? 'publicnode' : 'keplr';
    if (url.pathname.endsWith('/status')) return Response.json({ result: { sync_info: { latest_block_height: String(HEAD) } } });
    if (url.pathname.endsWith('/block')) return Response.json({ result: { block: { header: { time: new Date(Date.now() - 60_000).toISOString() } } } });
    if (!url.pathname.endsWith('/tx_search')) throw new Error(`unexpected ${url}`);
    const q = url.searchParams.get('query') ?? '';
    const per = Number(url.searchParams.get('per_page')), page = Number(url.searchParams.get('page'));
    const list = q.includes('send_packet') ? sends : [];
    asked.push(`${who} ${q.includes('send_packet') ? 'send' : 'other'} ${per} ${page}`);
    const part = list.slice((page - 1) * per, page * per);
    const bytes = new TextEncoder().encode(JSON.stringify({ result: { txs: part, total_count: String(list.length) } }));
    return new Response(bytes, { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(bytes.length) } });
  }));
  return asked;
}
function hubOn(db: TestD1) {
  return Object.assign(Object.create(LiveHub.prototype), {
    env: { DB: db, KEPLR_KEY: 'dummy' },
    seenOsmoTx: new Set<string>(), osmoRetryTx: new Map<string, number>(), osmoWriting: new Map(), osmoRetryFrom: null, osmoRetryGen: 0, osmoHeight: 0,
    sessions: new Set(), lastPriceUsd: null, needSweep: false,
    osmoCtx: { poolAddrs: new Map(), priceUsd: null, assets: new Map() },
    quote: new HubQuote(async () => null, async () => null),
  }) as any;
}

describe('transactions that make no row, kept by every search', () => {
  it('twenty large non-NAM sends above the floor: the search still finishes, and the missed NAM send below them is written', async () => {
    const db = testD1();
    await db.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('osmosis.cursor', ?, 0)").bind(JSON.stringify({ height: CURSOR, at: 1 })).run();
    const hub = hubOn(db);
    const sends = [...Array.from({ length: 20 }, (_, i) => junk(i)), missed()];
    const asked = osmosis(sends);
    for (let n = 0; n < 3; n++) await hub.sweepOsmosis();
    const cur = JSON.parse((db.raw.prepare("SELECT value FROM kv WHERE key='osmosis.cursor'").get() as any).value);
    const stored = (db.raw.prepare("SELECT COUNT(*) AS n FROM flows WHERE tx_hash = ? AND kind = 'ibc_out'").get(hashOf('DD', 0)) as any).n;
    const junkStored = (db.raw.prepare("SELECT COUNT(*) AS n FROM flows WHERE tx_hash LIKE 'EE%'").get() as any).n;
    console.log('asked', JSON.stringify(asked.filter((a) => a.includes('send'))), 'cursor', JSON.stringify(cur), 'missed stored', stored, 'junk stored', junkStored);
    expect(junkStored).toBe(0);
    // the defect: three searches, none complete (the same junk is kept and charged every time), the missed send lost
    expect(cur.height).toBe(HEAD);
    expect(stored).toBe(1);
  }, 120_000);
});

describe('contrast', () => {
  it('without the junk the same missed send is written and the search finishes', async () => {
    const db = testD1();
    await db.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('osmosis.cursor', ?, 0)").bind(JSON.stringify({ height: CURSOR, at: 1 })).run();
    osmosis([missed()]);
    await hubOn(db).sweepOsmosis();
    const cur = JSON.parse((db.raw.prepare("SELECT value FROM kv WHERE key='osmosis.cursor'").get() as any).value);
    expect(cur.height).toBe(HEAD);
    expect((db.raw.prepare("SELECT COUNT(*) AS n FROM flows WHERE tx_hash = ? AND kind = 'ibc_out'").get(hashOf('DD', 0)) as any).n).toBe(1);
  }, 120_000);
});
