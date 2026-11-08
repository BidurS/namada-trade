// Migration 0020: the wallet that received the shielded pool's coins on 2026-06-18 labelled like the staking-account
// exploit of migration 0019 (source 'curated'), 0019's note on tnam1qry99h4f... kept to what the chain shows for that
// wallet, and the bond row the chain did not apply at block 8,202,488 taken out with what the daily job and the stake
// estimate counted from it. And the rule that keeps curated rows: no automatic writer replaces one (worker/src/db.ts
// stmt.label, stmt.genesisLabel, stmt.userTag), only another migration.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { testD1, insert, runStmts, type TestD1 } from './d1-sqlite';
import { stmt } from '../worker/src/db';
import { STAKE_ESTIMATES_SQL } from '../worker/src/cron';
import { BOND_LISTING_SRC } from '../worker/src/holders';
import { readDay, dayStmts } from '../worker/src/series';
import { INTERNAL_LABELS } from '../worker/src/config';
import { BANNED } from './banned-words';

const MIGRATION = readFileSync(join(__dirname, '..', 'migrations', '0020_drain_labels.sql'), 'utf8');
const POS = 'tnam1qgqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqc8j2fp';
const DRAIN = 'tnam1qqmr0e209af2eqr0n4w6fq44a6udrhvcvqraa8h4';
const EXPLOIT = 'tnam1qry99h4faqtkleuuyecxzrswq7vgkj2hu5kg6dqp';
const NOT_APPLIED = 'namada:8D515657565D2D26ABE13CCA578DACAF537B481F97FBEA556763D19195E77322:pos';
const DAY = '2026-10-08';

const label = (db: TestD1, address: string) =>
  db.raw.prepare('SELECT chain, label, category, source, note, author FROM labels WHERE address = ?').get(address) as Record<string, unknown> | undefined;

describe('migration 0020: the shielded-pool drain of 2026-06-18', () => {
  it('labels the wallet the six transfers paid as a curated exploit row, beside the four of 0019, and nothing on Osmosis', () => {
    const db = testD1();
    const curated = db.raw.prepare("SELECT address FROM labels WHERE source = 'curated' ORDER BY address").all().map((r: any) => r.address);
    expect(curated).toHaveLength(5);
    expect(curated).toEqual(expect.arrayContaining([DRAIN, EXPLOIT]));
    expect(label(db, DRAIN)).toMatchObject({ chain: 'namada', label: 'Shielded pool drain, 2026-06-18', category: 'exploit', source: 'curated', author: null });
    // 0020 labels nothing on Osmosis: the two Osmosis rows are 0019's
    expect((db.raw.prepare("SELECT COUNT(*) n FROM labels WHERE source = 'curated' AND chain = 'osmosis'").get() as any).n).toBe(2);
    // the note, exactly: the coins, amounts and blocks block_results show, and that none of the six moved NAM
    expect(String(label(db, DRAIN)!.note)).toBe('Received six transfers out of the shielded pool on 2026-06-18 (blocks 6,966,393-6,966,885, 09:13-10:09 UTC): 150,355.82 USDC (Noble), 228,517.65 ATOM, 43,998.77 OSMO, 236,743.11 NYM and 4,990.51 TIA. After the last transfer of each coin, the pool held none of it. None of the six moved NAM. Namada announced an exploit on 2026-06-20.');
  });

  it("rewords the 0019 note to what the chain shows for that wallet, with its balance dated", () => {
    const db = testD1();
    const note = String(label(db, EXPLOIT)!.note);
    expect(note).toBe('Took 332,386,683 NAM out of the staking account on 2026-08-31 (heights 7,900,823-7,900,866); shielded 50,000,000 NAM on 2026-09-01; received 9,999,997 NAM from the shielded pool on 2026-09-03; sent 289,385,685 NAM to the repayment wallet on 2026-09-03; still held 3,000,997.13 NAM at block 8,516,950 (2026-11-02).');
  });

  it('the notes it writes are in plain words and name what the chain shows, never a person', () => {
    const db = testD1();
    for (const a of [DRAIN, EXPLOIT]) {
      const note = String(label(db, a)!.note);
      expect(note, a).not.toMatch(BANNED);
      expect(note, a).not.toMatch(/attacker|hacker|thief/i);
    }
  });

  it("a wallet's tag on the address is kept, as 0019 keeps one", () => {
    const db = testD1();
    db.raw.prepare('DELETE FROM labels WHERE address = ?').run(DRAIN);
    insert(db, 'labels', [{ address: DRAIN, chain: 'namada', label: 'mine', category: 'watch', source: 'user', author: 'tnam1qauthor', updated_at: 1 }]);
    db.exec(MIGRATION);
    expect(label(db, DRAIN)).toMatchObject({ label: 'mine', source: 'user' });
  });
});

describe('migration 0020: the bond the chain rejected at block 8,202,488', () => {
  // The day as production held it on 2026-11-02: three NAM moves and the bond row the chain rejected.
  const DAY_FLOWS = [
    { id: 'namada:100E11111C0EF38626A55A0DBDDCE94E0C9524E8B3811548D2FB5CDB8F0336B7:0', height: 8202272, ts: 1791497653101, tx_hash: '100E11111C0EF38626A55A0DBDDCE94E0C9524E8B3811548D2FB5CDB8F0336B7', kind: 'transfer', from_addr: 'tnam1qxd6n2pfj6jucqnx2tf3feuevkqmr266gg06yurm', to_addr: 'tnam1qqe4hfhyy3ktls9drstpaqqm4z0cpsfvr53w7q3a', amount_num: 5, meta: JSON.stringify({ descriptor: 'transfer-from-wasm', innerTxHash: '88DF4782A1C9AAA05C5012F9323241C4E3B800875893F8C946C98E4B676F850B' }) },
    { id: 'namada:6B6D49FD07EEF692149006957521C222371461859BF420DBF0BFC16DCD45A3EC:0', height: 8202396, ts: 1791498503123, tx_hash: '6B6D49FD07EEF692149006957521C222371461859BF420DBF0BFC16DCD45A3EC', kind: 'rewards', from_addr: POS, to_addr: 'tnam1qrkg60aq0352mcnvszge866tcgy8q5rddcdccwz0', amount_num: 483.437169, meta: JSON.stringify({ descriptor: 'pos-claim-rewards', innerTxHash: '95B69F8CE916C601233D3384F83D37A19D99E8FC2915FBFE440201D6270BD74E' }) },
    { id: 'namada:21895361158A2A13963F1B7FFC1F143BF2DB75A84A900BCE337EEAFCAEE50F01:0', height: 8202416, ts: 1791498640106, tx_hash: '21895361158A2A13963F1B7FFC1F143BF2DB75A84A900BCE337EEAFCAEE50F01', kind: 'rewards', from_addr: POS, to_addr: 'tnam1qrkg60aq0352mcnvszge866tcgy8q5rddcdccwz0', amount_num: 1912.376243, meta: JSON.stringify({ descriptor: 'pos-claim-rewards', innerTxHash: '81088EE7734D3B41CC0A1F75B0E00D496D42E243EB0C2622466BD5CCABC8729A' }) },
    { id: NOT_APPLIED, height: 8202488, ts: 1791499160810, tx_hash: '8D515657565D2D26ABE13CCA578DACAF537B481F97FBEA556763D19195E77322', kind: 'bond', from_addr: POS, to_addr: POS, amount_num: 0.00001, meta: JSON.stringify({ source: 'namada-indexer', txKind: 'bond', validator: 'tnam1q8s9kj30dhsnw5kvtf0mq2exgyup64l28sxn953p', wrapper: 'e953e69af1027aef7bc467c9e86a400ae226744ccc10203a67c685ea5bf2ccce', tsSource: 'interpolated' }) },
  ].map((f) => ({ chain: 'namada', ...f }));
  const MARK = Date.parse('2026-11-02T18:42:00Z');

  /** A database holding the day, its daily rows as the daily job wrote them, the stake estimate and a clean count. */
  async function production() {
    const db = testD1();
    insert(db, 'flows', DAY_FLOWS);
    await runStmts(db, dayStmts(DAY, await readDay(db as any, DAY)));
    db.raw.prepare(STAKE_ESTIMATES_SQL).run(MARK - 3_600_000);
    // the bond listing never names the staking account as a source, so it set the chain's figure to 0
    await runStmts(db, stmt.stakesVerified([{ address: POS, bondedNam: 0, delegations: [] }], 2700, 8_400_000, MARK - 1000, BOND_LISTING_SRC));
    db.raw.prepare('UPDATE flow_count_mark SET mark = ?, dirty = 0, at = ? WHERE id = 1').run(MARK, MARK);
    return db;
  }
  const activity = (db: TestD1) => db.raw.prepare("SELECT flows, senders, receivers, active, nam FROM activity_daily WHERE day = ? AND chain = 'namada'").get(DAY) as any;
  const edges = (db: TestD1) => db.raw.prepare("SELECT kind, from_cat, to_cat, n, nam FROM flow_edges_daily WHERE day = ? AND chain = 'namada' ORDER BY kind, from_cat, to_cat").all(DAY) as any[];
  const stake = (db: TestD1) => db.raw.prepare('SELECT bonded_num, estimated_num FROM stakes WHERE address = ?').get(POS) as any;

  it('before: the row is one flow of the day, the edge from pos to pos alone, and the staking account\'s estimate', async () => {
    const db = await production();
    expect(activity(db)).toMatchObject({ flows: 4, senders: 1, receivers: 2, active: 3 });
    expect(activity(db).nam).toBeCloseTo(2400.813422, 9);
    expect(edges(db).find((e) => e.kind === 'bond')).toMatchObject({ from_cat: 'pos', to_cat: 'pos', n: 1, nam: 0.00001 });
    expect(stake(db)).toEqual({ bonded_num: 0, estimated_num: 0.00001 });
  });

  it('after: the row is gone and every figure counted from it is what the cron\'s own code computes from the rows left', async () => {
    const db = await production();
    db.exec(MIGRATION);
    expect(db.raw.prepare('SELECT COUNT(*) n FROM flows WHERE id = ?').get(NOT_APPLIED)).toEqual({ n: 0 });
    expect((db.raw.prepare('SELECT COUNT(*) n FROM flows').get() as any).n).toBe(3);
    // the day: as the daily job writes it now
    const now = await readDay(db as any, DAY);
    const a = now.activity.find((x) => x.chain === 'namada')!;
    expect(activity(db)).toMatchObject({ flows: a.flows, senders: a.senders, receivers: a.receivers, active: a.active });
    expect(activity(db).flows).toBe(3);
    expect(activity(db).nam).toBeCloseTo(a.nam, 9);
    expect(activity(db).nam).toBeCloseTo(2400.813412, 9);
    const want = now.edges.filter((e) => e.chain === 'namada').map(({ kind, from_cat, to_cat, n, nam }) => ({ kind, from_cat, to_cat, n, nam }))
      .sort((x, y) => `${x.kind}|${x.from_cat}|${x.to_cat}`.localeCompare(`${y.kind}|${y.from_cat}|${y.to_cat}`));
    expect(edges(db).map((e) => ({ ...e, nam: Number(e.nam.toFixed(6)) }))).toEqual(want.map((e) => ({ ...e, nam: Number(e.nam.toFixed(6)) })));
    expect(edges(db).some((e) => e.kind === 'bond')).toBe(false);
    // the estimate: unknown, not 0, and the hourly estimate leaves it so; the chain's figure stays
    expect(stake(db)).toEqual({ bonded_num: 0, estimated_num: null });
    db.raw.prepare(STAKE_ESTIMATES_SQL).run(MARK + 3_600_000);
    expect(stake(db)).toEqual({ bonded_num: 0, estimated_num: null });
    // the stored counts are marked for a recount (migration 0017's trigger)
    expect((db.raw.prepare('SELECT dirty FROM flow_count_mark WHERE id = 1').get() as any).dirty).toBe(1);
  });

  it('a second run, or a database without the row, changes nothing', async () => {
    const db = await production();
    db.exec(MIGRATION);
    db.raw.prepare('UPDATE flow_count_mark SET dirty = 0 WHERE id = 1').run();
    const before = { activity: activity(db), edges: edges(db), stake: stake(db) };
    db.exec(MIGRATION);
    expect({ activity: activity(db), edges: edges(db), stake: stake(db) }).toEqual(before);
    expect((db.raw.prepare('SELECT dirty FROM flow_count_mark WHERE id = 1').get() as any).dirty).toBe(0);
  });
});

describe('curated labels: only a migration changes one', () => {
  it('no automatic writer replaces a curated row: auto and pool labels, the genesis loader, a wallet\'s tag', async () => {
    const db = testD1();
    const before = label(db, DRAIN);
    await runStmts(db, [
      stmt.label(DRAIN, 'namada', 'Somebody', 'other', 'auto', null, 2),
      stmt.label(DRAIN, 'namada', 'Pool #1', 'pool', 'auto', null, 3),
      stmt.label(DRAIN, 'namada', 'Valoper', 'validator', 'valopers', null, 4),
      stmt.genesisLabel(DRAIN, 'Genesis: af_backers', 'backer', 'Genesis 1 NAM', 5),
      stmt.userTag(DRAIN, 'namada', 'mine', 'watch', 'tnam1qauthor', null, 6),
    ]);
    expect(label(db, DRAIN)).toEqual(before);
    expect(label(db, EXPLOIT)!.source).toBe('curated');
  });

  it('the protocol account labels the backfill writes leave every curated row as it is', async () => {
    const db = testD1();
    const curated = () => db.raw.prepare("SELECT * FROM labels WHERE source = 'curated' ORDER BY address").all();
    const before = curated();
    await runStmts(db, Object.entries(INTERNAL_LABELS).map(([a, l]) => stmt.label(a, a.startsWith('osmo') ? 'osmosis' : 'namada', l.label, l.category, 'auto', null, 7)));
    expect(curated()).toEqual(before);
  });

  it('control: an automatic label still replaces an automatic one, and a pool label a wallet\'s tag', async () => {
    const db = testD1();
    const A = 'tnam1q' + 'a'.repeat(39), P = 'osmo1' + 'p'.repeat(58);
    await runStmts(db, [stmt.label(A, 'namada', 'Old', 'other', 'auto', null, 1), stmt.label(A, 'namada', 'New', 'exchange', 'auto', null, 2)]);
    expect(label(db, A)).toMatchObject({ label: 'New', category: 'exchange', source: 'auto' });
    insert(db, 'labels', [{ address: P, chain: 'osmosis', label: 'mine', category: 'watch', source: 'user', author: 'osmo1author', updated_at: 1 }]);
    await runStmts(db, [stmt.label(P, 'osmosis', 'Osmosis Pool #3999 (NAM / OSMO)', 'pool', 'auto', null, 3)]);
    expect(label(db, P)).toMatchObject({ category: 'pool', source: 'auto', author: null });
  });
});
