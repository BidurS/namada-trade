// Security review (2026-10-22), listing height floor: the chain listings were checked against the highest height
// any node's status reported, the listing's own node included, and an applied listing's height became a floor that
// never went down (the record's height, holders.updated_height, stakes.verified_height). One node reporting a height
// near 1e9 could have its own listing applied there and refuse every honest listing and block write for good. The
// head is now one this tick's answers agree on, as the live scan's chainHead agrees on one (sources/namada.ts
// listingHeads): the highest status height of a node on this chain, not catching up, that another answer (the other
// node, the indexer's latest block) is within 100 blocks of. With no head they agree on, no listing is applied: a
// lone node far ahead, a node restored from an old snapshot, or two nodes catching up vouch for nothing. On an agreed
// head, a stored height above it (from before this check, or a row the block follower stamped from one node) is set
// aside and its rows re-stamped by the listing applied. The counts a listing is checked against for a short answer
// (keys, sources) are no floor one answer sets for good either: a key listed twice refuses the answer, a stored count
// set aside with its height is no floor, and a smaller count another node answers is applied once a second answer
// confirms it. The real runCron against the sqlite D1 stand-in and a stubbed network, and the listing runs on
// fixtures cut from real answers (test/fixtures/balance_listing.json, bonds_listing.json).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseBalanceListing, parseBondListing, listingHeads, answeringRpcs } from '../worker/src/sources/namada';
import { NAMADA } from '../worker/src/config';
import { runCron, runBalanceListing, runBondListing, heightCeiling, LISTING_WRITE_CAP, BALANCE_LISTING_MS, type BalanceListingRecord, type BondListingRecord } from '../worker/src/cron';
import { BALANCE_LISTING_SRC } from '../worker/src/holders';
import { stmt } from '../worker/src/db';
import { testD1, insert, runStmts, type TestD1 } from './d1-sqlite';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
const BAL = fx('balance_listing.json');
const BONDS = fx('bonds_listing.json');
const H = 3600000;
const NOW = Date.UTC(2026, 9, 20, 12, 0);
const FAR = 999_999_950;
const R = 8_343_400;
const env = (db: TestD1) => ({ DB: db } as any);
const balLister = (height: number, provider: string) => async () => ({ ...parseBalanceListing(BAL.value), height, provider });
const bondLister = (height: number, provider: string) => async () => ({ ...parseBondListing(BONDS.value), height, provider });
const kv = <T,>(db: TestD1, key: string): T => JSON.parse(db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(key).value);
const users = BAL.expected.users_ as Record<string, string>;
const [A, B] = Object.entries(users).filter(([, v]) => v !== '0').map(([a]) => a).sort();
const row = (db: TestD1, a: string) => db.raw.prepare("SELECT balance, updated_height FROM holders WHERE chain='namada' AND address=?").get(a);
/** The fixture with A's NAM moved to B: the sum, the minted key and the key count are unchanged, so only the height gate can refuse it. */
const forged = (height: number) => async () => {
  const f = parseBalanceListing(BAL.value);
  f.entries.set(B, (BigInt(users[A]) + BigInt(users[B])).toString());
  f.entries.set(A, '0');
  return { ...f, height, provider: 'EVIL' };
};
const st = (height: number, catchingUp = false) => ({ height, catchingUp });
/** The listing context runCron builds from the statuses and the indexer's height. */
const ctxOf = (statuses: { height?: number; catchingUp?: boolean; error?: string }[], indexer?: number) => {
  const h = listingHeads(statuses, indexer);
  return { headHeight: h.head, headByNodes: h.byNodes };
};
const NO_HEAD = "Not applied: no two of this tick's answers agree on the chain's head, so the balance listing's height cannot be checked";

describe('a node that names another chain', () => {
  const [five, papa] = NAMADA.rpcs.map((r) => r.provider);
  const other = { provider: five, height: 999_999_900, catchingUp: false, network: 'other-chain-1' };
  const here = { provider: papa, height: 8343400, catchingUp: false, network: NAMADA.chainId };

  it('neither sets the head nor serves the listings; a status that names no chain still counts, as before', () => {
    expect(listingHeads([other, here], 8343398)).toEqual({ head: 8343400, top: 8343400, note: null, byNodes: false });
    expect(answeringRpcs([other, here]).map((r) => r.provider)).toEqual([papa]);
    const unnamed = { provider: five, height: 8343401, catchingUp: false };
    expect(answeringRpcs([unnamed, here]).map((r) => r.provider)).toEqual([five, papa]);
    expect(listingHeads([unnamed, here])).toEqual({ head: 8343400, top: 8343401, note: null, byNodes: true });
  });

  it('is never asked, even when no node on this chain answered its status', () => {
    expect(answeringRpcs([other, { provider: papa, error: 'down' }]).map((r) => r.provider)).toEqual([papa]);
    expect(answeringRpcs([other, { ...here, network: 'other-chain-2' }])).toEqual([]);
    // nodes that only failed their status or are catching up are still asked, as before (nothing better answered)
    expect(answeringRpcs([{ provider: five, error: 'down' }, { ...here, catchingUp: true }]).map((r) => r.provider)).toEqual([five, papa]);
  });
});

describe('the head the answers agree on', () => {
  it('two answers within 100 blocks of each other: the lowest node height they agree on is the head', () => {
    expect(listingHeads([st(8343400), st(8343398)], 8343390)).toEqual({ head: 8343398, top: 8343400, note: null, byNodes: true });
    expect(listingHeads([st(8343400), st(8343398)])).toEqual({ head: 8343398, top: 8343400, note: null, byNodes: true });
    expect(listingHeads([st(8343400), { error: 'timeout' }], 8343390)).toEqual({ head: 8343400, top: 8343400, note: null, byNodes: false });
    // a node that says it is 100 blocks ahead never sets the head: its listing from further ahead is refused
    expect(listingHeads([st(8343500), st(8343400)], 8343400).head).toBe(8343400);
    // a node 1,000 blocks behind (catching_up false, as 5ElementsNodes was on 2026-10-20): the indexer agrees with the leader
    expect(listingHeads([st(8343400), st(8342400)], 8343395).head).toBe(8343400);
    // the indexer vouches for a node's height but is never the head itself
    expect(listingHeads([st(8343300), { error: 'down' }], 8343390).head).toBe(8343300);
    expect(heightCeiling(8343400)).toBe(8343500);
    expect(heightCeiling(null)).toBeNull();
  });

  it('a lone answer, or answers further apart, give no head', () => {
    expect(listingHeads([st(8343400), { error: 'timeout' }]).head).toBeNull();
    expect(listingHeads([st(8343400), st(8342400)]).head).toBeNull();
    expect(listingHeads([{ error: 'a' }, { error: 'b' }]).head).toBeNull();
    expect(listingHeads([{ error: 'a' }, { error: 'b' }], 8343390).head).toBeNull();
    expect(listingHeads([st(999_999_900), { error: 'down' }]).head).toBeNull();
    expect(listingHeads([{ provider: '5ElementsNodes', height: 8353399 }, { provider: 'Papadritta', error: 'down' }], null)).toEqual({
      head: null, note: "no two of this tick's answers agree on the chain's head (5ElementsNodes 8353399; Papadritta: no answer; the indexer: no answer)", top: null, byNodes: false,
    });
  });

  it('a node far above, or up to 10,000 blocks above, the other answers is not the head', () => {
    expect(listingHeads([st(999_999_900), st(8343400)], 8343398).head).toBe(8343400);
    expect(listingHeads([st(999_999_900), st(8343400)]).head).toBeNull();
    expect(listingHeads([st(999_999_900), { error: 'down' }], 8343398).head).toBeNull();
    expect(listingHeads([st(R + 9_999), st(R)], R).head).toBe(R);
    expect(listingHeads([st(R + 9_999), { error: 'down' }], R).head).toBeNull();
  });

  it('a node catching up never vouches: two of them cannot outvote the indexer', () => {
    expect(listingHeads([st(8343400), st(8343400, true)]).head).toBeNull();
    expect(listingHeads([st(8318300, true), st(8318300, true)], 8343360)).toMatchObject({ head: null });
    expect(listingHeads([st(8318300, true), st(8343400)], 8343360).head).toBe(8343400);
    expect(listingHeads([st(8318300, true), { error: 'down' }]).note).toBe("no two of this tick's answers agree on the chain's head (a node: catching up; a node: no answer; the indexer: no answer)");
  });
});

describe('a listing from a height the chain has not reached', () => {
  it('is refused when another node answers, and the honest listing under the same answers is applied', async () => {
    const db = testD1();
    await runBalanceListing(env(db), [], NOW, {}, balLister(8343304, 'HONEST'), LISTING_WRITE_CAP, ctxOf([st(8343304), st(8343304)]));
    const ctx = { ...ctxOf([st(999_999_900), st(8343400)], 8343398), supplyBase: BigInt(BAL.expected.minted) };
    const bad = (await runBalanceListing(env(db), [], NOW + H, {}, forged(FAR), LISTING_WRITE_CAP, ctx))!;
    expect(bad.error).toBe('Not applied: the balance listing is from height 999,999,950, ahead of the head (8,343,400)');
    expect(bad).toMatchObject({ height: 8343304, refusedProvider: 'EVIL' });
    const near = (await runBalanceListing(env(db), [], NOW + H + 30000, {}, forged(8350000), LISTING_WRITE_CAP, ctx))!;
    expect(near.error).toBe('Not applied: the balance listing is from height 8,350,000, ahead of the head (8,343,400)');
    expect(row(db, A)).toMatchObject({ balance: users[A], updated_height: 8343304 });
    const good = (await runBalanceListing(env(db), [], NOW + H + 60000, {}, balLister(8343400, 'HONEST'), LISTING_WRITE_CAP, ctx))!;
    expect(good).toMatchObject({ height: 8343400, completeAt: NOW + H + 60000, failures: 0 });
    expect(good.error).toBeUndefined();
  });

  it('is refused when no two answers agree: a lone node, the indexer alone against it, or no answer at all', async () => {
    const db = testD1();
    await runBalanceListing(env(db), [], NOW, {}, balLister(8343304, 'HONEST'), LISTING_WRITE_CAP, ctxOf([st(8343304), st(8343304)]));
    for (const [i, ctx] of [ctxOf([st(999_999_900), { error: 'down' }]), ctxOf([st(999_999_900), { error: 'down' }], 8343398), ctxOf([{ error: 'a' }, { error: 'b' }], 8343398)].entries()) {
      const r = (await runBalanceListing(env(db), [], NOW + (i + 1) * H, {}, forged(FAR), LISTING_WRITE_CAP, ctx))!;
      expect(r.error).toBe(NO_HEAD);
    }
    expect(row(db, A)).toMatchObject({ balance: users[A], updated_height: 8343304 });
  });

  it('a node up to 10,000 blocks above the other node and the indexer: its listing is refused, and the next honest one is applied', async () => {
    const db = testD1();
    const supplyBase = BigInt(BAL.expected.minted);
    await runBalanceListing(env(db), [], NOW, {}, balLister(R, 'HONEST'), LISTING_WRITE_CAP, ctxOf([st(R), st(R)], R));
    const lie = (await runBalanceListing(env(db), [], NOW + H, {}, forged(R + 10_099), LISTING_WRITE_CAP, { ...ctxOf([st(R + 9_999), st(R + 50)], R + 50), supplyBase }))!;
    expect(lie.error).toBe('Not applied: the balance listing is from height 8,353,499, ahead of the head (8,343,450)');
    expect(row(db, A).balance).toBe(users[A]);
    // with the other node down, the indexer alone does not make the liar the head
    const alone = (await runBalanceListing(env(db), [], NOW + 2 * H, {}, forged(R + 10_099), LISTING_WRITE_CAP, { ...ctxOf([st(R + 9_999), { error: 'down' }], R + 50), supplyBase }))!;
    expect(alone.error).toBe(NO_HEAD);
    const honest = (await runBalanceListing(env(db), [], NOW + 3 * H, {}, balLister(R + 400, 'HONEST'), LISTING_WRITE_CAP, { ...ctxOf([st(R + 400), st(R + 400)], R + 398), supplyBase }))!;
    expect(honest.error).toBeUndefined();
    await runStmts(db, [stmt.namadaBalance({ address: A, balance: '123', height: R + 401 } as any, NOW + 3 * H)]);
    expect(row(db, A)).toMatchObject({ balance: '123', updated_height: R + 401 });
  });
});

/** A D1 already holding a far-future floor: the record and rows A and B at FAR (applied before this check, with no head to check against). */
async function farFloor(db: TestD1) {
  await runBalanceListing(env(db), [], NOW, {}, balLister(8343304, 'HONEST'), LISTING_WRITE_CAP, ctxOf([st(8343304), st(8343304)], 8343300));
  const lie = (await runBalanceListing(env(db), [], NOW + H, {}, forged(FAR), LISTING_WRITE_CAP, {}))!;
  expect(lie).toMatchObject({ height: FAR, completeAt: NOW + H });
  expect(row(db, A)).toMatchObject({ balance: '0', updated_height: FAR });
}

describe('a stored height above the head the answers agree on', () => {
  it('is kept while no two answers agree, then set aside on an agreed head: the honest listing re-stamps and corrects the rows and block writes land again', async () => {
    const db = testD1();
    await farFloor(db);
    // The honest node is back but the liar still answers and the indexer is down: no two answers agree, so the
    // stored height is kept (no lone answer may set it aside: a lagging node would roll the rows back) and the listing waits.
    const wait = (await runBalanceListing(env(db), [], NOW + 2 * H, {}, balLister(8343500, 'HONEST'), LISTING_WRITE_CAP, ctxOf([st(999_999_900), st(8343500)])))!;
    expect(wait.error).toBe(NO_HEAD);
    expect(row(db, A)).toMatchObject({ balance: '0', updated_height: FAR });
    // With the indexer agreeing with the honest node (the liar still answering), the stored height is set aside.
    const health: any[] = [];
    const healed = (await runBalanceListing(env(db), health, NOW + 3 * H, {}, balLister(8343600, 'HONEST'), LISTING_WRITE_CAP, ctxOf([st(999_999_900), st(8343600)], 8343598)))!;
    expect(healed).toMatchObject({ height: 8343600, completeAt: NOW + 3 * H, failures: 0, unpinned: 2 });
    expect(healed.error).toBeUndefined();
    expect(row(db, A)).toMatchObject({ balance: users[A], updated_height: 8343600 });
    expect(row(db, B)).toMatchObject({ balance: users[B], updated_height: 8343600 });
    expect(db.raw.prepare("SELECT MAX(updated_height) h FROM holders WHERE chain='namada'").get().h).toBe(8343600);
    expect(health[0]).toMatchObject({ name: 'Namada RPC (balance listing)', ok: true });
    expect(health[0].note).toMatch(/; heights above 8,353,600 \(past the head this tick's answers agree on\) set aside: the last listing's 999,999,950, 2 rows re-stamped$/);
    await runStmts(db, [stmt.namadaBalance({ address: A, balance: '123', height: 8343601 } as any, NOW + 3 * H)]);
    expect(row(db, A)).toMatchObject({ balance: '123', updated_height: 8343601 });
    // An older listing is refused again by the new floor.
    const older = (await runBalanceListing(env(db), [], NOW + 4 * H, {}, balLister(8343550, 'SLOW'), LISTING_WRITE_CAP, ctxOf([st(8343620), st(8343620)])))!;
    expect(older.error).toBe('Not applied: the balance listing is from height 8,343,550, older than the one already applied (8,343,600)');
  });

  it('on a head both nodes agree on, a row stamped far above it (a lone node\'s block) is re-stamped and corrected by the listing', async () => {
    const db = testD1();
    await runBalanceListing(env(db), [], NOW, {}, balLister(R, 'HONEST'), LISTING_WRITE_CAP, ctxOf([st(R), st(R)], R));
    await runStmts(db, [stmt.namadaBalance({ address: A, balance: '1', height: R + 5_000 } as any, NOW + 20 * 60000)]);
    const health: any[] = [];
    const rec = (await runBalanceListing(env(db), health, NOW + H, {}, balLister(R + 400, 'HONEST'), LISTING_WRITE_CAP, ctxOf([st(R + 400), st(R + 400)], R + 398)))!;
    expect(rec.error).toBeUndefined();
    expect(rec.unpinned).toBe(1);
    expect(row(db, A)).toMatchObject({ balance: users[A], updated_height: R + 400 });
    await runStmts(db, [stmt.namadaBalance({ address: A, balance: '5', height: R + 401 } as any, NOW + H + 60000)]);
    expect(row(db, A)).toMatchObject({ balance: '5', updated_height: R + 401 });
  });

  it('two answers that agree on a head a few hundred blocks below the stored height do not set it aside: no rollback', async () => {
    // A node stuck behind without saying it is catching up, and an indexer lagging as far, agree with each other.
    // The stored height and the rows stamped near it are a little above that head, not past any answer: they stay,
    // and the older listing is refused, as before the review.
    const db = testD1();
    await runBalanceListing(env(db), [], NOW, {}, balLister(8343400, 'HONEST'), LISTING_WRITE_CAP, ctxOf([st(8343400), st(8343400)], 8343390));
    await runStmts(db, [stmt.namadaBalance({ address: A, balance: '777', height: 8343450 } as any, NOW + 60_000)]);
    const behind = (await runBalanceListing(env(db), [], NOW + H, {}, balLister(8343250, 'STUCK'), LISTING_WRITE_CAP, ctxOf([{ error: 'down' }, st(8343250)], 8343248)))!;
    expect(behind.error).toBe('Not applied: the balance listing is from height 8,343,250, older than the one already applied (8,343,400)');
    expect(behind.unpinned ?? 0).toBe(0);
    expect(row(db, A)).toMatchObject({ balance: '777', updated_height: 8343450 });
  });

  it('two honest nodes far apart: with no indexer nothing is applied; with the indexer at the leader the laggard is refused', async () => {
    const db = testD1();
    await runBalanceListing(env(db), [], NOW, {}, balLister(8363400, 'LEADER'), LISTING_WRITE_CAP, ctxOf([st(8363400), st(8343400)], 8363390));
    const lag = (await runBalanceListing(env(db), [], NOW + H, {}, balLister(8343500, 'LAGGARD'), LISTING_WRITE_CAP, ctxOf([st(8363900), st(8343500)])))!;
    expect(lag.error).toBe(NO_HEAD);
    const behind = (await runBalanceListing(env(db), [], NOW + 2 * H, {}, balLister(8343500, 'LAGGARD'), LISTING_WRITE_CAP, ctxOf([st(8363900), st(8343500)], 8363890)))!;
    expect(behind.error).toBe('Not applied: the balance listing is from height 8,343,500, older than the one already applied (8,363,400)');
    expect(row(db, A).updated_height).toBe(8363400);
  });

  it('a node restored from an old snapshot (catching up) with the other node and the indexer down: its listing is refused, the rows stay', async () => {
    const db = testD1();
    await runBalanceListing(env(db), [], NOW, {}, balLister(8343300, 'HONEST'), LISTING_WRITE_CAP, ctxOf([st(8343300), st(8343300)], 8343290));
    const stale = (await runBalanceListing(env(db), [], NOW + H, {}, forged(8318300), LISTING_WRITE_CAP, ctxOf([{ error: 'down' }, st(8318300, true)])))!;
    expect(stale.error).toBe(NO_HEAD);
    const both = (await runBalanceListing(env(db), [], NOW + 2 * H, {}, forged(8318300), LISTING_WRITE_CAP, ctxOf([st(8318300, true), st(8318300, true)], 8343360)))!;
    expect(both.error).toBe(NO_HEAD);
    expect(row(db, A)).toMatchObject({ balance: users[A], updated_height: 8343300 });
    expect(stale.unpinned).toBeUndefined();
  });

  it('the bond listing: stakes rows from a far-future height are re-stamped and corrected on an agreed head', async () => {
    const db = testD1();
    await runBondListing(env(db), [], NOW, 2690, {}, bondLister(8343327, 'HONEST'), LISTING_WRITE_CAP, ctxOf([st(8343327), st(8343327)]));
    const g = parseBondListing(BONDS.value);
    const [S, src] = [...g.sources.entries()].filter(([, v]) => v.bondedBase > 0n).sort(([a], [b]) => (a < b ? -1 : 1))[0];
    g.sources.set(S, { ...src, bondedBase: src.bondedBase + 1_000_000n });
    const lie = (await runBondListing(env(db), [], NOW + H, 2691, {}, async () => ({ ...g, height: FAR, provider: 'EVIL' }), LISTING_WRITE_CAP, {}))!;
    expect(lie.height).toBe(FAR);
    const srow = () => db.raw.prepare('SELECT bonded_num, verified_height FROM stakes WHERE address=?').get(S);
    expect(srow().verified_height).toBe(FAR);
    const lone = (await runBondListing(env(db), [], NOW + 2 * H, 2692, {}, bondLister(8343500, 'HONEST'), LISTING_WRITE_CAP, ctxOf([st(8343500)])))!;
    expect(lone.error).toBe("Not applied: no two of this tick's answers agree on the chain's head, so the bond listing's height cannot be checked");
    expect(srow().verified_height).toBe(FAR);
    const healed = (await runBondListing(env(db), [], NOW + 3 * H, 2692, {}, bondLister(8343500, 'HONEST'), LISTING_WRITE_CAP, ctxOf([st(8343500), st(8343500)], 8343498)))!;
    expect(healed.error).toBeUndefined();
    expect(healed).toMatchObject({ height: 8343500, unpinned: 1 });
    expect(srow()).toMatchObject({ verified_height: 8343500 });
    expect(srow().bonded_num).toBeCloseTo(Number(src.bondedBase) / 1e6, 6);
  });
});

// ---------------------------------------------------------------- the counts a short answer is checked against

/** The fixture's borsh answer with every key listed twice: the same balances, sum and minted key. */
function duplicatedKeys(): string {
  const bytes = Buffer.from(BAL.value, 'base64');
  const n = bytes.readUInt32LE(0);
  const head = Buffer.alloc(4); head.writeUInt32LE(n * 2, 0);
  return Buffer.concat([head, bytes.subarray(4), bytes.subarray(4)]).toString('base64');
}
/** The fixture with A's NAM moved to B and `pad` keys of addresses holding nothing: the sums pass, the key count is inflated. */
const padded = (height: number, pad: number) => async () => {
  const f = parseBalanceListing(BAL.value);
  f.entries.set(B, (BigInt(users[A]) + BigInt(users[B])).toString());
  f.entries.set(A, '0');
  for (let i = 0; i < pad; i++) f.entries.set(`tnam1qpadding${String(i).padStart(4, '0')}`, '0');
  return { ...f, keys: f.keys + pad, height, provider: 'EVIL' };
};
const short = (height: number, provider: string, drop: number) => async () => {
  const f = parseBalanceListing(BAL.value);
  const zeros = [...f.entries].filter(([, v]) => v === '0').slice(0, drop).map(([a]) => a);
  for (const a of zeros) f.entries.delete(a);
  return { ...f, keys: f.keys - zeros.length, height, provider };
};

describe('a key or bond entry listed twice', () => {
  it('refuses the answer: a prefix read lists each key once, and a repeat would only inflate the counts', () => {
    const real = parseBalanceListing(BAL.value);
    expect(real.keys).toBe(real.entries.size + real.internal.size + 1);
    expect(() => parseBalanceListing(duplicatedKeys())).toThrow(/^balance listing: key 28 \(.+\) is listed twice$/);
    const bytes = Buffer.from(BONDS.value, 'base64');
    const n = bytes.readUInt32LE(0);
    const head = Buffer.alloc(4); head.writeUInt32LE(n * 2, 0);
    expect(() => parseBondListing(Buffer.concat([head, bytes.subarray(4), bytes.subarray(4)]).toString('base64'))).toThrow(/^bond listing: entry \d+ \(tnam1.+ to tnam1.+\) is listed twice$/);
    expect(parseBondListing(BONDS.value).entries).toBe(n);
  });
});

describe('the count a short answer is checked against', () => {
  it('is set aside with the stored height: the far-future floor of a padded answer does not refuse the healing listing', async () => {
    const db = testD1();
    await runBalanceListing(env(db), [], NOW, {}, balLister(8343304, 'HONEST'), LISTING_WRITE_CAP, ctxOf([st(8343304), st(8343304)], 8343300));
    const lie = (await runBalanceListing(env(db), [], NOW + H, {}, padded(FAR, 28), LISTING_WRITE_CAP, {}))!;
    expect(lie).toMatchObject({ height: FAR, keys: 56 });
    const healed = (await runBalanceListing(env(db), [], NOW + 3 * H, {}, balLister(8343600, 'HONEST'), LISTING_WRITE_CAP, ctxOf([st(999_999_900), st(8343600)], 8343598)))!;
    expect(healed.error).toBeUndefined();
    expect(healed).toMatchObject({ height: 8343600, keys: 28, unpinned: 2 });
    expect(row(db, A)).toMatchObject({ balance: users[A], updated_height: 8343600 });
  });

  it('a padded answer at the head sets no floor for good: another node\'s smaller count is applied once a second answer confirms it', async () => {
    const db = testD1();
    const supplyBase = BigInt(BAL.expected.minted);
    const at = (h: number) => ({ ...ctxOf([st(h), st(h)], h - 2), supplyBase });
    await runBalanceListing(env(db), [], NOW, {}, balLister(R, 'HONEST'), LISTING_WRITE_CAP, at(R));
    // a node at the head serves a listing padded with 28 keys of addresses holding nothing (every sum passes)
    const lie = (await runBalanceListing(env(db), [], NOW + H, {}, padded(R + 300, 28), LISTING_WRITE_CAP, at(R + 300)))!;
    expect(lie).toMatchObject({ keys: 56, provider: 'EVIL' });
    expect(lie.error).toBeUndefined();
    // the next honest listing is short against it: refused once, and its count kept to be confirmed
    const first = (await runBalanceListing(env(db), [], NOW + 2 * H, {}, balLister(R + 1340, 'HONEST'), LISTING_WRITE_CAP, at(R + 1340)))!;
    expect(first.error).toBe("Not applied: the listing has 28 keys, under 90% of the last one's 56");
    expect(first.smaller).toEqual({ count: 28, provider: 'HONEST', at: NOW + 2 * H });
    // a second answer within 1% of it (another tick, either node) is applied, and the forged balances are replaced
    const second = (await runBalanceListing(env(db), [], NOW + 2 * H + 5 * 60000, {}, balLister(R + 1380, 'HONEST'), LISTING_WRITE_CAP, at(R + 1380)))!;
    expect(second.error).toBeUndefined();
    expect(second).toMatchObject({ keys: 28, completeAt: NOW + 2 * H + 5 * 60000, failures: 0 });
    expect(second.smaller).toBeUndefined();
    expect(row(db, A).balance).toBe(users[A]);
    expect(row(db, B).balance).toBe(users[B]);
  });

  it('still refuses a short answer: from the node that set the count, once from another node, and one no second answer confirms', async () => {
    const db = testD1();
    await runBalanceListing(env(db), [], NOW, {}, balLister(R, 'HONEST'), LISTING_WRITE_CAP, ctxOf([st(R), st(R)], R));
    const same = (await runBalanceListing(env(db), [], NOW + H, {}, short(R + 500, 'HONEST', 4), LISTING_WRITE_CAP, ctxOf([st(R + 500), st(R + 500)], R + 500)))!;
    expect(same.error).toBe("Not applied: the listing has 24 keys, under 90% of the last one's 28");
    expect(same.smaller).toBeUndefined();
    const once = (await runBalanceListing(env(db), [], NOW + 2 * H, {}, short(R + 1000, 'TRUNC', 4), LISTING_WRITE_CAP, ctxOf([st(R + 1000), st(R + 1000)], R + 1000)))!;
    expect(once.error).toBe("Not applied: the listing has 24 keys, under 90% of the last one's 28");
    expect(once.smaller).toEqual({ count: 24, provider: 'TRUNC', at: NOW + 2 * H });
    // a second short answer more than 1% off the first does not confirm it, and waits in its place
    const other = (await runBalanceListing(env(db), [], NOW + 3 * H, {}, short(R + 1500, 'TRUNC', 3), LISTING_WRITE_CAP, ctxOf([st(R + 1500), st(R + 1500)], R + 1500)))!;
    expect(other.error).toBe("Not applied: the listing has 25 keys, under 90% of the last one's 28");
    expect(other.smaller).toEqual({ count: 25, provider: 'TRUNC', at: NOW + 3 * H });
    expect(kv<BalanceListingRecord>(db, 'balance.listing')).toMatchObject({ height: R, keys: 28 });
    // a full answer is applied as before and clears the count waiting for confirmation
    const full = (await runBalanceListing(env(db), [], NOW + 4 * H, {}, balLister(R + 2000, 'TRUNC'), LISTING_WRITE_CAP, ctxOf([st(R + 2000), st(R + 2000)], R + 2000)))!;
    expect(full.error).toBeUndefined();
    expect(full.smaller).toBeUndefined();
  });

  it('the bond twin: sources with no bond left inflate the count once; the honest listing is applied once confirmed', async () => {
    const db = testD1();
    await runBondListing(env(db), [], NOW, 2690, {}, bondLister(R, 'HONEST'), LISTING_WRITE_CAP, ctxOf([st(R), st(R)], R));
    const g = parseBondListing(BONDS.value);
    const n = g.sources.size;
    const template = [...g.sources.values()][0];
    for (let i = 0; i < n; i++) g.sources.set(`tnam1qfake${String(i).padStart(4, '0')}`, { ...template, bondedBase: 0n, grossBase: 0n, slashedBase: 0n, delegations: [] });
    const lie = (await runBondListing(env(db), [], NOW + H, 2691, {}, async () => ({ ...g, height: R + 300, provider: 'EVIL' }), LISTING_WRITE_CAP, ctxOf([st(R + 300), st(R + 300)], R + 298)))!;
    expect(lie).toMatchObject({ sources: 2 * n });
    const first = (await runBondListing(env(db), [], NOW + 2 * H, 2692, {}, bondLister(R + 820, 'HONEST'), LISTING_WRITE_CAP, ctxOf([st(R + 820), st(R + 820)], R + 818)))!;
    expect(first.error).toBe(`Not applied: the listing names ${n} sources, under 90% of the last one's ${2 * n}`);
    expect(first.smaller).toEqual({ count: n, provider: 'HONEST', at: NOW + 2 * H });
    const second = (await runBondListing(env(db), [], NOW + 2 * H + 5 * 60000, 2692, {}, bondLister(R + 860, 'HONEST'), LISTING_WRITE_CAP, ctxOf([st(R + 860), st(R + 860)], R + 858)))!;
    expect(second.error).toBeUndefined();
    expect(kv<BondListingRecord>(db, 'bond.listing')).toMatchObject({ sources: n, height: R + 860 });
  });
});

// ---------------------------------------------------------------- the real tick

const u256 = (n: bigint) => { const b = new Uint8Array(32); let v = n; for (let i = 0; i < 32; i++) { b[i] = Number(v & 0xffn); v >>= 8n; } return btoa(String.fromCharCode(...b)); };
const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
type Node = number | { height: number; catchingUp?: boolean; network?: string; status?: 'fails' } | null;
/**
 * Each node answers its status 50 blocks under its height (or as given) and every ABCI read at its height; null: the
 * node is down. The indexer answers its latest block, or is down. `calls` collects every URL asked.
 */
function network(nodes: { fiveElements: Node; papadritta: Node; indexer: number | null }) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('indexer.namada.net') && url.includes('/chain/block/latest')) return nodes.indexer ? json({ block: String(nodes.indexer) }) : new Response('down', { status: 503 });
    const raw = url.includes('5elementsnodes') ? nodes.fiveElements : url.includes('papadritta') ? nodes.papadritta : undefined;
    if (raw === undefined) return new Response('not here', { status: 404 });
    if (raw === null) throw new TypeError('fetch failed: connection refused');
    const n = typeof raw === 'number' ? { height: raw, statusHeight: raw - 50 } : { ...raw, statusHeight: raw.height };
    if (url.includes('/status')) {
      if ('status' in n && n.status === 'fails') return new Response('busy', { status: 503 });
      return json({ result: { ...('network' in n && n.network ? { node_info: { network: n.network } } : {}), sync_info: { latest_block_height: String(n.statusHeight), latest_block_time: new Date().toISOString(), catching_up: 'catchingUp' in n ? !!n.catchingUp : false, earliest_block_height: '1' } } });
    }
    if (url.includes('abci_query')) {
      const path = decodeURIComponent(url.split('path=')[1] ?? '');
      const value = path.includes('/shell/epoch') ? btoa(String.fromCharCode(155, 10, 0, 0, 0, 0, 0, 0))
        : path.includes('/shell/prefix/') ? BAL.value
        : path.includes('balance/minted') ? u256(BigInt(BAL.expected.minted))
        : u256(1000000n);
      return json({ result: { response: { code: 0, value, height: String(n.height) } } });
    }
    return new Response('not here', { status: 404 });
  }));
  return calls;
}
async function tick(db: TestD1, start: number) {
  vi.useFakeTimers({ now: start, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  let done = false;
  let err: unknown = null;
  runCron({ DB: db, KEPLR_KEY: 'k' } as any).catch((e) => { err = e; }).finally(() => { done = true; });
  for (let i = 0; !done && i < 4000; i++) await vi.advanceTimersByTimeAsync(250);
  vi.useRealTimers();
  if (err) throw err;
  expect(done).toBe(true);
}
const PLAIN = Date.parse('2026-10-17T22:41:05Z');
const NEW_HOLDER = 'tnam1qzzzznewholderfromtheday00000000000000';
/** Due: the balance listing (its last pass an interval ago); not due: the bond listing (complete a minute ago). Rows last written by `src`. */
function seeded(listingHeight: number, rowHeight: number, provider = 'Papadritta', src = BALANCE_LISTING_SRC) {
  const db = testD1();
  insert(db, 'holders', Object.entries(users).filter(([, v]) => v !== '0').map(([address, balance]) => ({ chain: 'namada', address, balance, balance_num: Number(BigInt(balance)) / 1e6, updated_height: rowHeight, updated_at: PLAIN - H, verified_at: PLAIN - H, verified_src: src })));
  const at = PLAIN - BALANCE_LISTING_MS - 60000;
  const bal: BalanceListingRecord = { at, completeAt: at, height: listingHeight, provider, keys: 28, holders: 18, totalNam: 0, bytes: 0, written: 0, zeroed: 0, remaining: 0, ticks: 1, durationMs: 0, spansAt: at, extendedAt: at };
  insert(db, 'kv', [
    { key: 'balance.listing', value: JSON.stringify(bal), updated_at: at },
    { key: 'bond.listing', value: JSON.stringify({ at: PLAIN - 60000, completeAt: PLAIN - 60000, height: 8343300, epoch: 2690, provider: 'Papadritta', sources: 48, stakers: 12, totalNam: 75, bytes: 0, written: 0, zeroed: 0, remaining: 0, ticks: 1, durationMs: 0 }), updated_at: PLAIN - 60000 },
  ]);
  return db;
}
const healthOf = (db: TestD1) => JSON.parse(db.raw.prepare("SELECT value FROM kv WHERE key='source.health'").get().value);
const listingReads = (calls: string[]) => calls.filter((u) => decodeURIComponent(u).includes('/shell/prefix/'));
const maxHeight = (db: TestD1) => db.raw.prepare("SELECT MAX(updated_height) h FROM holders WHERE chain='namada'").get().h;

describe('the cron tick', () => {
  it('a node reporting a far-future head with the other node and the indexer at the real one: its listing is refused, nothing is stamped above the head', async () => {
    // The lying node served the last listing, so it is asked first (listingRpcs).
    const db = seeded(8343300, 8343300, '5ElementsNodes');
    network({ fiveElements: FAR, papadritta: 8343400, indexer: 8343390 });
    await tick(db, PLAIN);
    const rec = kv<BalanceListingRecord>(db, 'balance.listing');
    expect(rec.error).toBe('Not applied: the balance listing is from height 999,999,950, ahead of the head (8,343,350)');
    expect(rec).toMatchObject({ height: 8343300, refusedProvider: '5ElementsNodes' });
    expect(maxHeight(db)).toBeLessThan(8343500);
    expect(db.raw.prepare("SELECT updated_height FROM holders WHERE address = ?").get(NAMADA.internal.pos).updated_height).toBeNull();
  });

  it('a D1 already holding a far-future floor heals on the first tick whose answers agree on the real head', async () => {
    const db = seeded(FAR, FAR);
    network({ fiveElements: 8343400, papadritta: 8343400, indexer: 8343390 });
    await tick(db, PLAIN);
    const rec = kv<BalanceListingRecord>(db, 'balance.listing');
    expect(rec.error).toBeUndefined();
    expect(rec).toMatchObject({ height: 8343400, completeAt: PLAIN, unpinned: 18 });
    expect(maxHeight(db)).toBe(8343400);
    // the internal accounts' heights are stored on an agreed head
    expect(db.raw.prepare("SELECT updated_height FROM holders WHERE address = ?").get(NAMADA.internal.pos).updated_height).toBe(8343400);
  });

  it('a node up to 10,000 blocks above the other node and the indexer: its listing is refused, and an hour later the honest one is applied', async () => {
    const db = seeded(8343300, 8343300, '5ElementsNodes', 'node');
    network({ fiveElements: R + 9_950, papadritta: R, indexer: R - 10 });
    await tick(db, PLAIN);
    const rec = kv<BalanceListingRecord>(db, 'balance.listing');
    expect(rec.error).toBe('Not applied: the balance listing is from height 8,353,350, ahead of the head (8,343,350)');
    expect(maxHeight(db)).toBe(8343300);
    // keep the bond listing from taking the next tick's turn
    db.raw.prepare("UPDATE kv SET value = json_set(value, '$.at', ?) WHERE key = 'bond.listing'").run(PLAIN + 61 * 60000);
    network({ fiveElements: R + 500, papadritta: R + 500, indexer: R + 490 });
    await tick(db, PLAIN + 61 * 60000);
    const rec2 = kv<BalanceListingRecord>(db, 'balance.listing');
    expect(rec2.error).toBeUndefined();
    expect(rec2).toMatchObject({ height: R + 500, completeAt: PLAIN + 61 * 60000 });
  });

  for (const [what, five] of [
    ['fails', { height: R + 9_000, status: 'fails' as const }],
    ['names another chain', { height: R + 9_000, network: 'other-chain-1' }],
  ] as const) {
    it(`the other node down and 5ElementsNodes' status ${what}: the indexer alone is no head, no listing is read, and the record backs off`, async () => {
      const db = seeded(8343300, 8343300, 'Papadritta');
      const calls = network({ fiveElements: five, papadritta: null, indexer: R });
      await tick(db, PLAIN);
      expect(listingReads(calls)).toHaveLength(0);
      if (what === 'names another chain') expect(calls.filter((u) => u.includes('5elementsnodes') && u.includes('abci_query'))).toHaveLength(0);
      const rec = kv<BalanceListingRecord>(db, 'balance.listing');
      expect(rec).toMatchObject({ height: 8343300, failedAt: PLAIN, failures: 1 });
      expect(rec.error).toMatch(/^Not applied: no two of this tick's answers agree on the chain's head \(5ElementsNodes: (no answer|names another chain); Papadritta: no answer; the indexer 8343400\)$/);
      expect(healthOf(db)['Namada RPC (balance listing)']).toMatchObject({ ok: false });
      expect(healthOf(db)['Namada RPC (balance listing)'].note).toMatch(/^Not read this tick: no two of this tick's answers agree on the chain's head/);
      expect(maxHeight(db)).toBe(8343300);
      // an internal account's read is stored without a height none of the answers agreed on
      const pos = db.raw.prepare("SELECT updated_height FROM holders WHERE address = ?").get(NAMADA.internal.pos);
      expect(pos?.updated_height ?? null).toBeNull();
    });
  }

  it('a node restored from a two-day-old snapshot (catching up), the other node and the indexer down: nothing is rolled back', async () => {
    const REAL = 8343300, STALE = REAL - 25_000;
    const db = seeded(REAL, REAL);
    insert(db, 'holders', [{ chain: 'namada', address: NEW_HOLDER, balance: '5000000000', balance_num: 5000, updated_height: REAL + 40, updated_at: PLAIN - H, first_seen: PLAIN - H }]);
    const calls = network({ fiveElements: null, papadritta: { height: STALE, catchingUp: true }, indexer: null });
    await tick(db, PLAIN);
    expect(listingReads(calls)).toHaveLength(0);
    expect(kv<BalanceListingRecord>(db, 'balance.listing')).toMatchObject({ height: REAL, failures: 1 });
    expect(maxHeight(db)).toBe(REAL + 40);
    expect(db.raw.prepare('SELECT balance, updated_height FROM holders WHERE address=?').get(NEW_HOLDER)).toMatchObject({ balance: '5000000000', updated_height: REAL + 40 });
  });

  it('both nodes catching up from old snapshots while the indexer answers the real head: they do not vouch for each other', async () => {
    const REAL = 8343300, STALE = REAL - 25_000;
    const db = seeded(REAL, REAL);
    insert(db, 'holders', [{ chain: 'namada', address: NEW_HOLDER, balance: '5000000000', balance_num: 5000, updated_height: REAL + 40, updated_at: PLAIN - H, first_seen: PLAIN - H }]);
    const calls = network({ fiveElements: { height: STALE, catchingUp: true }, papadritta: { height: STALE, catchingUp: true }, indexer: REAL + 60 });
    await tick(db, PLAIN);
    expect(listingReads(calls)).toHaveLength(0);
    expect(kv<BalanceListingRecord>(db, 'balance.listing')).toMatchObject({ height: REAL, failures: 1 });
    expect(db.raw.prepare('SELECT balance, updated_height FROM holders WHERE address=?').get(NEW_HOLDER)).toMatchObject({ balance: '5000000000', updated_height: REAL + 40 });
  });
});
