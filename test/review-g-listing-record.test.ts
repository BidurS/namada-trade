// Security review (2026-10-22), chain listing records under bad producer answers: the record that spaces the chain
// listings (kv bond.listing, balance.listing) was written only by their apply. A tick without an epoch started the
// due bond read and let it go, and a producer value that made the tick throw after the read had started (an indexer
// totalSupply that is not a whole number, an SQS liquidity_cap that does not parse) ended the tick before the apply.
// Either way the record never moved, so every minute read the same multi-megabyte listing again and the balance
// listing was never chosen. Now a tick without an epoch does not start the bond read (the balance listing takes the
// turn), the two producer values are checked where they are used, and a tick that fails after starting a listing
// stops the read and records it as failed, so the retry wait applies. That record is read again for the write, and
// nothing is written when the read fails: the tick's first read of it may have failed too, and a record built from
// nothing replaced a complete one. One node answering the epoch without a value no longer leaves the tick without
// one (the other node is asked), and a listing skipped for the epoch keeps that reason in its row when it is also
// overdue. The pools row is one row: a figure that does not parse joins the note of a refused pool address.
// The real runCron over the sqlite D1 stand-in.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { runCron, type BalanceListingRecord, type BondListingRecord } from '../worker/src/cron';
import { BALANCE_LISTING_SRC, listingTimes } from '../worker/src/holders';
import { testD1, insert } from './d1-sqlite';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
const BAL = fx('balance_listing.json');
const BONDS = fx('bonds_listing.json');
const u256 = (n: bigint) => { const b = new Uint8Array(32); let v = n; for (let i = 0; i < 32; i++) { b[i] = Number(v & 0xffn); v >>= 8n; } return btoa(String.fromCharCode(...b)); };
const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });

/** The stubbed network of test/cron-hang.test.ts: `hung` requests are never answered (only their abort ends them), `answer` overrides a reply. */
interface Net { hung?: (url: string) => boolean; answer?: (url: string) => Response | undefined }
function network(n: Net = {}) {
  const calls: string[] = [];
  const pending: { url: string; signal?: AbortSignal | null }[] = [];
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (n.hung?.(url)) {
      pending.push({ url, signal: init?.signal });
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    }
    let res: Response;
    const custom = n.answer?.(url);
    if (custom) res = custom;
    else if (url.includes('/status')) res = json({ result: { sync_info: { latest_block_height: '8343400', latest_block_time: new Date().toISOString(), catching_up: false, earliest_block_height: '1' } } });
    else if (url.includes('abci_query')) {
      const path = decodeURIComponent(url.split('path=')[1] ?? '');
      if (path.includes('/vp/pos/bond/')) res = json({ result: { response: { code: 1, info: 'RPC error: Cannot find bond', value: null, height: '1' } } });
      else {
        const value = path.includes('/shell/epoch') ? btoa(String.fromCharCode(155, 10, 0, 0, 0, 0, 0, 0))
          : path.includes('/shell/prefix/') ? BAL.value
          : path.includes('/vp/pos/bonds_and_unbonds/to') ? BONDS.value
          : path.includes('delegations_at') ? null
          : path.includes('balance/minted') ? u256(BigInt(BAL.expected.minted))
          : u256(path.includes('total_stake') ? 75338381473000n : 1000000n);
        res = json({ result: { response: { code: 0, value, height: '8343400' } } });
      }
    } else if (url.includes('denom_owners')) {
      res = json({ denom_owners: [{ address: 'osmo1aaa', balance: { amount: '3000000' } }, { address: 'osmo1bbb', balance: { amount: '7000000' } }], pagination: { next_key: null, total: '0' } });
    } else if (url.includes('supply/by_denom')) {
      res = json({ amount: { denom: 'x', amount: '10000000' } });
    } else res = new Response('not here', { status: 404 });
    return Promise.resolve(res);
  }));
  return { calls, pending };
}

/** Run a tick under fake timers from `start`. */
async function virtualTick(env: any, start: number) {
  vi.useFakeTimers({ now: start, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  let done = false; let err: unknown = null;
  runCron(env).catch((e) => { err = e; }).finally(() => { done = true; });
  for (let i = 0; !done && i < 4000; i++) await vi.advanceTimersByTimeAsync(250);
  vi.useRealTimers();
  if (err) throw err;
  expect(done).toBe(true);
}

// 22:41:05 UTC: not a 10-minute holder sync, not the first minutes of an hour.
const PLAIN = Date.parse('2026-10-17T22:41:05Z');
const MIN = 60_000;
function seeded() {
  const db = testD1();
  insert(db, 'holders', Array.from({ length: 50 }, (_, i) => ({ chain: 'namada', address: `tnam1qholder${String(i).padStart(3, '0')}`, balance: '1', balance_num: 0.000001, updated_height: 1, updated_at: PLAIN - 86400000, verified_at: PLAIN - 86400000, verified_src: BALANCE_LISTING_SRC })));
  insert(db, 'holders', [{ chain: 'osmosis', address: 'osmo1zzz', balance: '5000000', balance_num: 5, updated_at: PLAIN - 600000, verified_at: PLAIN - 600000 }]);
  return db;
}
const env = (db: any) => ({ DB: db, KEPLR_KEY: 'k' });
const healthOf = (db: any) => JSON.parse(db.raw.prepare("SELECT value FROM kv WHERE key='source.health'").get().value);
const rawRecord = (db: any, key: string): string | null => db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(key)?.value ?? null;
const record = <T,>(db: any, key: string): T | null => { const r = rawRecord(db, key); return r ? JSON.parse(r) : null; };
const bondReads = (calls: string[]) => calls.filter((u) => decodeURIComponent(u).includes('bonds_and_unbonds/to'));
const balanceReads = (calls: string[]) => calls.filter((u) => decodeURIComponent(u).includes('/shell/prefix/'));
const checkRow = (db: any, key: string) => db.raw.prepare('SELECT status, detail, checked_at FROM checks WHERE key = ?').get(key);
const metricAt = (db: any, key: string, ts: number) => db.raw.prepare('SELECT value FROM metrics WHERE key = ? AND ts = ?').get(key, ts)?.value ?? null;

/** Two clean ticks: the bond listing at PLAIN, the balance listing at PLAIN + 1 min; the bond listing is due again from PLAIN + 40 min. */
async function listed() {
  const db = seeded();
  network();
  await virtualTick(env(db), PLAIN);
  await virtualTick(env(db), PLAIN + MIN);
  expect(record<BondListingRecord>(db, 'bond.listing')!.at).toBe(PLAIN);
  expect(record<BalanceListingRecord>(db, 'balance.listing')!.at).toBe(PLAIN + MIN);
  return db;
}
const tokenSupply = (body: unknown) => (u: string) => (u.includes('/chain/token-supply') ? json(body) : undefined);

describe('an indexer totalSupply that is not a whole number', () => {
  for (const bad of ['1000000000.5', 1000000000.5, '1e15', { amount: '1' }]) {
    it(`(${JSON.stringify(bad)}) no longer ends the tick: the bond listing is read once and applied, the second node is the other source`, async () => {
      const db = await listed();
      const { calls } = network({ answer: tokenSupply({ totalSupply: bad }) });
      await virtualTick(env(db), PLAIN + 41 * MIN);
      await virtualTick(env(db), PLAIN + 42 * MIN);
      expect(record<BondListingRecord>(db, 'bond.listing')).toMatchObject({ at: PLAIN + 41 * MIN, completeAt: PLAIN + 41 * MIN, failedAt: null, failures: 0 });
      expect(bondReads(calls)).toHaveLength(1);
      expect(healthOf(db).cron).toBeUndefined();
      expect(checkRow(db, 'rpc_consensus').checked_at).toBe(PLAIN + 42 * MIN);
      const cross = checkRow(db, 'supply_cross_source');
      expect(cross.checked_at).toBe(PLAIN + 42 * MIN);
      expect(JSON.parse(cross.detail).otherSource).toMatch(/^Namada node /);
    });
  }

  it('a whole number (a JSON number, as the indexer answered on 2026-10-22, or a string) is still the other source', async () => {
    for (const good of [Number(BAL.expected.minted), String(BAL.expected.minted)]) {
      const db = await listed();
      network({ answer: tokenSupply({ totalSupply: good }) });
      await virtualTick(env(db), PLAIN + 41 * MIN);
      const cross = checkRow(db, 'supply_cross_source');
      expect(cross.status).toBe('ok');
      expect(JSON.parse(cross.detail).otherSource).toBe('Namada indexer (indexer.namada.net)');
    }
  });
});

describe('an SQS pool whose liquidity_cap does not parse', () => {
  it('no longer fails the metrics batch: the figure is left out, the pools row says which, the tick and the bond listing go on', async () => {
    const db = await listed();
    const pools = (cap: string) => (u: string) => (u.includes('sqs.osmosis.zone/pools') ? json([{ chain_model: { id: '3005', address: 'osmo1m459jtgn77tz8cffvthq5jh0erswxu9872mjd9qde546mslc6udq85we5r' }, type: 1, balances: [{ denom: 'ibc/C7110DEC66869DAE9BE9C3C60F4B5313B16A2204AE020C3B0527DD6B322386A3', amount: '1000000' }], liquidity_cap: cap }]) : undefined);
    const { calls } = network({ answer: pools('n/a') });
    await virtualTick(env(db), PLAIN + 41 * MIN);
    await virtualTick(env(db), PLAIN + 42 * MIN);
    expect(record<BondListingRecord>(db, 'bond.listing')).toMatchObject({ at: PLAIN + 41 * MIN, failedAt: null });
    expect(bondReads(calls)).toHaveLength(1);
    expect(healthOf(db).cron).toBeUndefined();
    expect(healthOf(db)['Osmosis SQS (pools)']).toMatchObject({ ok: false, note: 'Not a number, so not stored: dex.liquidity_usd, dex.ref_pool_liquidity_usd' });
    // the rest of the batch landed: the supply, the pool count, the reference pool's reserves
    expect(metricAt(db, 'supply.total', PLAIN + 42 * MIN)).not.toBeNull();
    expect(metricAt(db, 'dex.pool_count', PLAIN + 42 * MIN)).toBe(1);
    expect(metricAt(db, 'dex.liquidity_usd', PLAIN + 42 * MIN)).toBeNull();
    expect(checkRow(db, 'rpc_consensus').checked_at).toBe(PLAIN + 42 * MIN);
    // the next good answer clears the row and is stored
    network({ answer: pools('724') });
    await virtualTick(env(db), PLAIN + 43 * MIN);
    expect(healthOf(db)['Osmosis SQS (pools)'].ok).toBe(true);
    expect(metricAt(db, 'dex.liquidity_usd', PLAIN + 43 * MIN)).toBe(724);
  });
});

describe('a tick that fails after its listing read has started', () => {
  it('stops the read and records it as failed, so the next tries wait LISTING_RETRY_MS instead of reading it every minute', async () => {
    const db = await listed();
    // Any failure between the start of the read and its apply: here D1 refuses the integrity-checks batch.
    let failing = true;
    const flaky = { ...db, batch: (stmts: any[]) => (failing && stmts.some((s) => /INTO checks/.test(s.sql)) ? Promise.reject(new Error('D1_ERROR: simulated')) : db.batch(stmts)) };
    const net = network({ hung: (u) => decodeURIComponent(u).includes('bonds_and_unbonds/to') });
    await virtualTick(env(flaky), PLAIN + 41 * MIN);
    expect(healthOf(db).cron).toMatchObject({ ok: false, note: 'Error: D1_ERROR: simulated' });
    // the download is not left running after the tick
    expect(net.pending).toHaveLength(1);
    expect(net.pending[0].signal?.aborted).toBe(true);
    const failed = record<BondListingRecord>(db, 'bond.listing')!;
    expect(failed).toMatchObject({ at: PLAIN, completeAt: PLAIN, failedAt: PLAIN + 41 * MIN, failures: 1 });
    expect(failed.error).toMatch(/^Not applied: the tick failed first \(Error: D1_ERROR: simulated\)/);
    // within the retry wait the next failing tick does not read the listing again
    await virtualTick(env(flaky), PLAIN + 42 * MIN);
    expect(bondReads(net.calls)).toHaveLength(1);
    expect(record<BondListingRecord>(db, 'bond.listing')!.failures).toBe(1);
    // after it, a healthy tick reads and applies the listing and the record starts over
    failing = false;
    const { calls } = network();
    await virtualTick(env(flaky), PLAIN + 46 * MIN);
    expect(bondReads(calls)).toHaveLength(1);
    expect(record<BondListingRecord>(db, 'bond.listing')).toMatchObject({ at: PLAIN + 46 * MIN, completeAt: PLAIN + 46 * MIN, failedAt: null, failures: 0 });
  });

  it('with no record yet, the failed read still leaves one the retry wait can apply to and the next listing replaces', async () => {
    const db = seeded();
    const flaky = { ...db, batch: (stmts: any[]) => (stmts.some((s) => /INTO checks/.test(s.sql)) ? Promise.reject(new Error('D1_ERROR: simulated')) : db.batch(stmts)) };
    network();
    await virtualTick(env(flaky), PLAIN);
    expect(record<BondListingRecord>(db, 'bond.listing')).toMatchObject({ at: 0, completeAt: null, remaining: 0, failedAt: PLAIN, failures: 1 });
    const { calls } = network();
    await virtualTick(env(db), PLAIN + 2 * MIN);
    expect(bondReads(calls)).toHaveLength(0);
    await virtualTick(env(db), PLAIN + 5 * MIN);
    expect(record<BondListingRecord>(db, 'bond.listing')).toMatchObject({ at: PLAIN + 5 * MIN, completeAt: PLAIN + 5 * MIN, failures: 0 });
  });
});

const BOND_SEED = (at: number) => ({ at, completeAt: at, height: 8343000, epoch: 2714, provider: '5ElementsNodes', sources: 12, stakers: 12, totalNam: 75564397, bytes: 1, written: 0, zeroed: 0, remaining: 0, ticks: 1, durationMs: 0 });
const BAL_SEED = (at: number) => ({ at, completeAt: at, height: 8343000, provider: '5ElementsNodes', keys: 28, holders: 18, totalNam: 0, bytes: 1, written: 0, zeroed: 0, remaining: 0, ticks: 1, durationMs: 0, spansAt: null, extendedAt: null });
const epochAnswer = (body: unknown) => (u: string) => (decodeURIComponent(u).includes('/shell/epoch') ? json(body) : undefined);

describe('a tick with no usable epoch while the bond listing is due', () => {
  for (const [what, answer] of [
    ['every node answers the epoch with no value', epochAnswer({ result: { response: { code: 0, value: null, height: '8343400' } } })],
    ['every node answers the epoch without a response', epochAnswer({ jsonrpc: '2.0', id: -1 })],
  ] as const) {
    it(`(${what}) does not read the bond listing; the balance listing takes the turn; the bond listing is read once the epoch is back`, async () => {
      const db = seeded();
      const bondSeed = JSON.stringify(BOND_SEED(PLAIN - 41 * MIN));
      db.raw.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run('bond.listing', bondSeed, PLAIN - 41 * MIN);
      db.raw.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run('balance.listing', JSON.stringify(BAL_SEED(PLAIN - 3 * 3600000)), PLAIN - 3 * 3600000);
      const { calls } = network({ answer });
      await virtualTick(env(db), PLAIN);
      expect(bondReads(calls)).toHaveLength(0);
      expect(balanceReads(calls).length).toBeGreaterThanOrEqual(1);
      expect(record<BalanceListingRecord>(db, 'balance.listing')).toMatchObject({ at: PLAIN, completeAt: PLAIN, failures: 0 });
      expect(healthOf(db)['Namada RPC (balance listing)']).toMatchObject({ ok: true });
      expect(healthOf(db)['Namada RPC (bond listing)']).toMatchObject({ ok: false, note: 'Not read this tick: the epoch could not be read from the chain.' });
      expect(rawRecord(db, 'bond.listing')).toBe(bondSeed);
      // the next two ticks without an epoch read neither listing (the balance listing is current)
      const balanceReadsAfterFirst = balanceReads(calls).length;
      await virtualTick(env(db), PLAIN + MIN);
      await virtualTick(env(db), PLAIN + 2 * MIN);
      expect(bondReads(calls)).toHaveLength(0);
      expect(balanceReads(calls)).toHaveLength(balanceReadsAfterFirst);
      expect(rawRecord(db, 'bond.listing')).toBe(bondSeed);
      // the epoch is back: the bond listing is read and applied
      const next = network();
      await virtualTick(env(db), PLAIN + 3 * MIN);
      expect(bondReads(next.calls)).toHaveLength(1);
      expect(record<BondListingRecord>(db, 'bond.listing')).toMatchObject({ at: PLAIN + 3 * MIN, completeAt: PLAIN + 3 * MIN, epoch: 2715 });
    });
  }
});

/** `db` with D1 failing the first read of `key`'s record and every integrity-checks batch (a transient D1 error twice in one tick). */
function flakyFirstRead(db: any, key: string) {
  const state = { missed: false };
  const flaky: any = {
    ...db,
    prepare(sql: string) {
      const s = db.prepare(sql);
      if (sql !== 'SELECT value FROM kv WHERE key=?') return s;
      return { bind: (...p: unknown[]) => {
        const b = s.bind(...p);
        if (!state.missed && p[0] === key) { state.missed = true; return { ...b, first: () => Promise.reject(new Error('D1_ERROR: Network connection lost.')) }; }
        return b;
      } };
    },
    batch: (stmts: any[]) => (stmts.some((s) => /INTO checks/.test(s.sql)) ? Promise.reject(new Error('D1_ERROR: simulated')) : db.batch(stmts)),
  };
  return { flaky, state };
}

describe('a failed tick whose first read of the listing record failed too', () => {
  it('(the bond listing due) keeps the complete record and records the failure on it, instead of writing a blank one', async () => {
    const db = await listed();
    const good = record<BondListingRecord>(db, 'bond.listing')!;
    const { flaky, state } = flakyFirstRead(db, 'bond.listing');
    const { calls } = network();
    await virtualTick(env(flaky), PLAIN + 41 * MIN);
    expect(state.missed).toBe(true);
    expect(bondReads(calls)).toHaveLength(1);
    const after = record<BondListingRecord>(db, 'bond.listing')!;
    expect(after).toMatchObject({ completeAt: PLAIN, height: good.height, epoch: good.epoch, provider: good.provider, sources: good.sources, failedAt: PLAIN + 41 * MIN, failures: 1 });
    expect(after.error).toMatch(/^Not applied: the tick failed first/);
    expect((await listingTimes(db as any)).bond).toBe(PLAIN);
  });

  it('(the bond listing not due, read only because the record read failed) keeps the record whole', async () => {
    const db = await listed();
    const good = record<BondListingRecord>(db, 'bond.listing')!;
    const { flaky } = flakyFirstRead(db, 'bond.listing');
    const { calls } = network();
    await virtualTick(env(flaky), PLAIN + 10 * MIN);
    expect(bondReads(calls)).toHaveLength(1);
    expect(record<BondListingRecord>(db, 'bond.listing')).toMatchObject({ completeAt: PLAIN, height: good.height, provider: good.provider, sources: good.sources });
  });

  it('writes nothing when the record cannot be read again either', async () => {
    const db = await listed();
    const before = rawRecord(db, 'bond.listing');
    const reads = { n: 0 };
    const flaky: any = {
      ...db,
      prepare(sql: string) {
        const s = db.prepare(sql);
        if (sql !== 'SELECT value FROM kv WHERE key=?') return s;
        return { bind: (...p: unknown[]) => { const b = s.bind(...p); if (p[0] === 'bond.listing') { reads.n++; return { ...b, first: () => Promise.reject(new Error('D1_ERROR: Network connection lost.')) }; } return b; } };
      },
      batch: (stmts: any[]) => (stmts.some((s) => /INTO checks/.test(s.sql)) ? Promise.reject(new Error('D1_ERROR: simulated')) : db.batch(stmts)),
    };
    network();
    await virtualTick(env(flaky), PLAIN + 41 * MIN);
    expect(reads.n).toBeGreaterThanOrEqual(2);
    expect(rawRecord(db, 'bond.listing')).toBe(before);
  });
});

describe('the Osmosis SQS (pools) row with a refused pool address and a figure that does not parse', () => {
  it('says both in one row', async () => {
    const db = seeded();
    network({ answer: (u: string) => (u.includes('sqs.osmosis.zone/pools') ? json([{ chain_model: { id: '3005', address: 'tnam1qr4wemkpjfycn7ts7297e8qecg2t6pf2vq2wulsa' }, type: 1, balances: [{ denom: 'ibc/C7110DEC66869DAE9BE9C3C60F4B5313B16A2204AE020C3B0527DD6B322386A3', amount: '1000000' }], liquidity_cap: 'n/a' }]) : undefined) });
    await virtualTick(env(db), PLAIN);
    const row = healthOf(db)['Osmosis SQS (pools)'];
    expect(row.ok).toBe(false);
    expect(row.note).toMatch(/^The pool list named 1 address that is not an Osmosis pool account; it is not labelled a pool\. Not a number, so not stored: dex\.liquidity_usd/);
    expect(row.note.length).toBeLessThanOrEqual(160);
  });
});

describe('a tick without an epoch while the bond listing is overdue', () => {
  it('says in one row that the epoch is why it was not read, and how long the listing has been overdue', async () => {
    const db = seeded();
    db.raw.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run('bond.listing', JSON.stringify(BOND_SEED(PLAIN - 90 * MIN)), PLAIN - 90 * MIN);
    network({ answer: epochAnswer({ result: { response: { code: 0, value: null, height: '8343400' } } }) });
    await virtualTick(env(db), PLAIN);
    expect(healthOf(db)['Namada RPC (bond listing)']).toEqual({ name: 'Namada RPC (bond listing)', ok: false, at: PLAIN, note: 'Not read this tick: the epoch could not be read from the chain. No complete bond listing for 1.5 h (stakes as of the last one).' });
  });
});

describe('one node answering the epoch without a value, the other with the epoch', () => {
  it('the epoch is read from the other node, and the due bond listing is read and applied with it', async () => {
    const db = seeded();
    db.raw.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run('bond.listing', JSON.stringify(BOND_SEED(PLAIN - 41 * MIN)), PLAIN - 41 * MIN);
    db.raw.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run('balance.listing', JSON.stringify(BAL_SEED(PLAIN - 30 * MIN)), PLAIN - 30 * MIN);
    const { calls } = network({ answer: (u) => (u.includes('5elementsnodes') && decodeURIComponent(u).includes('/shell/epoch') ? json({ result: { response: { code: 0, value: null, height: '8343400' } } }) : undefined) });
    await virtualTick(env(db), PLAIN);
    const epochAsks = calls.filter((u) => decodeURIComponent(u).includes('/shell/epoch')).map((u) => (u.includes('5elementsnodes') ? '5E' : 'Papadritta'));
    expect(epochAsks.slice(0, 2)).toEqual(['5E', 'Papadritta']);
    expect(healthOf(db)['Namada RPC (epoch)']).toMatchObject({ ok: true });
    expect(bondReads(calls)).toHaveLength(1);
    expect(record<BondListingRecord>(db, 'bond.listing')).toMatchObject({ at: PLAIN, completeAt: PLAIN, epoch: 2715 });
    expect(metricAt(db, 'epoch', PLAIN)).toBe(2715);
  });
});
