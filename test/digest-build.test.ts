// Daily digest (2026-10-23): worker/src/digest/build.ts, the join of the digest's parts. figures.ts's output goes
// through the adapter into message.ts and gives the worked example of spec section 7 field by field; the orchestrator
// on the survey's rows seeded in the SQLite stand-in (as test/digest-figures-read.test.ts seeds them, plus the charts'
// stored series) gives the operator's posts with those figures, every attachment the embeds name and no other; a
// figure that was not read shows no figure; a subscriber's watchlist reaches that subscriber's posts only; and every
// post stays within Discord's limits. Nothing is fetched, nothing is posted; the addresses are fixture-shaped.
import { describe, expect, it } from 'vitest';
import { testD1, insert, type TestD1 } from './d1-sqlite';
import { fx, seedCharts, seedSurvey, readsFromSurvey, fixtureAddress, T, A24, A7 } from './digest-survey';
import {
  attentionMarks, bridgeLateOf, discordProblems, messageReason, postsFor, quoteSeriesSource, quoteSourceAt, readAndBuildDigest, referencedFiles,
  toMessageFigures, toMessageOperator, toMessageWatchLine, DIGEST_ATTN_FILE, DIGEST_AVATAR_URL, type DigestBuild, type DigestPost,
} from '../worker/src/digest/build';
import type { AttentionFigures } from '../worker/src/digest/attention';
import type { PriceHowLog } from '../worker/src/price-how';
import { digestWindow, shapeDigestFigures } from '../worker/src/digest/figures';
import { changeFrom, MINUTE_BOUND_MS } from '../worker/src/digest/freshness';
import {
  buildDigest, discordCount, messageCount, DIGEST_MESSAGE_MAX, DISCORD_DESCRIPTION_MAX, DISCORD_EMBEDS_MAX, DISCORD_FIELD_MAX,
  DISCORD_FIELDS_MAX, DISCORD_MESSAGE_MAX, DISCORD_TITLE_MAX, type Embed, type Mark, type MarkKey, MARK_ORDER,
} from '../worker/src/digest/message';
import { DB_NOT_ANSWERED, failed, notRead, type NotRead } from '../worker/src/digest/types';
import type { OperatorFigures } from '../worker/src/digest/operator';
import { BALANCE_LISTING_SRC } from '../worker/src/holders';

const H = 3600_000, MIN = 60_000;
const BALANCE_LISTING_AT = 1792741923099; // the survey's balance listing, 07:52:03 UTC
/** A subscriber's own wallet and two watched addresses, fixture-shaped (no such wallet exists). */
const WALLET = fixtureAddress('namada', 1, 'qwallet');
const TNAM = fixtureAddress('namada', 2, 'qdgst');
const OSMO = fixtureAddress('osmosis', 3, 'qdgst');

const field = (e: Embed, name: string): string => {
  const f = e.fields?.find((x) => x.name === name);
  if (!f) throw new Error(`no field ${name}: ${e.fields?.map((x) => x.name).join(', ')}`);
  return f.value;
};
const sources = (e: Embed): string[] => (e.fields ?? []).filter((f) => f.name.startsWith('Sources')).flatMap((f) => f.value.split(' · '));
const allText = (p: DigestPost): string => JSON.stringify(p.payload);
const titles = (p: DigestPost): string[] => p.payload.embeds.map((e) => e.title ?? '');

function seeded(): TestD1 {
  const db = testD1();
  seedSurvey(db);
  seedCharts(db);
  return db;
}

/** Two watched addresses: a Namada one 12,500 NAM lower than 24 h ago, an Osmosis one unchanged. */
function seedWatch(db: TestD1) {
  insert(db, 'holders', [
    { chain: 'namada', address: TNAM, balance: '1250000000000', balance_num: 1_250_000, updated_height: 8384388, updated_at: BALANCE_LISTING_AT, verified_at: BALANCE_LISTING_AT, verified_src: BALANCE_LISTING_SRC },
    { chain: 'osmosis', address: OSMO, balance: '2100000000', balance_num: 2_100, updated_height: null, updated_at: 1792741802657, verified_at: 1792741802657, verified_src: 'keplr' },
  ]);
  insert(db, 'balance_spans', [
    { chain: 'namada', address: TNAM, from_ts: A24 - 33 * MIN, to_ts: A24 + 27 * MIN, balance: '1262500000000', balance_num: 1_262_500, reads: 2 },
    { chain: 'namada', address: TNAM, from_ts: A24 + 2 * H, to_ts: BALANCE_LISTING_AT, balance: '1250000000000', balance_num: 1_250_000, reads: 20 },
    { chain: 'osmosis', address: OSMO, from_ts: A24 - 10 * H, to_ts: 1792741802657, balance: '2100000000', balance_num: 2_100, reads: 30 },
  ]);
}

/** Every attachment an embed names is a file of the post, and every file is named by an embed, in the attachments' order. */
function expectFilesMatch(p: DigestPost) {
  expect([...referencedFiles(p.payload.embeds)].sort()).toEqual(p.files.map((f) => f.name).sort());
  expect((p.payload.attachments ?? []).map((a) => a.filename)).toEqual(p.files.map((f) => f.name));
  expect((p.payload.attachments ?? []).map((a) => a.id)).toEqual(p.files.map((_, i) => i));
}

/** Discord's limits, counted here independently of discordProblems: embeds, fields, each part, the total, the files. */
function expectWithinDiscord(p: DigestPost) {
  expect(discordProblems(p)).toEqual([]);
  const embeds = p.payload.embeds;
  expect(embeds.length).toBeLessThanOrEqual(DISCORD_EMBEDS_MAX);
  let total = 0;
  for (const e of embeds) {
    expect((e.title ?? '').length).toBeLessThanOrEqual(DISCORD_TITLE_MAX);
    expect((e.description ?? '').length).toBeLessThanOrEqual(DISCORD_DESCRIPTION_MAX);
    expect((e.fields ?? []).length).toBeLessThanOrEqual(DISCORD_FIELDS_MAX);
    for (const f of e.fields ?? []) {
      expect(f.value.length, f.name).toBeLessThanOrEqual(DISCORD_FIELD_MAX);
      expect(f.name.length).toBeLessThanOrEqual(256);
    }
    total += (e.title ?? '').length + (e.description ?? '').length + (e.footer?.text.length ?? 0) + (e.fields ?? []).reduce((a, f) => a + f.name.length + f.value.length, 0);
  }
  expect(total).toBeLessThanOrEqual(DISCORD_MESSAGE_MAX);
  let bytes = new TextEncoder().encode(JSON.stringify(p.payload)).length;
  for (const f of p.files) {
    expect(f.bytes.length).toBeLessThan(8 * 1024 * 1024);
    bytes += f.bytes.length;
  }
  expect(bytes).toBeLessThan(25 * 1024 * 1024);
  expect(p.files.length).toBeLessThanOrEqual(10);
}

describe('the adapter on the survey\'s stored answers gives message.ts the worked example of section 7', () => {
  const reads = readsFromSurvey('daily');
  const f = shapeDigestFigures(reads, digestWindow(T, 'daily'));
  const q = (f.price as { value: { quote: { value: { at: number; value: number } } } }).value.quote.value;
  // the daily's 7 d base, as readAndBuildDigest reads it: latest('price.usd', A7)
  const priceWeek = changeFrom({ ts: q.at, value: q.value }, fx.instants['price.usd']['7d'], A7, MINUTE_BOUND_MS, null);
  const e = buildDigest(toMessageFigures(f, { priceWeek, bridgeLate: bridgeLateOf(reads) }), T, 'daily').shared;

  it('Staked NAM, the pipeline, rewards, price (with the daily\'s 7 d change), trades, bridge, shielded pool, holders, governance and validators read as section 7.1', () => {
    expect(field(e, 'Staked NAM')).toBe(
      'Total stake 267,774,764.27 NAM ¹ · 24 h: +467,207.00 NAM (+0.17 %) vs 267,307,557.27 at 07:59 UTC yesterday.\n' +
      '19,340 stakers (−2 / 24 h) with 246 validators ⁴.\n' +
      'Staking account 341,793,716.36 NAM ² (stake + unbonding + withdrawable + rewards) · 24 h: −720,267.35 NAM. ' +
      'On its way out or unclaimed: 74,018,952.09 NAM (the account less total stake).',
    );
    expect(field(e, 'Unbonding pipeline')).toBe(
      'Waiting to unlock (in flight): 181,962.02 NAM ⁴. Became withdrawable in the last 24 h (epochs 2,693–2,696): 0.00 NAM ⁴ ³; ' +
      'withdrawn in the 24 h: 1,170,000.00 NAM in 1 withdrawal (14:19 UTC yesterday) ³. ' +
      'Unlocking in the next 24 h (epochs 2,697–2,700): 0.00 NAM ⁴; next: 37,489.27 NAM (2 unbonds) at epoch 2,704, about 03:35 UTC on 25 Oct (± 10 min) ⁵. ' +
      'Withdrawable and not yet withdrawn: 36,859,599.85 NAM ⁴ (epochs 56–2,696).',
    );
    expect(field(e, 'Rewards claimed (24 h)')).toBe('17 claims, 3,250.15 NAM, largest 928.27 NAM ³.');
    expect(field(e, 'Price')).toBe('$0.00087359 ⁶ · 24 h +3.31 % (vs $0.00084557 at 07:59 UTC yesterday) · 7 d −13.97 % (vs $0.00101543, 16 Oct 07:59 UTC)');
    expect(field(e, 'Trades')).toBe(
      'Last executed hour 05:00 UTC: $0.00091650 from 1 trade ⁷; the quote is 4.68 % under it. ' +
      '24 h: 9 trades, 60,537.86 NAM (bought 29,284.64 / sold 31,253.22), $53.91 at the stored prices (1 at execution, 8 at the Osmosis quote of their minute), 4 traders ⁸. Osmosis data API 24 h: $41.74 ⁹. ' +
      // the depth store (2026-10-29) had no hour on 2026-10-23: one not-read line naming the store, no mark (no read to cite)
      "Depth: not read — no hour of this site's depth store is on record yet.",
    );
    expect(field(e, 'Bridge (24 h)')).toBe(
      'Namada → Osmosis 1,454.20 NAM (1 crossing). Osmosis → Namada 359,041.66 NAM (5 crossings, largest 259,041.66). ' +
      'Net +357,587.45 NAM to Namada ⁸. Escrow 20,832,856.30 NAM ¹⁰, −357,587.45 / 24 h (matches).',
    );
    expect(field(e, 'Shielded pool (24 h)')).toBe(
      'In 100,003.00 NAM (4 shielded IBC deposits, 2 shieldings). Out 3.28 NAM (4 unshieldings, incl. 0.24 NAM of fees). ' +
      'Net +99,999.73 NAM ³. Pool balance 49,187,665.01 NAM ¹¹, +99,999.73 / 24 h (matches).',
    );
    expect(field(e, 'Holders')).toBe(
      'Namada 64,825 ¹² (−1 / 24 h, vs 64,826 at 07:27 UTC yesterday); the 10 largest hold 274,832,001.62 NAM = 23.94 % of minted NAM ¹³. ' +
      'Osmosis 1,313 ¹⁴ (no change / 24 h); the 10 largest hold 10,221,302.57 NAM = 49.07 % of the NAM on Osmosis ¹⁵. ' +
      'Staking: the 10 largest validators hold 53.15 % of stake ⁴ (53.24 % yesterday).',
    );
    expect(field(e, 'Governance')).toBe('Opened: none. Closed: none. Ending within 24 h (epochs 2,697–2,700): none. Newest of the 20 proposals read: #42 (rejected) ¹⁶.');
    expect(field(e, 'Validators')).toBe(
      '246 with stake on both days ¹⁷; 0 joined, 0 left, 0 state changes (listing 00:27 UTC yesterday → 00:10 UTC today). ' +
      'Stake +442,107.00 NAM between the listings; gross |change| 504,213.00 NAM. ' +
      'Largest moves: PathrockNetwork +100,000.00 (57 → 58 delegators), Stake&Relax 🦥 +50,000.00, MELLIFERA +50,000.00 (81 → 82), OriginStake +50,000.00 (79 → 80), StakeUp +50,000.00 (45 → 46). ' +
      'Redelegations are not decoded.',
    );
  });

  it('the requests carry what the stored answers hold: the tie read\'s seven bonds of 50,000 NAM to six validators, no largest unbond row (none was captured), so no figure for it', () => {
    // section 7.1 says "three of that size" from a LIMIT 3 read; figures.ts's tie statement counts all seven (digest-figures-shape)
    expect(field(e, 'Bond and unbond requests (24 h)')).toBe(
      'Bonds: 10 requests, 373,220.00 NAM, largest 50,000.00 NAM (seven of that size at 12:35 UTC yesterday, block 8,374,275, to six validators). ' +
      'Unbonds: 2 requests, 30,900.00 NAM. ³',
    );
  });

  it('the Sources list the 17 marks of section 7.1, the providers named', () => {
    const s = sources(e);
    expect(s).toHaveLength(17);
    expect(s[3]).toBe("⁴ the chain's bond listing, height 8,384,271, 07:38 UTC (Papadritta)");
    expect(s[11]).toBe("¹² the chain's balance listing, height 8,384,388, 07:52 UTC (5ElementsNodes), with the bond listing ⁴");
    expect(s[16]).toBe('¹⁷ the first complete bond listings of 22 Oct (00:27 UTC, height 8,367,878) and 23 Oct (00:10 UTC, height 8,380,347); names by indexer.namada.net, read 00:00 UTC');
  });

  it('the bridge\'s found-late rows are said on their own side', () => {
    const r = readsFromSurvey('daily');
    if (!r.bridge.ok) throw new Error('bridge');
    r.bridge = { ok: true, rows: r.bridge.rows.map((x) => (x.kind === 'ibc_out' ? { ...x, late: 2 } : x)) };
    const g = shapeDigestFigures(r, digestWindow(T, 'daily'));
    const b = field(buildDigest(toMessageFigures(g, { priceWeek, bridgeLate: bridgeLateOf(r) }), T, 'daily').shared, 'Bridge (24 h)');
    expect(b).toContain('Osmosis → Namada 359,041.66 NAM (5 crossings, largest 259,041.66, 2 found late).');
    expect(b).toContain('Namada → Osmosis 1,454.20 NAM (1 crossing).');
  });

  it('a validator state missing from one snapshot (the table\'s first days kept none) is not compared, never a change from "none"', () => {
    const r = readsFromSurvey('daily');
    r.vdStates = { ok: true, rows: [
      { validator: 'tnam1qx405kgvey8wwfcyt7rgsr4nvkrqsnztxs2kz7wv', name: 'PathrockNetwork', s_from: 'consensus', s_to: 'jailed' },
      { validator: 'tnam1q8d8ypu5j88qqvx89grct795uap82dtlqvjqjh3h', name: 'MELLIFERA', s_from: null, s_to: 'inactive' },
    ] };
    const v = field(buildDigest(toMessageFigures(shapeDigestFigures(r, digestWindow(T, 'daily')), { priceWeek }), T, 'daily').shared, 'Validators');
    expect(v).toContain('0 joined, 0 left, 1 state change (PathrockNetwork consensus → jailed) among the 245 compared (1 not on record in one snapshot) (listing');
    expect(v).not.toContain('none →');
  });

  it('a price section whose read failed makes the executed hour "not read", never "no trade on record"; the window\'s trades stay', () => {
    const r = readsFromSurvey('daily');
    r.trusted = failed('D1_ERROR');
    const g = shapeDigestFigures(r, digestWindow(T, 'daily'));
    const m = buildDigest(toMessageFigures(g, {}), T, 'daily').shared;
    expect(field(m, 'Price')).toBe('Price: not read — the database did not answer this read.');
    const t = field(m, 'Trades');
    expect(t).toMatch(/^Last executed hour: not read — the database did not answer this read\. 24 h: 9 trades, 60,537\.86 NAM/);
    expect(t).not.toContain('No executed');
  });
});

describe('readAndBuildDigest on the survey\'s rows seeded in the stand-in', () => {
  let build: DigestBuild;
  const db = seeded();
  seedWatch(db);

  it('builds the operator\'s posts: the digest with the worked example\'s figures the seeded rows hold, the gallery, the Operator embed', async () => {
    build = await readAndBuildDigest(db, T, 'daily', { wallets: [{ address: WALLET, watchlist: [TNAM, OSMO] }] });
    expect(build.key).toBe('alert:digest:daily:2026-10-23');
    expect(build.what).toBe('digest 2026-10-23');
    expect(build.notes).toEqual([]);
    const [first] = build.operatorPosts;
    const shared = first.payload.embeds[0];
    expect(shared.title).toBe('NAM daily digest · Fri 23 Oct 2026, 08:00 UTC');
    expect(first.payload.username).toBe('NamadaTrade');
    expect(first.payload.avatar_url).toBe(DIGEST_AVATAR_URL);
    expect(first.payload.allowed_mentions).toEqual({ parse: [] });
    const text = allText(first);
    for (const s of [
      'Total stake 267,774,764.27 NAM ¹ · 24 h: +467,207.00 NAM (+0.17 %) vs 267,307,557.27 at 07:59 UTC yesterday.',
      'Staking account 341,793,716.36 NAM ²', '74,018,952.09 NAM (the account less total stake)',
      'largest 50,000.00 NAM (three of that size at 12:35 UTC yesterday, block 8,374,275, to three validators)',
      'Unbonds: 2 requests, 30,900.00 NAM, largest 25,100.00 NAM at 20:33 UTC yesterday',
      'Waiting to unlock (in flight): 181,962.02 NAM ⁴', 'withdrawn in the 24 h: 1,170,000.00 NAM in 1 withdrawal (14:19 UTC yesterday)',
      'next: 37,489.27 NAM (2 unbonds) at epoch 2,704, about 03:35 UTC on 25 Oct (± 10 min) ⁵', 'Withdrawable and not yet withdrawn: 36,859,599.85 NAM ⁴',
      '$0.00087359 ⁶ · 24 h +3.31 % (vs $0.00084557 at 07:59 UTC yesterday) · 7 d −13.97 % (vs $0.00101543, 16 Oct 07:59 UTC)',
      'Last executed hour 05:00 UTC: $0.00091650 from 1 trade ⁷; the quote is 4.68 % under it.', 'Osmosis data API 24 h: $41.74 ⁹',
      'Escrow 20,832,856.30 NAM ¹⁰, −357,587.45 / 24 h', 'In 100,003.00 NAM (4 shielded IBC deposits, 2 shieldings).', 'Pool balance 49,187,665.01 NAM ¹¹, +99,999.73 / 24 h',
      'Namada 64,825 ¹² (−1 / 24 h, vs 64,826 at 07:27 UTC yesterday); the 10 largest hold 274,832,001.62 NAM = 23.94 % of minted NAM ¹³.',
      'Osmosis 1,313 ¹⁴ (no change / 24 h); the 10 largest hold 10,221,302.57 NAM = 49.07 % of the NAM on Osmosis ¹⁵.',
      'Staking: the 10 largest validators hold 53.15 % of stake ⁴ (53.24 % yesterday).',
      'Opened: none. Closed: none. Ending within 24 h (epochs 2,697–2,700): none. Newest of the 20 proposals read: #42 (rejected) ¹⁶.',
      '(listing 00:27 UTC yesterday → 00:10 UTC today)',
    ]) expect(text, s).toContain(s);
    // the seeded trade carries no price: the dollar sum is said in words, never $0.00
    expect(field(shared, 'Trades')).toContain('24 h: 1 trade, 9,970.02 NAM (bought 0.00 / sold 9,970.02), no USD value at execution (1 trade unpriced), 1 trader ⁸.');
    expect(text).not.toContain('$0.00 at execution');
    const op = first.payload.embeds.find((x) => x.title === 'Operator')!;
    expect(op.description).toBe(
      'Sources at 08:00 UTC: 28 of 28 ok. Faults that cleared before 08:00: no record (the health log starts with this deploy).\n' +
      'Checks: 11 of 11 ok.\n' +
      'Alerts in the 24 h: 0 posted; none not sent on record.\n' +
      'This digest: the operator channel only (0 subscribers). Yesterday: no digest on record (the first one).',
    );
    expect(first.payload.embeds.at(-1)!.title).toBe('Operator');
    // the message fits by the trim steps: no field is cut short (a cut drops a field's closing mark)
    for (const f of shared.fields!) expect(f.value.endsWith('…'), f.name).toBe(false);
  });

  it('attaches the four charts the embeds name and nothing else: the lead image on the digest, the other three as a gallery on its url', () => {
    const [first] = build.operatorPosts;
    expect(first.files.map((f) => f.name)).toEqual(['price-7d.png', 'stake-30d.png', 'pipeline-30d.png', 'flows-7d.png']);
    expect(first.payload.embeds[0].image).toEqual({ url: 'attachment://price-7d.png' });
    expect(first.payload.embeds.slice(1, 4)).toEqual([
      { url: 'https://namada.trade/', image: { url: 'attachment://stake-30d.png' } },
      { url: 'https://namada.trade/', image: { url: 'attachment://pipeline-30d.png' } },
      { url: 'https://namada.trade/', image: { url: 'attachment://flows-7d.png' } },
    ]);
    for (const f of first.files) expect([...f.bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    for (const p of build.operatorPosts) expectFilesMatch(p);
    const names = first.payload.embeds[0].fields!.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(['① Price, 7 days', '② Staked NAM, 30 days', '③ Unlocks, next 30 days', '④ Net flow, 7 days']));
  });

  it('puts the attention section in a message of its own with its picture when the first message has no room for it at A0, else as embed 2', () => {
    const a = build.parts.attention!;
    expect(a.full.title).toBe('Trades worth attention · 24 h to 08:00 UTC, 23 Oct 2026');
    const [first, second] = build.operatorPosts;
    const room = DIGEST_MESSAGE_MAX - messageCount(first.payload.embeds.filter((x) => !x.title?.startsWith('Trades worth attention')));
    if (discordCount(a.full) <= room) {
      expect(build.operatorPosts).toHaveLength(1);
      expect(titles(first)).toContain(a.full.title);
    } else {
      expect(build.operatorPosts).toHaveLength(2);
      expect(titles(second)).toEqual([a.full.title]);
      expect(second.files.map((f) => f.name)).toEqual([DIGEST_ATTN_FILE]);
      expect(second.payload.embeds[0].image).toEqual({ url: `attachment://${DIGEST_ATTN_FILE}` });
      expectFilesMatch(second);
    }
    // the section shares the digest's numbers for the Osmosis index (⁸); the quote's readings over the window and the
    // trades' own prices are its own sources, numbered after the digest's and named in its own Sources
    expect(a.full.description).toContain('9,970.02 NAM ⁸');
    expect(a.full.description).toContain('¹⁸ ¹⁹.');
    const own = a.full.fields!.find((f) => f.name === 'Sources (this embed)')!.value;
    expect(own).toContain('¹⁸ Osmosis SQS (stored), the stored minute quotes, ');
    expect(own).toContain("¹⁹ this site's Osmosis trade records: each trade's settle price");
    expect(own.indexOf('¹⁸')).toBeLessThan(own.indexOf('¹⁹'));
  });

  it('a subscriber with a two-address watchlist gets the watchlist embed and no operator embed; no address is printed whole', () => {
    const posts = build.subscriberPosts({ address: WALLET, watchlistOn: true, watchlist: [TNAM, OSMO] });
    const [first] = posts;
    expect(titles(first)).toContain('Your watchlist (24 h)');
    expect(titles(first)).not.toContain('Operator');
    const w = first.payload.embeds.find((x) => x.title === 'Your watchlist (24 h)')!;
    expect(first.payload.embeds.at(-1)).toBe(w);
    const [l1, l2, rule] = w.description!.split('\n');
    expect(l1).toBe(`\`${TNAM.slice(0, 14)}…${TNAM.slice(-6)}\`  −12,500.00 NAM spendable (now 1,250,000.00 NAM) — Namada, as of the 07:52 UTC listing; 24 h ago from the reading at 07:27 UTC yesterday`);
    expect(l2).toBe(`\`${OSMO.slice(0, 14)}…${OSMO.slice(-6)}\`  no change (2,100.00 NAM) — Osmosis, as of the 07:50 UTC pass`);
    expect(rule).toBe('Spendable NAM only; staked changes are not computed. Addresses are shown shortened, never their tags. One digest per channel.');
    for (const p of posts) {
      const t = allText(p);
      for (const a of [WALLET, TNAM, OSMO]) expect(t).not.toContain(a);
      expect(t).not.toContain('Operator');
      expectFilesMatch(p);
      expectWithinDiscord(p);
    }
    // the shared embed is the same bytes for every channel
    expect(JSON.stringify(first.payload.embeds[0])).toBe(JSON.stringify(build.operatorPosts[0].payload.embeds[0]));
  });

  it('a subscriber without a watchlist (or with it off) gets the digest alone; a wallet the run did not read says so in its embed', () => {
    const none = build.subscriberPosts({ address: WALLET, watchlistOn: false, watchlist: [TNAM] });
    expect(titles(none[0])).not.toContain('Your watchlist (24 h)');
    expect(titles(none[0])).not.toContain('Operator');
    const other = build.subscriberPosts({ address: fixtureAddress('namada', 9, 'qwallet'), watchlistOn: true, watchlist: [TNAM] });
    const w = other[0].payload.embeds.find((x) => x.title === 'Your watchlist (24 h)')!;
    expect(w.description).toBe("Your watchlist: not read this time — this wallet's watchlist was not part of this run.");
  });

  it('every post is within Discord\'s limits (6,000 over the embeds, 10 embeds, 25 fields, 1,024 a field, 256 a title, 4,096 a description; files under 8 MB, the post under 25 MB)', () => {
    for (const p of build.operatorPosts) expectWithinDiscord(p);
  });

  it('reads every statement on its index, with no address in any statement text', () => {
    const log: { sql: string; params: unknown[] }[] = [];
    return readAndBuildDigest(db, T, 'daily', { wallets: [{ address: WALLET, watchlist: [TNAM, OSMO] }], log }).then(() => {
      expect(log.length).toBeGreaterThan(70);
      for (const s of log) {
        expect(s.sql).not.toMatch(/tnam1q[0-9a-z]{30}|osmo1[0-9a-z]{30}/);
        const plan = (db.raw.prepare(`EXPLAIN QUERY PLAN ${s.sql}`).all(...s.params) as { detail: string }[]).map((p) => p.detail).join(' | ');
        expect(plan, s.sql.slice(0, 80)).not.toMatch(/SCAN flows|SCAN metrics|SCAN holders|SCAN balance_spans|SCAN unbond_queue/);
      }
    });
  });
});

describe('a figure that was not read shows no figure', () => {
  it('total stake 11 min old, validator_daily gone, the top-10 sums 2 h 1 min old, the proposal list 31 min old, the hourly stake series empty', async () => {
    const db = seeded();
    db.exec(`UPDATE metrics SET ts = ${T - 11 * MIN} WHERE key = 'supply.total_stake' AND ts = 1792742342769`);
    db.exec('DROP TABLE validator_daily');
    const hf = { ...fx.kv['holders.figures'].value };
    hf.namada = { ...hf.namada, top10: { s: hf.namada.top10.s, at: T - 2 * H - MIN } };
    db.exec(`UPDATE kv SET value = '${JSON.stringify(hf)}' WHERE key = 'holders.figures'`);
    const cache = { ...fx.kv['intel.cache'].value, fetchedAt: T - 31 * MIN };
    db.exec(`UPDATE kv SET value = '${JSON.stringify(cache).replace(/'/g, "''")}' WHERE key = 'intel.cache'`);
    db.exec("DELETE FROM metrics WHERE key = 'supply.total_stake.1h'");
    const b = await readAndBuildDigest(db, T, 'daily');
    const [first] = b.operatorPosts;
    const e = first.payload.embeds[0];
    const text = allText(first);

    const staked = field(e, 'Staked NAM');
    expect(staked.split('\n')[0]).toBe('Total stake: not read — Namada RPC (total stake) last answered 07:49 UTC, 11 min ago; the figure is not shown.');
    expect(text).not.toContain('267,774,764');
    expect(staked).not.toContain('On its way out');
    expect(field(e, 'Validators')).toBe('Validators: not read — the database did not answer this read.');
    expect(field(e, 'Holders')).toContain('; the 10 largest: not read — this site\'s holder index last answered 05:59 UTC, 2 h 1 min ago; the figure is not shown. Osmosis');
    expect(text).not.toContain('274,832,001');
    expect(sources(e).some((s) => /this site's holder index, the 10 largest by total NAM: not read, last answered 05:59 UTC$/.test(s))).toBe(true);
    expect(field(e, 'Governance')).toBe('Governance: not read since 07:29 UTC — indexer.namada.net proposals last answered then, 31 min ago; the figure is not shown.');
    // the stake chart is left out with its sentence; its file is neither attached nor named
    expect(field(e, '② Staked NAM, 30 days')).toBe('Staked NAM: no chart — Namada RPC (total stake), hourly rollup has no reading in the 30 days to 23 Oct 08:00 UTC (last read 23 Oct 07:49 UTC).');
    expect(first.files.map((f) => f.name).filter((n) => n !== DIGEST_ATTN_FILE)).toEqual(['price-7d.png', 'pipeline-30d.png', 'flows-7d.png']);
    expectFilesMatch(first);
    // no not-read line carries a number in place of the figure
    for (const f of e.fields!) for (const line of f.value.split(/(?<=\.)\s/)) if (/not read —/.test(line)) expect(line, line).not.toMatch(/\d[\d,]*\.\d\d NAM/);
    for (const p of b.operatorPosts) expectWithinDiscord(p);
  });

  it('the figures\' "last answered" reason is said once, with what it adds kept', () => {
    expect(messageReason('last answered 07:49 UTC, 11 min ago; the figure is not shown')).toBe('');
    expect(messageReason('never answered; the figure is not shown')).toBe('');
    expect(messageReason('not read since 07:29 UTC')).toBe('');
    expect(messageReason('not read since 05:38 UTC (the listing failed at 06:10 UTC)')).toBe('the listing failed at 06:10 UTC');
    expect(messageReason('the balance listing last completed 04:52 UTC (timeout)')).toBe('timeout');
    expect(messageReason(DB_NOT_ANSWERED)).toBe(DB_NOT_ANSWERED);
    expect(messageReason("not read this time — the digest's address cap (5,000) was reached; see the Holders page")).toBe("the digest's address cap (5,000) was reached; see the Holders page");
    expect(messageReason('no complete bond listing on record')).toBe('no complete bond listing on record');
  });
});

describe('the attention section\'s place and marks', () => {
  it('a section too long for the first message goes as the second message with its picture; one that fits is embed 2, before the recipient\'s own', async () => {
    const db = seeded();
    const b = await readAndBuildDigest(db, T, 'daily');
    const a = b.parts.attention!;
    const big = { ...a, full: { ...a.full, description: `${a.full.description} ${'x'.repeat(3_000)}` } };
    const own: Embed = { title: 'Operator', description: 'o' };
    const two = postsFor({ ...b.parts, attention: big }, own);
    expect(two).toHaveLength(2);
    expect(titles(two[1])).toEqual([a.alone!.title]);
    expect(two[1].files.map((f) => f.name)).toEqual(a.picture ? [DIGEST_ATTN_FILE] : []);
    expect(two[0].files.map((f) => f.name)).not.toContain(DIGEST_ATTN_FILE);
    const small = { ...a, full: { title: 'Trades worth attention · 24 h to 08:00 UTC, 23 Oct 2026', description: 'short', image: { url: `attachment://${DIGEST_ATTN_FILE}` } } };
    const one = postsFor({ ...b.parts, attention: small }, own);
    expect(one).toHaveLength(1);
    expect(titles(one[0]).slice(-2)).toEqual([small.full.title, 'Operator']);
    expect(one[0].files.map((f) => f.name)).toContain(DIGEST_ATTN_FILE);
    for (const p of [...two, ...one]) { expectFilesMatch(p); expectWithinDiscord(p); }
  });

  it('an own embed with no room beside the shared embed goes first in the next message, before the attention section; the shared embed is the same and no figure of it is cut', async () => {
    const db = seeded();
    const b = await readAndBuildDigest(db, T, 'daily');
    const shared = b.parts.body.shared;
    // an own embed that leaves the first message 50 characters over its budget
    const own: Embed = { title: 'Operator', description: 'o'.repeat(DIGEST_MESSAGE_MAX - discordCount(shared) + 50 - 'Operator'.length) };
    const [first, second] = postsFor(b.parts, own);
    expect(first.payload.embeds[0]).toEqual(shared);
    expect(titles(first)).not.toContain('Operator');
    expect(titles(second)[0]).toBe('Operator');
    expect(titles(second)).toContain(b.parts.attention!.full.title);
    expect(second.files.map((f) => f.name)).toEqual(b.parts.attention!.picture ? [DIGEST_ATTN_FILE] : []);
    for (const f of shared.fields!) expect(f.value.endsWith('…'), f.name).toBe(false);
    // the captions and the pictures stay with the shared embed
    expect(shared.fields!.some((f) => f.name === '① Price, 7 days')).toBe(true);
    expect(first.files.map((f) => f.name)).toEqual(['price-7d.png', 'stake-30d.png', 'pipeline-30d.png', 'flows-7d.png']);
    for (const p of [first, second]) { expectFilesMatch(p); expectWithinDiscord(p); }
    // with no attention section the own embed travels alone in the second message
    const [, alone] = postsFor({ ...b.parts, attention: null }, own);
    expect(titles(alone)).toEqual(['Operator']);
    expect(alone.files).toEqual([]);
  });

  it('takes the digest\'s numbers for the sources it shares and numbers its own after them; a shared source the digest did not cite gets its own entry', () => {
    const all: Mark[] = MARK_ORDER.map((key, i) => ({ n: i + 1, key, text: key }));
    const m = attentionMarks(all);
    expect([m.marks.scan, m.marks.clock, m.marks.stream, m.marks.listing, m.marks.pass, m.marks.validators]).toEqual(['³', '⁵', '⁸', '¹²', '¹⁴', '¹⁷']);
    // its own: the quote's readings over the window, the trades' own prices, the labels, the coin quotes
    expect([m.marks.quote, m.marks.trades, m.marks.labels, m.marks.coinQuote]).toEqual(['¹⁹', '²⁰', '²¹', '²²']);
    expect(m.extra).toEqual([]);
    // only the own marks the section prints are numbered first, in that order
    const used = attentionMarks(all, new Set(['trades', 'coinQuote'] as const));
    expect([used.marks.trades, used.marks.coinQuote]).toEqual(['¹⁹', '²⁰']);
    // the validators section not read: its mark is not in the digest's list
    const without = all.filter((x) => x.key !== ('validatorDaily' as MarkKey));
    const w = attentionMarks(without);
    // numbered after the digest's highest mark (the depth store's, eighteenth), not after its count
    expect(w.marks.validators).toBe('¹⁹');
    expect(w.extra).toEqual([{ mark: '¹⁹', text: 'the daily validator snapshot (the first complete bond listing of each UTC day)' }]);
    expect([w.marks.quote, w.marks.trades, w.marks.labels, w.marks.coinQuote]).toEqual(['²⁰', '²¹', '²²', '²³']);
  });
});

describe('the operator\'s previous period and the watch lines', () => {
  const base: OperatorFigures = {
    kind: 'daily', now: T, from: A24, to: T,
    sources: { value: { ok: 28, total: 28, notOk: [], episodes: [], logFrom: null }, stamp: { source: 'source.health', at: T, status: 'live' } },
    checks: { value: { ok: 11, total: 11, notPassing: [] }, stamp: { source: 'checks', at: T, status: 'live' } },
    alerts: { value: { claimed: { n: 0, moves: 0, crossings: 0, governance: 0, forum: 0, digests: 0, firstAt: null, lastAt: null }, skipped: null }, stamp: { source: 'alert claims', at: T, status: 'live' } },
    delivery: { value: { last: null, previous: { key: 'alert:digest:daily:2026-10-22', sentAt: null }, dailiesNotSent: [] }, stamp: { source: 'digest.last', at: 0, status: 'live' } },
  };
  const x = { healthLogFirstAt: null, channels: 1, subscribers: 0, watchCapWallets: 0 };
  const last = { key: 'alert:digest:daily:2026-10-22', at: Date.UTC(2026, 9, 22, 8), targets: 13, posted: 12, skipped: 1 };

  it('no digest ever recorded: the first one; yesterday\'s record: its counts; a recorded digest before a day with no claim: the missed day; a claim without its record: said', () => {
    expect(toMessageOperator(base, x).previous).toEqual({ last: null, missed: [], sentWithoutRecord: false });
    const sent = toMessageOperator({ ...base, delivery: { ...base.delivery, value: { last, previous: { key: last.key, sentAt: last.at }, dailiesNotSent: [] } } as OperatorFigures['delivery'] }, x);
    expect(sent.previous).toEqual({ last, missed: [], sentWithoutRecord: false });
    const older = { ...last, key: 'alert:digest:daily:2026-10-21', at: Date.UTC(2026, 9, 21, 8) };
    const missed = toMessageOperator({ ...base, delivery: { ...base.delivery, value: { last: older, previous: { key: last.key, sentAt: null }, dailiesNotSent: [] } } as OperatorFigures['delivery'] }, x);
    expect(missed.previous).toEqual({ last: null, missed: ['2026-10-22'], sentWithoutRecord: false });
    const overwritten = toMessageOperator({ ...base, delivery: { ...base.delivery, value: { last: { ...last, key: 'alert:digest:weekly:2026-W44' }, previous: { key: last.key, sentAt: last.at }, dailiesNotSent: [] } } as OperatorFigures['delivery'] }, x);
    expect(overwritten.previous).toEqual({ last: null, missed: [], sentWithoutRecord: true });
    const nr = toMessageOperator({ ...base, delivery: notRead('digest.last', null, DB_NOT_ANSWERED) as NotRead }, x);
    expect(nr.previous).toEqual({ notRead: true, source: 'digest.last', lastAt: null, reason: DB_NOT_ANSWERED });
  });

  it('a failing check says since when its flip is in the health log, else as of its last run; a stale one says it has not run', () => {
    const o = toMessageOperator({
      ...base,
      sources: { ...base.sources, value: { ok: 28, total: 28, notOk: [], episodes: [{ name: 'check:bonded_coverage', from: Date.UTC(2026, 9, 23, 4), to: null, note: 'warn' }], logFrom: Date.UTC(2026, 9, 23, 4) } } as OperatorFigures['sources'],
      checks: { ...base.checks, value: { ok: 9, total: 11, notPassing: [
        { key: 'bonded_coverage', status: 'warn', checkedAt: T - MIN, stale: false },
        { key: 'indexer_lag', status: 'ok', checkedAt: T - 20 * MIN, stale: true },
      ] } } as OperatorFigures['checks'],
    }, x);
    expect(o.checks).toEqual({ value: { ok: 9, total: 11, failing: [
      { key: 'bonded_coverage', status: 'warn', since: Date.UTC(2026, 9, 23, 4), asOf: T - MIN },
      { key: 'indexer_lag', status: 'ok, not run', since: T - 20 * MIN, asOf: T - 20 * MIN },
    ] } });
  });

  it('a watch line\'s base time is the first reading of the span that held the base (at or before the instant); not listed and not known carry no base', () => {
    const l = { address: TNAM, chain: 'namada' as const, status: 'changed' as const, now: 10, base: 12, change: -2, asOf: T - H, baseSpan: { fromTs: A24 - 30 * MIN, toTs: A24 + 5 * H } };
    expect(toMessageWatchLine(l)).toEqual({ address: TNAM, chain: 'namada', now: 10, nowAt: T - H, base: 12, baseAt: A24 - 30 * MIN });
    expect(toMessageWatchLine({ ...l, status: 'base-unknown', base: null, change: null, baseSpan: null })).toMatchObject({ base: null, baseAt: null, now: 10 });
    expect(toMessageWatchLine({ ...l, status: 'not-listed', now: null, base: null, change: null, asOf: null, baseSpan: null })).toMatchObject({ now: null, base: null });
  });
});

describe('Discord\'s limits on the largest subscriber and on the weekly', () => {
  it('a subscriber with 100 watched addresses, all changed, stays within every limit, the watchlist trimmed and the rest counted', async () => {
    const db = seeded();
    const list = Array.from({ length: 100 }, (_, i) => fixtureAddress(i % 2 ? 'osmosis' : 'namada', 100 + i, 'qlarge'));
    insert(db, 'holders', list.map((a, i) => ({ chain: i % 2 ? 'osmosis' : 'namada', address: a, balance: '1', balance_num: 1_000 + i, updated_height: null, updated_at: BALANCE_LISTING_AT, verified_at: BALANCE_LISTING_AT, verified_src: i % 2 ? 'keplr' : BALANCE_LISTING_SRC })));
    insert(db, 'balance_spans', list.map((a, i) => ({ chain: i % 2 ? 'osmosis' : 'namada', address: a, from_ts: A24 - H, to_ts: A24 + H, balance: '1', balance_num: 500 + 3 * i, reads: 2 })));
    const b = await readAndBuildDigest(db, T, 'daily', { wallets: [{ address: WALLET, watchlist: list }], targets: { channels: 2, subscribers: 1 } });
    const posts = b.subscriberPosts({ address: WALLET, watchlistOn: true, watchlist: list });
    // the watchlist is in the first message when it has room there, else first in the second
    const w = posts.flatMap((p) => p.payload.embeds).find((x) => x.title === 'Your watchlist (24 h)')!;
    expect(w.description).toMatch(/\nand \d+ more: 0 unchanged, 0 not read\n/);
    for (const p of posts) { expectWithinDiscord(p); expectFilesMatch(p); }
    expect(b.operatorPosts.flatMap((p) => p.payload.embeds).find((x) => x.title === 'Operator')!.description).toContain('This digest: 2 channels (1 subscriber).');
    // the shared embed is the same for the operator and the subscriber
    expect(JSON.stringify(posts[0].payload.embeds[0])).toBe(JSON.stringify(b.operatorPosts[0].payload.embeds[0]));
  });

  it('the weekly: its title, the 7 d window, the weekly pictures, within every limit', async () => {
    const db = seeded();
    const b = await readAndBuildDigest(db, T, 'weekly');
    expect(b.key).toBe('alert:digest:weekly:2026-W43');
    const [first] = b.operatorPosts;
    expect(first.payload.embeds[0].title).toBe('NAM weekly digest · 7 days to Fri 23 Oct 2026, 08:00 UTC');
    expect(first.files.map((f) => f.name)).toEqual(['weekly-price-30d.png', 'weekly-stake-90d.png', 'weekly-pipeline-90d.png', 'weekly-flows-30d.png']);
    expect(field(first.payload.embeds[0], 'Validators')).toMatch(/^The snapshots start 22 Oct, so that day is the base, not 7 days back\./);
    for (const p of b.operatorPosts) { expectWithinDiscord(p); expectFilesMatch(p); }
  });
});

describe('the price\'s source as the site names a stored price (kv price.how)', () => {
  const route = (since: number) => ({ how: 'route' as const, refNam: 1_000, routes: [[{ id: '3005', liquidityUsd: 40 }, { id: '3497', liquidityUsd: 900_000 }]], liquidityUsd: 40, since });
  const log: PriceHowLog = { log: [{ how: 'list', since: T - 10 * H }, route(T - 2 * H)] };

  it('the reading shown is named by the way it was read: the price list before the change, the route quote with its note after; an unread record is said', () => {
    expect(quoteSourceAt(log, T - 3 * H)).toEqual({ name: 'Osmosis SQS (stored)' });
    const r = quoteSourceAt(log, T - MIN);
    expect(r.name).toBe('Osmosis SQS route spot, 1,000 NAM (stored)');
    expect(r.note).toContain('pool 3005');
    expect(quoteSourceAt(null, T)).toEqual({ name: 'Osmosis SQS (stored)' });
    expect(quoteSourceAt(notRead('price.how', null, DB_NOT_ANSWERED), T)).toEqual({ name: 'Osmosis SQS quote', note: 'how it was read is not known: its record did not answer' });
  });

  it('the attention section\'s quote readings name their span and each way they were read over it', () => {
    const series = Array.from({ length: 24 * 60 }, (_, i) => ({ ts: A24 + (i + 1) * MIN, value: 0.0009 }));
    const fig = { now: T, from: A24, to: T, kind: 'daily', series, seriesBounded: false } as unknown as AttentionFigures;
    expect(quoteSeriesSource(log, fig)).toBe('the stored minute quotes, 08:01 UTC yesterday to 08:00 UTC: Osmosis SQS (stored); from 06:00 UTC Osmosis SQS route spot, 1,000 NAM (stored)');
    expect(quoteSeriesSource(null, fig)).toBe('Osmosis SQS (stored), the stored minute quotes, 08:01 UTC yesterday to 08:00 UTC');
  });

  it('a digest read from the stand-in names its quote by the stored record', async () => {
    const db = seeded();
    insert(db, 'kv', [{ key: 'price.how', value: JSON.stringify({ log: [route(T - 2 * H)] }), updated_at: T - 2 * H }]);
    const b = await readAndBuildDigest(db, T, 'daily');
    expect(sources(b.parts.body.shared).some((x) => x.startsWith('⁶ Osmosis SQS route spot, 1,000 NAM (stored) 07:59 UTC'))).toBe(true);
  });
});
