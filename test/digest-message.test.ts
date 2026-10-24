// Daily digest (2026-10-23): the message builder, worker/src/digest/message.ts, on literal figures and a fixed now.
// The worked example of the spec's section 7 is rendered from production's stored rows (test/fixtures/digest-2026-10-23.ts)
// and asserted line by line; every "not read" shape of section 6 is rendered one at a time; a maximal fixture is held
// within Discord's limits by fit() in the documented trim order without splitting a number from its mark; the late
// note, the pipeline's epoch arithmetic, the weekly's wording and keys, the watchlist and operator embeds, the chart
// attachment references and the field cut are each checked on their own. No database, no fetch, no real wallet.
import { describe, expect, it } from 'vitest';
import {
  buildDigest, cutValue, DB_NOT_ANSWERED, digestKey, digestLabel, digestPayload, DIGEST_MESSAGE_MAX, DIGEST_OWN_MAX, DIGEST_SHARED_ALONE_MAX, DIGEST_SHARED_MAX,
  DIGEST_URL, discordCount, DISCORD_DESCRIPTION_MAX, DISCORD_EMBEDS_MAX, DISCORD_FIELD_MAX, DISCORD_FIELDS_MAX, DISCORD_TITLE_MAX, epochRange,
  fitMessage, isoWeek, lateNote, messageCount, operatorEmbed, renderShared, SUP_RE, TRIM_FULL, watchlistEmbed, CADENCE,
  type DigestFigures, type Embed, type NotRead, type OperatorFigures, type WatchLine,
} from '../worker/src/digest/message';
import { A24, A7, figures, operator, T } from './fixtures/digest-2026-10-23';

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
/** The two fixture-shaped addresses of the spec's section 7.2 (no such wallet exists). */
const TNAM = 'tnam1qdigestexample' + 'q'.repeat(25);
const OSMO = 'osmo1digestexample' + 'q'.repeat(25);
const field = (e: Embed, name: string): string => {
  const f = e.fields?.find((x) => x.name === name);
  if (!f) throw new Error(`no field ${name}: ${e.fields?.map((x) => x.name).join(', ')}`);
  return f.value;
};
const sources = (e: Embed): string[] =>
  (e.fields ?? []).filter((f) => f.name.startsWith('Sources')).flatMap((f) => f.value.split(' · '));
const notRead = (source: string, lastAt: number | null, reason = ''): NotRead => ({ notRead: true, source, lastAt, reason });
const value = <T>(f: { value: T } | NotRead): T => { if ('notRead' in f) throw new Error('not read'); return f.value; };

describe('the worked example of 2026-10-23 08:00 UTC, from the stored rows', () => {
  const body = buildDigest(figures(), T, 'daily');
  const e = body.shared;

  it('has the title, the description, the footer, the url, the colour and the timestamp of section 6', () => {
    expect(e.title).toBe('NAM daily digest · Fri 23 Oct 2026, 08:00 UTC');
    // the first sentence is the day's three figures with their marks, so a phone's push shows the day
    expect(e.description).toBe(
      'Total stake 267,774,764.27 NAM ¹ (+0.17 % / 24 h) · price $0.00087359 ⁶ (+3.31 % / 24 h) · 9 trades, 60,537.86 NAM ⁸. ' +
      'The 24 h to <t:1792742400:f>. Each mark names its source in Sources; "not read" means no answer in time, never 0.',
    );
    expect(e.footer).toEqual({ text: 'NamadaTrade · daily digest · figures as read · turn it off in Settings' });
    expect(e.url).toBe(DIGEST_URL);
    expect(e.color).toBe(0x5865f2);
    expect(e.timestamp).toBe('2026-10-23T08:00:00.000Z');
    expect(e.image).toBeUndefined();
    expect(body.key).toBe('alert:digest:daily:2026-10-23');
    expect(body.what).toBe('digest 2026-10-23');
    expect(body.files).toEqual([]);
    expect(body.gallery).toEqual([]);
  });

  it('has the fields in order, the four inline ones marked, and the Sources split in two', () => {
    expect(e.fields!.map((f) => f.name)).toEqual([
      'Staked NAM', 'Bond and unbond requests (24 h)', 'Unbonding pipeline', 'Rewards claimed (24 h)', 'Price', 'Trades', 'Bridge (24 h)',
      'Shielded pool (24 h)', 'Holders', 'Governance', 'Validators', 'Sources (1)', 'Sources (2)',
    ]);
    expect(e.fields!.filter((f) => f.inline).map((f) => f.name)).toEqual(['Price', 'Trades', 'Bridge (24 h)', 'Shielded pool (24 h)']);
  });

  it('Staked NAM: the total stake with its 24 h change and base, the stakers, the staking account and its difference', () => {
    expect(field(e, 'Staked NAM')).toBe(
      'Total stake 267,774,764.27 NAM ¹ · 24 h: +467,207.00 NAM (+0.17 %) vs 267,307,557.27 at 07:59 UTC yesterday.\n' +
      '19,340 stakers (−2 / 24 h) with 246 validators ⁴.\n' +
      'Staking account 341,793,716.36 NAM ² (stake + unbonding + withdrawable + rewards) · 24 h: −720,267.35 NAM. ' +
      'On its way out or unclaimed: 74,018,952.09 NAM (the account less total stake).',
    );
  });

  it('Bond and unbond requests: the counts, the sums, the tie of three at the largest, the block scan mark', () => {
    expect(field(e, 'Bond and unbond requests (24 h)')).toBe(
      'Bonds: 10 requests, 373,220.00 NAM, largest 50,000.00 NAM (three of that size at 12:35 UTC yesterday, block 8,374,275, to three validators). ' +
      'Unbonds: 2 requests, 30,900.00 NAM, largest 25,100.00 NAM at 20:33 UTC yesterday. ³',
    );
  });

  it('Unbonding pipeline: in flight, the identity over the two listings, the withdrawal, the next unlock on the epoch clock', () => {
    expect(field(e, 'Unbonding pipeline')).toBe(
      'Waiting to unlock (in flight): 181,962.02 NAM ⁴. Became withdrawable in the last 24 h (epochs 2,693–2,696): 0.00 NAM ⁴ ³; ' +
      'withdrawn in the 24 h: 1,170,000.00 NAM in 1 withdrawal (14:19 UTC yesterday) ³. ' +
      'Unlocking in the next 24 h (epochs 2,697–2,700): 0.00 NAM ⁴; next: 37,489.27 NAM (2 unbonds) at epoch 2,704, about 03:35 UTC on 25 Oct (± 10 min) ⁵. ' +
      'Withdrawable and not yet withdrawn: 36,859,599.85 NAM ⁴ (epochs 56–2,696).',
    );
  });

  it('Rewards claimed', () => {
    expect(field(e, 'Rewards claimed (24 h)')).toBe('17 claims, 3,250.15 NAM, largest 928.27 NAM ³.');
  });

  it('Price: the quote, the 24 h change against the last reading at or before yesterday, the 7 d change with its day', () => {
    expect(field(e, 'Price')).toBe('$0.00087359 ⁶ · 24 h +3.31 % (vs $0.00084557 at 07:59 UTC yesterday) · 7 d −13.97 % (vs $0.00101543, 16 Oct 07:59 UTC)');
  });

  it('Trades: the last executed hour against the quote, the window, the data API', () => {
    expect(field(e, 'Trades')).toBe(
      'Last executed hour 05:00 UTC: $0.00091650 from 1 trade ⁷; the quote is 4.68 % under it. ' +
      '24 h: 9 trades, 60,537.86 NAM (bought 29,284.64 / sold 31,253.22), $53.91 at the stored prices (1 at execution, 8 at the Osmosis quote of their minute), 4 traders ⁸. Osmosis data API 24 h: $41.74 ⁹.',
    );
  });

  it('Bridge: both directions in words, the net, the escrow matching', () => {
    expect(field(e, 'Bridge (24 h)')).toBe(
      'Namada → Osmosis 1,454.20 NAM (1 crossing). Osmosis → Namada 359,041.66 NAM (5 crossings, largest 259,041.66). ' +
      'Net +357,587.45 NAM to Namada ⁸. Escrow 20,832,856.30 NAM ¹⁰, −357,587.45 / 24 h (matches).',
    );
  });

  it('Shielded pool: in, out with the fees, net, the balance matching', () => {
    expect(field(e, 'Shielded pool (24 h)')).toBe(
      'In 100,003.00 NAM (4 shielded IBC deposits, 2 shieldings). Out 3.28 NAM (4 unshieldings, incl. 0.24 NAM of fees). ' +
      'Net +99,999.73 NAM ³. Pool balance 49,187,665.01 NAM ¹¹, +99,999.73 / 24 h (matches).',
    );
  });

  it('Holders: both counts with the day\'s change, the top-10 shares with their denominators named, the staking share', () => {
    expect(field(e, 'Holders')).toBe(
      'Namada 64,825 ¹² (−1 / 24 h, vs 64,826 at 07:27 UTC yesterday); the 10 largest hold 274,832,001.62 NAM = 23.94 % of minted NAM ¹³. ' +
      'Osmosis 1,313 ¹⁴ (no change / 24 h); the 10 largest hold 10,221,302.57 NAM = 49.07 % of the NAM on Osmosis ¹⁵. ' +
      'Staking: the 10 largest validators hold 53.15 % of stake ⁴ (53.24 % yesterday).',
    );
  });

  it('Governance: nothing opened, closed or ending; the record', () => {
    expect(field(e, 'Governance')).toBe('Opened: none. Closed: none. Ending within 24 h (epochs 2,697–2,700): none. Newest of the 20 proposals read: #42 (rejected) ¹⁶.');
  });

  it('Validators: the set, the listing window, the stake between the listings, the five largest moves, the redelegation caveat', () => {
    expect(field(e, 'Validators')).toBe(
      '246 with stake on both days ¹⁷; 0 joined, 0 left, 0 state changes (listing 00:27 UTC yesterday → 00:10 UTC today). ' +
      'Stake +442,107.00 NAM between the listings; gross |change| 504,213.00 NAM. ' +
      'Largest moves: PathrockNetwork +100,000.00 (57 → 58 delegators), Stake&Relax 🦥 +50,000.00, MELLIFERA +50,000.00 (81 → 82), OriginStake +50,000.00 (79 → 80), StakeUp +50,000.00 (45 → 46). ' +
      'Redelegations are not decoded.',
    );
  });

  it('Sources: each of the 17 marks once, with its source and time, the providers named, the stored stamps printed as read', () => {
    expect(sources(e)).toEqual([
      '¹ Namada RPC (total stake) 07:59 UTC',
      '² Namada RPC (PoS balance) 07:59 UTC',
      "³ this site's Namada block scan, read to block 8,388,520 at 15:45 UTC",
      "⁴ the chain's bond listing, height 8,384,271, 07:38 UTC (Papadritta)",
      '⁵ epoch 2,696 began 03:33 UTC (first reading); epoch length 21,617 s measured over the last 30 epochs; indexer.namada.net chain parameters',
      '⁶ Osmosis SQS quote 07:59 UTC',
      "⁷ this site's Osmosis trade index (single-pool NAM/USDC swaps ≥ 50 NAM), hour 05:00 UTC",
      "⁸ this site's Osmosis stream and catch-up search, swept to height 73,054,078 at 15:43 UTC",
      '⁹ Osmosis data API, updated 07:58 UTC',
      '¹⁰ Namada RPC (IBC escrow) 07:59 UTC',
      '¹¹ Namada RPC (MASP balance) 07:59 UTC',
      "¹² the chain's balance listing, height 8,384,388, 07:52 UTC (5ElementsNodes), with the bond listing ⁴",
      "¹³ this site's holder index, the 10 largest by total NAM, as of the 14:56 listing; minted NAM 1,147,916,525.09, Namada RPC 07:59 UTC",
      '¹⁴ Keplr Osmosis REST holder list, pass of 07:50 UTC',
      "¹⁵ this site's Osmosis holder index 15:20 UTC; NAM on Osmosis 20,831,242.30, Keplr Osmosis REST (supply) 07:59 UTC",
      '¹⁶ indexer.namada.net proposals, read 15:41 UTC; chain epoch 2,696',
      '¹⁷ the first complete bond listings of 22 Oct (00:27 UTC, height 8,367,878) and 23 Oct (00:10 UTC, height 8,380,347); names by indexer.namada.net, read 00:00 UTC',
    ]);
    expect(body.marks.map((m) => m.n)).toEqual([...Array(17)].map((_, i) => i + 1));
    expect(body.marks.filter((m) => m.provider).map((m) => [m.key, m.provider])).toEqual([['bondListing', 'Papadritta'], ['balanceListing', '5ElementsNodes']]);
  });

  it('every line that carries a figure ends with a mark, and the embed fits its budget with the movers at five', () => {
    for (const f of e.fields!) {
      if (f.name.startsWith('Sources')) continue;
      for (const line of f.value.split('\n')) if (/\d/.test(line)) expect(line, `${f.name}: ${line}`).toMatch(SUP_RE);
    }
    expect(discordCount(e)).toBeGreaterThan(3_500);
    expect(discordCount(e)).toBeLessThanOrEqual(DIGEST_SHARED_MAX);
    expect(field(e, 'Validators')).toContain('StakeUp');
    for (const f of e.fields!) expect(f.value.length).toBeLessThanOrEqual(DISCORD_FIELD_MAX);
  });

  it('with the Operator embed the message is one payload under 5,800 with no mention in it', () => {
    const op = operatorEmbed(operator(), T);
    const { embeds, fits } = fitMessage({ shared: body.render, own: op, gallery: body.gallery });
    expect(fits).toBe(true);
    expect(embeds).toHaveLength(2);
    expect(messageCount(embeds)).toBeLessThanOrEqual(DIGEST_MESSAGE_MAX);
    const payload = digestPayload(embeds);
    expect(payload.username).toBe('NamadaTrade');
    expect(JSON.stringify(payload)).not.toContain('@');
    expect(JSON.stringify(payload)).not.toMatch(/ibc_in|ibc_out|bridge\.in_daily|supply\.pos_bonded/);
  });

  it('the Operator embed of section 7.1', () => {
    const op = operatorEmbed(operator(), T);
    expect(op.title).toBe('Operator');
    expect(op.color).toBe(0xfee75c);
    expect(op.description).toBe(
      'Sources at 08:00 UTC: 28 of 28 ok. Faults that cleared before 08:00: no record (the health log starts with this deploy).\n' +
      'Checks: 11 of 11 ok.\n' +
      'Alerts in the 24 h: 14 posted (14 moves, 5 of them bridge crossings; first 08:07 UTC yesterday, last 02:34 UTC today); none not sent on record.\n' +
      'This digest: the operator channel only (0 subscribers). Yesterday: no digest on record (the first one).',
    );
    expect(discordCount(op)).toBeLessThanOrEqual(DIGEST_OWN_MAX);
  });

  it('the largest request links the explorer on the wrapper hash when the row carries one', () => {
    // A real bond of block 8,351,607 (test/fixtures/namada_block_8351607_txs.json): the inner hash as tx_hash, the wrapper in meta.
    const fig = figures();
    value(fig.requests).bonds.largest!.txHash = '49E6CB93123C4F4D1288450107D271896BE9AB6F5CB2CC595AB8597A68B86298';
    value(fig.requests).bonds.largest!.wrapper = '0CB1EEDDA9D8F82DEA3E6ECED81EDC9BB0ED3505CDFA8E006DE8D818FF061810';
    const out = field(buildDigest(fig, T, 'daily').shared, 'Bond and unbond requests (24 h)');
    expect(out).toContain('to three validators) [tx ↗](https://namada.valopers.com/transactions/0CB1EEDDA9D8F82DEA3E6ECED81EDC9BB0ED3505CDFA8E006DE8D818FF061810). Unbonds:');
  });
});

describe('the "not read" shapes of section 6, one at a time', () => {
  it('a "now" reading past its bound: the source, its last time and age, no number, and the mark still listed', () => {
    const fig = figures();
    value(fig.staked).totalStake = notRead('Namada RPC (total stake)', T - (1 * HOUR + 48 * MIN));
    const e = buildDigest(fig, T, 'daily').shared;
    const v = field(e, 'Staked NAM');
    expect(v.split('\n')[0]).toBe('Total stake: not read — Namada RPC (total stake) last answered 06:12 UTC, 1 h 48 min ago; the figure is not shown.');
    expect(v).not.toContain('267,774,764');
    expect(v).not.toContain('On its way out');
    expect(v).toContain('Staking account 341,793,716.36 NAM ²');
    expect(sources(e)[0]).toBe('¹ Namada RPC (total stake): not read, last answered 06:12 UTC');
  });

  it('a missing base: the change is not read between the two times, the figure stays', () => {
    const fig = figures();
    value(fig.staked).totalStake = { ...value(fig.staked).totalStake as any, bases: [{ label: '24 h', instant: A24, base: { gap: { from: A24 - 2 * HOUR, to: A24 } } }] };
    const v = field(buildDigest(fig, T, 'daily').shared, 'Staked NAM');
    expect(v.split('\n')[0]).toBe('Total stake 267,774,764.27 NAM ¹ (24 h change not read: no reading between 06:00 and 08:00 UTC yesterday).');
  });

  it('a base before the series starts', () => {
    const fig = figures();
    const q = value(fig.price).quote as any;
    q.bases[1] = { label: '7 d', instant: A7, base: { seriesStart: Date.UTC(2026, 9, 18, 4, 0) } };
    const v = field(buildDigest(fig, T, 'daily').shared, 'Price');
    expect(v).toBe('$0.00087359 ⁶ · 24 h +3.31 % (vs $0.00084557 at 07:59 UTC yesterday) · (no reading 7 d ago: series starts 18 Oct 04:00 UTC)');
  });

  it('the Namada cursor past its bound: the Namada lines count to the cursor only, and say so first', () => {
    const fig = figures();
    fig.anchors.namada = { cursor: 8388520, cursorAt: T - 4 * MIN, head: 8388513 };
    const e = buildDigest(fig, T, 'daily').shared;
    const head = "counted to 07:56 UTC only ³ — this site's Namada scan is behind (read to block 8,388,520); moves since are not counted.";
    expect(field(e, 'Bond and unbond requests (24 h)')).toBe(`Bond and unbond requests (24 h): ${head}\nBonds: 10 requests, 373,220.00 NAM, largest 50,000.00 NAM (three of that size at 12:35 UTC yesterday, block 8,374,275, to three validators). Unbonds: 2 requests, 30,900.00 NAM, largest 25,100.00 NAM at 20:33 UTC yesterday. ³`);
    expect(field(e, 'Rewards claimed (24 h)').startsWith(`Rewards claimed (24 h): ${head}\n`)).toBe(true);
    expect(field(e, 'Shielded pool (24 h)').startsWith(`Shielded pool (24 h): ${head}\n`)).toBe(true);
    expect(field(e, 'Bridge (24 h)')).not.toContain('counted to');
    // a cursor more than 30 blocks behind the head says the same
    fig.anchors.namada = { cursor: 8388400, cursorAt: T - MIN, head: 8388513 };
    expect(field(buildDigest(fig, T, 'daily').shared, 'Rewards claimed (24 h)')).toContain('counted to 07:59 UTC only ³');
  });

  it('the Osmosis stream down and the sweep past its bound: the Osmosis lines count to the sweep only', () => {
    const fig = figures();
    fig.anchors.osmosis = { live: { connected: false, at: T - 25 * MIN, height: 73054078 }, sweep: { height: 73054078, at: T - 20 * MIN } };
    const e = buildDigest(fig, T, 'daily').shared;
    const head = "counted to 07:40 UTC only ⁸ — this site's Osmosis index is behind (swept to height 73,054,078 at 07:40 UTC); moves since are not counted.";
    expect(field(e, 'Bridge (24 h)').startsWith(`Bridge (24 h): ${head}\nNamada → Osmosis 1,454.20 NAM`)).toBe(true);
    expect(field(e, 'Trades').startsWith(`Trades: ${head}\n`)).toBe(true);
    expect(sources(e)[7]).toBe("⁸ this site's Osmosis stream and catch-up search, swept to height 73,054,078 at 07:40 UTC; stream down since 07:35 UTC");
    // a recent sweep with the stream down is still current
    fig.anchors.osmosis = { live: { connected: false, at: T - 25 * MIN, height: 73054078 }, sweep: { height: 73054078, at: T - 5 * MIN } };
    expect(field(buildDigest(fig, T, 'daily').shared, 'Bridge (24 h)')).not.toContain('counted to');
  });

  it('a section whose read threw', () => {
    const fig = figures();
    fig.validators = notRead('validator_daily', null, DB_NOT_ANSWERED);
    const e = buildDigest(fig, T, 'daily').shared;
    expect(field(e, 'Validators')).toBe('Validators: not read — the database did not answer this read.');
    expect(sources(e).some((s) => s.startsWith('¹⁷'))).toBe(false);
    expect(sources(e)).toHaveLength(16);
  });

  it('holders.figures older than 2 h: no top-10 share, no mark for it', () => {
    const fig = figures();
    value(fig.holders).namadaTop10 = null;
    const e = buildDigest(fig, T, 'daily').shared;
    expect(field(e, 'Holders')).toBe(
      'Namada 64,825 ¹² (−1 / 24 h, vs 64,826 at 07:27 UTC yesterday). ' +
      'Osmosis 1,313 ¹³ (no change / 24 h); the 10 largest hold 10,221,302.57 NAM = 49.07 % of the NAM on Osmosis ¹⁴. ' +
      'Staking: the 10 largest validators hold 53.15 % of stake ⁴ (53.24 % yesterday).',
    );
    expect(sources(e).some((s) => s.includes('holder index, the 10 largest'))).toBe(false);
  });

  it('the top-10 share names yesterday\'s once the daily rows exist; the Osmosis pass not current says since when', () => {
    const fig = figures();
    value(fig.holders).namadaTop10!.previousPct = 23.9;
    value(fig.holders).osmosisPassTrustedAt = T - 7 * HOUR;
    const v = field(buildDigest(fig, T, 'daily').shared, 'Holders');
    expect(v).toContain('= 23.94 % of minted NAM (23.90 % yesterday) ¹³.');
    expect(v).toContain('Osmosis 1,313 ¹⁴ (no change / 24 h) — not current: the last pass that added up to the supply started 01:00 UTC; the 10 largest');
  });

  it('intel.cache older than 30 min: governance not read since its time', () => {
    const fig = figures();
    fig.governance = notRead('indexer.namada.net proposals', T - 48 * MIN);
    const e = buildDigest(fig, T, 'daily').shared;
    expect(field(e, 'Governance')).toBe('Governance: not read since 07:12 UTC — indexer.namada.net proposals last answered then, 48 min ago; the figure is not shown.');
    expect(sources(e).find((s) => s.includes('proposals'))).toBe('¹⁶ indexer.namada.net proposals: not read, last answered 07:12 UTC');
  });

  it('chain.params missing: epochs only, never a clock time', () => {
    const fig = figures();
    fig.anchors.epoch!.params = null;
    const e = buildDigest(fig, T, 'daily').shared;
    const p = field(e, 'Unbonding pipeline');
    expect(p).toContain('Unlocking in the next 24 h: not computed (the epoch length is not read); next: 37,489.27 NAM (2 unbonds) at epoch 2,704, 8 epochs away ⁵.');
    expect(p).not.toContain('UTC on');
    expect(field(e, 'Governance')).toContain('Ending within 24 h: not computed (the epoch clock is not read).');
    expect(sources(e)[4]).toBe('⁵ epoch 2,696 began 03:33 UTC (first reading); chain parameters not read: no clock');
  });

  it('the epoch anchor missing: e24 from the epoch length and the word "about"', () => {
    const fig = figures();
    fig.anchors.epoch!.startedAt = null;
    fig.anchors.epoch!.plusMinusMs = null;
    const p = field(buildDigest(fig, T, 'daily').shared, 'Unbonding pipeline');
    expect(p).toContain('Unlocking in the next 24 h (about epochs 2,697–2,700): 0.00 NAM ⁴; next: 37,489.27 NAM (2 unbonds) at epoch 2,704, about 8 epochs away ⁵.');
    expect(p).not.toContain('UTC on');
  });

  it('the bond listing past 2 h: no pipeline figure at all', () => {
    const fig = figures();
    fig.pipeline = notRead("the chain's bond listing", T - (2 * HOUR + 48 * MIN), 'the listing of 05:12 UTC failed: provider refused');
    const v = field(buildDigest(fig, T, 'daily').shared, 'Unbonding pipeline');
    expect(v).toBe("Unbonding pipeline: not read — the chain's bond listing last answered 05:12 UTC, 2 h 48 min ago (the listing of 05:12 UTC failed: provider refused); the figure is not shown.");
    expect(v).not.toContain('NAM');
  });

  it('the quote not read: the price line and the trade comparison both say so, the trades still count', () => {
    const fig = figures();
    value(fig.price).quote = notRead('Osmosis SQS (price)', T - 23 * MIN);
    const e = buildDigest(fig, T, 'daily').shared;
    // the field's name is not said twice ("Price: Price: …"); the line names what was not read
    expect(field(e, 'Price')).toBe('The quote: not read — Osmosis SQS (price) last answered 07:37 UTC, 23 min ago; the figure is not shown.');
    expect(e.description!.startsWith('Total stake 267,774,764.27 NAM ¹ (+0.17 % / 24 h) · price not read · 9 trades, 60,537.86 NAM ⁸.')).toBe(true);
    expect(field(e, 'Trades')).toContain('from 1 trade ⁷; no comparison: the quote is not read. 24 h: 9 trades');
  });

  it('the executed hour between 6 h and 24 h old, and older than 24 h', () => {
    const fig = figures();
    // the age said is the hour's start's, as the price check measures it; never a "last trusted trade" age
    value(fig.trades).executed = { hourStart: T - 19 * HOUR, price: 0.00078, n: 2 };
    expect(field(buildDigest(fig, T, 'daily').shared, 'Trades')).toContain(
      'Last executed hour 13:00 UTC yesterday: $0.00078000 from 2 trades ⁷; no comparison: the hour began 19 h ago, and the check compares hours begun within 6 h. 24 h:',
    );
    // with the quote not read that is the reason given, whatever the hour's age
    const noQuote = figures();
    value(noQuote.price).quote = notRead('Osmosis SQS (price)', T - 9 * HOUR);
    value(noQuote.trades).executed = { hourStart: T - 7 * HOUR, price: 0.00078, n: 1 };
    expect(field(buildDigest(noQuote, T, 'daily').shared, 'Trades')).toContain('Last executed hour 01:00 UTC: $0.00078000 from 1 trade ⁷; no comparison: the quote is not read. 24 h:');
    value(fig.trades).executed = { hourStart: T - 37 * HOUR, price: 0.00078, n: 2 };
    expect(field(buildDigest(fig, T, 'daily').shared, 'Trades')).toContain('No executed NAM/USDC trade in the last 24 h (last 21 Oct 19:00 UTC) ⁷. 24 h:');
    // a quote outside the 5 % band says so; the VWAP shows from two trusted trades; the bound says the newest 20,000
    value(fig.trades).executed = { hourStart: T - 3 * HOUR, price: 0.0008, n: 3 };
    value(fig.trades).vwap = { n: 3, vwap: 0.00081, lo: 0.0008, hi: 0.00082 };
    value(fig.trades).window.overBound = true;
    value(fig.trades).window.unpriced = 2;
    value(fig.trades).window.basis = { execution: 1, pool_1h: 0, spot: 6, swap_1h: 0, unstated: 0 };
    const v = field(buildDigest(fig, T, 'daily').shared, 'Trades');
    expect(v).toContain('the quote is 9.20 % over it (outside the 5 % band). 24 h VWAP of 3 trusted trades $0.00081000 ($0.00080000–$0.00082000) ⁷.');
    expect(v).toContain('24 h: more than 20,000 trades (the newest 20,000 counted), 60,537.86 NAM (bought 29,284.64 / sold 31,253.22), $53.91 at the stored prices (1 at execution, 6 at the Osmosis quote of their minute; 2 of them unpriced), 4 traders ⁸.');
  });
});

/** The largest figures the store can hand the builder: long names and titles, many claims, a tie of 20, the late note. */
function maximal(): { fig: DigestFigures; now: number; watch: WatchLine[] } {
  const fig = figures();
  const now = T + 3 * MIN;
  fig.now = now;
  const longName = (i: number) => `V${String(i).padStart(3, '0')} ${'name '.repeat(16)}`.slice(0, 80);
  const vals = value(fig.validators);
  vals.movers = [...Array(250)].map((_, i) => ({ validator: `tnam1qv${'q'.repeat(38)}`, name: longName(i), state: 'consensus', d: 1000 * (250 - i), delegatorsToday: i + 2, delegatorsBase: i + 1 }));
  vals.stateChanges = [...Array(250)].map((_, i) => ({ validator: `tnam1qv${'q'.repeat(38)}`, name: i === 0 ? 'Tick `tock` ``' : longName(i), from: 'consensus', to: 'jailed' }));
  vals.joined = 3; vals.left = 2;
  const gov = value(fig.governance);
  gov.proposals = [...Array(25)].map((_, i) => ({
    id: 100 + i, title: `${i === 0 ? 'evil](https://evil.example/x) ' : ''}${'Proposal title words '.repeat(20)}`.slice(0, 256),
    status: i < 20 ? 'voting' : 'executedPassed', type: 'default', startEpoch: 2690, endEpoch: 2698 + (i % 3), discussionsUrl: i % 2 ? 'https://forum.namada.net/t/x' : 'javascript:alert(1)',
  }));
  gov.opened = [...Array(20)].map((_, i) => ({ id: 100 + i, at: A24 + i * HOUR }));
  gov.closed = [...Array(20)].map((_, i) => ({ id: 100 + i, status: i % 2 ? 'passed' : 'rejected', at: A24 + i * HOUR }));
  const req = value(fig.requests);
  req.bonds.largest = { ...req.bonds.largest!, ties: 20, tieValidators: 7 };
  fig.charts = [
    { file: 'price-7d.png', title: 'Price, 7 days', caption: 'Price, 7 days to 23 Oct 08:00 UTC. Solid dots: the executed hourly median. Dashed: the quote. Low $0.00016402, high $0.00152799.', present: true },
    { file: 'stake-30d.png', title: 'Staked NAM, 30 days', caption: 'Total stake per hour, 30 days to 23 Oct 08:00 UTC (124 of 124 hours read). The axis is fitted to the readings.', notes: ['The series starts 18 Oct 04:00 UTC; the chart is blank before it.'], present: true },
    { file: 'pipeline-30d.png', title: 'Unlocks, next 30 days', caption: 'Unlocks: no chart — the chain\'s bond listing is 2 h 10 min old (bound 2 h) (last read 05:50 UTC).', present: false },
    { file: 'flows-7d.png', title: 'Net flow, 7 days', caption: 'Net flow per UTC day, 16 Oct to 22 Oct. White bars: the bridge. Cyan bars: the shielded pool. A bar below the line is a net outflow.', present: true },
  ];
  const watch: WatchLine[] = [...Array(100)].map((_, i) => ({
    address: `${i % 2 ? 'tnam1q' : 'osmo1'}digest${String(i).padStart(3, '0')}${'q'.repeat(30)}`, chain: i % 2 ? 'namada' : 'osmosis',
    now: 1000 + i, nowAt: T - 10 * MIN, base: 900, baseAt: A24 - 5 * MIN,
  }));
  return { fig, now, watch };
}

describe('Discord limits on the largest fixture, and the trim order', () => {
  const { fig, now, watch } = maximal();
  const body = buildDigest(fig, now, 'daily');
  const own = (t: typeof TRIM_FULL) => watchlistEmbed(watch, now, 'daily', t.watchLines);
  const r = fitMessage({ shared: body.render, own, gallery: body.gallery });

  it('the message fits every limit: 5,800 in all, 1,024 a field, 256 the title, 4,096 the description, 25 fields, 10 embeds', () => {
    expect(r.fits).toBe(true);
    expect(messageCount(r.embeds)).toBeLessThanOrEqual(DIGEST_MESSAGE_MAX);
    // the own embed, in this message or apart for the next one, is within its share
    const own = r.ownApart ?? r.embeds[r.embeds.length - 1];
    expect(discordCount(own)).toBeLessThanOrEqual(DIGEST_OWN_MAX);
    expect(discordCount(r.embeds[0])).toBeLessThanOrEqual(DIGEST_SHARED_ALONE_MAX);
    if (!r.ownApart) expect(discordCount(r.embeds[0])).toBeLessThanOrEqual(DIGEST_MESSAGE_MAX - discordCount(own));
    expect(r.embeds.length).toBeLessThanOrEqual(DISCORD_EMBEDS_MAX);
    for (const e of [...r.embeds, ...(r.ownApart ? [r.ownApart] : [])]) {
      expect((e.title ?? '').length).toBeLessThanOrEqual(DISCORD_TITLE_MAX);
      expect((e.description ?? '').length).toBeLessThanOrEqual(DISCORD_DESCRIPTION_MAX);
      expect((e.fields ?? []).length).toBeLessThanOrEqual(DISCORD_FIELDS_MAX);
      for (const f of e.fields ?? []) { expect(f.name.length).toBeLessThanOrEqual(256); expect(f.value.length).toBeLessThanOrEqual(DISCORD_FIELD_MAX); }
    }
  });

  it('trimmed in the documented order, as far as it had to', () => {
    // the shared embed's steps that drop no figure are all spent before one that drops a figure is taken
    const t = body.trim;
    if (t.movers < 5 || t.captions === 'none') {
      expect(t.captions).not.toBe('full');
      expect(t.govTitle).toBe(40);
      expect(t.providers).toBe(false);
    }
    if (!t.providers) expect(t.govTitle).toBe(40);
    if (t.govTitle === 40) expect(t.captions).not.toBe('full');
    if (t.captions === 'none') expect(t.movers).toBe(0);
    // this fixture is over the whole message even then: the movers and the attached charts' captions went
    expect(t).toMatchObject({ captions: 'none', movers: 0, govTitle: 40, providers: false });
    // the own embed's lines were cut to fit its own budget, and nothing of the shared embed for it
    const ownAlone = watchlistEmbed(watch, now, 'daily', 20);
    expect(discordCount(ownAlone)).toBeGreaterThan(DIGEST_OWN_MAX);
    expect(discordCount(r.ownApart ?? r.embeds[r.embeds.length - 1])).toBeLessThanOrEqual(DIGEST_OWN_MAX);
    expect(r.trim.watchLines).toBe(5);
    expect(r.embeds[0]).toEqual(body.shared);
  });

  it('a cut never splits a number from its mark, nor a link or a code span', () => {
    for (const e of r.embeds) for (const f of e.fields ?? []) {
      if (!f.value.endsWith('…')) continue;
      const head = f.value.slice(0, -1);
      expect(head, f.name).not.toMatch(/[\d%]$/);
      expect(head, f.name).not.toMatch(/NAM$/);
      expect((head.split('`').length - 1) % 2, f.name).toBe(0);
      const lb = head.lastIndexOf('[');
      if (lb >= 0) expect(head.slice(lb).includes('](') && !head.slice(lb).includes(')'), f.name).toBe(false);
    }
  });

  it('the Sources overflow landed in Sources (2), the providers dropped only when the order reached them', () => {
    const names = r.embeds[0].fields!.map((f) => f.name);
    expect(names).toContain('Sources (1)');
    expect(names).toContain('Sources (2)');
    const all = sources(r.embeds[0]);
    expect(all).toHaveLength(17);
    expect(all.some((s) => s.includes('(Papadritta)'))).toBe(r.trim.providers);
  });

  it('outside text is shown as text: a title with "](" cannot carry a link, a backtick cannot close a code span, nothing is a mention', () => {
    const s = JSON.stringify(r.embeds);
    expect(s).not.toContain('](https://evil.example/x)');
    expect(s).toContain('evil] (https://evil.example/x)');
    expect(s).not.toContain('javascript:');
    expect(field(renderShared(fig, now, 'daily', TRIM_FULL).embed, 'Governance')).toContain('…](https://namada.valopers.com/proposals/100); #101 [');
    expect(field(r.embeds[0], 'Validators')).toContain('250 state changes (Tick tock  consensus → jailed, V001');
    expect(s).not.toContain('@');
  });

  it('the last resort shortened the longest fields, each still ending with "…" and none below its floor', () => {
    expect(r.hardCut).toBe(true);
    expect(body.hardCut).toBe(true);
    const shared = r.embeds[0];
    expect(field(shared, 'Validators').endsWith('…')).toBe(true);
    expect(field(shared, 'Governance').endsWith('…')).toBe(true);
    for (const f of shared.fields!) expect(f.value.length).toBeGreaterThanOrEqual(1);
    // the digest's own figures are untouched by it: the short fields are whole
    expect(field(shared, 'Rewards claimed (24 h)')).toBe('17 claims, 3,250.15 NAM, largest 928.27 NAM ³.');
    expect(sources(shared)).toHaveLength(17);
  });

  it('the late note is in the description and the window names the send time', () => {
    expect(r.embeds[0].description).toContain('The 24 h to <t:1792742580:f>.');
    expect(r.embeds[0].description!.endsWith(' Sent at 08:03 UTC, the first run at or after 08:00 UTC in which it could be sent (3 min late).')).toBe(true);
  });

  it('the tie of 20 is said in digits, the delegator word once', () => {
    expect(field(renderShared(fig, now, 'daily').embed, 'Bond and unbond requests (24 h)')).toContain('largest 50,000.00 NAM (20 of that size at 12:35 UTC yesterday, block 8,374,275, to seven validators)');
    const movers = field(buildDigest(figures(), T, 'daily').shared, 'Validators');
    expect(movers.match(/delegators\)/g)).toHaveLength(1);
    expect(movers.match(/\(\d+ → \d+/g)).toHaveLength(4);
  });
});

describe('the late note', () => {
  it('none at 08:00:30, "3 min late" at 08:03, "5 h 2 min late" at 13:02 with the window to 13:02', () => {
    expect(lateNote(T + 30_000)).toBe('');
    expect(lateNote(T + 3 * MIN)).toBe(' Sent at 08:03 UTC, the first run at or after 08:00 UTC in which it could be sent (3 min late).');
    const fig = figures();
    const now = T + 5 * HOUR + 2 * MIN;
    const e = buildDigest(fig, now, 'daily').shared;
    expect(e.title).toBe('NAM daily digest · Fri 23 Oct 2026, 13:02 UTC');
    expect(e.description).toContain('The 24 h to <t:1792760520:f>.');
    expect(e.description!.endsWith('(5 h 2 min late).')).toBe(true);
  });
});

describe('the pipeline arithmetic on fixed listings and queue', () => {
  it('the identity, the direct sum and the "still waiting" clause when they differ, the epoch ranges from the listings', () => {
    const fig = figures();
    const p = value(fig.pipeline);
    p.base!.withdrawable = 38029599.847648 - 7000;
    p.directMatured = { nam: 5000, n: 2 };
    const v = field(buildDigest(fig, T, 'daily').shared, 'Unbonding pipeline');
    expect(v).toContain('Became withdrawable in the last 24 h (epochs 2,693–2,696): 7,000.00 NAM ⁴ ³ (of which 5,000.00 NAM still waiting to be withdrawn); withdrawn in the 24 h:');
  });

  it('no base listing: the direct sum with its caveat; no base epoch either: not computed', () => {
    const fig = figures();
    const p = value(fig.pipeline);
    p.base = null;
    p.directMatured = { nam: 0, n: 0 };
    expect(field(buildDigest(fig, T, 'daily').shared, 'Unbonding pipeline')).toContain('Became withdrawable in the last 24 h (epochs 2,693–2,696): 0.00 NAM ⁴ (unbonds withdrawn since are not counted: no bond listing 24 h ago);');
    p.baseEpoch = null;
    p.directMatured = null;
    expect(field(buildDigest(fig, T, 'daily').shared, 'Unbonding pipeline')).toContain('Became withdrawable in the last 24 h: not computed (no bond listing 24 h ago and the epoch then is not read);');
  });

  it('E_end from the anchor: +4 at 08:00 and at 03:40, +5 once 24 h on reaches the fifth epoch; e24 = 4 without it', () => {
    const clock = figures().anchors.epoch!;
    const started = clock.startedAt!;
    expect(epochRange(clock, T, DAY)!.end).toBe(2700);
    expect(epochRange(clock, Date.UTC(2026, 9, 23, 3, 40), DAY)!.end).toBe(2700);
    expect(epochRange(clock, Date.UTC(2026, 9, 23, 9, 35), DAY)!.end).toBe(2701);
    expect(epochRange(clock, Date.UTC(2026, 9, 23, 9, 32), DAY)!.end).toBe(2700);
    const r = epochRange({ ...clock, startedAt: null, plusMinusMs: null }, T, DAY)!;
    expect(r.end).toBe(2700);
    expect(r.about).toBe(true);
    expect(r.clockOf(2704)).toBeNull();
    // the clock of the next bucket: eight epochs after the anchor
    const at = epochRange(clock, T, DAY)!.clockOf(2704)!;
    expect(new Date(at).toISOString()).toBe(new Date(started + 8 * 21617.16293333333 * 1000).toISOString());
    expect(new Date(at).toISOString().slice(0, 16)).toBe('2026-10-25T03:35');
    // the weekly's horizon lists the buckets of the next seven days
    expect(epochRange(clock, T, 7 * DAY)!.end).toBe(2696 + Math.floor((7 * DAY + (T - started)) / (21617.16293333333 * 1000)));
  });

  it('buckets inside the horizon are listed with their clocks; none left says so', () => {
    const fig = figures();
    const p = value(fig.pipeline);
    p.buckets = [{ epoch: 2698, nam: 1000, n: 1 }, { epoch: 2700, nam: 250.5, n: 2 }];
    expect(field(buildDigest(fig, T, 'daily').shared, 'Unbonding pipeline')).toContain(
      // 03:33:03 + 2 × 21,617.16 s = 15:33:37; + 4 × 21,617.16 s = 03:34:12 the next day
      'Unlocking in the next 24 h (epochs 2,697–2,700): 1,250.50 NAM in 3 unbonds ⁴; NAM (unbonds) at epoch, about when UTC ± 10 min ⁵: 1,000.00 (1) at 2,698, 23 Oct 15:33; 250.50 (2) at 2,700, 24 Oct 03:34.',
    );
    p.buckets = [{ epoch: 2700, nam: 250.5, n: 2 }];
    expect(field(buildDigest(fig, T, 'daily').shared, 'Unbonding pipeline')).toContain(
      'Unlocking in the next 24 h (epochs 2,697–2,700): 250.50 NAM (2 unbonds) at epoch 2,700, about 03:34 UTC on 24 Oct (± 10 min) ⁴ ⁵.',
    );
    p.buckets = [];
    expect(field(buildDigest(fig, T, 'daily').shared, 'Unbonding pipeline')).toContain('Unlocking in the next 24 h (epochs 2,697–2,700): 0.00 NAM ⁴; nothing further in the queue.');
  });
});

describe('the price\'s source, the states not compared and the matured unbonds without a base listing', () => {
  it('names the price as it was read: the route quote by its name, its note the part the provider trim drops; not read, the way of the last reading', () => {
    const fig = figures();
    value(fig.price).source = { name: 'Osmosis SQS route spot, 1,000 NAM (stored)', note: 'the price list gave NAM no price, so the route quote stands' };
    expect(sources(renderShared(fig, T, 'daily', TRIM_FULL).embed)).toContain('⁶ Osmosis SQS route spot, 1,000 NAM (stored) 07:59 UTC (the price list gave NAM no price, so the route quote stands)');
    expect(sources(renderShared(fig, T, 'daily', { ...TRIM_FULL, providers: false }).embed)).toContain('⁶ Osmosis SQS route spot, 1,000 NAM (stored) 07:59 UTC');
    value(fig.price).quote = notRead('Osmosis SQS (price)', T - 3 * HOUR);
    expect(sources(buildDigest(fig, T, 'daily').shared)).toContain('⁶ Osmosis SQS route spot, 1,000 NAM (stored): not read, last answered 05:00 UTC');
    // without a source the quote service is named, as before the record existed
    expect(sources(buildDigest(figures(), T, 'daily').shared)).toContain('⁶ Osmosis SQS quote 07:59 UTC');
  });

  it('with every validator\'s state off the record in one snapshot, the states are said not compared, never "0 state changes"', () => {
    const fig = figures();
    const v = value(fig.validators);
    v.statesNotCompared = v.today.validators - v.joined;
    v.stateChanges = [];
    const text = field(buildDigest(fig, T, 'daily').shared, 'Validators');
    expect(text).toContain('0 joined, 0 left, states not compared (not on record in one snapshot) (listing');
    expect(text).not.toContain('0 state changes');
  });

  it('with no base listing, what matured is the queue\'s own sum over the epochs since the base instant, with its count', () => {
    const fig = figures();
    const p = value(fig.pipeline);
    p.base = null;
    p.baseEpoch = 2692;
    p.directMatured = { nam: 5139.77, n: 34 };
    expect(field(buildDigest(fig, T, 'daily').shared, 'Unbonding pipeline')).toContain(
      'Became withdrawable in the last 24 h (epochs 2,693–2,696): 5,139.77 NAM in 34 unbonds ⁴ (unbonds withdrawn since are not counted: no bond listing 24 h ago);',
    );
  });
});

describe('the weekly variant and the keys', () => {
  const MON = Date.UTC(2026, 9, 26, 8);

  it('names the seven days to the send time, the ISO week key, the 7 d windows, and the series that start inside the week', () => {
    const fig = figures();
    fig.kind = 'weekly';
    fig.now = MON;
    // the indexes and the data API as read at the Monday's tick (the daily fixture's stamps are three days old by then)
    fig.anchors.namada!.cursorAt = MON - MIN;
    fig.anchors.osmosis = { live: { connected: true, at: MON - MIN, height: 73054078 }, sweep: { height: 73054078, at: MON - 2 * MIN } };
    (value(fig.trades).dataApi as any).at = MON - 2 * MIN;
    value(fig.staked).stakers = { value: 19340, at: MON - 20 * MIN, cadenceMs: CADENCE.bondListing, bases: [{ label: '7 d', instant: MON - 7 * DAY, base: { seriesStart: Date.UTC(2026, 9, 20, 21, 47) } }] };
    value(fig.price).quote.bases = [
      { label: '7 d', instant: MON - 7 * DAY, base: { at: MON - 7 * DAY - 58_000, value: 0.00101543 } },
      { label: '30 d', instant: MON - 30 * DAY, base: { seriesStart: Date.UTC(2026, 9, 15, 4, 14) } },
    ];
    const body = buildDigest(fig, MON, 'weekly');
    const e = body.shared;
    expect(e.title).toBe('NAM weekly digest · 7 days to Mon 26 Oct 2026, 08:00 UTC');
    expect(e.description).toContain('· price $0.00087359 ⁶ (−13.97 % / 7 d) · 9 trades, 60,537.86 NAM ⁸. The 7 × 24 h to <t:1793001600:f>. Each mark');
    expect(e.footer!.text).toBe('NamadaTrade · weekly digest · figures as read · turn it off in Settings');
    expect(e.color).toBe(0x3498db);
    expect(body.key).toBe('alert:digest:weekly:2026-W44');
    expect(body.what).toBe('weekly digest 2026-W44');
    expect(e.fields!.map((f) => f.name).slice(0, 8)).toEqual(['Staked NAM', 'Bond and unbond requests (7 d)', 'Unbonding pipeline', 'Rewards claimed (7 d)', 'Price', 'Trades', 'Bridge (7 d)', 'Shielded pool (7 d)']);
    expect(field(e, 'Staked NAM')).toContain('19,340 stakers (no reading 7 d ago: series starts 20 Oct 21:47 UTC) with 246 validators ⁴.');
    expect(field(e, 'Price')).toContain('· 7 d −13.97 % (vs $0.00101543, 19 Oct 07:59 UTC) · (no reading 30 d ago: series starts 15 Oct 04:14 UTC)');
    expect(field(e, 'Unbonding pipeline')).toContain('Unlocking in the next 7 days (epochs');
    expect(field(e, 'Trades')).toContain('No executed NAM/USDC trade in the last 24 h (last 23 Oct 05:00 UTC) ⁷. 7 d: 9 trades,');
    expect(field(e, 'Trades')).toContain('Osmosis data API 7 d: $41.74 ⁹.');
    expect(field(e, 'Trades')).not.toContain('counted to');
    expect(field(e, 'Governance')).toContain('Ending within 7 days (epochs');
    expect(field(e, 'Holders')).toContain('(53.24 % 7 d ago)');
  });

  it('isoWeek and the keys: 2026-10-26 is 2026-W44, 2026-01-01 (a Thursday) is in 2026-W01, a daily key is the UTC date', () => {
    expect(isoWeek(MON)).toBe('2026-W44');
    expect(isoWeek(Date.UTC(2026, 0, 1, 12))).toBe('2026-W01');
    expect(new Date(Date.UTC(2026, 0, 1)).getUTCDay()).toBe(4);
    expect(isoWeek(Date.UTC(2025, 11, 29))).toBe('2026-W01');
    expect(isoWeek(Date.UTC(2025, 11, 28))).toBe('2025-W52');
    expect(digestKey(T, 'daily')).toBe('alert:digest:daily:2026-10-23');
    expect(digestKey(T + 15 * HOUR + 59 * MIN, 'daily')).toBe('alert:digest:daily:2026-10-23');
    expect(digestLabel(T, 'daily')).toBe('digest 2026-10-23');
    expect(digestKey(MON, 'weekly')).toBe('alert:digest:weekly:2026-W44');
  });
});

describe('the subscriber\'s watchlist embed', () => {
  const lines: WatchLine[] = [
    { address: TNAM, chain: 'namada', now: 1_250_000, nowAt: 1792741923099, base: 1_262_500, baseAt: 1792654025087 },
    { address: OSMO, chain: 'osmosis', now: 2_100, nowAt: 1792741802657, base: 2_100, baseAt: 1792655402216 },
  ];

  it('renders the two lines of section 7.2 and the closing rule', () => {
    const e = watchlistEmbed(lines, T);
    expect(e.title).toBe('Your watchlist (24 h)');
    expect(e.color).toBe(0x9b59b6);
    expect(e.description).toBe(
      '`tnam1qdigestex…qqqqqq`  −12,500.00 NAM spendable (now 1,250,000.00 NAM) — Namada, as of the 07:52 UTC listing; 24 h ago from the reading at 07:27 UTC yesterday\n' +
      '`osmo1digestexa…qqqqqq`  no change (2,100.00 NAM) — Osmosis, as of the 07:50 UTC pass\n' +
      'Spendable NAM only; staked changes are not computed. Addresses are shown shortened, never their tags. One digest per channel.',
    );
    expect(e.description).not.toContain(TNAM);
  });

  it('the not-listed and not-known shapes', () => {
    const e = watchlistEmbed([
      { address: TNAM, chain: 'namada', now: null, nowAt: null, base: null, baseAt: null },
      { address: OSMO, chain: 'osmosis', now: 1_250_000, nowAt: 1792741802657, base: null, baseAt: null },
    ], T);
    const [a, b] = e.description!.split('\n');
    expect(a).toBe('`osmo1digestexa…qqqqqq`  24 h ago: not known (no reading) — now 1,250,000.00 NAM');
    expect(b).toBe('`tnam1qdigestex…qqqqqq`  not listed (the chain lists no spendable NAM for it)');
  });

  it('sorts by |change| then address, shows 20 lines, then "and N more" with the unchanged and not-read counts; trims to 10 and 5', () => {
    const many: WatchLine[] = [...Array(26)].map((_, i) => ({
      address: `tnam1qdigest${String(i).padStart(2, '0')}${'q'.repeat(30)}`, chain: 'namada',
      now: i < 3 ? 100 : i < 5 ? null : 1000, nowAt: T - MIN, base: i < 3 ? 100 : i < 5 ? null : 1000 - (26 - i) * 10, baseAt: A24,
    }));
    const e = watchlistEmbed(many, T);
    const rows = e.description!.split('\n');
    expect(rows).toHaveLength(22);
    expect(rows[0]).toContain('`tnam1qdigest05…qqqqqq`  +210.00 NAM spendable');
    expect(rows[19]).toContain('`tnam1qdigest24…qqqqqq`  +20.00 NAM spendable');
    expect(rows[20]).toBe('and 6 more: 3 unchanged, 2 not read');
    expect(discordCount(e)).toBeGreaterThan(DIGEST_OWN_MAX);
    expect(watchlistEmbed(many, T, 'daily', 10).description!.split('\n')[10]).toBe('and 16 more: 3 unchanged, 2 not read');
    expect(watchlistEmbed(many, T, 'daily', 5).description!.split('\n')).toHaveLength(7);
    // lines of the changed shape run to about 115 characters, so five fit the own budget where ten do not
    expect(discordCount(watchlistEmbed(many, T, 'daily', 5))).toBeLessThanOrEqual(DIGEST_OWN_MAX);
    const r = fitMessage({ shared: buildDigest(figures(), T, 'daily').render, own: (t) => watchlistEmbed(many, T, 'daily', t.watchLines) });
    expect(r.fits).toBe(true);
    expect(r.hardCut).toBe(false);
    expect(r.trim.watchLines).toBe(5);
    expect(r.trim.movers).toBe(5);
  });

  it('the cap note and the failed read, and the weekly\'s 7 d words', () => {
    expect(watchlistEmbed(notRead('this site', null, "the digest's address cap (5,000) was reached; see the Holders page"), T).description)
      .toBe("Your watchlist: not read this time — the digest's address cap (5,000) was reached; see the Holders page.");
    expect(watchlistEmbed(notRead('holders', null, DB_NOT_ANSWERED), T).description).toBe('Your watchlist: not read — the database did not answer this read.');
    const w = watchlistEmbed(lines, T, 'weekly');
    expect(w.title).toBe('Your watchlist (7 d)');
    expect(w.description).toContain('; 7 d ago from the reading at 07:27 UTC yesterday');
  });
});

describe('direction words and denominators', () => {
  it('a bridge fixture with Osmosis ibc_in 5 / ibc_out 1 says Namada → Osmosis for the ibc_in sum, and no key name appears', () => {
    const fig = figures();
    value(fig.bridge).ibcIn = { n: 5, nam: 5000, largest: 2000, late: 1 };
    value(fig.bridge).ibcOut = { n: 1, nam: 100, largest: 100, late: 0 };
    value(fig.bridge).refunded = { n: 1, nam: 50 };
    const v = field(buildDigest(fig, T, 'daily').shared, 'Bridge (24 h)');
    expect(v.startsWith('Namada → Osmosis 5,000.00 NAM (5 crossings, largest 2,000.00, 1 found late). Osmosis → Namada 100.00 NAM (1 crossing). (1 refunded, 50.00 NAM, left out.) Net 4,900.00 NAM to Osmosis ⁸. Escrow 20,832,856.30 NAM ¹⁰, −357,587.45 / 24 h (differs by 362,487.45 NAM).')).toBe(true);
    expect(v).not.toMatch(/ibc_in|ibc_out|in_daily|out_daily/);
  });

  it('the top-10 lines name "of minted NAM" and "of the NAM on Osmosis"; the staking share names "of stake"', () => {
    const v = field(buildDigest(figures(), T, 'daily').shared, 'Holders');
    expect(v).toContain('% of minted NAM ¹³');
    expect(v).toContain('% of the NAM on Osmosis ¹⁵');
    expect(v).toContain('% of stake ⁴');
  });

  it('the shielded pool: a differing balance names the rewards, a shielded IBC withdrawal is an out', () => {
    const fig = figures();
    value(fig.masp).ibcOut = { n: 1, nam: 500 };
    const v = field(buildDigest(fig, T, 'daily').shared, 'Shielded pool (24 h)');
    expect(v).toContain('Out 503.28 NAM (4 unshieldings, 1 shielded IBC withdrawal, incl. 0.24 NAM of fees). Net +99,499.73 NAM ³. Pool balance 49,187,665.01 NAM ¹¹, +99,999.73 / 24 h (differs by 500.00 NAM: shielded rewards accrue inside the pool once per MASP epoch with no event).');
  });

  it('governance with claims: the proposals named and linked, a claimed id off the page said so, the ending ones on the clock', () => {
    const fig = figures();
    const gov = value(fig.governance);
    gov.proposals[0] = { ...gov.proposals[0], status: 'voting', endEpoch: 2699, discussionsUrl: 'https://forum.namada.net/t/knowable' };
    gov.opened = [{ id: 42, at: T - 2 * HOUR }, { id: 7, at: T - HOUR }];
    gov.closed = [{ id: 41, status: 'executedPassed', at: T - 3 * HOUR }];
    const v = field(renderShared(fig, T, 'daily', TRIM_FULL).embed, 'Governance');
    expect(v).toBe(
      'Opened: #42 [Signalling - Knowable is leaving Namada](https://forum.namada.net/t/knowable); #7 (not among the 20 newest on record). ' +
      'Closed: #41 [Whitelist Osmosis and Cosmos Hub channels permissionlessly](https://namada.valopers.com/proposals/41) passed. ' +
      'Ending within 24 h (epochs 2,697–2,700): #42 [Signalling - Knowable is leaving Namada](https://forum.namada.net/t/knowable), voting ends at epoch 2,699, about 13 h 34 min ⁵. ' +
      'Newest of the 20 proposals read: #42 (voting) ¹⁶. The list is page 1 only (the 20 newest): a proposal older than those that changes state is not named here.',
    );
  });
});

describe('the operator embed', () => {
  it('names a source that flipped and recovered, one still down, a failing check, a held post, yesterday\'s counts and a missed day', () => {
    const ops: OperatorFigures = {
      ...operator(),
      health: { value: { ok: 27, total: 28, notOk: [{ name: 'Keplr Osmosis REST (holders)', since: T - 70 * MIN, note: 'HTTP 502' }] } },
      healthLog: { value: { firstAt: T - 30 * HOUR, flips: [{ name: 'Namada RPC Papadritta', from: Date.UTC(2026, 9, 23, 3, 12), to: Date.UTC(2026, 9, 23, 3, 40), note: 'timeout' }, { name: 'Keplr Osmosis REST (holders)', from: T - 70 * MIN, to: null, note: 'HTTP 502' }] } },
      checks: { value: { ok: 10, total: 11, failing: [{ key: 'bonded_coverage', status: 'warn', since: Date.UTC(2026, 9, 23, 4, 0) }] } },
      skipped: { what: 'digest 2026-10-22', n: 4, at: Date.UTC(2026, 9, 22, 8, 0, 49), total: 9 },
      previous: { last: { key: 'alert:digest:daily:2026-10-22', at: Date.UTC(2026, 9, 22, 8), targets: 501, posted: 497, skipped: 4 }, missed: [] },
      channels: 501, subscribers: 500, watchCapWallets: 2,
    };
    expect(operatorEmbed(ops, T).description).toBe(
      'Sources at 08:00 UTC: 27 of 28 ok; not ok: Keplr Osmosis REST (holders) since 06:50 UTC: HTTP 502. ' +
      'Degraded during the day: Namada RPC Papadritta: not ok 03:12–03:40 UTC (28 min); Keplr Osmosis REST (holders): not ok since 06:50 UTC (still).\n' +
      'Checks: 10 of 11 ok; bonded_coverage warn since 04:00 UTC.\n' +
      'Alerts in the 24 h: 14 posted (14 moves, 5 of them bridge crossings; first 08:07 UTC yesterday, last 02:34 UTC today); 4 posts for digest 2026-10-22 not sent at 08:00 UTC yesterday; 9 in all.\n' +
      "This digest: 501 channels (500 subscribers). Yesterday's digest reached 497 of 501 channels (4 not sent).\n" +
      'The per-user address cap (5,000) was reached: 2 wallets got no watchlist.',
    );
    const missed = operatorEmbed({ ...operator(), previous: { last: null, missed: ['2026-10-22'] } }, T).description!;
    expect(missed.endsWith('This digest: the operator channel only (0 subscribers). No digest was sent on 22 Oct (no run between 08:00 and 24:00 UTC).')).toBe(true);
    const young = operatorEmbed({ ...operator(), healthLog: { value: { firstAt: T - 5 * HOUR, flips: [] } } }, T).description!;
    expect(young).toContain('Sources at 08:00 UTC: 28 of 28 ok. Faults that cleared before 03:00 UTC have no record.');
  });

  it('a quiet day prints the all-clear sentence', () => {
    const ops: OperatorFigures = {
      ...operator(),
      healthLog: { value: { firstAt: T - 3 * DAY, flips: [] } },
      previous: { last: { key: 'alert:digest:daily:2026-10-22', at: Date.UTC(2026, 9, 22, 8), targets: 13, posted: 13, skipped: 0 }, missed: [] },
      channels: 13, subscribers: 12,
    };
    expect(operatorEmbed(ops, T).description).toBe(
      'All sources answered through the day; every check passed; no alert post was held back; the digest reached every channel.\n' +
      'This digest: 13 channels (12 subscribers).',
    );
  });

  it('a failed operator read says so per line, never a count', () => {
    const ops: OperatorFigures = { ...operator(), health: notRead('source.health', null, DB_NOT_ANSWERED), claims: notRead('alert claims', null, DB_NOT_ANSWERED) };
    const d = operatorEmbed(ops, T).description!;
    expect(d).toContain('Sources at 08:00 UTC: not read — the database did not answer this read.');
    expect(d).toContain('Alerts in the 24 h: not read — the database did not answer this read. None not sent on record.');
  });
});

describe('the chart attachments', () => {
  it('the first present chart is the shared embed\'s image, the others share its url, the captions are fields, the absent one says why', () => {
    const { fig, now } = maximal();
    const body = buildDigest(fig, now, 'daily');
    expect(body.files).toEqual(['price-7d.png', 'stake-30d.png', 'flows-7d.png']);
    expect(body.shared.image).toEqual({ url: 'attachment://price-7d.png' });
    expect(body.gallery).toEqual([{ url: DIGEST_URL, image: { url: 'attachment://stake-30d.png' } }, { url: DIGEST_URL, image: { url: 'attachment://flows-7d.png' } }]);
    const full = renderShared(fig, now, 'daily', TRIM_FULL).embed;
    expect(full.fields!.map((f) => f.name).slice(11, 15)).toEqual(['① Price, 7 days', '② Staked NAM, 30 days', '③ Unlocks, next 30 days', '④ Net flow, 7 days']);
    expect(field(full, '② Staked NAM, 30 days')).toBe('Total stake per hour, 30 days to 23 Oct 08:00 UTC (124 of 124 hours read). The axis is fitted to the readings. The series starts 18 Oct 04:00 UTC; the chart is blank before it.');
    expect(field(full, '③ Unlocks, next 30 days')).toBe("Unlocks: no chart — the chain's bond listing is 2 h 10 min old (bound 2 h) (last read 05:50 UTC).");
    const first = renderShared(fig, now, 'daily', { ...TRIM_FULL, captions: 'first' }).embed;
    expect(field(first, '② Staked NAM, 30 days')).toBe('Total stake per hour, 30 days to 23 Oct 08:00 UTC (124 of 124 hours read).');
    expect(field(first, '① Price, 7 days')).toBe('Price, 7 days to 23 Oct 08:00 UTC.');
    // the gallery embeds carry no text, so they cost nothing against the budget and the message stays within 10 embeds
    const r = fitMessage({ shared: body.render, own: operatorEmbed(operator(), now), gallery: body.gallery });
    expect(r.embeds[1].image!.url).toBe('attachment://stake-30d.png');
    // this fixture's shared embed leaves no room beside it: the Operator embed goes first in the next message
    expect(r.embeds).toHaveLength(3);
    expect(r.ownApart!.title).toBe('Operator');
  });
});

describe('the field cut', () => {
  it('ends with "…" at a word boundary, never between a number and its mark, never inside a link or a code span', () => {
    const num = `${'word '.repeat(200)}1,234.00 NAM ¹⁷ and more words`;
    const cut = cutValue(num, 1024);
    expect(cut.length).toBeLessThanOrEqual(1024);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut).not.toMatch(/NAM…$/);
    expect(cut).not.toMatch(/\d…$/);
    const link = `${'word '.repeat(200)}[tx ↗](https://namada.valopers.com/transactions/${'A'.repeat(64)}) tail`;
    const c2 = cutValue(link, 1024);
    expect(c2.endsWith('…')).toBe(true);
    expect(c2).not.toContain('[tx');
    const code = `${'word '.repeat(201)}\`tnam1qdigestex…qqqqqq\` tail`;
    const c3 = cutValue(code, 1024);
    expect((c3.split('`').length - 1) % 2).toBe(0);
    expect(cutValue('short', 1024)).toBe('short');
  });
});
