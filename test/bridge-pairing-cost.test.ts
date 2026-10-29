// Security review (2026-10-22), bridge check cost: every minute the cron read every bridge row of the last 14 days
// on both chains, memo included and with no bound, and paired them with a linear search per Namada row, so its
// synchronous work grew with the product of two row counts that chain users set (a dust transfer is one row), ahead
// of the listing applies, the holder writes and the lock release. The pairing now indexes the Osmosis records by
// kind, addresses and amount and searches them by time; the refund fallback looks only through sends without a
// sequence; each read takes the newest BRIDGE_CHECK_ROWS rows and only the meta fields it uses; and a full read
// judges only the crossings it covers whole, says from when, and does not pass. Two crossings of one user and amount,
// one shielded and one not, that a relayer delivers in one transaction share a time on the receiving chain: the
// indexed pairing took them in the order the read gave ties (the newest id first), and the row naming the shielded
// pool, which stands for any tnam1 address, took the transparent crossing's record and left the other one unpaired.
// Ties are now broken the same way for the rows and the records (height, then id), and the rows that name both their
// addresses pair before those that name the escrow or the pool, which take only the records left. That order alone
// could still leave a crossing unpaired that the linear search had paired: a Namada row that names the escrow (a
// packet the parser could not bind) lost the one record it can pair with to a row of its own addresses, or to a row
// that names the shielded pool, which had another record in its window. A bounded search for chains of moves now
// gives such a row that record and moves the other row on.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { runCron, unpairedCrossings, bridgeJudgedFrom, BRIDGE_CHECK_ROWS, PAIR_WINDOW_MS, PAIR_AUGMENT_ROWS } from '../worker/src/cron';
import { timedOutSends, type IbcRow } from '../worker/src/analytics';
import { NAMADA } from '../worker/src/config';
import { NOT_LEGACY_TWIN } from '../worker/src/flows-query';
import { checkDetail } from '../web/src/lib/prov';
import { testD1, insert } from './d1-sqlite';
import type { Check } from '../shared/types';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const ESCROW = NAMADA.internal.ibc;
const MASP = NAMADA.internal.masp;
const NOW = 1_800_000_000_000;
const M = 60_000, H = 3_600_000, D = 86_400_000;

/** The pairing as it was (a linear search per Namada row), kept here to compare results with. */
function linearPairing(namada: any[], osmosis: any[], now: number) {
  const W = 15 * 60000, SETTLE = 30 * 60000;
  const used = new Set<any>();
  const namadaOnly: any[] = [];
  const same = (a: string | null, b: string | null) => a === b || a === ESCROW || (a === MASP && !!b?.startsWith('tnam1'));
  for (const n of namada) {
    const want = n.kind === 'ibc_in' ? 'ibc_out' : 'ibc_in';
    const m = osmosis.find((o) => !used.has(o) && o.kind === want && same(n.from_addr, o.from_addr) && same(n.to_addr, o.to_addr) && Math.abs(o.amount_num - n.amount_num) < 1e-6 && Math.abs(o.ts - n.ts) <= W);
    if (m) used.add(m);
    else if (now - n.ts > SETTLE) namadaOnly.push(n);
  }
  return { namadaOnly, osmosisOnly: osmosis.filter((o) => !used.has(o) && now - o.ts > SETTLE) };
}

/** The refund matching as it was, kept here to compare results with. */
function linearRefunds(outs: IbcRow[], refunds: IbcRow[]): Set<string> {
  const done = new Set<string>(), used = new Set<string>(), bySeq = new Map<string, IbcRow>();
  for (const o of outs) if (o.seq) bySeq.set(o.seq, o);
  for (const r of refunds) { const o = r.seq ? bySeq.get(r.seq) : undefined; if (o && !done.has(o.id)) { done.add(o.id); used.add(r.id); } }
  const sorted = [...outs].sort((a, b) => b.ts - a.ts);
  for (const r of [...refunds].sort((a, b) => a.ts - b.ts)) {
    if (used.has(r.id)) continue;
    const o = sorted.find((x) => !done.has(x.id) && !(x.seq && r.seq) && Math.abs(x.amount - r.amount) < 1e-6 && x.ts <= r.ts && r.ts - x.ts <= 3 * D && (!r.receiverKnown || r.to === x.from));
    if (o) { done.add(o.id); used.add(r.id); }
  }
  return done;
}

const ids = (u: { namadaOnly: any[]; osmosisOnly: any[] }) => ({ namada: u.namadaOnly.map((r) => r.id).sort(), osmosis: u.osmosisOnly.map((r) => r.id).sort() });
/** A deterministic random source (mulberry32). */
const rng = (seed: number) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

// The shapes a chain user can make with dust transfers: K crossings recorded on both chains, K records on each chain
// that pair with nothing, and K of one key whose Osmosis records lie an hour away from every Namada record.
const nam = (K: number, to = 'tnam1receiver') => Array.from({ length: K }, (_, i) => ({ id: 'n' + i, kind: 'ibc_in', ts: NOW - H - i * 1000, from_addr: 'osmo1sender', to_addr: to, amount_num: 0.000001 }));
const osm = (K: number, to: string, shift = 0) => Array.from({ length: K }, (_, i) => ({ id: 'o' + i, kind: 'ibc_out', ts: NOW - H - i * 1000 - shift, from_addr: 'osmo1sender', to_addr: to, amount_num: 0.000001 }));
const counted = (arr: any[]) => {
  const c = { reads: 0 };
  return { rows: new Proxy(arr, { get(t, k, r) { if (typeof k === 'string' && /^\d+$/.test(k)) c.reads++; return Reflect.get(t, k, r); } }), c };
};

describe('the bridge pairing grows with the rows, not with their product', () => {
  it('reads each Osmosis record a fixed number of times, paired or not', () => {
    const K = 2000;
    const un = counted(osm(K, 'tnam1other'));
    const u = unpairedCrossings(nam(K), un.rows, NOW);
    expect(u.namadaOnly).toHaveLength(K);
    expect(u.osmosisOnly).toHaveLength(K);
    const pa = counted(osm(K, 'tnam1receiver'));
    const p = unpairedCrossings(nam(K), pa.rows, NOW);
    expect(p.namadaOnly.length + p.osmosisOnly.length).toBe(0);
    // The linear search read K * K + K records unpaired and K(K+1)/2 + K paired.
    expect(un.c.reads).toBeLessThanOrEqual(3 * K);
    expect(pa.c.reads).toBeLessThanOrEqual(3 * K);
  });

  it(`pairs ${(20_000).toLocaleString('en-US')} records a chain in well under a second, whatever their shape`, () => {
    const K = 20_000;
    const shapes: [string, any[], any[], number][] = [
      ['every record paired', nam(K), osm(K, 'tnam1receiver'), 0],
      ['nothing pairs', nam(K), osm(K, 'tnam1other'), 2 * K],
      ['one key, an hour apart', nam(K), osm(K, 'tnam1receiver', 25 * H), 2 * K],
      ['escrow-named records, nothing pairs', nam(K, ESCROW).map((r) => ({ ...r, from_addr: ESCROW, to_addr: 'tnam1receiver' })), osm(K, 'tnam1other').map((r) => ({ ...r, amount_num: 0.000002 })), 2 * K],
    ];
    for (const [name, n, o, unpaired] of shapes) {
      const t = performance.now();
      const u = unpairedCrossings(n, o, NOW);
      const ms = performance.now() - t;
      expect({ name, unpaired: u.namadaOnly.length + u.osmosisOnly.length }).toEqual({ name, unpaired });
      // The linear search took about 1.7 s (every record paired) to 7 s (nothing pairs) here on 2026-10-22.
      expect({ name, fast: ms < 1000 }).toEqual({ name, fast: true });
    }
  }, 60_000);

  it('a refund whose sequence matched no send looks only through the sends without one', () => {
    const K = 2000;
    const c = { n: 0 };
    const outs = Array.from({ length: K }, (_, i) => ({ get id() { c.n++; return 'o' + i; }, ts: NOW - i * 1000, from: 'osmo1s', to: 'tnam1r', amount: 1, seq: 'a' + i, receiverKnown: false })) as IbcRow[];
    const strays = Array.from({ length: K }, (_, i) => ({ id: 'r' + i, ts: NOW, from: null, to: null, amount: 1, seq: 'b' + i, receiverKnown: false }));
    expect(timedOutSends(outs, strays).size).toBe(0);
    // The linear search read every send's id for every refund: K * K.
    expect(c.n).toBeLessThanOrEqual(2 * K);
  });
});

describe('the bridge pairing finds what the linear search found', () => {
  const row = (id: string, kind: string, ts: number, from: string | null, to: string | null, nam: number) => ({ id, kind, ts, from_addr: from, to_addr: to, amount_num: nam });

  it('the escrow stands for any address, the shielded pool for any tnam1 address, the window is 15 minutes either side', () => {
    const t = NOW - 5 * H;
    const namada = [
      row('esc', 'ibc_in', t, ESCROW, 'tnam1a', 5),                  // an older record naming the escrow as sender
      row('masp-in', 'ibc_in', t, 'osmo1b', MASP, 7),                // a shielding transfer
      row('masp-out', 'ibc_out', t, MASP, 'osmo1c', 9),              // a shielded withdrawal, sent from a one-time address
      row('masp-junk', 'ibc_in', t, 'osmo1d', MASP, 11),             // only an Osmosis record to a non-tnam1 receiver
      row('edge', 'ibc_in', t, 'osmo1e', 'tnam1e', 13),              // its Osmosis record exactly 15 minutes later
      row('past', 'ibc_in', t, 'osmo1f', 'tnam1f', 15),              // its Osmosis record 15 minutes and 1 ms later
      row('null', 'ibc_in', t, null, 'tnam1g', 17),
      row('young', 'ibc_in', NOW - 10 * M, 'osmo1h', 'tnam1h', 19),  // not judged yet
      row('nan', 'ibc_in', Number.NaN, 'osmo1i', 'tnam1i', 21),
    ];
    const osmosis = [
      row('o-esc', 'ibc_out', t + M, 'osmo1zzz', 'tnam1a', 5),
      row('o-masp-in', 'ibc_out', t - M, 'osmo1b', 'tnam1pcqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzmefah', 7),
      row('o-masp-out', 'ibc_in', t + 2 * M, 'tnam1onetime', 'osmo1c', 9),
      row('o-masp-junk', 'ibc_out', t, 'osmo1d', 'not-an-address', 11),
      row('o-edge', 'ibc_out', t + 15 * M, 'osmo1e', 'tnam1e', 13),
      row('o-past', 'ibc_out', t + 15 * M + 1, 'osmo1f', 'tnam1f', 15),
      row('o-null', 'ibc_out', t, null, 'tnam1g', 17),
      row('o-wrong-kind', 'ibc_in', t, 'osmo1zzz', 'tnam1a', 5),
    ];
    const u = unpairedCrossings(namada, osmosis, NOW);
    expect(ids(u)).toEqual(ids(linearPairing(namada, osmosis, NOW)));
    expect(ids(u)).toEqual({ namada: ['masp-junk', 'past'], osmosis: ['o-masp-junk', 'o-past', 'o-wrong-kind'] });
  });

  it('amounts less than 1e-6 apart pair, as they did', () => {
    const r = rng(7);
    for (let i = 0; i < 2000; i++) {
      const k = Math.floor(r() * 1e12);
      const t = NOW - 2 * H;
      const n = [row('n', 'ibc_in', t, 'osmo1a', 'tnam1a', k / 1e6)];
      const o = [row('o', 'ibc_out', t, 'osmo1a', 'tnam1a', (k + (i % 3) - 1) / 1e6)];
      expect(ids(unpairedCrossings(n, o, NOW))).toEqual(ids(linearPairing(n, o, NOW)));
    }
  });

  it('records that do not compete pair the same way; records that do are never paired less', () => {
    const froms = ['osmo1a', 'osmo1b', ESCROW, MASP, null];
    const tos = ['tnam1a', 'tnam1b', 'osmo1c', MASP, ESCROW, 'junk'];
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed);
      const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
      // No competition: every crossing its own amount (3 micro units apart), so each record has one candidate at most.
      const namada: any[] = [], osmosis: any[] = [];
      for (let i = 0; i < 60; i++) {
        const nam = (i + 1) * 3e-6 * 1000;
        const ts = NOW - r() * 3 * D;
        const kind = r() < 0.5 ? 'ibc_in' : 'ibc_out';
        const f = pick(froms), t = pick(tos);
        if (r() < 0.8) namada.push(row(`n${i}`, kind, ts, f, t, nam));
        if (r() < 0.8) osmosis.push(row(`o${i}`, r() < 0.9 ? (kind === 'ibc_in' ? 'ibc_out' : 'ibc_in') : kind, ts + (r() - 0.5) * 40 * M,
          f === ESCROW || f === MASP ? pick(['osmo1x', 'tnam1x', 'junk']) : f, t === ESCROW || t === MASP ? pick(['tnam1y', 'osmo1y', 'junk']) : t, nam));
      }
      expect(ids(unpairedCrossings(namada, osmosis, NOW))).toEqual(ids(linearPairing(namada, osmosis, NOW)));
      // Competition: one sender, receiver and amount, times close together.
      const a = Array.from({ length: 40 }, (_, i) => row(`n${i}`, 'ibc_in', NOW - H - r() * 3 * H, 'osmo1s', 'tnam1r', 1));
      const b = Array.from({ length: 40 }, (_, i) => row(`o${i}`, 'ibc_out', NOW - H - r() * 3 * H, 'osmo1s', 'tnam1r', 1));
      const now = unpairedCrossings(a, b, NOW), was = linearPairing(a, b, NOW);
      expect(now.namadaOnly.length + now.osmosisOnly.length).toBeLessThanOrEqual(was.namadaOnly.length + was.osmosisOnly.length);
    }
  });

  it('refunds cancel the same sends as before', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed);
      const outs: IbcRow[] = Array.from({ length: 30 }, (_, i) => ({ id: `o${i}`, ts: NOW - Math.floor(r() * 5 * D), from: r() < 0.5 ? 'osmo1a' : 'osmo1b', to: 'tnam1r', amount: 1 + Math.floor(r() * 3), seq: r() < 0.6 ? String(i) : null, receiverKnown: false }));
      const refunds: IbcRow[] = Array.from({ length: 20 }, (_, i) => ({ id: `r${i}`, ts: NOW - Math.floor(r() * 4 * D), from: null, to: r() < 0.5 ? 'osmo1a' : 'osmo1b', amount: 1 + Math.floor(r() * 3), seq: r() < 0.6 ? String(Math.floor(r() * 40)) : null, receiverKnown: r() < 0.5 }));
      expect([...timedOutSends(outs, refunds)].sort()).toEqual([...linearRefunds(outs, refunds)].sort());
    }
  });
});

describe('a full read judges only the crossings it covers', () => {
  it('the time after which every record a crossing can pair with was read', () => {
    const rows = (n: number, oldest: number) => Array.from({ length: n }, (_, i) => ({ ts: oldest + (n - 1 - i) * 1000 }));
    expect(bridgeJudgedFrom(rows(10, 0), rows(10, 0), rows(10, 0))).toBeNull();
    expect(bridgeJudgedFrom(rows(BRIDGE_CHECK_ROWS, NOW - D), rows(5, 0), [])).toBe(NOW - D + PAIR_WINDOW_MS);
    expect(bridgeJudgedFrom([], rows(BRIDGE_CHECK_ROWS, NOW - 2 * D), rows(BRIDGE_CHECK_ROWS, NOW - D))).toBe(NOW - D);
  });
});

// ---------------------------------------------------------------- the tick (as test/review-c-ibc-conservation.test.ts runs it)
const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
const BAL = fx('balance_listing.json');
const BONDS = fx('bonds_listing.json');
const u256 = (n: bigint) => { const b = new Uint8Array(32); let v = n; for (let i = 0; i < 32; i++) { b[i] = Number(v & 0xffn); v >>= 8n; } return btoa(String.fromCharCode(...b)); };
const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
function network() {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
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
        : u256(path.includes('total_stake') ? 75338381473000n : 1000000n);
      return Promise.resolve(json({ result: { response: { code: 0, value, height: '8343400' } } }));
    }
    if (url.includes('denom_owners')) return Promise.resolve(json({ denom_owners: [], pagination: { next_key: null, total: '0' } }));
    if (url.includes('supply/by_denom')) return Promise.resolve(json({ amount: { denom: 'x', amount: '1000000' } }));
    return Promise.resolve(new Response('not here', { status: 404 }));
  }));
}
async function tick(env: any, start: number) {
  vi.useFakeTimers({ now: start, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  let done = false, err: unknown = null;
  runCron(env).catch((e) => { err = e; }).finally(() => { done = true; });
  for (let i = 0; !done && i < 4000; i++) await vi.advanceTimersByTimeAsync(250);
  vi.useRealTimers();
  if (err) throw err;
  expect(done).toBe(true);
}
const PLAIN = Date.parse('2026-10-17T22:41:05Z');
const BRIDGE_READ = /kind IN \('ibc_in','ibc_out'\) AND (f\.)?ts >= \?|kind='other' AND ts >= \? AND meta LIKE '%"ibcTimeoutRefund":true%'(\s|$)/;
/** The test D1 with the bridge check's reads measured: rows and bytes of each answer. */
function measured() {
  const db = testD1();
  const reads: { rows: number; bytes: number }[] = [];
  const prepare = db.prepare.bind(db);
  (db as any).prepare = (sql: string) => {
    const s: any = prepare(sql);
    if (!BRIDGE_READ.test(sql)) return s;
    const bind = s.bind.bind(s);
    s.bind = (...p: unknown[]) => {
      const b: any = bind(...p);
      const all = b.all.bind(b);
      b.all = async () => { const r = await all(); reads.push({ rows: r.results.length, bytes: JSON.stringify(r.results).length }); return r; };
      return b;
    };
    return s;
  };
  return { db, reads };
}
const insertFlows = (db: any, rows: any[]) => {
  const ins = db.raw.prepare('INSERT INTO flows (id,chain,height,ts,tx_hash,kind,from_addr,to_addr,amount_num,meta) VALUES (?,?,?,?,?,?,?,?,?,?)');
  db.raw.exec('BEGIN');
  for (const r of rows) ins.run(r.id, r.chain, r.height ?? 1, r.ts, r.tx_hash ?? r.id, r.kind, r.from_addr, r.to_addr, r.amount_num, r.meta == null ? null : JSON.stringify(r.meta));
  db.raw.exec('COMMIT');
};
const pairedCheck = (db: any) => {
  const r = db.raw.prepare("SELECT status, title, detail, checked_at FROM checks WHERE key='bridge_records_paired'").get();
  return r ? { ...r, detail: JSON.parse(r.detail) } : null;
};
const INNER = 'ab'.repeat(32);

describe('the tick\'s bridge check', () => {
  it('reads no memo, and pairs a crossing whose sender wrote a 30 KB one', async () => {
    const { db, reads } = measured();
    const memo = 'x'.repeat(30_000);
    insertFlows(db, [
      { id: `namada:${INNER}:ibc_in:0`, chain: 'namada', ts: PLAIN - 2 * H, kind: 'ibc_in', from_addr: 'osmo1sender', to_addr: 'tnam1receiver', amount_num: 2.5, meta: { innerTxHash: INNER, channel: 'channel-1', packetSequence: '77', memo } },
      { id: 'osmosis:T1:ibc_out:0', chain: 'osmosis', ts: PLAIN - 2 * H - M, kind: 'ibc_out', from_addr: 'osmo1sender', to_addr: 'tnam1receiver', amount_num: 2.5, meta: { memo, channel: 'channel-98451', packetSequence: '77' } },
    ]);
    network();
    await tick({ DB: db, KEPLR_KEY: 'k' }, PLAIN);
    const c = pairedCheck(db)!;
    expect(c.status).toBe('ok');
    expect(c.detail).toMatchObject({ namadaRows: 1, osmosisRows: 1, onlyOnNamada: 0, onlyOnOsmosis: 0 });
    expect(c.detail.judgedFrom).toBeUndefined();
    expect(reads).toHaveLength(3);
    for (const r of reads) expect(r.bytes).toBeLessThan(2_000);
  });

  it('a read that comes back full is judged from its oldest row on, says so, and the tick goes on', async () => {
    const { db, reads } = measured();
    const T = 'T'.padEnd(64, '0');
    // Dust records on Osmosis only, one a minute back from two hours ago, more than one read takes.
    const dust = Array.from({ length: BRIDGE_CHECK_ROWS + 50 }, (_, i) => ({ id: `osmosis:D${i}:ibc_out:0`, chain: 'osmosis', ts: PLAIN - 2 * H - i * 30_000, kind: 'ibc_out', from_addr: 'osmo1dust', to_addr: `tnam1dust${i % 7}`, amount_num: 0.000001, meta: { memo: '', channel: 'channel-98451', packetSequence: String(100_000 + i) } }));
    insertFlows(db, [
      ...dust,
      // a crossing on both chains an hour ago, and one on Namada only three hours ago (inside what the reads cover)
      { id: `namada:${INNER}:ibc_in:0`, chain: 'namada', ts: PLAIN - H, kind: 'ibc_in', from_addr: 'osmo1real', to_addr: 'tnam1real', amount_num: 40, meta: { innerTxHash: INNER, packetSequence: '1' } },
      { id: 'osmosis:R1:ibc_out:0', chain: 'osmosis', ts: PLAIN - H - M, kind: 'ibc_out', from_addr: 'osmo1real', to_addr: 'tnam1real', amount_num: 40, meta: { memo: '', packetSequence: '1' } },
      { id: `namada:${T}:ibc_out:0`, chain: 'namada', ts: PLAIN - 3 * H, kind: 'ibc_out', from_addr: 'tnam1real', to_addr: 'osmo1real', amount_num: 12, meta: { innerTxHash: T } },
    ]);
    network();
    await tick({ DB: db, KEPLR_KEY: 'k' }, PLAIN);
    const c = pairedCheck(db)!;
    expect(reads.every((r) => r.rows <= BRIDGE_CHECK_ROWS)).toBe(true);
    // The Osmosis read took the newest BRIDGE_CHECK_ROWS rows: the real one and all but 51 of the dust.
    const oldestRead = PLAIN - 2 * H - (BRIDGE_CHECK_ROWS - 2) * 30_000;
    expect(c.status).toBe('warn');
    expect(c.detail.judgedFrom).toBe(oldestRead + PAIR_WINDOW_MS);
    expect(c.detail.rowCap).toBe(BRIDGE_CHECK_ROWS);
    expect(c.detail.onlyOnNamada).toBe(1);
    expect(c.detail.onlyOnOsmosis).toBe(dust.filter((r) => r.ts > oldestRead + PAIR_WINDOW_MS).length);
    expect(c.detail.examples.namada.map((r: any) => r.id)).toEqual([`namada:${T}:ibc_out:0`]);
    const line = checkDetail({ key: 'bridge_records_paired', status: c.status, title: c.title, detail: c.detail, checkedAt: c.checked_at } as Check);
    expect(line).toMatch(/on one chain only, judging only crossings since \d+ \w+ \d{4}, \d\d:\d\d.UTC: there were too many records to pair 14 days$/);
    // The tick went on past the check: the health map was written at its end.
    expect(db.raw.prepare("SELECT 1 FROM kv WHERE key='source.health'").get()).toBeTruthy();
  }, 60_000);
});

// ---------------------------------------------------------------- two crossings a relayer delivers in one transaction
/** The cron's two bridge reads (runCron), and the reads before the bound (no ORDER BY, no LIMIT; flows_kind order). */
async function bridgeReads(db: ReturnType<typeof testD1>, now: number) {
  const from14 = now - 14 * D;
  const nb = await db.prepare(`SELECT f.id, f.kind, f.ts, f.height, f.from_addr, f.to_addr, f.amount_num,
                        json_object('innerTxHash', json_extract(f.meta, '$.innerTxHash'), 'wrapper', json_extract(f.meta, '$.wrapper'), 'channel', json_extract(f.meta, '$.channel'), 'packetSequence', json_extract(f.meta, '$.packetSequence')) meta
                      FROM flows f WHERE f.chain='namada' AND f.kind IN ('ibc_in','ibc_out') AND f.ts >= ?
                      AND (f.from_addr LIKE 'osmo1%' OR f.to_addr LIKE 'osmo1%' OR f.from_addr = ? OR f.to_addr = ?) AND (f.meta IS NULL OR f.meta NOT LIKE '%"tokenSymbol":%') AND ${NOT_LEGACY_TWIN}
                      ORDER BY f.ts DESC LIMIT ?`).bind(from14, ESCROW, ESCROW, BRIDGE_CHECK_ROWS).all<any>();
  const ob = await db.prepare(`SELECT id, kind, ts, height, from_addr, to_addr, amount_num, json_object('channel', json_extract(meta, '$.channel'), 'packetSequence', json_extract(meta, '$.packetSequence')) meta
                      FROM flows WHERE chain='osmosis' AND kind IN ('ibc_in','ibc_out') AND ts >= ? ORDER BY ts DESC LIMIT ?`).bind(from14 - 15 * 60000, BRIDGE_CHECK_ROWS).all<any>();
  const nbOld = await db.prepare(`SELECT f.id, f.kind, f.ts, f.height, f.from_addr, f.to_addr, f.amount_num, f.meta FROM flows f WHERE f.chain='namada' AND f.kind IN ('ibc_in','ibc_out') AND f.ts >= ?
                      AND (f.from_addr LIKE 'osmo1%' OR f.to_addr LIKE 'osmo1%' OR f.from_addr = ? OR f.to_addr = ?) AND (f.meta IS NULL OR f.meta NOT LIKE '%"tokenSymbol":%') AND ${NOT_LEGACY_TWIN}`).bind(from14, ESCROW, ESCROW).all<any>();
  const obOld = await db.prepare(`SELECT id, kind, ts, from_addr, to_addr, amount_num, meta FROM flows WHERE chain='osmosis' AND kind IN ('ibc_in','ibc_out') AND ts >= ?`).bind(from14 - 15 * 60000).all<any>();
  const recent = (rows: any[]) => rows.filter((r) => r.ts >= from14);
  return { nb: nb.results, ob: recent(ob.results), nbOld: nbOld.results, obOld: recent(obOld.results) };
}

const flowRow = (id: string, chain: string, kind: string, ts: number, from: string, to: string) =>
  ({ id, chain, height: chain === 'namada' ? 10 : 20, ts, tx_hash: id.split(':')[1], kind, from_addr: from, to_addr: to, amount_num: 1000, meta: JSON.stringify({ packetSequence: Number(id.split(':')[2]) || 1 }) });

/** Two crossings of 1,000 NAM by one user, 6 s apart, one shielded (S) and one not (T), relayed in one transaction (ids :6 then :7 in packet order). */
function batched(dir: 'osmosis->namada' | 'namada->osmosis', shieldedFirst: boolean, T: number) {
  const first = shieldedFirst ? 'S' : 'T', second = shieldedFirst ? 'T' : 'S';
  if (dir === 'osmosis->namada') {
    const to = (k: string) => (k === 'S' ? MASP : 'tnam1user');
    return [
      flowRow('osmosis:A1:0', 'osmosis', 'ibc_out', T, 'osmo1user', to(first)),
      flowRow('osmosis:B2:0', 'osmosis', 'ibc_out', T + 6000, 'osmo1user', to(second)),
      flowRow('namada:C3:6', 'namada', 'ibc_in', T + 12000, 'osmo1user', to(first)),
      flowRow('namada:C3:7', 'namada', 'ibc_in', T + 12000, 'osmo1user', to(second)),
    ];
  }
  // A shielded withdrawal leaves the pool on Namada and is sent from a one-time transparent address on the packet.
  const nfrom = (k: string) => (k === 'S' ? MASP : 'tnam1user'), ofrom = (k: string) => (k === 'S' ? 'tnam1onetimeaddress' : 'tnam1user');
  return [
    flowRow('namada:A1:0', 'namada', 'ibc_out', T, nfrom(first), 'osmo1user'),
    flowRow('namada:B2:0', 'namada', 'ibc_out', T + 6000, nfrom(second), 'osmo1user'),
    flowRow('osmosis:C3:6', 'osmosis', 'ibc_in', T + 12000, ofrom(first), 'osmo1user'),
    flowRow('osmosis:C3:7', 'osmosis', 'ibc_in', T + 12000, ofrom(second), 'osmo1user'),
  ];
}

describe('two crossings a relayer delivers in one transaction', () => {
  for (const dir of ['osmosis->namada', 'namada->osmosis'] as const) {
    for (const shieldedFirst of [false, true]) {
      it(`${dir}, ${shieldedFirst ? 'shielded' : 'transparent'} first: both pair, as with the linear search, whatever order the read gives the tie`, async () => {
        const db = testD1();
        const now = Date.now();
        insert(db, 'flows', batched(dir, shieldedFirst, now - 2 * H));
        const r = await bridgeReads(db, now);
        const was = linearPairing(r.nbOld, r.obOld, now);
        expect(was.namadaOnly.length + was.osmosisOnly.length).toBe(0);
        expect(ids(unpairedCrossings(r.nb, r.ob, now))).toEqual({ namada: [], osmosis: [] });
        expect(ids(unpairedCrossings([...r.nb].reverse(), [...r.ob].reverse(), now))).toEqual({ namada: [], osmosis: [] });
      });
    }
  }

  it('the tick\'s check stays ok', async () => {
    const { db } = measured();
    insert(db, 'flows', [...batched('osmosis->namada', false, PLAIN - 2 * H), ...batched('namada->osmosis', true, PLAIN - 3 * H).map((r) => ({ ...r, id: r.id.replace(':', ':N') }))]);
    network();
    await tick({ DB: db, KEPLR_KEY: 'k' }, PLAIN);
    expect(pairedCheck(db)).toMatchObject({ status: 'ok', detail: { namadaRows: 4, osmosisRows: 4, onlyOnNamada: 0, onlyOnOsmosis: 0 } });
  });

  it('honest crossings, some shielded, some delivered in one block: every one pairs, in whatever order the reads come', () => {
    // Crossings as users make them: each one a Namada row and its Osmosis record, a few seconds to a minute apart, on
    // a 6 s block grid (records of one block share a time), one or two senders, receivers and amounts.
    const shuffle = <T,>(xs: T[], r: () => number) => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
    let failed = 0;
    for (let seed = 1; seed <= 5000; seed++) {
      const r = rng(seed);
      const namada: any[] = [], osmosis: any[] = [];
      const n = 2 + Math.floor(r() * 5);
      for (let i = 0; i < n; i++) {
        const o = r() < 0.5 ? 'osmo1a' : 'osmo1b', t = r() < 0.5 ? 'tnam1x' : 'tnam1y';
        const amt = [1, 1, 1, 10, 0.000001, 0.000002][Math.floor(r() * 6)];
        const ts = NOW - 2 * H + Math.floor(r() * 40) * 6000, lag = Math.floor(r() * 4) * 6000;
        const shielded = r() < 0.4;
        if (r() < 0.5) {
          osmosis.push({ id: `o${i}`, kind: 'ibc_out', ts, from_addr: o, to_addr: shielded ? MASP : t, amount_num: amt });
          namada.push({ id: `n${i}`, kind: 'ibc_in', ts: ts + lag, from_addr: o, to_addr: shielded ? MASP : t, amount_num: amt });
        } else {
          namada.push({ id: `n${i}`, kind: 'ibc_out', ts, from_addr: shielded ? MASP : t, to_addr: o, amount_num: amt });
          osmosis.push({ id: `o${i}`, kind: 'ibc_in', ts: ts + lag, from_addr: shielded ? `tnam1onetime${i}` : t, to_addr: o, amount_num: amt });
        }
      }
      for (const [a, b] of [[namada, osmosis], [shuffle(namada, r), shuffle(osmosis, r)]]) {
        const u = unpairedCrossings(a, b, NOW);
        if (u.namadaOnly.length + u.osmosisOnly.length > 0) failed++;
      }
    }
    expect(failed).toBe(0);
  });
});

// ---------------------------------------------------------------- rows that name the escrow, and chains of moves
/** The size of a maximum matching (Kuhn), with the pairing's own rule for which record a row may take. */
function maxPairs(namada: any[], osmosis: any[]) {
  const same = (x: string | null, y: string | null) => x === y || x === ESCROW || (x === MASP && !!y?.startsWith('tnam1'));
  const ok = (n: any, o: any) => o.kind === (n.kind === 'ibc_in' ? 'ibc_out' : 'ibc_in') && same(n.from_addr, o.from_addr) && same(n.to_addr, o.to_addr) && Math.abs(o.amount_num - n.amount_num) < 1e-6 && Math.abs(o.ts - n.ts) <= PAIR_WINDOW_MS;
  const to: number[] = osmosis.map(() => -1);
  const go = (i: number, seen: boolean[]): boolean => {
    for (let j = 0; j < osmosis.length; j++) if (!seen[j] && ok(namada[i], osmosis[j])) { seen[j] = true; if (to[j] < 0 || go(to[j], seen)) { to[j] = i; return true; } }
    return false;
  };
  let m = 0;
  for (let i = 0; i < namada.length; i++) if (go(i, osmosis.map(() => false))) m++;
  return m;
}
/** The order the linear search's read gave (flows_kind: kind, then the newest first), and the order the bounded reads give (the newest first). */
const idDesc = (a: any, b: any) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
const kindOrder = (a: any, b: any) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : b.ts - a.ts || (b.height ?? 0) - (a.height ?? 0) || idDesc(a, b));
const newest = (a: any, b: any) => b.ts - a.ts || (b.height ?? 0) - (a.height ?? 0) || idDesc(a, b);
const unpairedCount = (u: { namadaOnly: any[]; osmosisOnly: any[] }) => u.namadaOnly.length + u.osmosisOnly.length;

type Kind = 'T_out' | 'T_in' | 'S_out' | 'S_in' | 'E_in' | 'E_out';
/** Honest crossings: each a Namada row and its own Osmosis record, received 6 s to 10 min after it was sent, on a 6 s block grid. */
function honestCrossings(r: () => number, kinds: Kind[]) {
  const namada: any[] = [], osmosis: any[] = [];
  const n = 2 + Math.floor(r() * 6);
  const blk = (ts: number) => Math.round((ts - (NOW - 3 * H)) / 6000);
  for (let i = 0; i < n; i++) {
    const o = r() < 0.5 ? 'osmo1a' : 'osmo1b', t = r() < 0.5 ? 'tnam1x' : 'tnam1y';
    const amt = [1, 1, 1, 10][Math.floor(r() * 4)];
    const ts = NOW - 2 * H + Math.floor(r() * 400) * 6000, lag = 6000 + Math.floor(r() * 100) * 6000;
    const N = (kind: string, at: number, f: string, to: string) => namada.push({ id: `namada:N${i}`, kind, ts: at, height: blk(at), from_addr: f, to_addr: to, amount_num: amt });
    const O = (kind: string, at: number, f: string, to: string) => osmosis.push({ id: `osmosis:O${i}:0`, kind, ts: at, height: blk(at), from_addr: f, to_addr: to, amount_num: amt });
    const k = kinds[Math.floor(r() * kinds.length)];
    if (k === 'T_out') { N('ibc_out', ts, t, o); O('ibc_in', ts + lag, t, o); }
    if (k === 'T_in') { O('ibc_out', ts, o, t); N('ibc_in', ts + lag, o, t); }
    if (k === 'S_out') { N('ibc_out', ts, MASP, o); O('ibc_in', ts + lag, `tnam1onetime${i}`, o); }
    if (k === 'S_in') { O('ibc_out', ts, o, MASP); N('ibc_in', ts + lag, o, MASP); }
    // the packet was not bound, so the Namada row names the escrow in place of the Osmosis address
    if (k === 'E_in') { O('ibc_out', ts, o, t); N('ibc_in', ts + lag, ESCROW, t); }
    if (k === 'E_out') { N('ibc_out', ts, t, ESCROW); O('ibc_in', ts + lag, t, o); }
  }
  return { namada, osmosis };
}

describe('a row that names the escrow pairs as it did with the linear search', () => {
  const both = (namada: any[], osmosis: any[]) => [[[...namada].sort(newest), [...osmosis].sort(newest)], [namada, osmosis]] as const;

  it('an escrow send and a send of the same user and amount 14 minutes later: the later row moves on to its own record', () => {
    // A user sends 1 NAM to osmo1y twice, 14 minutes apart; the first Namada row names the escrow (no packet bound),
    // the second the receiver. Each record lands 2 minutes after its send.
    const namada = [
      { id: 'namada:E', kind: 'ibc_out', ts: NOW - 2 * H, height: 1, from_addr: 'tnam1x', to_addr: ESCROW, amount_num: 1 },
      { id: 'namada:A', kind: 'ibc_out', ts: NOW - 2 * H + 14 * M, height: 2, from_addr: 'tnam1x', to_addr: 'osmo1y', amount_num: 1 },
    ];
    const osmosis = [
      { id: 'osmosis:rE:0', kind: 'ibc_in', ts: NOW - 2 * H + 2 * M, height: 1, from_addr: 'tnam1x', to_addr: 'osmo1y', amount_num: 1 },
      { id: 'osmosis:rA:0', kind: 'ibc_in', ts: NOW - 2 * H + 16 * M, height: 2, from_addr: 'tnam1x', to_addr: 'osmo1y', amount_num: 1 },
    ];
    expect(unpairedCount(linearPairing([...namada].sort(kindOrder), [...osmosis].sort(kindOrder), NOW))).toBe(0);
    for (const [n, o] of both(namada, osmosis)) expect(ids(unpairedCrossings(n, o, NOW))).toEqual({ namada: [], osmosis: [] });
  });

  it('an escrow receive and a shielded deposit of the same user and amount: the shielded row moves on to the pool\'s record', () => {
    // One Osmosis user sends 1 NAM to its Namada address and a minute later 1 NAM into the shielded pool. The shielded
    // one is received first on Namada; the transparent receive's packet was not bound, so its row names the escrow.
    const T = NOW - 2 * H;
    const osmosis = [
      { id: 'osmosis:OT:0', kind: 'ibc_out', ts: T, height: 100, from_addr: 'osmo1user', to_addr: 'tnam1user', amount_num: 1 },
      { id: 'osmosis:OS:0', kind: 'ibc_out', ts: T + M, height: 110, from_addr: 'osmo1user', to_addr: MASP, amount_num: 1 },
    ];
    const namada = [
      { id: 'namada:NS', kind: 'ibc_in', ts: T + 90_000, height: 15, from_addr: 'osmo1user', to_addr: MASP, amount_num: 1 },
      { id: 'namada:NT', kind: 'ibc_in', ts: T + 2 * M, height: 20, from_addr: ESCROW, to_addr: 'tnam1user', amount_num: 1 },
    ];
    expect(unpairedCount(linearPairing([...namada].sort(kindOrder), [...osmosis].sort(kindOrder), NOW))).toBe(0);
    for (const [n, o] of both(namada, osmosis)) expect(ids(unpairedCrossings(n, o, NOW))).toEqual({ namada: [], osmosis: [] });
  });

  it('a chain of two moves: an escrow row whose record another escrow row took, whose own the shielded row took', () => {
    // The shielded row N1 (osmo1b) takes O5, a transparent record of osmo1b to tnam1y; the escrow row N5 (tnam1y) takes
    // O4; the escrow row N4 (tnam1y) can pair only with O4. N5 moves to O5, and N1 to O1, the pool's record.
    const t = (s: number) => NOW - 2 * H + s * 1000;
    const namada = [
      { id: 'namada:N1', kind: 'ibc_in', ts: t(3196), height: 666, from_addr: 'osmo1b', to_addr: MASP, amount_num: 1 },
      { id: 'namada:N4', kind: 'ibc_in', ts: t(4162), height: 827, from_addr: ESCROW, to_addr: 'tnam1y', amount_num: 1 },
      { id: 'namada:N5', kind: 'ibc_in', ts: t(3514), height: 719, from_addr: ESCROW, to_addr: 'tnam1y', amount_num: 1 },
    ];
    const osmosis = [
      { id: 'osmosis:O1:0', kind: 'ibc_out', ts: t(3064), height: 644, from_addr: 'osmo1b', to_addr: MASP, amount_num: 1 },
      { id: 'osmosis:O4:0', kind: 'ibc_out', ts: t(4000), height: 800, from_addr: 'osmo1a', to_addr: 'tnam1y', amount_num: 1 },
      { id: 'osmosis:O5:0', kind: 'ibc_out', ts: t(2944), height: 624, from_addr: 'osmo1b', to_addr: 'tnam1y', amount_num: 1 },
    ];
    expect(maxPairs(namada, osmosis)).toBe(3);
    for (const [n, o] of both(namada, osmosis)) expect(ids(unpairedCrossings(n, o, NOW))).toEqual({ namada: [], osmosis: [] });
  });

  it('random crossings with escrow-named rows (sends and receives), honest and with rows missing or moved: never fewer pairs than the linear search, and as many as can be paired', () => {
    const counts = { runs: 0, belowLinear: 0, belowMax: 0 };
    const all: Kind[] = ['T_out', 'T_in', 'S_out', 'S_in', 'E_in', 'E_out'];
    const cases: [Kind[], boolean][] = [[all, false], [['T_in', 'S_in', 'E_in'], false], [all, true]];
    for (const [c, [kinds, broken]] of cases.entries()) {
      for (let seed = 1; seed <= 3000; seed++) {
        const r = rng(seed * 7919 + c);
        let { namada, osmosis } = honestCrossings(r, kinds);
        if (broken) {
          namada = namada.filter(() => r() > 0.15);
          osmosis = osmosis.filter(() => r() > 0.15).map((o) => (r() < 0.2 ? { ...o, ts: o.ts + Math.floor((r() - 0.5) * 40) * M } : o));
        }
        const was = unpairedCount(linearPairing([...namada].sort(kindOrder), [...osmosis].sort(kindOrder), NOW));
        const now = unpairedCount(unpairedCrossings([...namada].sort(newest), [...osmosis].sort(newest), NOW));
        const best = namada.length + osmosis.length - 2 * maxPairs(namada, osmosis);
        counts.runs++;
        if (now > was) counts.belowLinear++;
        if (now > best) counts.belowMax++;
      }
    }
    expect(counts).toEqual({ runs: 9000, belowLinear: 0, belowMax: 0 });
  });

  it(`the search for chains of moves is bounded: at most ${PAIR_AUGMENT_ROWS} rows search past a held record, however many dust rows are unpaired`, () => {
    // 20,000 escrow-named dust rows of one amount and receiver and 10,000 records, each in the windows of many rows: the
    // first pass pairs 10,000, and every other row finds only held records whose rows have nowhere else to go.
    const K = 20_000;
    const n = Array.from({ length: K }, (_, i) => ({ id: 'n' + i, kind: 'ibc_in', ts: NOW - H - Math.floor(i / 2) * 1000, from_addr: ESCROW, to_addr: 'tnam1receiver', amount_num: 0.000001 }));
    const o = Array.from({ length: K / 2 }, (_, i) => ({ id: 'o' + i, kind: 'ibc_out', ts: NOW - H - i * 1000, from_addr: 'osmo1sender', to_addr: 'tnam1receiver', amount_num: 0.000001 }));
    const t = performance.now();
    const u = unpairedCrossings(n, o, NOW);
    const ms = performance.now() - t;
    expect(u.namadaOnly).toHaveLength(K / 2);
    expect(u.osmosisOnly).toHaveLength(0);
    expect(ms).toBeLessThan(1000);
  });
});
