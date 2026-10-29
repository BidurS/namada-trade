// Bridge pairing by packet identity (2026-10-29). The check bridge_records_paired paired a Namada bridge row with an
// Osmosis row only by addresses, amount and a 15-minute window. On 2026-10-29 a relayer delivered a send of
// 800,000 NAM 37.7 minutes after it left Namada, so the check flagged one row on each chain and the Sources sheet
// said a crossing that completed needed a look. unpairedCrossings now pairs first by packet identity: complementary
// kinds, the same packetSequence, the same amount within a micro unit, and the bridge's channels when the rows
// carry them, with no time window beyond the 14 days the reads cover. The rows left pair by the window as before,
// and the 30-minute settle rule is unchanged.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { runCron, unpairedCrossings, PAIR_WINDOW_MS } from '../worker/src/cron';
import { NAM } from '../worker/src/config';
import { testD1 } from './d1-sqlite';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const M = 60_000, H = 3_600_000;
// The two addresses of the crossing, their first characters as the Sources sheet showed them, padded to the length
// of a real address of each chain.
const SENDER = 'tnam1qzdxrdjvkhlxmxq'.padEnd(45, 'q');
const RECEIVER = 'osmo1nn62s9hm7ns4lwq'.padEnd(43, 'q');
const NAMADA_ID = 'namada:18856721FB637CF36C22B657137FCFFE600F744EB18541EB2120D6CDCA96960E:4';
const OSMOSIS_ID = 'osmosis:BF8EB682121699CB7FE14D4E9F858A5EC5887D28479863F9E82D88BE7CD72597:ibc_in:11';
const SENT_AT = Date.UTC(2026, 9, 29, 5, 53, 31);
const RECEIVED_AT = Date.UTC(2026, 9, 29, 6, 31, 13);
const NOW = RECEIVED_AT + 2 * H;

/** The crossing of 2026-10-29 as the check's reads give it: meta as JSON text, or as an object when `meta` says so. */
function crossing(overrides: { n?: Record<string, unknown>; o?: Record<string, unknown>; nMeta?: Record<string, unknown>; oMeta?: Record<string, unknown>; asText?: boolean } = {}) {
  const pack = (m: Record<string, unknown>) => (overrides.asText === false ? m : JSON.stringify(m));
  const n = { id: NAMADA_ID, kind: 'ibc_out', ts: SENT_AT, height: 8458676, from_addr: SENDER, to_addr: RECEIVER, amount_num: 800_000,
    meta: pack({ channel: 'channel-1', packetSequence: '8568', ...overrides.nMeta }), ...overrides.n };
  const o = { id: OSMOSIS_ID, kind: 'ibc_in', ts: RECEIVED_AT, height: 73444230, from_addr: SENDER, to_addr: RECEIVER, amount_num: 800_000,
    meta: pack({ channel: 'channel-98451', packetSequence: '8568', ...overrides.oMeta }), ...overrides.o };
  return { n, o };
}
const ids = (u: { namadaOnly: any[]; osmosisOnly: any[] }) => ({ namada: u.namadaOnly.map((r) => r.id).sort(), osmosis: u.osmosisOnly.map((r) => r.id).sort() });
const NONE = { namada: [], osmosis: [] };

describe('a crossing pairs by packet identity, whatever the time between its records', () => {
  it('the crossing of 2026-10-29, delivered 37.7 minutes after the send, pairs and both lists come back empty', () => {
    const { n, o } = crossing();
    expect(RECEIVED_AT - SENT_AT).toBeGreaterThan(PAIR_WINDOW_MS);
    expect((RECEIVED_AT - SENT_AT) / M).toBeCloseTo(37.7, 1);
    expect(ids(unpairedCrossings([n], [o], NOW))).toEqual(NONE);
    // The same with meta as objects, and with the sequence as a number.
    const obj = crossing({ asText: false });
    expect(ids(unpairedCrossings([obj.n], [obj.o], NOW))).toEqual(NONE);
    const num = crossing({ nMeta: { packetSequence: 8568 }, oMeta: { packetSequence: 8568 } });
    expect(ids(unpairedCrossings([num.n], [num.o], NOW))).toEqual(NONE);
    // The channels of the configuration are the ones the rows carry.
    expect(NAM.namadaChannel).toBe('channel-1');
    expect(NAM.osmoChannel).toBe('channel-98451');
  });

  it('a Namada send and an Osmosis send with one sequence never pair: a sequence numbers one channel\'s packets', () => {
    const { n, o } = crossing({ o: { kind: 'ibc_out' } });
    expect(ids(unpairedCrossings([n], [o], NOW))).toEqual({ namada: [NAMADA_ID], osmosis: [OSMOSIS_ID] });
    // Nor a Namada receive with an Osmosis receive.
    const r = crossing({ n: { kind: 'ibc_in' } });
    expect(ids(unpairedCrossings([r.n], [r.o], NOW))).toEqual({ namada: [NAMADA_ID], osmosis: [OSMOSIS_ID] });
  });

  it('a same-sequence pair with a different amount does not pair by sequence, and the window judges it as before', () => {
    // Different amounts: neither rule pairs them, outside the window or inside it.
    const far = crossing({ o: { amount_num: 800_001 } });
    expect(ids(unpairedCrossings([far.n], [far.o], NOW))).toEqual({ namada: [NAMADA_ID], osmosis: [OSMOSIS_ID] });
    const near = crossing({ o: { amount_num: 800_001, ts: SENT_AT + 5 * M } });
    expect(ids(unpairedCrossings([near.n], [near.o], NOW))).toEqual({ namada: [NAMADA_ID], osmosis: [OSMOSIS_ID] });
    // Amounts less than a micro unit apart pair by sequence, as the window rule has always paired such amounts.
    const micro = crossing({ o: { amount_num: 800_000.0000005 } });
    expect(ids(unpairedCrossings([micro.n], [micro.o], NOW))).toEqual(NONE);
    // A micro unit and more apart: not one crossing.
    const two = crossing({ o: { amount_num: 800_000.000002 } });
    expect(ids(unpairedCrossings([two.n], [two.o], NOW))).toEqual({ namada: [NAMADA_ID], osmosis: [OSMOSIS_ID] });
  });

  it('a Namada row whose channel is not channel-1 does not pair by sequence', () => {
    const other = crossing({ nMeta: { channel: 'channel-7' } });
    expect(ids(unpairedCrossings([other.n], [other.o], NOW))).toEqual({ namada: [NAMADA_ID], osmosis: [OSMOSIS_ID] });
    // Nor an Osmosis row whose channel is another one.
    const o2 = crossing({ oMeta: { channel: 'channel-0' } });
    expect(ids(unpairedCrossings([o2.n], [o2.o], NOW))).toEqual({ namada: [NAMADA_ID], osmosis: [OSMOSIS_ID] });
    // A row with no channel at all is held to the sequence alone.
    const none = crossing({ nMeta: { channel: undefined }, oMeta: { channel: undefined } });
    expect(ids(unpairedCrossings([none.n], [none.o], NOW))).toEqual(NONE);
    // Inside the window, the wrong channel still pairs by addresses, amount and time, as before.
    const inWindow = crossing({ nMeta: { channel: 'channel-7' }, o: { ts: SENT_AT + 5 * M } });
    expect(ids(unpairedCrossings([inWindow.n], [inWindow.o], NOW))).toEqual(NONE);
  });

  it('rows without a sequence pair by the window exactly as before', () => {
    const noSeq = (ts: number) => crossing({ nMeta: { packetSequence: undefined }, oMeta: { packetSequence: undefined }, o: { ts } });
    const inside = noSeq(SENT_AT + PAIR_WINDOW_MS);
    expect(ids(unpairedCrossings([inside.n], [inside.o], NOW))).toEqual(NONE);
    const outside = noSeq(SENT_AT + PAIR_WINDOW_MS + 1);
    expect(ids(unpairedCrossings([outside.n], [outside.o], NOW))).toEqual({ namada: [NAMADA_ID], osmosis: [OSMOSIS_ID] });
    const later = noSeq(RECEIVED_AT);
    expect(ids(unpairedCrossings([later.n], [later.o], NOW))).toEqual({ namada: [NAMADA_ID], osmosis: [OSMOSIS_ID] });
    // A sequence on one row only is no sequence pair either.
    const half = crossing({ oMeta: { packetSequence: undefined } });
    expect(ids(unpairedCrossings([half.n], [half.o], NOW))).toEqual({ namada: [NAMADA_ID], osmosis: [OSMOSIS_ID] });
  });

  it('two Namada rows with one sequence and one Osmosis row: the earlier pairs by sequence, the other goes to the window pass', () => {
    const { n, o } = crossing();
    const n2 = { ...n, id: NAMADA_ID.replace(':4', ':5'), ts: SENT_AT + 6000 };
    // With no record in its window, the second row is left on Namada only.
    expect(ids(unpairedCrossings([n2, n], [o], NOW))).toEqual({ namada: [n2.id], osmosis: [] });
    // A record of its addresses and amount in its window, with no sequence, takes it.
    const o2 = { ...o, id: OSMOSIS_ID.replace(':11', ':12'), ts: SENT_AT + 4 * M, meta: JSON.stringify({ channel: 'channel-98451' }) };
    expect(ids(unpairedCrossings([n2, n], [o2, o], NOW))).toEqual(NONE);
    // The other way round: two Osmosis records of one sequence, the earlier is taken, the other judged by the window.
    const o3 = { ...o, id: OSMOSIS_ID.replace(':11', ':13'), ts: RECEIVED_AT + 6000 };
    expect(ids(unpairedCrossings([n], [o3, o], NOW))).toEqual({ namada: [], osmosis: [o3.id] });
  });

  it('a crossing younger than 30 minutes is not judged', () => {
    const { n, o } = crossing();
    // Each record alone, young: nothing is said; at 30 minutes and one millisecond it is.
    expect(ids(unpairedCrossings([n], [], SENT_AT + 30 * M))).toEqual(NONE);
    expect(ids(unpairedCrossings([n], [], SENT_AT + 30 * M + 1))).toEqual({ namada: [NAMADA_ID], osmosis: [] });
    expect(ids(unpairedCrossings([], [o], RECEIVED_AT + 30 * M))).toEqual(NONE);
    expect(ids(unpairedCrossings([], [o], RECEIVED_AT + 30 * M + 1))).toEqual({ namada: [], osmosis: [OSMOSIS_ID] });
    // The send alone, 37 minutes old and its receipt not yet recorded: still flagged, as a relayer that has not
    // delivered is what the check is for.
    expect(ids(unpairedCrossings([n], [], RECEIVED_AT))).toEqual({ namada: [NAMADA_ID], osmosis: [] });
  });
});

// ---------------------------------------------------------------- the tick (as test/bridge-pairing-cost.test.ts runs it)
const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
const BAL = fx('balance_listing.json');
const BONDS = fx('bonds_listing.json');
const u256 = (n: bigint) => { const b = new Uint8Array(32); let v = n; for (let i = 0; i < 32; i++) { b[i] = Number(v & 0xffn); v >>= 8n; } return btoa(String.fromCharCode(...b)); };
const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
function network() {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/ibc/')) return Promise.resolve(new Response('not here', { status: 404 }));
    if (url.includes('/status')) return Promise.resolve(json({ result: { sync_info: { latest_block_height: '8458700', latest_block_time: new Date().toISOString(), catching_up: false, earliest_block_height: '1' } } }));
    if (url.includes('abci_query')) {
      const path = decodeURIComponent(url.split('path=')[1] ?? '');
      if (path.includes('/vp/pos/bond/')) return Promise.resolve(json({ result: { response: { code: 1, info: 'RPC error: Cannot find bond', value: null, height: '1' } } }));
      const value = path.includes('/shell/epoch') ? btoa(String.fromCharCode(155, 10, 0, 0, 0, 0, 0, 0))
        : path.includes('/shell/prefix/') ? BAL.value
        : path.includes('/vp/pos/bonds_and_unbonds/to') ? BONDS.value
        : path.includes('delegations_at') ? null
        : path.includes('balance/minted') ? u256(BigInt(BAL.expected.minted))
        : u256(path.includes('total_stake') ? 75338381473000n : 1000000n);
      return Promise.resolve(json({ result: { response: { code: 0, value, height: '8458700' } } }));
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

describe('the tick\'s bridge check on the crossing of 2026-10-29', () => {
  it('reads the Osmosis row\'s channel beside its sequence, and passes', async () => {
    const db = testD1();
    const { n, o } = crossing();
    const ins = db.raw.prepare('INSERT INTO flows (id,chain,height,ts,tx_hash,kind,from_addr,to_addr,amount_num,meta) VALUES (?,?,?,?,?,?,?,?,?,?)');
    ins.run(n.id, 'namada', n.height, n.ts, n.id.split(':')[1], n.kind, n.from_addr, n.to_addr, n.amount_num, n.meta);
    ins.run(o.id, 'osmosis', o.height, o.ts, o.id.split(':')[1], o.kind, o.from_addr, o.to_addr, o.amount_num, o.meta);
    // The check's Osmosis read, as cron.ts words it, carries the channel.
    const read = db.raw.prepare(`SELECT json_object('channel', json_extract(meta, '$.channel'), 'packetSequence', json_extract(meta, '$.packetSequence')) meta FROM flows WHERE chain='osmosis'`).get() as { meta: string };
    expect(JSON.parse(read.meta)).toEqual({ channel: 'channel-98451', packetSequence: '8568' });
    network();
    await tick({ DB: db, KEPLR_KEY: 'k' }, NOW);
    const c = db.raw.prepare("SELECT status, detail FROM checks WHERE key='bridge_records_paired'").get() as { status: string; detail: string };
    expect(c.status).toBe('ok');
    expect(JSON.parse(c.detail)).toMatchObject({ namadaRows: 1, osmosisRows: 1, onlyOnNamada: 0, onlyOnOsmosis: 0 });
  });

  it('the cost test\'s mirror of the Osmosis read is the read the tick makes', () => {
    // test/bridge-pairing-cost.test.ts measures the check's reads on its own copy of the SELECT text; the copy must
    // take what cron.ts takes, the channel beside the sequence, or it measures a smaller read than the Worker makes.
    const osmoRead = /SELECT id, kind, ts, height, from_addr, to_addr, amount_num, json_object\(.*?\)\) meta\s+FROM flows WHERE chain='osmosis' AND kind IN \('ibc_in','ibc_out'\) AND ts >= \? ORDER BY ts DESC LIMIT \?/g;
    const norm = (t: string) => t.replace(/\s+/g, ' ');
    const cron = (readFileSync(new URL('../worker/src/cron.ts', import.meta.url), 'utf8').match(osmoRead) ?? []).map(norm);
    const cost = (readFileSync(new URL('./bridge-pairing-cost.test.ts', import.meta.url), 'utf8').match(osmoRead) ?? []).map(norm);
    expect(cron).toHaveLength(1);
    expect(cron[0]).toContain("'channel', json_extract(meta, '$.channel')");
    expect(cost).toEqual(cron);
  });
});
