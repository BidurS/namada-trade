// Security review (2026-10-22), user tags: pressure() put a receiver's bridged NAM in the Supply page's "Early
// backers, team and genesis addresses" cohort when the receiver's label, its Namada sender's label or the sender's
// upstream origin's label matched /genesis|backer|foundation|team/i, whatever wrote it, so one signed-in wallet's tag ('team wallet', 'steam')
// moved NAM into that cohort. And any tag on an untagged Namada sender took it out of the middle-address read, so
// NAM a genesis wallet routed through it left the cohort and the receiver lost the 0.1 its selling estimate gets
// for a middle address. A tag a signed-in wallet wrote never acts as a curated name (series.ts sideCategory,
// shared/labels.ts label_plain): it is now read as no label by both.
import { describe, it, expect } from 'vitest';
import { pressure } from '../worker/src/analytics';
import { stmt } from '../worker/src/db';
import { testD1, insert } from './d1-sqlite';

const NOW = Date.UTC(2026, 9, 22, 12, 0);
const H = 3600_000;
const R = 'osmo1recv_tagged', T = 'tnam1qsender_plain', B = 'tnam1qmiddle_burner', V = 'tnam1qgenesis_vault', U = 'tnam1qorigin_plain';
const AUTHOR = 'tnam1qtagger_wallet';

const crossing = (id: string, ts: number, from: string, to: string, nam: number) =>
  ({ id, chain: 'osmosis', height: 3, ts, tx_hash: id.toUpperCase(), kind: 'ibc_in', from_addr: from, to_addr: to, amount_num: nam, meta: null });
const transfer = (id: string, ts: number, from: string, to: string, nam: number) =>
  ({ id, chain: 'namada', height: 2, ts, tx_hash: id.toUpperCase(), kind: 'transfer', from_addr: from, to_addr: to, amount_num: nam, meta: null });
/** The tag exactly as POST /api/labels writes it (USER_TAG_CATEGORIES: 'watch' is the default). */
const tag = (db: any, address: string, label: string) => {
  const s = stmt.userTag(address, address.startsWith('osmo1') ? 'osmosis' : 'namada', label, 'watch', AUTHOR, null, NOW - H);
  return db.prepare(s.sql).bind(...s.params).run();
};
const cohorts = async (db: any) => (await pressure(db, NOW, false, 7)).pipelineSummary!.cohorts;

describe('a signed-in wallet\'s tag never puts NAM in the early-backers cohort', () => {
  it('a tag on the receiver ("team wallet") leaves its NAM where its sender puts it', async () => {
    const db = testD1();
    insert(db, 'flows', [crossing('o1', NOW - 20 * H, T, R, 300_000)]);
    expect(await cohorts(db)).toEqual({ genesisBackersNam: 0, maspTurnstileNam: 0, burnerHopNam: 0, transparentNam: 300_000 });
    await tag(db, R, 'team wallet');
    const p = await pressure(db as any, NOW, false, 7);
    expect(p.onDeck.find((e) => e.address === R)).toMatchObject({ label: 'team wallet', labelSource: 'user' });
    expect(p.pipelineSummary!.cohorts).toEqual({ genesisBackersNam: 0, maspTurnstileNam: 0, burnerHopNam: 0, transparentNam: 300_000 });
  });

  it('a tag on the Namada sender ("my team", "steam") does not either', async () => {
    for (const text of ['my team', 'steam', 'Genesis: af_backers']) {
      const db = testD1();
      insert(db, 'flows', [crossing('o1', NOW - 20 * H, T, R, 300_000)]);
      await tag(db, T, text);
      expect(await cohorts(db)).toEqual({ genesisBackersNam: 0, maspTurnstileNam: 0, burnerHopNam: 0, transparentNam: 300_000 });
    }
  });

  it('a tag on a middle address\'s upstream origin makes it a middle address, not early-backer NAM', async () => {
    const db = testD1();
    insert(db, 'flows', [transfer('h1', NOW - 4 * H, U, B, 300_000), crossing('b1', NOW - 2 * H, B, R, 300_000)]);
    expect(await cohorts(db)).toEqual({ genesisBackersNam: 0, maspTurnstileNam: 0, burnerHopNam: 300_000, transparentNam: 0 });
    await tag(db, U, 'foundation');
    expect(await cohorts(db)).toEqual({ genesisBackersNam: 0, maspTurnstileNam: 0, burnerHopNam: 300_000, transparentNam: 0 });
  });

  it('control: curated names still count (the genesis file\'s, and a curated label with those words)', async () => {
    const db = testD1();
    insert(db, 'labels', [{ address: R, chain: 'osmosis', label: 'Team treasury', category: 'team', source: 'auto' }]);
    insert(db, 'flows', [crossing('o1', NOW - 20 * H, T, R, 70_000)]);
    expect(await cohorts(db)).toMatchObject({ genesisBackersNam: 70_000, transparentNam: 0 });
  });
});

describe('a tag on a middle address does not hide the genesis wallet behind it', () => {
  async function routed(tagText: string | null) {
    const db = testD1();
    insert(db, 'labels', [{ address: V, chain: 'namada', label: 'Genesis: af_backers', category: 'backer', source: 'genesis' }]);
    insert(db, 'flows', [transfer('h1', NOW - 4 * H, V, B, 300_000), crossing('b1', NOW - 2 * H, B, R, 300_000)]);
    if (tagText) await tag(db, B, tagText);
    const p = await pressure(db as any, NOW, false, 7);
    return { p, e: p.onDeck.find((x) => x.address === R)! };
  }

  it('untagged (control): the genesis vault is the origin and its NAM is early-backer NAM', async () => {
    const { p, e } = await routed(null);
    expect(e.hopOriginNamada).toMatchObject({ address: V, label: 'Genesis: af_backers' });
    expect(p.pipelineSummary!.cohorts).toEqual({ genesisBackersNam: 300_000, maspTurnstileNam: 0, burnerHopNam: 0, transparentNam: 0 });
  });

  it('tagged "my wallet" by any signed-in wallet: the same origin, the same cohort, the same selling estimate', async () => {
    const base = await routed(null);
    const { p, e } = await routed('my wallet');
    expect(e).toMatchObject({ linkedNamada: B, linkedLabel: 'my wallet', linkedLabelSource: 'user' });
    expect(e.hopOriginNamada).toMatchObject({ address: V, label: 'Genesis: af_backers' });
    expect(p.pipelineSummary!.cohorts).toEqual({ genesisBackersNam: 300_000, maspTurnstileNam: 0, burnerHopNam: 0, transparentNam: 0 });
    expect(e.dumpHazardScore).toBe(base.e.dumpHazardScore);
  });

  it('a genesis-file origin whose name has none of the words (Heliax) is early-backer NAM, as it is when it sends directly', async () => {
    const db = testD1();
    insert(db, 'labels', [{ address: V, chain: 'namada', label: 'Heliax', category: 'foundation', source: 'genesis' }]);
    insert(db, 'flows', [transfer('h1', NOW - 4 * H, V, B, 300_000), crossing('b1', NOW - 2 * H, B, R, 300_000), crossing('d1', NOW - 20 * H, V, 'osmo1recv_direct', 50_000)]);
    expect(await cohorts(db)).toEqual({ genesisBackersNam: 350_000, maspTurnstileNam: 0, burnerHopNam: 0, transparentNam: 0 });
  });
});
