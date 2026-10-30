// The one place the digest's parts are joined (the digest spec of 2026-10-23 with the owner's decisions of the same
// day). figures.ts, operator.ts and watchlists.ts read D1 and return their own shapes; charts/ draws the pictures;
// attention.ts reads and words the "Trades worth attention" section; message.ts words the message from a figures shape
// of its own. This file maps the readers' shapes onto the message's field by field (a figure that was not read stays
// not read: no field falls back to a default that could print 0), places the attention section, attaches the files
// the embeds name, and returns each recipient's Discord posts in order. readAndBuildDigest runs every read of one
// digest with its bounds; nothing here posts anything, claims anything or writes to the database.
import {
  collectDigestReads, shapeDigestFigures,
  type Anchors, type DigestFigures as ReadFigures, type DigestReads, type RequestKind,
} from './figures';
import { changeFrom, BASE_WINDOW_MS, MINUTE_BOUND_MS } from './freshness';
import {
  CADENCE, DIGEST_MESSAGE_MAX, DISCORD_DESCRIPTION_MAX, DISCORD_EMBEDS_MAX, DISCORD_FIELDS_MAX, DISCORD_FIELD_MAX, DISCORD_MESSAGE_MAX,
  DISCORD_TITLE_MAX, buildDigest, digestPayload, discordCount, fitMessage, messageCount, operatorEmbed, sup, watchlistEmbed,
  type ChangeBase, type ChangeLabel, type ChartRef, type DigestBody, type DigestFigures as MessageFigures, type Embed, type FitPart,
  type MarkKey, type Mark, type Metric, type MetricFigure, type NotRead as MessageNotRead, type OperatorFigures as MessageOperator,
  type QuoteSource, type RequestSide, type TrimState, type WatchLine as MessageWatchLine,
} from './message';
import { PRICE_HOW_KEY, priceHowAt, storedPriceNote, storedPriceSource, type PriceHowLog } from '../price-how';
import { DIGEST_HEALTH_LOG_KV, HEALTH_LOG_PER_NAME, digestKeysAsked, readOperatorFigures, type OperatorFigures as ReadOperator } from './operator';
import { SQL } from './sql';
import {
  DAY_MS, DB_NOT_ANSWERED, digestWindow, isNotRead, notRead, type Change, type DigestKind, type Figure, type MetricFigure as ReadMetric,
  type NotRead,
} from './types';
import { readWatchlists, type WatchLine as ReadWatchLine, type WatchResult, type WatchWallet } from './watchlists';
import { Wave, type Prepared } from './waves';
import { renderChartSet, type ChartSet } from './charts/charts';
import { chartCaptions, readChartRows, shapeCharts, type ChartCaption, type ChartContext } from './charts/read';
import {
  DIGEST_ATTN_LEVELS, DIGEST_ATTN_MESSAGE_MAX, attentionEmbed, attentionForRoom, pictureLeftOut, quoteCoverage, readAttentionFigures,
  renderAttentionPicture, spanWords, supValue, whenWords, type AttentionFigures, type AttentionLevel, type AttentionMarks,
} from './attention';
import type { AttentionPicture } from './charts/attention';

// ------------------------------------------------------------------------------------------------- constants

/** The sender's mark (the owner's decision 5.3: the site's own icon, the Namada mark goes). */
export const DIGEST_AVATAR_URL = 'https://namada.trade/icon-512.png';
/** The attention section's picture, as its embed names it. */
export const DIGEST_ATTN_FILE = 'attention.png';
/** Discord's attachment limits for a webhook post: 10 files, each under 8 MB here, the whole request under 25 MB. */
export const DISCORD_ATTACHMENTS_MAX = 10;
export const DISCORD_FILE_MAX_BYTES = 8 * 1024 * 1024;
export const DISCORD_POST_MAX_BYTES = 25 * 1024 * 1024;
export const DISCORD_FIELD_NAME_MAX = 256;
export const DISCORD_FOOTER_MAX = 2_048;

// ------------------------------------------------------------------------------------------------- not-read reasons

/**
 * The reason a reader gave, as the message's not-read line takes it. figures.ts words a stale reading as "last answered
 * HH:MM UTC, N ago; the figure is not shown" and message.ts composes that same clause from `lastAt`, so the repeated
 * clause is dropped here and only what it adds (an error, a health note) is kept.
 */
export function messageReason(reason: string): string {
  let r = (reason ?? '').trim();
  if (r === DB_NOT_ANSWERED) return r;
  r = r.replace(/^last answered \d\d:\d\d UTC, .*? ago; the figure is not shown/, '');
  r = r.replace(/^never answered; the figure is not shown/, '');
  r = r.replace(/^not read since \d\d:\d\d UTC/, '');
  r = r.replace(/^the balance listing last completed \d\d:\d\d UTC/, '');
  r = r.replace(/^not read this time — /, '');
  r = r.trim();
  const inner = /^\((.*)\)$/.exec(r);
  return inner ? inner[1].trim() : r;
}

/** A reader's NotRead as the message's: the same source and last answer, the reason once. */
export const toMessageNotRead = (nr: NotRead): MessageNotRead => ({ notRead: true, source: nr.source, lastAt: nr.lastAt, reason: messageReason(nr.reason) });

/** Thrown inside a section when a value the message needs is missing although its read answered: the section is then not read, never filled in. */
class Gap extends Error {}
const need = <T>(x: T | null | undefined, what: string): T => {
  if (x == null || (typeof x === 'number' && !Number.isFinite(x))) throw new Gap(what);
  return x;
};
/** A section mapped inside its own try: a missing value makes it a NotRead that names the value. */
function mapped<T>(source: string, fn: () => T): T | MessageNotRead {
  try { return fn(); } catch (e) {
    if (e instanceof Gap) return { notRead: true, source, lastAt: null, reason: `the ${e.message} was not read` };
    throw e;
  }
}

// ------------------------------------------------------------------------------------------------- metrics

/** How often each metrics key is written (message.ts derives each key's bound and its "as of" rule from this). */
export const CADENCE_OF: Readonly<Record<string, number>> = {
  'supply.total_stake': CADENCE.minute, 'supply.pos_bonded': CADENCE.minute, 'supply.total': CADENCE.minute, 'supply.osmosis': CADENCE.minute,
  'supply.ibc_escrow': CADENCE.minute, 'supply.masp_shielded': CADENCE.minute, 'price.usd': CADENCE.minute,
  'stake.stakers': CADENCE.bondListing, 'stake.validators': CADENCE.bondListing, 'stake.top10_pct': CADENCE.bondListing,
  'holders.namada': CADENCE.balanceListing, 'holders.osmosis': CADENCE.hourly,
  'dex.volume_24h_usd_osmosis': CADENCE.hourly, 'dex.volume_7d_usd_osmosis': CADENCE.hourly,
};
const cadenceOf = (key: string): number => CADENCE_OF[key] ?? CADENCE.minute;

/**
 * A change as the message's base: the reading found, the empty window, or the series' start. A series whose first
 * row was not read has no stated start, so it is said as the empty window it is (no reading at or before the instant).
 */
export function baseOf(change: Change, label: ChangeLabel, instant: number): ChangeBase {
  switch (change.kind) {
    case 'ok': return { label, instant, base: { at: change.base.ts, value: change.base.value } };
    case 'no-base': return { label, instant, base: { gap: { from: change.from, to: change.to } } };
    case 'before-start':
      return change.firstTs != null
        ? { label, instant, base: { seriesStart: change.firstTs } }
        : { label, instant, base: { gap: { from: instant - BASE_WINDOW_MS, to: instant } } };
  }
}

/** A metrics figure as the message's Metric: the reading, its key's cadence and its base(s); a NotRead stays one. */
export function metricOf(f: Figure<ReadMetric>, key: string, bases: { label: ChangeLabel; instant: number }[], more: ChangeBase[] = []): MetricFigure {
  if (isNotRead(f)) return toMessageNotRead(f);
  const m: Metric = { value: f.value.value, at: f.value.at, cadenceMs: cadenceOf(key), bases: [...bases.map((b) => baseOf(f.value.change, b.label, b.instant)), ...more] };
  return m;
}
/** A reading without a change (a count at T, the data API's own figure). */
const readingOf = (f: Figure<{ value: number; at: number }>, key: string): MetricFigure =>
  isNotRead(f) ? toMessageNotRead(f) : { value: f.value.value, at: f.value.at, cadenceMs: cadenceOf(key), bases: [] };

// ------------------------------------------------------------------------------------------------- the figures

/** What the adapter takes beside figures.ts's output: reads figures.ts does not make, and the chart references. */
export interface AdapterExtras {
  /** The daily's 7 d price change. Spec 5.5 and 7.1 give the daily a 7 d change ("7 d −13.97 %"); figures.ts reads
   *  the A7 base only for the weekly, so readAndBuildDigest reads it. A NotRead, or absent, leaves the 7 d part out. */
  priceWeek?: Change | NotRead;
  /** The bridge rows found late by side (figures.ts keeps their sum; the message says it per direction). */
  bridgeLate?: { toOsmosis: number; toNamada: number };
  /** The charts present and left out, in order. */
  charts?: ChartRef[];
  /** How the quote at T (or its last reading) was read, as the site names a stored price (kv price.how). */
  priceSource?: QuoteSource;
  /** The record of how the quote was read (kv price.how), so a change's base read another way is named. */
  priceHow?: PriceHowRead;
}

/** The bridge's found-late rows by side from the reads' GROUP BY (Osmosis ibc_in: to Osmosis; ibc_out: to Namada). */
export function bridgeLateOf(reads: DigestReads): { toOsmosis: number; toNamada: number } | undefined {
  if (!reads.bridge.ok) return undefined;
  const late = (k: string) => reads.bridge.ok ? (reads.bridge.rows.find((r) => r.kind === k)?.late ?? 0) : 0;
  return { toOsmosis: late('ibc_in'), toNamada: late('ibc_out') };
}

function anchorsOf(f: ReadFigures): MessageFigures['anchors'] {
  const a: Anchors = f.anchors;
  const e = a.epoch;
  // the balance listing the Namada holder count came from; the kv record's own when the count is not read
  const h = !isNotRead(f.holders) && !isNotRead(f.holders.value.namada) ? f.holders.value.namada.value : null;
  const bal = a.balanceListing;
  return {
    namada: { cursor: a.namada.cursor?.height ?? null, cursorAt: a.namada.cursor?.at ?? null, head: a.namada.head },
    osmosis: { live: a.osmosis.live, sweep: a.osmosis.sweep },
    bondListing: a.bondListing && a.bondListing.completeAt != null
      ? { at: a.bondListing.completeAt, height: a.bondListing.height, epoch: a.bondListing.epoch, provider: a.bondListing.provider }
      : null,
    balanceListing: h && h.listing
      ? { at: h.at, height: h.listing.height, provider: h.listing.provider }
      : bal && bal.completeAt != null ? { at: bal.completeAt, height: bal.height, epoch: bal.epoch, provider: bal.provider } : null,
    epoch: e.eNow == null || e.epochAt == null ? null : {
      epoch: e.eNow,
      at: e.epochAt,
      startedAt: e.startedAt,
      plusMinusMs: e.errorMs,
      params: e.epochMs != null && e.paramsAt != null ? { epochSec: e.epochMs / 1000, epochSecNote: e.epochSecNote, fetchedAt: e.paramsAt } : null,
    },
  };
}

const requestSide = (k: RequestKind): RequestSide => ({
  n: k.n,
  nam: k.nam,
  late: k.late,
  // the explorer files a move under the hash figures.ts resolved (the wrapper's when the row names one)
  largest: k.largest ? { amount: k.largest.amount, ts: k.largest.ts, height: k.largest.height, txHash: k.largest.explorerHash, wrapper: null, validator: k.largest.validator, ties: k.largest.ties, tieValidators: k.largest.validators } : null,
});

/** figures.ts's output as message.ts's input, every field mapped by hand. */
export function toMessageFigures(f: ReadFigures, x: AdapterExtras = {}): MessageFigures {
  const daily = f.kind === 'daily';
  const label: ChangeLabel = daily ? '24 h' : '7 d';
  const base = [{ label, instant: f.from }];
  const nr = toMessageNotRead;

  const staked: MessageFigures['staked'] = isNotRead(f.staked) ? nr(f.staked) : {
    value: {
      totalStake: metricOf(f.staked.value.totalStake, 'supply.total_stake', base),
      posAccount: metricOf(f.staked.value.account, 'supply.pos_bonded', base),
      stakers: metricOf(f.staked.value.stakers, 'stake.stakers', base),
      validators: readingOf(f.staked.value.validators, 'stake.validators'),
    },
    prov: f.staked.stamp,
  };

  const requests: MessageFigures['requests'] = isNotRead(f.requests) ? nr(f.requests) : {
    value: { bonds: requestSide(f.requests.value.bonds), unbonds: requestSide(f.requests.value.unbonds), decodeFailures: f.requests.value.decodeFailures },
    prov: f.requests.stamp,
  };

  const P = f.pipeline;
  const pipeline: MessageFigures['pipeline'] = isNotRead(P) ? nr(P) : mapped(P.stamp.source, () => {
    const p = P.value;
    const m = p.matured;
    const computed = 'notComputed' in m ? null : m;
    // the epoch the base listing ran in (or, with no listing then, the epoch at the base instant): the matured range
    // is (that epoch, the current listing's]
    const epochs = computed ? computed.epochs : 'notComputed' in m ? m.epochs ?? null : null;
    const baseEpoch = epochs ? epochs[0] - 1 : null;
    const w = p.withdrawn;
    const unlocking = isNotRead(p.unlocking) ? null : p.unlocking.value;
    return {
      value: {
        listing: { at: p.listing.at, height: p.listing.height, epoch: p.listing.epoch, provider: p.listing.provider },
        inFlight: p.inFlight,
        withdrawable: p.withdrawable,
        queueFromEpoch: p.withdrawableEpochs[0],
        base: computed ? { listing: { at: computed.base.at, height: null, epoch: baseEpoch, provider: null }, withdrawable: computed.base.withdrawable } : null,
        baseEpoch,
        // read only with a base listing; without one the message says the identity is not computed
        withdrawnBetween: computed ? { nam: computed.withdrawnBetween.nam, n: computed.withdrawnBetween.n } : { nam: 0, n: 0 },
        directMatured: m.direct ? { nam: m.direct.nam, n: m.direct.n } : null,
        // no withdraw group in the window's GROUP BY is a count of zero the read answered, not a missing figure
        withdrawn: w
          ? { n: w.n, nam: w.nam, largest: w.n > 1 ? need(w.largest, 'largest withdrawal') : w.nam, ts: w.n === 1 ? w.lastTs : null }
          : { n: 0, nam: 0, largest: 0, ts: null },
        // the buckets in the horizon and the first after it; the message picks the ones it names by the same clock
        buckets: unlocking ? [...unlocking.buckets, ...(unlocking.next ? [unlocking.next] : [])].map((b) => ({ epoch: b.epoch, nam: b.nam, n: b.n })) : [],
      },
      prov: P.stamp,
    };
  });

  const R = f.rewards;
  const rewards: MessageFigures['rewards'] = isNotRead(R) ? nr(R) : mapped(R.stamp.source, () => ({
    // no claim in the window is a count of zero; with claims the largest is the GROUP BY's own maximum
    value: { n: R.value.n, nam: R.value.nam, largest: R.value.n > 0 ? need(R.value.largest, 'largest claim') : 0, late: R.value.late },
    prov: R.stamp,
  }));

  // the price: the 24 h (or 7 d) change, and the second base: the daily's 7 d, the weekly's 30 d
  let price: MessageFigures['price'];
  if (isNotRead(f.price)) price = nr(f.price);
  else {
    const q = f.price.value.quote;
    let quote: MetricFigure;
    if (isNotRead(q)) quote = nr(q);
    else {
      const second: ChangeBase[] = [];
      if (daily && x.priceWeek && !isNotRead(x.priceWeek)) second.push(baseOf(x.priceWeek, '7 d', f.now - 7 * DAY_MS));
      if (!daily && q.value.longChange) second.push(baseOf(q.value.longChange, '30 d', f.now - 30 * DAY_MS));
      quote = { value: q.value.value, at: q.value.at, cadenceMs: cadenceOf('price.usd'), bases: [baseOf(q.value.change, label, f.from), ...second] };
    }
    let source = x.priceSource;
    if (source && !isNotRead(quote) && x.priceHow !== undefined && !isNotRead(x.priceHow)) {
      const how = x.priceHow;
      const bases = quote.bases.flatMap((b) => {
        if (!('at' in b.base)) return [];
        const name = storedPriceSource(priceHowAt(how, b.base.at));
        return name === source!.name ? [] : [{ label: b.label, name }];
      });
      if (bases.length) source = { ...source, bases };
    }
    price = { value: { quote, ...(source ? { source } : {}) }, prov: f.price.stamp };
  }

  const trades: MessageFigures['trades'] = isNotRead(f.trades) ? nr(f.trades) : (() => {
    const t = f.trades.value;
    // the executed hour lives in the price section: when that section's reads failed it is not read, never "none on record"
    let executed: Exclude<MessageFigures['trades'], MessageNotRead>['value']['executed'];
    let vwap: Exclude<MessageFigures['trades'], MessageNotRead>['value']['vwap'] = null;
    if (isNotRead(f.price)) executed = nr(f.price);
    else if (isNotRead(f.price.value.executed)) executed = nr(f.price.value.executed);
    else {
      const ex = f.price.value.executed.value;
      executed = ex.last ? { hourStart: ex.last.hourStart, price: ex.last.price, n: ex.last.n } : null;
      vwap = ex.vwap ? { n: ex.vwap.n, vwap: ex.vwap.vwap, lo: ex.vwap.lo, hi: ex.vwap.hi } : null;
    }
    return {
      value: {
        executed,
        vwap,
        // with no trade the sum is a real 0; with trades and no priced one it is unknown and stays null
        window: { n: t.n, nam: t.nam, usd: t.n === 0 ? 0 : t.usd, unpriced: t.unpriced, traders: t.traders, buyNam: t.buyNam, sellNam: t.sellNam, overBound: t.more, basis: t.basis },
        dataApi: readingOf(t.apiVolumeUsd, daily ? 'dex.volume_24h_usd_osmosis' : 'dex.volume_7d_usd_osmosis'),
      },
      prov: f.trades.stamp,
    };
  })();

  const B = f.bridge;
  const bridge: MessageFigures['bridge'] = isNotRead(B) ? nr(B) : mapped(B.stamp.source, () => {
    const b = B.value;
    // per side from the reads; without them the sum goes to the one side with crossings, and is left unsaid when both have some
    const late = x.bridgeLate ?? (b.late === 0 ? { toOsmosis: 0, toNamada: 0 } : b.toOsmosis.n === 0 ? { toOsmosis: 0, toNamada: b.late } : b.toNamada.n === 0 ? { toOsmosis: b.late, toNamada: 0 } : { toOsmosis: 0, toNamada: 0 });
    const side = (leg: { n: number; nam: number; largest: number | null }, lateN: number, what: string) =>
      ({ n: leg.n, nam: leg.nam, largest: leg.n > 1 ? need(leg.largest, what) : leg.largest ?? leg.nam, late: lateN });
    return {
      value: {
        ibcIn: side(b.toOsmosis, late.toOsmosis, 'largest crossing to Osmosis'),
        ibcOut: side(b.toNamada, late.toNamada, 'largest crossing to Namada'),
        refunded: { n: b.refunded.n, nam: b.refunded.nam },
        escrow: metricOf(b.escrow, 'supply.ibc_escrow', base),
      },
      prov: B.stamp,
    };
  });

  const masp: MessageFigures['masp'] = isNotRead(f.masp) ? nr(f.masp) : {
    value: {
      shield: { n: f.masp.value.in.shield.n, nam: f.masp.value.in.shield.nam },
      ibcIn: { n: f.masp.value.in.ibcIn.n, nam: f.masp.value.in.ibcIn.nam },
      unshield: { n: f.masp.value.out.unshield.n, nam: f.masp.value.out.unshield.nam },
      ibcOut: { n: f.masp.value.out.ibcOut.n, nam: f.masp.value.out.ibcOut.nam },
      feesNam: f.masp.value.out.feesNam,
      balance: metricOf(f.masp.value.balance, 'supply.masp_shielded', base),
    },
    prov: f.masp.stamp,
  };

  const holders: MessageFigures['holders'] = isNotRead(f.holders) ? nr(f.holders) : (() => {
    const h = f.holders.value;
    const top10 = (t: typeof h.namadaTop10) => (isNotRead(t) ? nr(t) : { nam: t.value.nam, at: t.value.at, previousPct: t.value.yesterday ? t.value.yesterday.share * 100 : null });
    // the pass's trusted start: stale or never trusted says "not current"; a current pass (or no pass record) says nothing
    const nc = isNotRead(h.osmosis) ? null : h.osmosis.value.notCurrent;
    return {
      value: {
        namada: metricOf(h.namada, 'holders.namada', base),
        osmosis: metricOf(h.osmosis, 'holders.osmosis', base),
        osmosisPassTrustedAt: nc ? nc.trustedStartedAt ?? 'never' : null,
        namadaTop10: top10(h.namadaTop10),
        osmosisTop10: top10(h.osmosisTop10),
        mintedNam: metricOf(f.anchors.mintedSupply, 'supply.total', []),
        osmosisNam: isNotRead(h.osmosisTop10) ? nr(h.osmosisTop10) : metricOf(h.osmosisTop10.value.denominator, 'supply.osmosis', []),
        stakeTop10Pct: metricOf(h.stakeTop10Pct, 'stake.top10_pct', base),
      },
      prov: f.holders.stamp,
    };
  })();

  const governance: MessageFigures['governance'] = isNotRead(f.governance) ? nr(f.governance) : {
    value: {
      fetchedAt: f.governance.value.fetchedAt,
      indexerEpoch: f.governance.value.indexerEpoch,
      proposals: f.governance.value.proposals.map((p) => ({
        id: p.id,
        title: p.title,
        // a status the cache does not carry is said as such, never guessed
        status: p.status ?? 'status not stated',
        type: p.type ?? '',
        // a missing epoch compares as no epoch at all (NaN is never inside a range), so the proposal is not "ending"
        startEpoch: p.startEpoch ?? Number.NaN,
        endEpoch: p.endEpoch ?? Number.NaN,
        // figures.ts already resolved the proposal's own discussion link or the valopers page; message.ts keeps a safe link as given
        discussionsUrl: p.link,
      })),
      opened: f.governance.value.opened.map((o) => ({ id: o.id, at: o.at })),
      closed: f.governance.value.closed.map((o) => ({ id: o.id, status: o.status, at: o.at })),
    },
    prov: f.governance.stamp,
  };

  const V = f.validators;
  const validators: MessageFigures['validators'] = isNotRead(V) ? nr(V) : mapped(V.stamp.source, () => {
    const v = V.value;
    const day = (r: typeof v.dayRow, name: string) => ({
      day: r.day, validators: r.validators,
      stake: need(r.stake, `stake of the ${name} snapshot`), asOf: need(r.as_of, `time of the ${name} snapshot`),
      height: need(r.height, `height of the ${name} snapshot`), namesAt: r.names_at,
    });
    // figures.ts compares states with IS NOT, so a state missing from one snapshot (the table's first days kept none)
    // reads as a change; it is a state not on record, so it is counted apart and never shown as "none → jailed"
    const compared = v.stateChanges.filter((s) => s.from != null && s.to != null);
    return {
      value: {
        today: day(v.dayRow, v.day), base: day(v.baseRow, v.baseDay), noListingToday: v.noListingToday, baseIsOldest: v.baseIsOldest,
        statesNotCompared: v.stateChanges.length - compared.length,
        joined: v.joined, left: v.left, gross: need(v.gross, 'gross stake change'),
        movers: v.moves.map((m) => ({ validator: m.validator, name: m.name, state: m.state, d: m.delta, delegatorsToday: m.delegators, delegatorsBase: m.delegatorsBefore })),
        stateChanges: compared.map((s) => ({ validator: s.validator, name: s.name, from: s.from, to: s.to })),
      },
      prov: V.stamp,
    };
  });

  // the depth lines: each line's own figure, the not-read reason kept in the message's words
  const D = f.depth;
  const depth: MessageFigures['depth'] = isNotRead(D) ? nr(D) : {
    value: {
      sizeNam: D.value.sizeNam, withinPct: D.value.withinPct,
      sell: isNotRead(D.value.sell) ? nr(D.value.sell) : D.value.sell.value,
      bids: isNotRead(D.value.bids) ? nr(D.value.bids) : D.value.bids.value,
    },
    prov: D.stamp,
  };

  return {
    kind: f.kind, now: f.now, from: f.from, to: f.to,
    anchors: anchorsOf(f),
    staked, requests, pipeline, rewards, price, trades, bridge, masp, holders, governance, validators, depth,
    charts: x.charts ?? [],
  };
}

// ------------------------------------------------------------------------------------------------- the operator's figures

export interface OperatorExtras {
  /** the health log's oldest entry overall (operator.ts reads the window's entries only); null when the log has none */
  healthLogFirstAt: number | null | NotRead;
  /** this digest's targets, known before the post: every channel, and the subscribers among them */
  channels: number;
  subscribers: number;
  /** wallets past the per-user address cap (watchlists.ts WatchResult.capped) */
  watchCapWallets: number;
}

const dateOfKey = (key: string): string | null => /(\d{4}-\d{2}-\d{2})$/.exec(key)?.[1] ?? null;

/** operator.ts's output as message.ts's OperatorFigures. */
export function toMessageOperator(o: ReadOperator, x: OperatorExtras): MessageOperator {
  const nr = toMessageNotRead;
  const s = o.sources;
  // a note is a sentence of its own; the line adds its stop after it
  const noteOf = (n: string | null) => (n ?? '').trim().replace(/\.+$/, '');
  // a state began at its open flip in the health log; source.health and the checks table keep only the last probe or run
  const openFlip = (name: string): number | null => (isNotRead(s) ? null : s.value.episodes.filter((e) => e.name === name && e.to == null).map((e) => e.from)[0] ?? null);
  const health: MessageOperator['health'] = isNotRead(s) ? nr(s) : {
    value: { ok: s.value.ok, total: s.value.total, notOk: s.value.notOk.map((h) => ({ name: h.name, since: openFlip(h.name), ...(h.since != null ? { asOf: h.since } : {}), note: noteOf(h.note) })) },
  };
  const fa = x.healthLogFirstAt;
  const healthLog: MessageOperator['healthLog'] = isNotRead(s) ? nr(s) : isNotRead(fa) ? nr(fa) : {
    value: {
      firstAt: fa, flips: s.value.episodes.map((e) => ({ name: e.name, from: e.from, to: e.to, note: noteOf(e.note) })),
      // a source whose older changes the log let go is named with how many, so its record's late start is said
      ...(s.value.cut?.length ? { cut: s.value.cut, perName: HEALTH_LOG_PER_NAME } : {}),
    },
  };
  const checks: MessageOperator['checks'] = isNotRead(o.checks) ? nr(o.checks) : {
    value: {
      ok: o.checks.value.ok,
      total: o.checks.value.total,
      failing: o.checks.value.notPassing.map((c) => (c.stale
        ? { key: c.key, status: `${c.status}, not run`, since: c.checkedAt, asOf: c.checkedAt }
        : { key: c.key, status: c.status, since: openFlip(`check:${c.key}`), asOf: c.checkedAt })),
      idle: o.checks.value.idle,
    },
  };
  const al = o.alerts;
  const claims: MessageOperator['claims'] = isNotRead(al) ? nr(al) : {
    value: { n: al.value.claimed.n, moves: al.value.claimed.moves, crossings: al.value.claimed.crossings, firstAt: al.value.claimed.firstAt, lastAt: al.value.claimed.lastAt },
  };
  const skipped: MessageOperator['skipped'] = isNotRead(al) ? nr(al)
    : al.value.skipped ? { what: al.value.skipped.last.what, n: al.value.skipped.last.n, at: al.value.skipped.last.at, total: al.value.skipped.total } : null;

  // the previous period: its delivery record when digest.last is that period's, a missed day when some digest was
  // recorded before it and its key was never claimed, nothing about days before the first digest on record
  let previous: MessageOperator['previous'];
  const d = o.delivery;
  if (isNotRead(d)) previous = nr(d);
  else {
    const { last, previous: prev, dailiesNotSent } = d.value;
    // digest.last holds the latest digest only: it is the previous period's record when it carries that period's key
    const lastMatches = !!last && last.key === prev.key;
    const missed: string[] = [];
    if (o.kind === 'daily') {
      // a day is missed only when a digest was recorded before it (the first day after the deploy has no previous one)
      if (prev.sentAt == null && last) missed.push(dateOfKey(prev.key)!);
    } else {
      const asked = digestKeysAsked(o.now, 'weekly').slice(1);
      const notSent = new Set(dailiesNotSent);
      const firstClaimed = asked.findIndex((k) => !notSent.has(k));
      const weekStart = Date.parse(`${dateOfKey(asked[0])}T00:00:00Z`);
      const existedBefore = prev.sentAt != null || (last != null && last.at < weekStart);
      asked.forEach((k, i) => { if (notSent.has(k) && (existedBefore || (firstClaimed >= 0 && i > firstClaimed))) missed.push(dateOfKey(k)!); });
    }
    previous = { last: lastMatches ? last : null, missed, sentWithoutRecord: prev.sentAt != null && !lastMatches };
  }
  return { health, healthLog, checks, claims, skipped, previous, channels: x.channels, subscribers: x.subscribers, watchCapWallets: x.watchCapWallets };
}

// ------------------------------------------------------------------------------------------------- watchlists

/** One watched address's line as the message's: the reading now and the one at the base instant, each with its time. */
export function toMessageWatchLine(l: ReadWatchLine): MessageWatchLine {
  // the span that held the base value: its first reading is the one known reading of that value at or before the
  // instant (the base rule is the last reading at or before it; the span's later readings may fall after it)
  const baseTime = l.baseSpan ? l.baseSpan.fromTs : null;
  return {
    address: l.address,
    // an address of neither chain is never listed; its chain word is never printed
    chain: l.chain ?? 'namada',
    now: l.status === 'not-listed' ? null : l.now,
    nowAt: l.asOf,
    base: l.status === 'base-unknown' || l.status === 'not-listed' ? null : l.base,
    baseAt: l.status === 'base-unknown' || l.status === 'not-listed' ? null : baseTime,
  };
}

export const toMessageWatch = (lines: ReadWatchLine[] | NotRead): MessageWatchLine[] | MessageNotRead =>
  isNotRead(lines) ? toMessageNotRead(lines) : lines.map((l) => toMessageWatchLine(l));

// ------------------------------------------------------------------------------------------------- the attention section

/**
 * Where the section's marks stand in the digest's numbering. The quote's readings over the window and the trades' own
 * prices are the section's own sources (the digest's quote entry names the reading at the send time, which may not be
 * read while the window's readings are; its trade-index entry names one executed hour), so they get their own marks
 * after the digest's, as do the labels and the coin quotes.
 */
const ATTN_MARK_KEYS: Record<keyof AttentionMarks, MarkKey | null> = {
  scan: 'namadaScan', clock: 'epochClock', quote: null, trades: null, stream: 'osmosisIndex',
  listing: 'balanceListing', pass: 'osmosisHolders', validators: 'validatorDaily', labels: null, coinQuote: null,
};
/** The section's own marks, numbered in this order after the digest's (only those the section uses). */
const ATTN_OWN_ORDER: readonly (keyof AttentionMarks)[] = ['quote', 'trades', 'labels', 'coinQuote'];
/** The entry a shared source gets in the section's own Sources when the digest did not cite it (its section not read). */
const ATTN_SOURCE_TEXT: Record<string, string> = {
  namadaScan: "this site's Namada block scan",
  epochClock: "the epoch clock (the current epoch's first reading and the chain's epoch length)",
  osmosisIndex: "this site's Osmosis stream and catch-up search",
  balanceListing: "the chain's balance listing",
  osmosisHolders: 'Keplr Osmosis REST holder list',
  validatorDaily: 'the daily validator snapshot (the first complete bond listing of each UTC day)',
};
/** The trades' own prices: the settle price of each trade's own coins, else the price recorded with it. */
export const ATTN_TRADES_SOURCE = "this site's Osmosis trade records: each trade's settle price from the coins it gave and got (fees in), else the price recorded with it";

/**
 * The section's marks in the digest's numbering, and the entries its own Sources must add for marks the digest does
 * not list. `used` (the section's own marks it prints) numbers only those, in ATTN_OWN_ORDER; the others follow them.
 */
export function attentionMarks(digestMarks: Mark[], used?: ReadonlySet<keyof AttentionMarks>): { marks: AttentionMarks; extra: { mark: string; text: string }[] } {
  const byKey = new Map(digestMarks.map((m) => [m.key, m.n]));
  let next = digestMarks.reduce((a, m) => Math.max(a, m.n), 0) + 1;
  const marks = {} as AttentionMarks;
  const extra: { mark: string; text: string }[] = [];
  for (const [name, key] of Object.entries(ATTN_MARK_KEYS) as [keyof AttentionMarks, MarkKey | null][]) {
    if (key && byKey.has(key)) { marks[name] = sup(byKey.get(key)!); continue; }
    if (key) { marks[name] = sup(next); extra.push({ mark: sup(next), text: ATTN_SOURCE_TEXT[key] }); next++; }
  }
  const own = used ? [...ATTN_OWN_ORDER.filter((k) => used.has(k)), ...ATTN_OWN_ORDER.filter((k) => !used.has(k))] : ATTN_OWN_ORDER;
  for (const k of own) marks[k] = sup(next++);
  return { marks, extra };
}

const usesMark = (text: string, mark: string): boolean => new RegExp(`(?<![⁰¹²³⁴⁵⁶⁷⁸⁹])${mark}(?![⁰¹²³⁴⁵⁶⁷⁸⁹])`).test(text);
const embedText = (e: Embed): string => [e.title ?? '', e.description ?? '', ...(e.fields ?? []).map((f) => `${f.name}\n${f.value}`)].join('\n');

/** Adds the entries of shared marks the digest does not list (and the A3 level's own entries) to the section's Sources
 *  field, every entry in the order of its mark. */
function withOwnSources(e: Embed, extra: { mark: string; text: string }[], append: string | null): Embed {
  const text = embedText(e);
  const added = [...extra.filter((x) => usesMark(text, x.mark)).map((x) => `${x.mark} ${x.text}`), ...(append ? append.split(' · ') : [])];
  if (!added.length) return e;
  const fields = [...(e.fields ?? [])];
  const at = fields.findIndex((f) => f.name === 'Sources (this embed)');
  const tail = " · other marks: the digest's Sources.";
  const have = at >= 0 ? (fields[at].value.endsWith(tail) ? fields[at].value.slice(0, -tail.length) : fields[at].value).split(' · ') : [];
  const value = `${[...have, ...added].sort((a, b) => supValue(a) - supValue(b)).join(' · ')}${tail}`;
  if (at >= 0) fields[at] = { ...fields[at], value };
  else fields.push({ name: 'Sources (this embed)', value, inline: false });
  return { ...e, fields: fields.map((f) => ({ ...f, value: f.value.length > DISCORD_FIELD_MAX ? `${f.value.slice(0, DISCORD_FIELD_MAX - 1)}…` : f.value })) };
}

/**
 * The source of the quote's minute readings the section shows (the picture's line, each trade's quote move): the
 * readings' span, and how they were read over it as the site names a stored price (kv price.how), each change of way
 * with its time. Several changes in a row name the first ways and count the rest.
 */
export function quoteSeriesSource(how: PriceHowRead, fig: AttentionFigures): string {
  const cov = isNotRead(fig.series) ? null : quoteCoverage(fig.series);
  const span = cov ? `, ${spanWords(cov.first, cov.last, fig.now)}` : '';
  if (isNotRead(how)) return `Osmosis SQS quote, the stored minute quotes${span} (how they were read is not known: its record did not answer)`;
  if (!cov) return `${storedPriceSource(priceHowAt(how, fig.to))}, the stored minute quotes`;
  const ways = [priceHowAt(how, cov.first), ...(how?.log ?? []).filter((e) => Number.isFinite(e?.since) && e.since > cov.first && e.since <= cov.last)];
  const runs: { name: string; since: number }[] = [];
  for (const w of ways) {
    const name = storedPriceSource(w);
    if (runs[runs.length - 1]?.name !== name) runs.push({ name, since: w?.since != null && w.since > cov.first ? w.since : cov.first });
  }
  if (runs.length === 1) return `${runs[0].name}, the stored minute quotes${span}`;
  const named = runs.slice(0, 3).map((r, i) => (i === 0 ? r.name : `from ${whenWords(r.since, fig.now)} ${r.name}`));
  const more = runs.length > 3 ? `; and ${runs.length - 3} more changes of way` : '';
  return `the stored minute quotes${span}: ${named.join('; ')}${more}`;
}

export interface DigestFile { name: string; bytes: Uint8Array; type: 'image/png'; description: string }

export interface AttentionPart {
  /** the section at A0 with the digest's marks, for the first message when it has room */
  full: Embed;
  /** the section in a message of its own: A0 unless past DIGEST_ATTN_MESSAGE_MAX; null when even A3 does not fit */
  alone: Embed | null;
  aloneLevel: AttentionLevel | null;
  /** the section at the first level that fits `room` characters (a second message that also carries the recipient's
   *  own embed), or null when even A3 does not */
  forRoom: (room: number) => { embed: Embed; level: AttentionLevel } | null;
  picture: DigestFile | null;
  /** why the section is not sent at all, when it is not */
  note: string | null;
}

/** What the section's wiring adds: why its picture is left out, and the record of how the quote was read. */
export interface AttentionWiring { pictureNote?: string | null; priceHow?: PriceHowRead }

/** The section once per run: the same embed for every channel, only its place differs. */
export function attentionPart(fig: AttentionFigures, picture: AttentionPicture | null, digestMarks: Mark[], wiring: AttentionWiring = {}): AttentionPart {
  const ownSources = { quote: quoteSeriesSource(wiring.priceHow ?? null, fig), trades: ATTN_TRADES_SOURCE };
  const base = { picture, pictureName: DIGEST_ATTN_FILE, pictureNote: picture ? null : wiring.pictureNote ?? null, ownSources };
  // number the section's own marks by the ones its full form prints
  const provisional = attentionMarks(digestMarks);
  const text = embedText(attentionEmbed(fig, 'A0', { ...base, marks: provisional.marks }).embed as Embed);
  const used = new Set(ATTN_OWN_ORDER.filter((k) => usesMark(text, provisional.marks[k])));
  const { marks, extra } = attentionMarks(digestMarks, used);
  const opts = { ...base, marks };
  const a0 = attentionEmbed(fig, 'A0', opts);
  const full = withOwnSources(a0.embed as Embed, extra, a0.sourcesAppend);
  const forRoom = (room: number): { embed: Embed; level: AttentionLevel } | null => {
    // the level is chosen with the section's own Sources entries in, as it is sent
    for (const level of DIGEST_ATTN_LEVELS) {
      const r = attentionEmbed(fig, level, opts);
      const embed = withOwnSources(r.embed as Embed, extra, r.sourcesAppend);
      if (discordCount(embed) <= room) return { embed, level };
    }
    return null;
  };
  const fitted = forRoom(DIGEST_ATTN_MESSAGE_MAX);
  const leftOut = attentionForRoom(fig, DIGEST_ATTN_MESSAGE_MAX, opts);
  return {
    full,
    alone: fitted?.embed ?? null,
    aloneLevel: fitted?.level ?? null,
    forRoom,
    picture: picture ? { name: DIGEST_ATTN_FILE, bytes: picture.png, type: 'image/png', description: 'Trades worth attention: the quote over the window with each trade at its own price' } : null,
    note: fitted ? null : 'leftOut' in leftOut ? leftOut.note : 'Trades worth attention: left out for room',
  };
}

// ------------------------------------------------------------------------------------------------- posts

/** The JSON body of one webhook post. */
export interface DigestPayload {
  username: string;
  avatar_url: string;
  embeds: Embed[];
  allowed_mentions: { parse: never[] };
  /** present when files go with the post: each part's id is its index among the files */
  attachments?: { id: number; filename: string; description: string }[];
}
export interface DigestPost { payload: DigestPayload; files: DigestFile[] }

/** Everything a recipient's posts are built from, built once per run. */
export interface DigestParts {
  kind: DigestKind;
  now: number;
  body: DigestBody;
  /** the chart files the shared embed and the gallery name, in body.files order */
  chartFiles: DigestFile[];
  attention: AttentionPart | null;
}

/** The first sentence of a caption, as message.ts fit() keeps it. */
export const firstSentence = (s: string): string => { const m = /^.*?[.!?](?=\s|$)/.exec(s); return m ? m[0] : s; };

const ATTACHMENT_RE = /^attachment:\/\/(.+)$/;
/** The attachment names a post's embeds reference. */
export const referencedFiles = (embeds: Embed[]): string[] =>
  embeds.flatMap((e) => (e.image?.url ? [ATTACHMENT_RE.exec(e.image.url)?.[1]].filter((x): x is string => !!x) : []));

function post(embeds: Embed[], files: DigestFile[]): DigestPost {
  const named = referencedFiles(embeds);
  const used = files.filter((f) => named.includes(f.name));
  const body = digestPayload(embeds, DIGEST_AVATAR_URL);
  return {
    payload: {
      username: body.username,
      avatar_url: DIGEST_AVATAR_URL,
      embeds: body.embeds,
      allowed_mentions: { parse: [] },
      ...(used.length ? { attachments: used.map((f, i) => ({ id: i, filename: f.name, description: f.description })) } : {}),
    },
    files: used,
  };
}

/**
 * One recipient's posts in order. The first message is the shared embed exactly as built for every recipient (so it
 * is the same for the operator and every subscriber), the chart gallery and, when the message has room for it, the
 * recipient's own embed; the attention section is embed 2 when the message still has room for it at A0. Otherwise a
 * second message carries the own embed first, when the first message had no room for it, and the attention section
 * at the first level its room allows, with its picture (the owner's decision: the full section as the digest's second
 * message with its picture when the first message has no room, else embed 2). Nothing is cut to make room.
 */
export function postsFor(parts: DigestParts, own: FitPart | null): DigestPost[] {
  const { body } = parts;
  const fitted = fitMessage({ shared: body.shared, own, gallery: body.gallery });
  let embeds = fitted.embeds;
  const files = [...parts.chartFiles];
  const second: Embed[] = fitted.ownApart ? [fitted.ownApart] : [];
  const secondFiles: DigestFile[] = [];
  const a = parts.attention;
  if (a) {
    const room = DIGEST_MESSAGE_MAX - messageCount(embeds);
    if (!second.length && discordCount(a.full) <= room && embeds.length < DISCORD_EMBEDS_MAX) {
      // embed 2 of the digest's message: after the shared embed and its gallery, before the recipient's own
      const at = own ? embeds.length - 1 : embeds.length;
      embeds = [...embeds.slice(0, at), a.full, ...embeds.slice(at)];
      if (a.picture) files.push(a.picture);
    } else {
      const placed = second.length ? a.forRoom(DIGEST_MESSAGE_MAX - messageCount(second)) : a.alone ? { embed: a.alone } : null;
      if (placed) {
        second.push(placed.embed);
        if (a.picture) secondFiles.push(a.picture);
      }
    }
  }
  return second.length ? [post(embeds, files), post(second, secondFiles)] : [post(embeds, files)];
}

/** The watchlist embed's renderer for fit(): its lines follow the trim (20 → 10 → 5). */
export const watchlistPart = (lines: MessageWatchLine[] | MessageNotRead, now: number, kind: DigestKind): FitPart =>
  (t: TrimState) => watchlistEmbed(lines, now, kind, t.watchLines);

// ------------------------------------------------------------------------------------------------- Discord's limits

/** Every way a post breaks Discord's limits (an empty list when it fits): counts as Discord counts, files both ways. */
export function discordProblems(p: DigestPost): string[] {
  const out: string[] = [];
  const embeds = p.payload.embeds;
  if (embeds.length > DISCORD_EMBEDS_MAX) out.push(`${embeds.length} embeds (limit ${DISCORD_EMBEDS_MAX})`);
  let total = 0;
  embeds.forEach((e, i) => {
    total += discordCount(e);
    if ((e.title ?? '').length > DISCORD_TITLE_MAX) out.push(`embed ${i}: title ${e.title!.length}`);
    if ((e.description ?? '').length > DISCORD_DESCRIPTION_MAX) out.push(`embed ${i}: description ${e.description!.length}`);
    if ((e.fields ?? []).length > DISCORD_FIELDS_MAX) out.push(`embed ${i}: ${e.fields!.length} fields`);
    if ((e.footer?.text ?? '').length > DISCORD_FOOTER_MAX) out.push(`embed ${i}: footer ${e.footer!.text.length}`);
    for (const f of e.fields ?? []) {
      if (f.name.length > DISCORD_FIELD_NAME_MAX) out.push(`embed ${i}: field name ${f.name.length}`);
      if (f.value.length > DISCORD_FIELD_MAX) out.push(`embed ${i}: field "${f.name}" ${f.value.length}`);
      if (!f.name.length || !f.value.length) out.push(`embed ${i}: an empty field`);
    }
  });
  if (total > DISCORD_MESSAGE_MAX) out.push(`${total} characters over the embeds (limit ${DISCORD_MESSAGE_MAX})`);
  const named = referencedFiles(embeds);
  const names = p.files.map((f) => f.name);
  for (const n of named) if (!names.includes(n)) out.push(`attachment://${n} has no file`);
  for (const n of names) if (!named.includes(n)) out.push(`file ${n} is not referenced`);
  if (new Set(names).size !== names.length) out.push('two files share a name');
  if (p.files.length > DISCORD_ATTACHMENTS_MAX) out.push(`${p.files.length} files (limit ${DISCORD_ATTACHMENTS_MAX})`);
  for (const f of p.files) if (f.bytes.length >= DISCORD_FILE_MAX_BYTES) out.push(`file ${f.name} is ${f.bytes.length} bytes`);
  const att = p.payload.attachments ?? [];
  if (att.length !== p.files.length || att.some((a, i) => a.filename !== p.files[i].name || a.id !== i)) out.push('attachments do not list the files in order');
  const bytes = new TextEncoder().encode(JSON.stringify(p.payload)).length + p.files.reduce((a, f) => a + f.bytes.length, 0);
  if (bytes >= DISCORD_POST_MAX_BYTES) out.push(`the post is ${bytes} bytes`);
  return out;
}

// ------------------------------------------------------------------------------------------------- the orchestrator

export interface SubscriberWallet { address: string; watchlistOn?: boolean; watchlist?: string[] }

export interface ReadAndBuildOptions {
  /** the subscribers whose watchlists this run reads, first saved first (watchlists.ts bounds them) */
  wallets?: WatchWallet[];
  /** this digest's targets, known before the post (the operator embed's "This digest" line) */
  targets?: { channels: number; subscribers: number };
  /** every statement the figures, the operator lines, the watchlists and the charts prepare */
  log?: Prepared[];
}

export interface DigestBuild {
  kind: DigestKind;
  now: number;
  key: string;
  what: string;
  figures: ReadFigures;
  reads: DigestReads;
  messageFigures: MessageFigures;
  operator: ReadOperator;
  operatorMessage: MessageOperator;
  /** null when no wallet was given; a NotRead when the read threw */
  watch: WatchResult | NotRead | null;
  charts: { set: ChartSet; captions: ChartCaption[] } | NotRead;
  attention: AttentionFigures | NotRead;
  attentionPicture: AttentionPicture | null;
  body: DigestBody;
  parts: DigestParts;
  operatorPosts: DigestPost[];
  subscriberPosts: (wallet: SubscriberWallet) => DigestPost[];
  /** the operator's posts for the targets known at the send (the operator embed's "This digest" and cap lines) */
  operatorPostsWith: (x: { channels: number; subscribers: number; watchCapWallets: number }) => DigestPost[];
  /** a subscriber's posts with the watchlists read at the send (null: none were read; a NotRead: the read failed) */
  subscriberPostsWith: (watch: WatchResult | NotRead | null) => (wallet: SubscriberWallet) => DigestPost[];
  /** what was left out of the build and why, for the health row and the console (no address, no figure) */
  notes: string[];
}

const errText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 200);

/** The chart context from the figures' anchors: the epoch clock, the bond listing, the minute readings at T. */
export function chartContext(f: ReadFigures): ChartContext {
  const a = f.anchors;
  const nowOf = (fig: Figure<ReadMetric> | null): ChartContext['quoteNow'] => (fig == null ? null : isNotRead(fig) ? { at: fig.lastAt, live: false } : { at: fig.value.at, live: true });
  const quote = isNotRead(f.price) ? null : f.price.value.quote;
  const stake = isNotRead(f.staked) ? null : f.staked.value.totalStake;
  return {
    now: f.now,
    kind: f.kind,
    clock: { eNow: a.epoch.eNow, epochAt: a.epoch.epochAt, startedAt: a.epoch.startedAt, errorMs: a.epoch.errorMs, epochMs: a.epoch.epochMs, paramsAt: a.epoch.paramsAt },
    listing: a.bondListing ? { completeAt: a.bondListing.completeAt, height: a.bondListing.height, provider: a.bondListing.provider, live: a.bondListing.live, error: a.bondListing.error, failedAt: a.bondListing.failedAt } : null,
    quoteNow: nowOf(quote),
    stakeNow: nowOf(stake),
  };
}

/** The record of how the quote was read (kv price.how): the log, null when no row exists (the price list was the only
 *  way), or a NotRead when the read did not answer. */
export type PriceHowRead = PriceHowLog | null | NotRead;

/**
 * The quote's source as the site names a stored price: the way the reading at `at` was read (price-how.ts
 * priceHowAt, storedPriceSource, storedPriceNote). When the record could not be read the way is not known, and the
 * entry says so rather than naming the price list.
 */
export function quoteSourceAt(how: PriceHowRead, at: number | null): QuoteSource {
  if (isNotRead(how)) return { name: 'Osmosis SQS quote', note: 'how it was read is not known: its record did not answer' };
  const entry = at != null ? priceHowAt(how, at) : null;
  const note = storedPriceNote(entry);
  return { name: storedPriceSource(entry), ...(note ? { note } : {}) };
}

/** The reads figures.ts and operator.ts leave to the wiring: the daily's 7 d price base, the health log's first entry
 *  and the record of how the quote was read. */
async function readExtras(db: D1Database, f: ReadFigures, log?: Prepared[]): Promise<{ priceWeek: Change | NotRead | undefined; healthLogFirstAt: number | null | NotRead; priceHow: PriceHowRead }> {
  const A7 = f.now - 7 * DAY_MS;
  const quote = isNotRead(f.price) || isNotRead(f.price.value.quote) ? null : f.price.value.quote.value;
  const w = new Wave(db, log);
  const base = f.kind === 'daily' && quote ? w.add<{ ts: number; value: number }>(SQL.latest, ['price.usd', A7]) : null;
  const first = f.kind === 'daily' && quote ? w.add<{ first_ts: number | null }>(SQL.firstTs, ['price.usd']) : null;
  const logFirst = w.add<{ first_at: number | null }>(
    "SELECT MIN(json_extract(e.value,'$.at')) first_at FROM kv, json_each(kv.value) e WHERE kv.key = ?",
    [DIGEST_HEALTH_LOG_KV],
  );
  const howRow = w.add<{ value: string }>('SELECT value FROM kv WHERE key = ?', [PRICE_HOW_KEY]);
  await w.run();
  let priceHow: PriceHowRead;
  if (!howRow.answer.ok) priceHow = notRead(PRICE_HOW_KEY, null, DB_NOT_ANSWERED);
  else {
    const raw = howRow.answer.rows[0]?.value;
    let parsed: PriceHowLog | null = null;
    try { parsed = raw ? (JSON.parse(raw) as PriceHowLog) : null; } catch { parsed = null; }
    // an unreadable stored row is no record, as the cron reads it (price-how.ts priceHowStmt starts a new log)
    priceHow = parsed && Array.isArray(parsed.log) ? parsed : null;
  }
  let priceWeek: Change | NotRead | undefined;
  if (base && first && quote) {
    priceWeek = base.answer.ok && first.answer.ok
      ? changeFrom({ ts: quote.at, value: quote.value }, base.answer.rows[0] ?? null, A7, MINUTE_BOUND_MS, first.answer.rows[0]?.first_ts ?? null)
      : notRead('Osmosis SQS (price)', null, DB_NOT_ANSWERED);
  }
  // no log row, or a log with no entry, is a log that holds no flip yet
  const at = logFirst.answer.ok ? logFirst.answer.rows[0]?.first_at : null;
  const healthLogFirstAt = !logFirst.answer.ok ? notRead(DIGEST_HEALTH_LOG_KV, null, DB_NOT_ANSWERED) : at != null && Number.isFinite(Number(at)) ? Number(at) : null;
  return { priceWeek, healthLogFirstAt, priceHow };
}

/**
 * Reads and builds one digest (daily or weekly) for the instant `now`: the figures (three batch waves; throws only when
 * the header part failed, so nothing is built that tick), then beside each other the operator lines, the watchlists of
 * `opts.wallets`, the chart series and their pictures, and the attention section with its picture, each in its own
 * try. Returns the operator's posts and a function that builds a subscriber's.
 */
export async function readAndBuildDigest(db: D1Database, now: number, kind: DigestKind, opts: ReadAndBuildOptions = {}): Promise<DigestBuild> {
  const win = digestWindow(now, kind);
  const log = opts.log;
  const reads = await collectDigestReads(db, win, log);
  const figures = shapeDigestFigures(reads, win);
  const notes: string[] = [];
  const e = figures.anchors.epoch;
  const clock = e.eNow != null && e.startedAt != null && e.epochMs != null ? { epoch: e.eNow, startedAt: e.startedAt, epochSec: e.epochMs / 1000 } : null;

  const [extras, operator, watch, charts, attention] = await Promise.all([
    readExtras(db, figures, log),
    readOperatorFigures(db, now, kind, log),
    opts.wallets
      ? readWatchlists(db, opts.wallets, now, kind, log).catch((err): NotRead => { notes.push(`watchlists: not read (${errText(err)})`); return notRead('watchlist', null, DB_NOT_ANSWERED); })
      : Promise.resolve(null),
    (async () => {
      const ctx = chartContext(figures);
      const rows = await readChartRows(db, ctx, log);
      const shaped = shapeCharts(rows, ctx);
      const set = await renderChartSet(shaped.input, kind);
      return { set, captions: chartCaptions(set, shaped, kind) };
    })().catch((err): NotRead => { notes.push(`charts: not drawn (${errText(err)})`); return notRead('charts', null, DB_NOT_ANSWERED); }),
    readAttentionFigures(db, now, kind, { clock }).catch((err): NotRead => { notes.push(`attention: not read (${errText(err)})`); return notRead('attention', null, DB_NOT_ANSWERED); }),
  ]);
  if (extras.priceWeek && isNotRead(extras.priceWeek)) notes.push("price: the daily's 7 d base was not read; the 7 d change is left out");

  const chartRefs: ChartRef[] = isNotRead(charts)
    ? [{ file: '', title: 'Charts', caption: 'Charts: not drawn — the database did not answer these reads.', present: false }]
    : charts.captions.map((c) => ({ file: c.file, title: c.title, caption: c.caption, notes: c.notes, present: c.present }));
  // the quote's source follows how the reading shown (or, not read, the last one) was read
  const quoteFig = isNotRead(figures.price) ? null : figures.price.value.quote;
  const quoteAt = quoteFig == null ? null : isNotRead(quoteFig) ? quoteFig.lastAt : quoteFig.value.at;
  const priceSource = quoteSourceAt(extras.priceHow, quoteAt);
  const messageFigures = toMessageFigures(figures, { priceWeek: extras.priceWeek, bridgeLate: bridgeLateOf(reads), charts: chartRefs, priceSource, priceHow: extras.priceHow });
  const body = buildDigest(messageFigures, now, kind);

  // each picture's alt text is its title and its caption's first sentence (the words the caption field would keep)
  const chartFiles: DigestFile[] = isNotRead(charts) ? [] : charts.set.charts.map((c) => {
    const cap = charts.captions.find((x) => x.file === c.file);
    return { name: c.file, bytes: c.png, type: 'image/png' as const, description: cap ? `${cap.title}: ${firstSentence(cap.caption)}`.slice(0, 1_024) : c.file };
  });
  let attentionPicture: AttentionPicture | null = null;
  let attn: AttentionPart | null = null;
  if (!isNotRead(attention)) {
    attentionPicture = await renderAttentionPicture(attention).catch(() => null);
    try {
      attn = attentionPart(attention, attentionPicture, body.marks, { pictureNote: pictureLeftOut(attention), priceHow: extras.priceHow });
      if (attn.note) notes.push(attn.note);
    } catch (err) { notes.push(`attention: not built (${errText(err)})`); }
  }
  const parts: DigestParts = { kind, now, body, chartFiles, attention: attn };

  const operatorFor = (x: { channels: number; subscribers: number; watchCapWallets: number }) => toMessageOperator(operator, {
    healthLogFirstAt: extras.healthLogFirstAt, channels: x.channels, subscribers: x.subscribers, watchCapWallets: x.watchCapWallets,
  });
  const operatorPostsWith = (x: { channels: number; subscribers: number; watchCapWallets: number }): DigestPost[] =>
    postsFor(parts, operatorEmbed(operatorFor(x), now, kind));
  const targets = opts.targets ?? { channels: 1, subscribers: 0 };
  const operatorMessage = operatorFor({ ...targets, watchCapWallets: watch && !isNotRead(watch) ? watch.capped : 0 });
  const operatorPosts = postsFor(parts, operatorEmbed(operatorMessage, now, kind));

  const subscriberPostsWith = (w: WatchResult | NotRead | null) => (wallet: SubscriberWallet): DigestPost[] => {
    const list = wallet.watchlist ?? [];
    if (!wallet.watchlistOn || !list.length) return postsFor(parts, null);
    const lines: ReadWatchLine[] | NotRead = w == null
      ? notRead('watchlist', null, 'the watchlists were not part of this run')
      : isNotRead(w) ? w
        : w.lines.get(wallet.address) ?? notRead('watchlist', null, "this wallet's watchlist was not part of this run");
    return postsFor(parts, watchlistPart(toMessageWatch(lines), now, kind));
  };
  const subscriberPosts = subscriberPostsWith(watch);

  return {
    kind, now, key: body.key, what: body.what, figures, reads, messageFigures, operator, operatorMessage, watch, charts, attention, attentionPicture,
    body, parts, operatorPosts, subscriberPosts, operatorPostsWith, subscriberPostsWith, notes,
  };
}
